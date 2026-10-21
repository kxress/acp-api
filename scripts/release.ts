import process from "node:process";
import { ProcessCommand, type ProcessOutput } from "#proc";
import * as nodeFs from "#fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import {
  checksumText,
  createReleaseArchive,
  extractReleaseArchive,
  type ReleaseManifest,
  releaseNames,
  sha256File,
  validatePackageManifest,
  validateReleaseManifest,
} from "./release_package.ts";
import { isWindowsTarget, targetId } from "./release_target.ts";

export { targetId } from "./release_target.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const target = targetId();
const windows = isWindowsTarget(target);
const executableName = windows ? "acp-api.exe" : "acp-api";
const buildPath = join(projectRoot, "dist", executableName);

export type { ReleaseManifest } from "./release_package.ts";
export { checksumText, sha256Hex } from "./release_package.ts";

const validateManifest = validateReleaseManifest;

export function artifactName(
  version: string,
  target: string,
  _os: NodeJS.Platform | "windows" = process.platform,
): string {
  return releaseNames(version, target).archive;
}

export function assertCleanTreeStatus(status: string): void {
  if (status.trim()) {
    throw new Error(
      "Local release requires a clean working tree (including untracked files). Commit or remove changes before packaging.",
    );
  }
}

/** Ensures release output stays in ordinary dist/releases directories. */
export async function ensureReleaseOutputRoot(
  projectRoot: string,
): Promise<string> {
  // Canonicalize the trusted checkout root first. On Windows, the supplied
  // path may use an ordinary 8.3 alias; resolve() does not expand it, while
  // realPath() does. Build the guarded output paths from that canonical root
  // so only redirects below the checkout are treated as links.
  const canonicalProjectRoot = resolve(await nodeFs.realpath(projectRoot));
  const expectedDist = resolve(canonicalProjectRoot, "dist");
  const expectedReleaseRoot = resolve(expectedDist, "releases");
  const ensurePlainDirectory = async (path: string): Promise<void> => {
    try {
      await nodeFs.mkdir(path);
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "EEXIST")) throw error;
    }
    const info = await nodeFs.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Release output path must be a plain directory: ${path}`);
    }
    const real = resolve(await nodeFs.realpath(path));
    const normalize = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(real) !== normalize(resolve(path))) {
      throw new Error(`Release output path resolves through a link: ${path}`);
    }
  };
  await ensurePlainDirectory(expectedDist);
  await ensurePlainDirectory(expectedReleaseRoot);
  return expectedReleaseRoot;
}

function parseChecksum(text: string, filename: string): string {
  const match = text.trim().match(/^([a-f0-9]{64})[ ]{2}(.+)$/);
  if (!match || match[2] !== filename) {
    throw new Error(`Checksum file does not match artifact '${filename}'`);
  }
  return match[1];
}

async function runCommand(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const status = await new ProcessCommand(npmCommand, {
    args: ["run", ...args],
    cwd: options.cwd ?? projectRoot,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    shell: process.platform === "win32",
  }).spawn().status;
  if (!status.success) {
    throw new Error(
      `Command failed (${status.code}): npm run ${args.join(" ")}`,
    );
  }
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<ProcessOutput> {
  return await new ProcessCommand(command, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
}

type VersionProbe = (path: string, cwd: string) => Promise<string | undefined>;

async function probeVersion(
  path: string,
  cwd: string,
): Promise<string | undefined> {
  const result = await capture(path, ["--version"], cwd);
  if (!result.success) return undefined;
  return new TextDecoder().decode(result.stdout).trim();
}

async function gitOutput(args: string[]): Promise<string> {
  const result = await capture("git", args, projectRoot);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder()
        .decode(result.stderr)
        .trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function requireCleanTree(): Promise<void> {
  assertCleanTreeStatus(
    await gitOutput(["status", "--porcelain", "--untracked-files=all"]),
  );
}

async function verifyExecutable(path: string, cwd: string): Promise<void> {
  const version = await capture(path, ["--version"], cwd);
  const output = new TextDecoder().decode(version.stdout).trim();
  if (!version.success || output !== `acp-api ${VERSION}`) {
    throw new Error(
      `Native executable version mismatch at '${path}': expected acp-api ${VERSION}`,
    );
  }
}

export async function smokeExecutable(path: string): Promise<void> {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-api-release-smoke-" });
  try {
    await verifyExecutable(path, cwd);
    const help = await capture(path, ["--help"], cwd);
    if (
      !help.success ||
      !new TextDecoder()
        .decode(help.stdout)
        .includes("acp-api --config <path>") ||
      help.stderr.length
    )
      throw new Error("Native --help smoke failed");
  } finally {
    await nodeFs.removePath(cwd, { recursive: true });
  }
  await smokeApiCommand(path);
}

export async function smokeApiCommand(
  command: string,
  commandArgs: string[] = [],
): Promise<void> {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-api-release-smoke-" });
  try {
    const port = await findAvailablePort();
    const configPath = join(cwd, "release smoke config.json");
    const fixtureAgent = join(
      projectRoot,
      "tests",
      "fixtures",
      "release_smoke_acp_agent.mjs",
    );
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port },
        agents: [
          {
            name: "release-smoke-agent",
            command: process.execPath,
            args: [fixtureAgent],
            cwd,
            models: ["release-smoke-model"],
            permission: "deny",
          },
        ],
      }),
    );
    const child = new ProcessCommand(command, {
      args: [...commandArgs, "--config", configPath],
      cwd,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const deadline = Date.now() + 10_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (await waitForExit(child, 100)) {
          throw new Error("Native API process exited before becoming healthy");
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          const report = (await response.json()) as {
            status?: string;
            service?: string;
            models?: number;
          };
          if (
            response.ok &&
            report.status === "ok" &&
            report.service === "acp-api" &&
            report.models === 1
          ) {
            healthy = true;
            break;
          }
        } catch {
          // The API process may still be starting its ACP fixture and HTTP server.
        }
      }
      if (!healthy) throw new Error("Native API health smoke failed");
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(2_000),
      });
      const listing = (await models.json()) as {
        data?: Array<{ id?: string }>;
      };
      if (!models.ok || listing.data?.[0]?.id !== "release-smoke-model") {
        throw new Error("Native OpenAI models endpoint smoke failed");
      }
      const anthropicModels = await fetch(
        `http://127.0.0.1:${port}/v1/models`,
        {
          headers: { "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(2_000),
        },
      );
      const anthropicListing = (await anthropicModels.json()) as {
        data?: Array<{ id?: string; type?: string }>;
      };
      const anthropicModel = anthropicListing.data?.[0];
      if (
        !anthropicModels.ok ||
        anthropicModel?.id !== "release-smoke-model" ||
        anthropicModel.type !== "model"
      ) {
        throw new Error("Native Anthropic models endpoint smoke failed");
      }
    } finally {
      let exited = false;
      if (process.platform === "win32" && child.pid) {
        await new ProcessCommand("taskkill.exe", {
          args: ["/PID", String(child.pid), "/T", "/F"],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).output();
        exited = await waitForExit(child, 5_000);
      } else {
        child.kill("SIGINT");
        exited = await waitForExit(child, 5_000);
      }
      if (!exited) child.kill("SIGKILL");
      await child.status.catch(() => undefined);
    }
  } finally {
    await nodeFs.removePath(cwd, { recursive: true });
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local API smoke-test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForExit(
  child: ReturnType<ProcessCommand["spawn"]>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.status.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return exited;
}

async function validateSource(): Promise<string> {
  await requireCleanTree();
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  await runCommand(["check"]);
  await runCommand(["test"]);
  await runCommand(["lint"]);
  await runCommand(["format:check"]);
  const diff = await capture("git", ["diff", "--check"], projectRoot);
  if (!diff.success) throw new Error("git diff --check failed");
  await runCommand(["build"]);
  await runCommand(["build:native"]);
  await requireCleanTree();
  await smokeExecutable(buildPath);
  return commit;
}

async function sameExistingRelease(
  finalDirectory: string,
  manifest: ReleaseManifest,
  manifestName: string,
): Promise<boolean> {
  try {
    const currentManifest = validateManifest(
      JSON.parse(await nodeFs.readText(join(finalDirectory, manifestName))),
    );
    const currentChecksum = await nodeFs.readText(
      join(finalDirectory, `${manifest.archive}.sha256`),
    );
    const currentHash = await sha256File(
      join(finalDirectory, manifest.archive),
    );
    return (
      currentManifest.product === manifest.product &&
      currentManifest.version === manifest.version &&
      currentManifest.target === manifest.target &&
      currentManifest.commit === manifest.commit &&
      currentManifest.executableSha256 === manifest.executableSha256 &&
      currentManifest.archiveSha256 === manifest.archiveSha256 &&
      currentChecksum ===
        checksumText(manifest.archiveSha256, manifest.archive) &&
      currentHash === manifest.archiveSha256
    );
  } catch {
    return false;
  }
}

async function packageRelease(): Promise<void> {
  const releaseRoot = await ensureReleaseOutputRoot(projectRoot);
  const commit = await validateSource();
  const target = targetId();
  const expectedTarget = process.env.ACPAPI_EXPECTED_RELEASE_TARGET;
  if (expectedTarget && expectedTarget !== target) {
    throw new Error(
      `Native target '${target}' does not match expected release target '${expectedTarget}'`,
    );
  }
  const names = releaseNames(VERSION, target);
  const executableHash = await sha256File(buildPath);
  const stageDirectory = await nodeFs.makeTempDir({
    dir: releaseRoot,
    prefix: ".staging-",
  });
  const finalDirectory = join(releaseRoot, `acp-api-${VERSION}-${target}`);
  try {
    const archivePath = join(stageDirectory, names.archive);
    const manifest = await createReleaseArchive(archivePath, {
      binaryPath: buildPath,
      version: VERSION,
      target: target as ReleaseManifest["target"],
      commit,
      executableSha256: executableHash,
      root: projectRoot,
    });
    const extracted = await nodeFs.makeTempDir({
      prefix: "acp-api-release-verify-",
    });
    try {
      await extractReleaseArchive(archivePath, target, extracted);
      const stagedExecutable = join(extracted, names.executable);
      if ((await sha256File(stagedExecutable)) !== executableHash) {
        throw new Error("Packaged executable hash differs from the build");
      }
      if (!windows) {
        const mode = (await nodeFs.stat(stagedExecutable)).mode;
        if (mode === null || (mode & 0o111) === 0) {
          throw new Error("Packaged POSIX executable is not executable");
        }
      }
      if (target === "macos-arm64") {
        const architecture = await capture(
          "file",
          [stagedExecutable],
          extracted,
        );
        const description = new TextDecoder().decode(architecture.stdout);
        if (!architecture.success || !/Mach-O.*arm64/i.test(description)) {
          throw new Error(
            `macOS release executable is not native ARM64 Mach-O: ${description.trim()}`,
          );
        }
      }
      await smokeExecutable(stagedExecutable);
    } finally {
      await nodeFs.removePath(extracted, { recursive: true });
    }
    const manifestName = names.manifest;
    const archiveHash = manifest.archiveSha256;
    await nodeFs.writeText(
      join(stageDirectory, names.checksum),
      checksumText(archiveHash, names.archive),
    );
    await nodeFs.writeText(
      join(stageDirectory, manifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const manifestOnDisk = validateManifest(
      JSON.parse(await nodeFs.readText(join(stageDirectory, manifestName))),
    );
    const checksumOnDisk = parseChecksum(
      await nodeFs.readText(join(stageDirectory, names.checksum)),
      names.archive,
    );
    if (
      manifestOnDisk.archiveSha256 !== archiveHash ||
      manifestOnDisk.executableSha256 !== executableHash ||
      checksumOnDisk !== archiveHash ||
      (await sha256File(archivePath)) !== archiveHash
    )
      throw new Error("Release package verification failed");

    try {
      const finalInfo = await nodeFs.lstat(finalDirectory);
      if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink()) {
        throw new Error(
          `Release output exists but is not a plain directory: ${finalDirectory}`,
        );
      }
      if (await sameExistingRelease(finalDirectory, manifest, manifestName)) {
        await nodeFs.removePath(stageDirectory, { recursive: true });
        console.log("Local release already exists and matches this build.");
        printReleaseSummary(finalDirectory, names.archive, manifest);
        return;
      }
      throw new Error(
        `Release output already exists with different contents: ${finalDirectory}. Review and remove it explicitly before retrying.`,
      );
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "ENOENT")) throw error;
    }
    await nodeFs.mkdir(releaseRoot, { recursive: true });
    await nodeFs.rename(stageDirectory, finalDirectory);
    printReleaseSummary(finalDirectory, names.archive, manifest);
  } finally {
    try {
      await nodeFs.removePath(stageDirectory, { recursive: true });
    } catch {
      /* Already renamed or removed. */
    }
  }
}

function printReleaseSummary(
  directory: string,
  filename: string,
  manifest: ReleaseManifest,
): void {
  console.log(`Version: ${manifest.version}`);
  console.log(`Target: ${manifest.target}`);
  console.log(`Source commit: ${manifest.commit}`);
  console.log(`Archive: ${join(directory, filename)}`);
  console.log(`Archive SHA-256: ${manifest.archiveSha256}`);
  console.log(`Executable SHA-256: ${manifest.executableSha256}`);
}

export function defaultInstallDestination(
  os: NodeJS.Platform | "windows" = process.platform,
  env: Record<string, string | undefined> = { ...process.env },
): string {
  if (os === "windows" || os === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set; pass --destination <path>");
    }
    return join(localAppData, "Programs", "acp-api", "acp-api.exe");
  }
  if (os === "linux" || os === "darwin") {
    const home = env.HOME;
    if (!home) throw new Error("HOME is not set; pass --destination <path>");
    return posix.join(home, ".local", "bin", "acp-api");
  }
  throw new Error(
    `Unsupported install platform '${os}'; supported targets are windows-x86_64, linux-x86_64, and macos-arm64`,
  );
}

async function readInstallManifest(
  directory: string,
): Promise<ReleaseManifest> {
  const suffix = `-${targetId()}.manifest.json`;
  const matches: string[] = [];
  for await (const entry of nodeFs.readDir(directory)) {
    if (
      entry.isFile() &&
      entry.name.startsWith("acp-api-") &&
      entry.name.endsWith(suffix)
    )
      matches.push(entry.name);
  }
  if (matches.length !== 1) {
    throw new Error(
      `Release directory must contain exactly one ${targetId()} manifest`,
    );
  }
  return validateReleaseManifest(
    JSON.parse(await nodeFs.readText(join(directory, matches[0]))),
  );
}

async function validateReleaseDirectory(
  directory: string,
  versionProbe: VersionProbe = probeVersion,
): Promise<{
  artifact: string;
  archivePath: string;
  temporaryDirectory: string;
  hash: string;
  manifest: ReleaseManifest;
}> {
  const manifest = await readInstallManifest(directory);
  const target = targetId();
  if (manifest.target !== target) {
    throw new Error(
      `Release target '${manifest.target}' does not match this host '${target}'`,
    );
  }
  const names = releaseNames(manifest.version, target);
  if (manifest.archive !== names.archive) {
    throw new Error("Release archive name does not match its manifest");
  }
  const archivePath = join(directory, names.archive);
  const info = await nodeFs.lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Release archive is not a regular file: ${archivePath}`);
  }
  const expectedHash = parseChecksum(
    await nodeFs.readText(join(directory, names.checksum)),
    names.archive,
  );
  const actualHash = await sha256File(archivePath);
  if (manifest.archiveSha256 !== expectedHash || actualHash !== expectedHash) {
    throw new Error(
      `Release SHA-256 verification failed for '${names.archive}'`,
    );
  }
  const temporaryDirectory = await nodeFs.makeTempDir({
    prefix: "acp-api-install-package-",
  });
  try {
    await extractReleaseArchive(archivePath, target, temporaryDirectory);
    const artifact = join(temporaryDirectory, names.executable);
    const embedded = validatePackageManifest(
      JSON.parse(
        await nodeFs.readText(join(temporaryDirectory, "manifest.json")),
      ),
    );
    if (
      embedded.product !== manifest.product ||
      embedded.version !== manifest.version ||
      embedded.target !== manifest.target ||
      embedded.commit !== manifest.commit ||
      embedded.executable !== manifest.executable ||
      embedded.executableSha256 !== manifest.executableSha256
    ) {
      throw new Error(
        "Embedded package manifest does not match release metadata",
      );
    }
    const executableHash = await sha256File(artifact);
    if (executableHash !== manifest.executableSha256) {
      throw new Error(
        "Packaged executable SHA-256 does not match its manifest",
      );
    }
    const version = await versionProbe(artifact, temporaryDirectory);
    if (version !== `acp-api ${manifest.version}`) {
      throw new Error(
        "Packaged executable version does not match its manifest",
      );
    }
    return {
      artifact,
      archivePath,
      temporaryDirectory,
      hash: executableHash,
      manifest,
    };
  } catch (error) {
    await nodeFs.removePath(temporaryDirectory, { recursive: true });
    throw error;
  }
}

export async function installRelease(
  releaseDirectory: string,
  destination: string,
  versionProbe: VersionProbe = probeVersion,
): Promise<{ hash: string; version: string; destination: string }> {
  const release = await validateReleaseDirectory(
    resolve(releaseDirectory),
    versionProbe,
  );
  try {
    const resolvedDestination = resolve(destination);
    if (
      windows
        ? resolvedDestination.toLowerCase() ===
          release.archivePath.toLowerCase()
        : resolvedDestination === release.archivePath
    ) {
      throw new Error(
        "Install destination must differ from the release archive",
      );
    }
    const parent = dirname(resolvedDestination);
    await nodeFs.mkdir(parent, { recursive: true });
    try {
      const info = await nodeFs.lstat(resolvedDestination);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(
          `Install destination is not a regular file: ${resolvedDestination}`,
        );
      }
    } catch (error) {
      if (!nodeFs.isErrorCode(error, "ENOENT")) throw error;
    }

    const staged = join(
      parent,
      `.${executableName.replace(
        /\.exe$/i,
        "",
      )}.install-${crypto.randomUUID()}${windows ? ".exe" : ""}`,
    );
    try {
      await nodeFs.copyFile(release.artifact, staged);
      if (!windows) await nodeFs.chmod(staged, 0o755);
      if ((await sha256File(staged)) !== release.hash) {
        throw new Error("Staged install copy failed SHA-256 verification");
      }
      const stagedVersion = await versionProbe(staged, parent);
      if (stagedVersion !== `acp-api ${release.manifest.version}`) {
        throw new Error("Staged install copy reports an unexpected version");
      }
      try {
        await nodeFs.rename(staged, resolvedDestination);
      } catch (error) {
        throw new Error(
          `Could not replace '${resolvedDestination}'. Close programs using acp-api and retry. ${String(
            error,
          )}`,
        );
      }
      const installedHash = await sha256File(resolvedDestination);
      if (installedHash !== release.hash) {
        throw new Error(
          "Installed executable SHA-256 differs from release artifact",
        );
      }
      const versionText = await versionProbe(resolvedDestination, parent);
      if (versionText !== `acp-api ${release.manifest.version}`) {
        throw new Error("Installed executable version verification failed");
      }
      return {
        hash: installedHash,
        version: versionText,
        destination: resolvedDestination,
      };
    } finally {
      try {
        await nodeFs.removePath(staged);
      } catch {
        /* Renamed or already removed. */
      }
    }
  } finally {
    await nodeFs.removePath(release.temporaryDirectory, { recursive: true });
  }
}

export function installDirectoryOnPath(
  destination: string,
  pathValue: string,
  os: NodeJS.Platform | "windows" = process.platform,
): boolean {
  const windowsPlatform = os === "windows" || os === "win32";
  const pathApi = windowsPlatform ? win32 : posix;
  const separator = windowsPlatform ? ";" : ":";
  const normalize = (path: string) => {
    const resolved = pathApi.resolve(path);
    return windowsPlatform ? resolved.toLowerCase() : resolved;
  };
  const installDirectory = normalize(pathApi.dirname(destination));
  return pathValue
    .split(separator)
    .filter(Boolean)
    .map(normalize)
    .includes(installDirectory);
}

function warnIfInstallDirectoryNotOnPath(destination: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const installDirectory = posix.resolve(posix.dirname(destination));
  if (!installDirectoryOnPath(destination, process.env.PATH ?? "")) {
    console.error(
      `Install directory '${installDirectory}' is not on PATH. Add it to your shell PATH to run acp-api by name.`,
    );
  }
}

function parseOptions(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name !== "--release-dir" && name !== "--destination") {
      throw new Error(`Unknown install option: ${name}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(name)) {
      throw new Error(`${name} requires one non-empty value`);
    }
    values.set(name, value);
  }
  return values;
}

async function main(args: string[]): Promise<void> {
  const [command = "package", ...rest] = args;
  if (command === "--help" || command === "-h") {
    console.log(
      [
        "Usage:",
        "  npm run release",
        "  npm run install-release -- --release-dir <path> [--destination <executable-path>]",
        "",
        "release builds and validates the native Windows x86_64, Linux x86_64, or macOS ARM64 executable,",
        "then packages it with project and third-party licenses, archive checksum,",
        "and manifest. install consumes the archive/checksum/manifest directory.",
      ].join("\n"),
    );
    return;
  }
  if (command === "package") {
    if (rest.length) throw new Error("release package takes no options");
    await packageRelease();
    return;
  }
  if (command === "install") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      console.log(
        "Usage: npm run install-release -- --release-dir <path> [--destination <executable-path>]",
      );
      return;
    }
    const options = parseOptions(rest);
    const releaseDirectory = options.get("--release-dir");
    if (!releaseDirectory) {
      throw new Error("install requires --release-dir <path>");
    }
    const destination =
      options.get("--destination") ?? defaultInstallDestination();
    const installed = await installRelease(releaseDirectory, destination);
    console.log(`Version: ${installed.version.slice("acp-api ".length)}`);
    console.log(`Install destination: ${installed.destination}`);
    console.log(`Installed SHA-256: ${installed.hash}`);
    console.log(`Installed version: ${installed.version}`);
    warnIfInstallDirectoryNotOnPath(installed.destination);
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Local release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
