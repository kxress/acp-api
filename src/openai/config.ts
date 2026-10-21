import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentDefinition, AgentMap } from "../agents/types.ts";
import type { PermissionPolicy } from "../sessions/manager.ts";

export type OpenAiRoutingStrategy =
  | "sticky_failover"
  | "primary_failover"
  | "round_robin"
  | "least_busy";

export interface OpenAiModelSelection {
  configId?: string;
  values: Record<string, string>;
  required: boolean;
}

export interface OpenAiAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  models: string[];
  permissionPolicy: PermissionPolicy;
  modelSelection?: OpenAiModelSelection;
  definition: AgentDefinition;
}

export interface OpenAiProxyConfig {
  path: string;
  host: string;
  port: number;
  apiKey: string;
  routingStrategy: OpenAiRoutingStrategy;
  maxRetries: number;
  failureCooldownMs: number;
  retryBackoffMs: number;
  maxSessions: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  agents: OpenAiAgentConfig[];
}

const DEFAULT_CONFIG = {
  server: {
    host: "127.0.0.1",
    port: 11435,
    api_key: "",
    routing_strategy: "sticky_failover",
    max_retries: 1,
    failure_cooldown_seconds: 60,
    retry_backoff_seconds: 0,
    max_sessions: 32,
    max_body_bytes: 16 * 1024 * 1024,
    request_timeout_ms: 5 * 60 * 1000,
  },
  agents: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function intRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function expandEnvironment(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\{(?:var|env):([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (
      _match,
      braced: string,
      bracedFallback: string,
      bare: string,
      token: string,
      tokenFallback: string,
    ) => {
      const name = braced ?? bare ?? token;
      const fallback = bracedFallback ?? tokenFallback;
      const found = process.env[name];
      return found === undefined || (found === "" && fallback !== undefined)
        ? (fallback ?? "")
        : found;
    },
  );
}

async function expandValue(value: string, path: string): Promise<string> {
  const matches = [...value.matchAll(/\{file:([^}]+)\}/g)];
  let protectedValue = value;
  const secrets: Array<{ token: string; value: string }> = [];
  for (const [index, match] of matches.entries()) {
    const source = match[1].trim();
    const withEnv = expandEnvironment(source).replace(
      /%([^%]+)%/g,
      (_m, name: string) => process.env[name] ?? `%${name}%`,
    );
    const home =
      process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"];
    const withHome =
      withEnv.startsWith("~/") && home ? `${home}${withEnv.slice(1)}` : withEnv;
    if (!isAbsolute(withHome)) {
      throw new Error(
        `Config file '${path}': secret file path must be absolute`,
      );
    }
    let secret: string;
    try {
      secret = await readFile(withHome, "utf8");
    } catch {
      throw new Error(
        `Config file '${path}': cannot read secret file '${withHome}'`,
      );
    }
    const token = `__ACP_PROXY_SECRET_${index}_${randomUUID()}__`;
    protectedValue = protectedValue.replace(match[0], token);
    secrets.push({ token, value: secret.replace(/\r?\n$/, "") });
  }
  let expanded = expandEnvironment(protectedValue);
  for (const secret of secrets)
    expanded = expanded.replace(secret.token, secret.value);
  return expanded;
}

function modelList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of model ids`);
  }
  const models = value.map((item, index) =>
    nonEmptyString(item, `${field}[${index}]`),
  );
  if (new Set(models).size !== models.length) {
    throw new Error(`${field} cannot contain duplicate model ids`);
  }
  return models;
}

function parseModelSelection(
  value: unknown,
  field: string,
): OpenAiModelSelection | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return { values: {}, required: true };
  if (!isRecord(value)) throw new Error(`${field} must be true or an object`);
  const values = value.values ?? {};
  if (!isRecord(values)) throw new Error(`${field}.values must be an object`);
  const mapped: Record<string, string> = {};
  for (const [model, raw] of Object.entries(values)) {
    mapped[nonEmptyString(model, `${field}.values key`)] = nonEmptyString(
      raw,
      `${field}.values.${model}`,
    );
  }
  return {
    configId:
      value.config_id === undefined && value.configId === undefined
        ? undefined
        : nonEmptyString(
            value.config_id ?? value.configId,
            `${field}.config_id`,
          ),
    values: mapped,
    required:
      value.required === undefined
        ? true
        : typeof value.required === "boolean"
          ? value.required
          : (() => {
              throw new Error(`${field}.required must be a boolean`);
            })(),
  };
}

function parsePermission(value: unknown, field: string): PermissionPolicy {
  if (value === undefined || value === "deny") return "deny_all";
  if (value === "allow") return "allow_all";
  if (value === "read_only") return "read_only";
  throw new Error(`${field} must be 'deny', 'read_only', or 'allow'`);
}

function parseRoutingStrategy(value: unknown): OpenAiRoutingStrategy {
  if (value === undefined)
    return DEFAULT_CONFIG.server.routing_strategy as OpenAiRoutingStrategy;
  if (
    [
      "sticky_failover",
      "primary_failover",
      "round_robin",
      "least_busy",
    ].includes(String(value))
  ) {
    return value as OpenAiRoutingStrategy;
  }
  throw new Error(
    "server.routing_strategy must be sticky_failover, primary_failover, round_robin, or least_busy",
  );
}

export async function parseOpenAiConfig(
  raw: unknown,
  path: string,
): Promise<OpenAiProxyConfig> {
  if (!isRecord(raw))
    throw new Error(`Config file '${path}' must contain a JSON object`);
  const server = raw.server === undefined ? DEFAULT_CONFIG.server : raw.server;
  if (!isRecord(server))
    throw new Error(`Config file '${path}': server must be an object`);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`Config file '${path}': agents must be a non-empty array`);
  }
  if (raw.agents.length > 1_024) {
    throw new Error(
      `Config file '${path}': agents cannot contain more than 1024 runtimes`,
    );
  }

  const agents: OpenAiAgentConfig[] = [];
  const ids = new Set<string>();
  const configDirectory = dirname(resolve(path));

  for (const [index, rawAgent] of raw.agents.entries()) {
    const field = `agents[${index}]`;
    if (!isRecord(rawAgent))
      throw new Error(`Config file '${path}': ${field} must be an object`);
    const name = nonEmptyString(rawAgent.name, `${field}.name`);
    const id = nonEmptyString(
      rawAgent.instance_id ?? rawAgent.instanceId ?? name,
      `${field}.instance_id`,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(
        `Config file '${path}': ${field}.instance_id contains unsupported characters`,
      );
    }
    if (ids.has(id))
      throw new Error(
        `Config file '${path}': duplicate agent instance id '${id}'`,
      );
    ids.add(id);
    const command = nonEmptyString(rawAgent.command, `${field}.command`);
    const rawArgs = rawAgent.args ?? [];
    if (
      !Array.isArray(rawArgs) ||
      !rawArgs.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Config file '${path}': ${field}.args must be an array of strings`,
      );
    }
    const env: Record<string, string> = {};
    if (rawAgent.env !== undefined) {
      if (!isRecord(rawAgent.env))
        throw new Error(
          `Config file '${path}': ${field}.env must be an object`,
        );
      for (const [key, item] of Object.entries(rawAgent.env)) {
        if (typeof item !== "string")
          throw new Error(
            `Config file '${path}': ${field}.env.${key} must be a string`,
          );
        env[key] = await expandValue(item, path);
      }
    }
    const rawCwd = typeof rawAgent.cwd === "string" ? rawAgent.cwd : ".";
    const cwdValue = await expandValue(rawCwd, path);
    const cwd = isAbsolute(cwdValue)
      ? cwdValue
      : resolve(configDirectory, cwdValue);
    const models = modelList(rawAgent.models, `${field}.models`);
    const modelSelection = parseModelSelection(
      rawAgent.model_selection ?? rawAgent.modelSelection,
      `${field}.model_selection`,
    );
    const modelConfigId =
      modelSelection?.configId ?? (modelSelection ? "model" : undefined);
    const permissionPolicy = parsePermission(
      rawAgent.permission,
      `${field}.permission`,
    );
    const acpProtocol = rawAgent.acpProtocol ?? rawAgent.acp_protocol ?? "v1";
    if (acpProtocol !== "v1" && acpProtocol !== "v2") {
      throw new Error(
        `Config file '${path}': ${field}.acp_protocol must be 'v1' or 'v2'`,
      );
    }
    const definition: AgentDefinition = {
      command,
      args: [...rawArgs] as string[],
      env,
      displayName: name,
      modelConfigId,
      acpProtocol,
    };
    agents.push({
      id,
      name,
      command,
      args: [...rawArgs] as string[],
      cwd,
      env,
      models,
      permissionPolicy,
      modelSelection,
      definition,
    });
  }

  const rawApiKey = server.api_key ?? server.apiKey ?? "";
  if (typeof rawApiKey !== "string")
    throw new Error("server.api_key must be a string");
  const apiKey = await expandValue(rawApiKey, path);
  const port = intRange(
    server.port,
    "server.port",
    1,
    65_535,
    DEFAULT_CONFIG.server.port,
  );
  const maxRetries = intRange(
    server.max_retries ?? server.maxRetries,
    "server.max_retries",
    0,
    32,
    1,
  );
  const failureCooldownMs =
    intRange(
      server.failure_cooldown_seconds ?? server.failureCooldownSeconds,
      "server.failure_cooldown_seconds",
      0,
      3_600,
      DEFAULT_CONFIG.server.failure_cooldown_seconds,
    ) * 1_000;
  const retryBackoffMs =
    intRange(
      server.retry_backoff_seconds ?? server.retryBackoffSeconds,
      "server.retry_backoff_seconds",
      0,
      300,
      DEFAULT_CONFIG.server.retry_backoff_seconds,
    ) * 1_000;
  const maxSessions = intRange(
    server.max_sessions ?? server.maxSessions,
    "server.max_sessions",
    agents.length,
    1_024,
    Math.max(32, agents.length),
  );
  const maxBodyBytes = intRange(
    server.max_body_bytes ?? server.maxBodyBytes,
    "server.max_body_bytes",
    1_024,
    64 * 1024 * 1024,
    DEFAULT_CONFIG.server.max_body_bytes,
  );
  const requestTimeoutMs = intRange(
    server.request_timeout_ms ?? server.requestTimeoutMs,
    "server.request_timeout_ms",
    1_000,
    60 * 60 * 1000,
    DEFAULT_CONFIG.server.request_timeout_ms,
  );

  const host = nonEmptyString(
    server.host ?? DEFAULT_CONFIG.server.host,
    "server.host",
  );
  const effectiveApiKey = process.env["ACP_OPENAI_PROXY_API_KEY"] ?? apiKey;
  if (
    !effectiveApiKey &&
    host !== "localhost" &&
    host !== "::1" &&
    !/^127\./.test(host)
  ) {
    throw new Error(
      "server.api_key is required when binding the proxy to a non-loopback host",
    );
  }

  return {
    path: resolve(path),
    host,
    port,
    apiKey: effectiveApiKey,
    routingStrategy: parseRoutingStrategy(
      server.routing_strategy ?? server.routingStrategy,
    ),
    maxRetries,
    failureCooldownMs,
    retryBackoffMs,
    maxSessions,
    maxBodyBytes,
    requestTimeoutMs,
    agents,
  };
}

export async function loadOpenAiConfig(
  path: string,
): Promise<OpenAiProxyConfig> {
  const absolute = isAbsolute(path) ? path : resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Config file '${absolute}' is not valid JSON`);
    throw new Error(
      `Could not read config file '${absolute}': ${String(error)}`,
    );
  }
  return await parseOpenAiConfig(raw, absolute);
}

export function agentMap(config: OpenAiProxyConfig): AgentMap {
  return Object.assign(
    Object.create(null) as AgentMap,
    Object.fromEntries(
      config.agents.map((agent) => [agent.id, agent.definition]),
    ),
  );
}
