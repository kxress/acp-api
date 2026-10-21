import process from "node:process";
import { build } from "esbuild";
import * as nodeFs from "#fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(projectRoot, "dist");

await nodeFs.mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(projectRoot, "src", "main.ts")],
  outfile: join(outputDirectory, "acp-api.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

if (!process.versions.node) throw new Error("Node.js runtime is required");
