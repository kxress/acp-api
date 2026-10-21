import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPython = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const python = existsSync(localPython)
  ? localPython
  : process.platform === "win32"
    ? "python"
    : "python3";
const result = spawnSync(
  python,
  [path.join(root, "tests", "langchain_integration.py")],
  { cwd: root, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
