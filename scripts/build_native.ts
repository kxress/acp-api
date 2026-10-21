import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindowsTarget, targetId } from "./release_target.ts";

const major = Number(process.versions.node.split(".")[0]);
if (major < 26) {
  throw new Error(
    `Native builds require Node.js 26 or newer; found ${process.versions.node}`,
  );
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const target = targetId();
const expected = process.env.ACPAPI_EXPECTED_RELEASE_TARGET;
if (expected && expected !== target) {
  throw new Error(
    `Native target '${target}' does not match expected release target '${expected}'`,
  );
}
const executableName = isWindowsTarget(target) ? "acp-api.exe" : "acp-api";
const outputPath = join(projectRoot, "dist", executableName);
const bundlePath = join(projectRoot, "dist", "acp-api.mjs");
const configPath = join(projectRoot, "dist", "sea-config.json");

await nodeFs.mkdir(join(projectRoot, "dist"), { recursive: true });
const bundleInfo = await nodeFs.stat(bundlePath).catch(() => undefined);
if (!bundleInfo?.isFile()) {
  throw new Error("Missing dist/acp-api.mjs; run npm run build first");
}
await nodeFs.writeText(
  configPath,
  `${JSON.stringify({
    main: bundlePath,
    mainFormat: "module",
    output: outputPath,
    disableExperimentalSEAWarning: true,
  })}\n`,
);
const command = await new ProcessCommand(process.execPath, {
  args: ["--build-sea", configPath],
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const status = await command.status;
await nodeFs.removePath(configPath).catch(() => undefined);
if (!status.success) process.exit(status.code || 1);
