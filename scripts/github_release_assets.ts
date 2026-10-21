import process from "node:process";
import * as nodeFs from "#fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  extractReleaseArchive,
  findNodeRuntimeLicensePath,
  loadLicenseInventory,
  releaseNames,
  renderThirdPartyNotices,
  sha256File,
  validatePackageManifest,
  validateReleaseManifest,
} from "./release_package.ts";
import { RELEASE_TARGETS, targetId } from "./release_target.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const supportedTargets = RELEASE_TARGETS;

export function assertTagMatchesVersion(tag: string, version: string): void {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag '${tag}'`);
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `Release tag '${tag}' does not match source version '${version}'`,
    );
  }
}

export function releaseAssetNames(
  version: string,
  target: string,
): { archive: string; checksum: string; manifest: string } {
  if (!supportedTargets.includes(target as (typeof supportedTargets)[number])) {
    throw new Error(`Unsupported GitHub release target '${target}'`);
  }
  return releaseNames(version, target);
}

export async function stageReleaseAssets(
  releaseDirectory: string,
  outputDirectory: string,
  runtimeLicensePath?: string,
): Promise<string[]> {
  const manifestFiles: string[] = [];
  for await (const entry of nodeFs.readDir(releaseDirectory)) {
    if (
      entry.isFile() &&
      entry.name.startsWith("acp-api-") &&
      entry.name.endsWith(".manifest.json")
    )
      manifestFiles.push(entry.name);
  }
  if (manifestFiles.length !== 1) {
    throw new Error("Release bundle must contain exactly one target manifest");
  }
  const manifest = validateReleaseManifest(
    JSON.parse(await nodeFs.readText(join(releaseDirectory, manifestFiles[0]))),
  );
  if (manifest.version !== VERSION) {
    throw new Error(
      `Release bundle version '${manifest.version}' does not match source version '${VERSION}'`,
    );
  }
  const names = releaseAssetNames(manifest.version, manifest.target);
  if (
    manifest.archive !== names.archive ||
    manifestFiles[0] !== names.manifest
  ) {
    throw new Error("Release bundle names do not match its target manifest");
  }
  const archive = join(releaseDirectory, names.archive);
  const hash = await sha256File(archive);
  const checksum = await nodeFs.readText(
    join(releaseDirectory, names.checksum),
  );
  if (
    hash !== manifest.archiveSha256 ||
    checksum !== checksumText(hash, names.archive)
  )
    throw new Error("Release archive checksum or manifest mismatch");

  const extracted = await nodeFs.makeTempDir({ prefix: "acp-api-gh-stage-" });
  try {
    await extractReleaseArchive(archive, manifest.target, extracted);
    const embedded = validatePackageManifest(
      JSON.parse(await nodeFs.readText(join(extracted, "manifest.json"))),
    );
    if (
      embedded.product !== manifest.product ||
      embedded.version !== manifest.version ||
      embedded.target !== manifest.target ||
      embedded.commit !== manifest.commit ||
      embedded.executable !== manifest.executable ||
      embedded.executableSha256 !== manifest.executableSha256 ||
      (await sha256File(join(extracted, embedded.executable))) !==
        manifest.executableSha256
    )
      throw new Error("Release archive executable or manifest mismatch");
    const inventory = await loadLicenseInventory(projectRoot);
    if (
      (await nodeFs.readText(join(extracted, "LICENSE"))) !==
        (await nodeFs.readText(join(projectRoot, "LICENSE"))) ||
      (await nodeFs.readText(join(extracted, "THIRD_PARTY_NOTICES.txt"))) !==
        renderThirdPartyNotices(inventory, { includeNodeRuntime: true })
    )
      throw new Error("Release archive omitted license or third-party notices");
    if (
      (await nodeFs.readText(
        join(extracted, "licenses/Node.js-LICENSE.txt"),
      )) !==
      (await nodeFs.readText(
        runtimeLicensePath ?? (await findNodeRuntimeLicensePath()),
      ))
    )
      throw new Error("Release archive Node.js license text mismatch");
    for (const relative of new Set(
      inventory.dependencies.flatMap((item) => item.licenseFiles),
    )) {
      if (
        (await nodeFs.readText(join(extracted, relative))) !==
        (await nodeFs.readText(join(projectRoot, relative)))
      )
        throw new Error(`Release archive license text mismatch: ${relative}`);
    }
  } finally {
    await nodeFs.removePath(extracted, { recursive: true });
  }

  await nodeFs.mkdir(outputDirectory);
  for (const name of [names.archive, names.checksum]) {
    await nodeFs.copyFile(
      join(releaseDirectory, name),
      join(outputDirectory, name),
    );
  }
  await nodeFs.writeText(
    join(outputDirectory, names.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return [names.archive, names.checksum, names.manifest];
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check-tag") {
    const tag = process.env.GITHUB_REF_NAME;
    if (!tag) throw new Error("GITHUB_REF_NAME is required");
    assertTagMatchesVersion(tag, VERSION);
    console.log(`Release tag ${tag} matches source version ${VERSION}`);
  } else if (command === "stage") {
    const target = targetId();
    if (args.length !== 0) throw new Error("stage takes no arguments");
    const expectedTarget = process.env.ACPAPI_EXPECTED_RELEASE_TARGET;
    if (expectedTarget && expectedTarget !== target) {
      throw new Error(
        `Native target '${target}' does not match expected release target '${expectedTarget}'`,
      );
    }
    const directory = join(
      projectRoot,
      "dist",
      "releases",
      `acp-api-${VERSION}-${target}`,
    );
    const output = join(projectRoot, "dist", "github-release-assets");
    const assets = await stageReleaseAssets(directory, output);
    console.log(`Staged ${assets.map((name) => basename(name)).join(", ")}`);
  } else {
    throw new Error("Usage: github_release_assets.ts check-tag|stage");
  }
}
