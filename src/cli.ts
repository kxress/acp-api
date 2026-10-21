import { loadOpenAiConfig } from "./openai/config.ts";
import { startOpenAiServer } from "./openai/server.ts";
import { diagnoseConfig, formatDoctorReport } from "./doctor.ts";
import { VERSION } from "./version.ts";

export const HELP_TEXT = `Usage:
  acp-api --config <path>
  acp-api doctor --config <path> [--json]
  acp-api --help
  acp-api --version

Options:
  --config <path>  Load the OpenAI proxy configuration
  doctor           Check configuration and configured agent executables offline
  --json           Print doctor results as JSON
  --help           Show this help
  --version        Show the product version`;

export type CliCommand =
  | { kind: "serve"; configPath: string }
  | { kind: "doctor"; configPath: string; json: boolean }
  | { kind: "help" }
  | { kind: "version" };

export function parseCliArgs(args: string[]): CliCommand {
  if (args[0] === "doctor") {
    let configPath: string | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--config") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("doctor --config requires one non-empty path");
        }
        if (configPath !== undefined) {
          throw new Error("doctor accepts --config only once");
        }
        configPath = value;
        index += 1;
      } else if (argument === "--json") {
        if (json) throw new Error("doctor accepts --json only once");
        json = true;
      } else {
        throw new Error(`Unknown doctor option: ${argument}`);
      }
    }
    if (!configPath) throw new Error("doctor requires --config <path>");
    return { kind: "doctor", configPath, json };
  }
  if (args.length === 0 || args[0] === "--config") {
    if (
      args.length !== 2 ||
      args[0] !== "--config" ||
      !args[1] ||
      args[1].startsWith("--")
    ) {
      throw new Error("--config requires one non-empty path");
    }
    return { kind: "serve", configPath: args[1] };
  }
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  throw new Error(`Unknown command or option: ${args[0] ?? ""}`);
}

export async function runCli(args: string[]): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(args);
  } catch (error) {
    console.error(
      `acp-api: ${error instanceof Error ? error.message : String(error)}\n${HELP_TEXT}`,
    );
    return 2;
  }
  if (command.kind === "help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (command.kind === "version") {
    console.log(`acp-api ${VERSION}`);
    return 0;
  }
  if (command.kind === "doctor") {
    const report = await diagnoseConfig(command.configPath);
    console.log(
      command.json
        ? JSON.stringify(report, null, 2)
        : formatDoctorReport(report),
    );
    return report.ok ? 0 : 1;
  }
  try {
    await startOpenAiServer(await loadOpenAiConfig(command.configPath));
    return 0;
  } catch (error) {
    console.error(
      `acp-api: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
