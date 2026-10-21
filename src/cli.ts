import { loadOpenAiConfig } from "./openai/config.ts";
import { startOpenAiServer } from "./openai/server.ts";
import { VERSION } from "./version.ts";

export const HELP_TEXT = `Usage:
  acp-api --config <path>
  acp-api --help
  acp-api --version

Options:
  --config <path>  Load the OpenAI proxy configuration
  --help           Show this help
  --version        Show the product version`;

export type CliCommand =
  | { kind: "serve"; configPath: string }
  | { kind: "help" }
  | { kind: "version" };

export function parseCliArgs(args: string[]): CliCommand {
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
