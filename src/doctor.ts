import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import * as nodeFs from "#fs";
import { findExecutablePath } from "./runtime/process.ts";
import {
  loadOpenAiConfig,
  type OpenAiAgentConfig,
  type OpenAiProxyConfig,
} from "./openai/config.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "error";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  config: string;
  checks: DoctorCheck[];
}

function check(
  name: string,
  status: DoctorCheck["status"],
  message: string,
): DoctorCheck {
  return { name, status, message };
}

function configuredPath(agent: OpenAiAgentConfig): string {
  const configured = Object.entries(agent.env).find(([name]) =>
    process.platform === "win32"
      ? name.toLowerCase() === "path"
      : name === "PATH",
  );
  return configured?.[1] ?? process.env.PATH ?? "";
}

function commandForLookup(agent: OpenAiAgentConfig): string {
  if (!agent.command.includes("/") && !agent.command.includes("\\")) {
    return agent.command;
  }
  return isAbsolute(agent.command)
    ? agent.command
    : resolve(agent.cwd, agent.command);
}

async function checkAgent(agent: OpenAiAgentConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const info = await nodeFs.stat(agent.cwd);
    if (!info.isDirectory()) {
      checks.push(
        check(
          `agent ${agent.id} working directory`,
          "error",
          `not a directory: ${agent.cwd}`,
        ),
      );
    } else {
      checks.push(
        check(`agent ${agent.id} working directory`, "ok", agent.cwd),
      );
    }
  } catch {
    checks.push(
      check(
        `agent ${agent.id} working directory`,
        "error",
        `not accessible: ${agent.cwd}`,
      ),
    );
  }

  const command = commandForLookup(agent);
  const executable = await findExecutablePath(command, configuredPath(agent));
  checks.push(
    executable
      ? check(
          `agent ${agent.id} command`,
          "ok",
          `${agent.command} resolves to ${executable}`,
        )
      : check(
          `agent ${agent.id} command`,
          "error",
          `executable not found: ${agent.command}`,
        ),
  );
  return checks;
}

export async function diagnoseConfig(
  configPath: string,
): Promise<DoctorReport> {
  let config: OpenAiProxyConfig;
  try {
    config = await loadOpenAiConfig(configPath);
  } catch (error) {
    const absolutePath = resolve(configPath);
    return {
      ok: false,
      config: absolutePath,
      checks: [
        check(
          "configuration",
          "error",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }

  const isLoopback =
    config.host.toLowerCase() === "localhost" ||
    config.host === "::1" ||
    config.host === "[::1]" ||
    /^127\./.test(config.host);
  const checks: DoctorCheck[] = [
    check(
      "configuration",
      "ok",
      `${config.agents.length} ACP agent${config.agents.length === 1 ? "" : "s"} configured`,
    ),
    check(
      "listener",
      "ok",
      `${config.host}:${config.port}; ${isLoopback ? "loopback binding" : "API key configured for non-loopback binding"}`,
    ),
  ];

  for (const agent of config.agents) {
    checks.push(...(await checkAgent(agent)));
  }

  return {
    ok: checks.every((item) => item.status === "ok"),
    config: config.path,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `acp-api doctor: ${report.ok ? "PASS" : "FAILED"}`,
    `Config: ${report.config}`,
  ];
  for (const item of report.checks) {
    lines.push(
      `[${item.status === "ok" ? "OK" : "FAIL"}] ${item.name}: ${item.message}`,
    );
  }
  lines.push("No ACP agents were started and no model requests were sent.");
  return lines.join("\n");
}
