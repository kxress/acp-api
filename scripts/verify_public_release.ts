import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  extractReleaseArchive,
  loadLicenseInventory,
  releaseNames,
  sha256File,
  validatePackageManifest,
  validateReleaseManifest,
} from "./release_package.ts";
import { isReleaseTarget } from "./release_target.ts";
import { smokeExecutable } from "./release.ts";

const [directoryArg, targetArg] = process.argv.slice(2);
if (
  !directoryArg ||
  !targetArg ||
  (targetArg !== "node" && !isReleaseTarget(targetArg))
) {
  throw new Error(
    "Usage: verify_public_release.ts <download-directory> <supported-target|node>",
  );
}
const directory = resolve(directoryArg);
if (targetArg === "node") {
  const archive = `acp-api-${VERSION}-node.zip`;
  const checksumName = `${archive}.sha256`;
  const manifestName = `acp-api-${VERSION}-node.manifest.json`;
  const expectedNodeAssets = new Set([archive, checksumName, manifestName]);
  const actualNodeAssets = new Set<string>();
  for await (const entry of nodeFs.readDir(directory)) {
    if (!entry.isFile())
      throw new Error("Downloaded release contains a non-file");
    actualNodeAssets.add(entry.name);
  }
  if (
    actualNodeAssets.size !== expectedNodeAssets.size ||
    [...expectedNodeAssets].some((name) => !actualNodeAssets.has(name))
  ) {
    throw new Error(
      "Downloaded Node release asset set is incomplete or unexpected",
    );
  }
  const manifest = JSON.parse(
    await nodeFs.readText(join(directory, manifestName)),
  ) as {
    product?: string;
    version?: string;
    runtime?: string;
    entry?: string;
    entrySha256?: string;
    archive?: string;
    archiveSha256?: string;
  };
  const archiveHash = await sha256File(join(directory, archive));
  if (
    manifest.product !== "acp-api" ||
    manifest.version !== VERSION ||
    manifest.runtime !== "node >=24.12.0" ||
    manifest.entry !== "acp-api.mjs" ||
    manifest.archive !== archive ||
    manifest.archiveSha256 !== archiveHash ||
    (await nodeFs.readText(join(directory, checksumName))) !==
      checksumText(archiveHash, archive)
  ) {
    throw new Error(
      "Downloaded Node release checksum or manifest does not match",
    );
  }
  const extractedNode = await nodeFs.makeTempDir({
    prefix: "acp-api-node-verify-",
  });
  try {
    const unzip = await new ProcessCommand("unzip", {
      args: ["-q", join(directory, archive), "-d", extractedNode],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!unzip.success)
      throw new Error("Could not extract downloaded Node release ZIP");
    const embedded = JSON.parse(
      await nodeFs.readText(join(extractedNode, "node-manifest.json")),
    ) as typeof manifest;
    if (
      embedded.version !== manifest.version ||
      embedded.product !== manifest.product ||
      embedded.runtime !== manifest.runtime ||
      embedded.entry !== manifest.entry ||
      embedded.entrySha256 !== manifest.entrySha256 ||
      (await sha256File(join(extractedNode, "acp-api.mjs"))) !==
        manifest.entrySha256
    ) {
      throw new Error("Downloaded Node entry does not match its manifest");
    }
    const inventory = await loadLicenseInventory();
    for (const file of [
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      ...new Set(inventory.dependencies.flatMap((item) => item.licenseFiles)),
    ]) {
      if (!(await nodeFs.stat(join(extractedNode, file))).isFile())
        throw new Error(`Node release omitted ${file}`);
    }
    console.log(
      `Downloaded Node ${VERSION} package passed checksum, manifest, entry hash, and license checks.`,
    );
  } finally {
    await nodeFs.removePath(extractedNode, { recursive: true });
  }
  process.exit(0);
}
const names = releaseNames(VERSION, targetArg);
const expected = new Set([names.archive, names.checksum, names.manifest]);
const actual = new Set<string>();
for await (const entry of nodeFs.readDir(directory)) {
  if (!entry.isFile())
    throw new Error("Downloaded release contains a non-file");
  actual.add(entry.name);
}
if (
  actual.size !== expected.size ||
  [...expected].some((name) => !actual.has(name))
)
  throw new Error("Downloaded release asset set is incomplete or unexpected");

const manifest = validateReleaseManifest(
  JSON.parse(await nodeFs.readText(join(directory, names.manifest))),
);
if (manifest.version !== VERSION || manifest.target !== targetArg) {
  throw new Error(
    "Downloaded release manifest has the wrong version or target",
  );
}
const archivePath = join(directory, names.archive);
const checksum = await nodeFs.readText(join(directory, names.checksum));
const archiveHash = await sha256File(archivePath);
if (
  checksum !== checksumText(archiveHash, names.archive) ||
  manifest.archiveSha256 !== archiveHash
)
  throw new Error("Downloaded archive checksum or manifest does not match");

const extracted = await nodeFs.makeTempDir({
  prefix: "acp-api-public-release-",
});
try {
  await extractReleaseArchive(archivePath, targetArg, extracted);
  const packageManifest = validatePackageManifest(
    JSON.parse(await nodeFs.readText(join(extracted, "manifest.json"))),
  );
  const executable = join(extracted, packageManifest.executable);
  if (
    packageManifest.version !== manifest.version ||
    packageManifest.target !== manifest.target ||
    packageManifest.commit !== manifest.commit ||
    packageManifest.executableSha256 !== manifest.executableSha256 ||
    (await sha256File(executable)) !== manifest.executableSha256
  )
    throw new Error("Downloaded executable does not match release manifests");
  if (
    !(
      await nodeFs.stat(join(extracted, "licenses/Node.js-LICENSE.txt"))
    ).isFile()
  ) {
    throw new Error("Downloaded release omitted the embedded Node.js license");
  }
  if (targetArg !== "windows-x86_64") {
    const mode = (await nodeFs.stat(executable)).mode;
    if (mode === null || (mode & 0o111) === 0) {
      throw new Error("Downloaded POSIX executable is not executable");
    }
  }
  if (targetArg === "macos-arm64") {
    const output = await new ProcessCommand("file", {
      args: [executable],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const description = new TextDecoder().decode(output.stdout);
    if (!output.success || !/Mach-O.*arm64/i.test(description)) {
      throw new Error(
        `Downloaded macOS executable is not ARM64 Mach-O: ${description.trim()}`,
      );
    }
    console.log(description.trim());
  }
  await smokeExecutable(executable);
  console.log(
    `Downloaded ${targetArg} ${VERSION} release package passed checksum, manifest, architecture/mode, version, and API smoke checks.`,
  );
} finally {
  await nodeFs.removePath(extracted, { recursive: true });
}
