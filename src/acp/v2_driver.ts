import {
  client,
  type ClientConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentDefinition } from "../agents/types.ts";
import type { startAgent } from "../runtime/process.ts";
import { interceptV2SessionUpdates } from "./session_update_stream.ts";
import { VERSION } from "../version.ts";
import type {
  AcpPermissionRequest,
  AcpPromptBlock,
  NormalizedAcpUpdate,
  ProtocolCallbacks,
  ProtocolDriver,
  ProtocolInitialization,
  ProtocolSessionInfo,
} from "./protocol.ts";

type ActiveTurn = {
  running: boolean;
  finish: (stopReason?: string) => void;
};

export class V2Driver implements ProtocolDriver {
  readonly definition: AgentDefinition;
  readonly process: Awaited<ReturnType<typeof startAgent>>;
  readonly protocol = "v2" as const;
  private readonly app = client({ name: "acp-api" });
  private readonly connection: ClientConnection;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private initialized?: ProtocolInitialization;

  constructor(
    definition: AgentDefinition,
    process: Awaited<ReturnType<typeof startAgent>>,
    callbacks: ProtocolCallbacks,
  ) {
    this.definition = definition;
    this.process = process;
    this.app.onRequest("session/request_permission", ({ params }) =>
      callbacks.permission(normalizePermission(params)),
    );
    const stream = interceptV2SessionUpdates(
      ndJsonStream(process.child.stdin, process.child.stdout),
      (params) => this.receiveUpdate(params, callbacks),
    );
    this.connection = this.app.connect(stream);
  }

  private receiveUpdate(params: unknown, callbacks: ProtocolCallbacks): void {
    const normalized = normalizeUpdate(params);
    callbacks.update(normalized);
    const turn = this.activeTurns.get(normalized.sessionId);
    if (!turn || normalized.kind !== "state_update") return;
    const state = (normalized.update as { state?: string }).state;
    if (state === "running") turn.running = true;
    else if (state === "idle" && turn.running) {
      turn.finish(normalized.stopReason);
      this.activeTurns.delete(normalized.sessionId);
    }
  }

  async initialize(): Promise<ProtocolInitialization> {
    let response: {
      protocolVersion: number;
      capabilities?: unknown;
      authMethods?: unknown[];
    };
    try {
      response = await this.connection.agent.request("initialize", {
        protocolVersion: 2,
        info: { name: "acp-api", version: VERSION },
        capabilities: {},
      });
    } catch (error) {
      throw new Error(
        `ACP v2 required; initialize failed or returned an incompatible protocol response: ${String(
          error,
        )}`,
      );
    }
    if (response.protocolVersion !== 2) {
      throw new Error(
        `ACP v2 required but agent negotiated v${response.protocolVersion}`,
      );
    }
    this.initialized = {
      capabilities: response.capabilities ?? {},
      authMethods: response.authMethods ?? [],
    };
    return this.initialized;
  }

  async newSession(cwd: string): Promise<ProtocolSessionInfo> {
    const response = await this.connection.agent.request("session/new", {
      cwd,
    });
    const configOptions = normalizeConfigOptions(response.configOptions ?? []);
    return {
      sessionId: response.sessionId,
      capabilities: this.initialized?.capabilities ?? {},
      authMethods: this.initialized?.authMethods ?? [],
      configOptions,
      modes: modesFromOptions(configOptions),
    };
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
  ): Promise<ProtocolSessionInfo> {
    const capabilities = this.initialized?.capabilities as
      | Record<string, unknown>
      | undefined;
    if (!capabilities?.session) {
      throw new Error("Agent does not advertise ACP v2 session support");
    }
    const response = await this.connection.agent.request("session/resume", {
      sessionId,
      cwd,
      replayFrom: { type: "start" },
    });
    const configOptions = normalizeConfigOptions(response.configOptions ?? []);
    return {
      sessionId,
      capabilities,
      authMethods: this.initialized?.authMethods ?? [],
      configOptions,
      modes: modesFromOptions(configOptions),
    };
  }

  async prompt(
    sessionId: string,
    input: string | AcpPromptBlock[],
  ): Promise<string | undefined> {
    if (this.activeTurns.has(sessionId)) {
      throw new Error("A v2 prompt turn is already active for this session");
    }
    let finish!: (stopReason?: string) => void;
    const stopped = new Promise<string | undefined>((resolve) => {
      finish = resolve;
    });
    const turn: ActiveTurn = { running: false, finish };
    this.activeTurns.set(sessionId, turn);
    try {
      await this.connection.agent.request("session/prompt", {
        sessionId,
        prompt:
          typeof input === "string" ? [{ type: "text", text: input }] : input,
      } as never);
      return await stopped;
    } catch (error) {
      this.activeTurns.delete(sessionId);
      throw error;
    }
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify("session/cancel", { sessionId });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
    option?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    let typedValue: string | boolean = value;
    let type: "id" | "boolean" = "id";
    if (option?.type === "boolean") {
      if (value !== "true" && value !== "false") {
        throw new Error(
          `Boolean config option '${String(
            option.id,
          )}' must be 'true' or 'false'`,
        );
      }
      type = "boolean";
      typedValue = value === "true";
    }
    const response = await this.connection.agent.request(
      "session/set_config_option",
      { sessionId, configId, type, value: typedValue } as never,
    );
    return normalizeConfigOptions(response.configOptions);
  }

  async setMode(
    sessionId: string,
    modeId: string,
    configOptions: Array<Record<string, unknown>>,
    _modes?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const option = configOptions.find((item) => item.category === "mode");
    if (!option) {
      throw new Error(
        "ACP v2 does not have session/set_mode and no mode config was advertised",
      );
    }
    const values = flattenOptions(option.options);
    if (values.length && !values.some((item) => item.value === modeId)) {
      throw new Error(`Unknown mode: ${modeId}`);
    }
    const updated = await this.setConfigOption(
      sessionId,
      String(option.id),
      modeId,
      option,
    );
    return modesFromOptions(updated);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.connection.agent.request("session/close", { sessionId });
  }

  closeConnection(error?: unknown): void {
    for (const turn of this.activeTurns.values()) turn.finish("cancelled");
    this.activeTurns.clear();
    this.connection.close(error);
  }
}

function normalizePermission(params: {
  sessionId: string;
  title: string;
  description?: string | null;
  subject?: Record<string, unknown> | null;
  options: Array<{ optionId: string; kind: string; name: string }>;
}): AcpPermissionRequest {
  const subject = params.subject;
  const toolCall =
    subject?.type === "tool_call"
      ? subject.toolCall
      : subject?.type === "command"
        ? { kind: "execute", ...subject }
        : { kind: "other", ...(subject ?? {}) };
  return {
    sessionId: params.sessionId,
    title: params.title,
    toolCall,
    options: params.options,
  };
}

function normalizeUpdate(value: unknown): NormalizedAcpUpdate {
  const params =
    value && typeof value === "object"
      ? (value as { sessionId?: unknown; update?: unknown })
      : {};
  const update =
    params.update && typeof params.update === "object"
      ? (params.update as Record<string, unknown>)
      : {};
  const kind =
    typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown";
  let text: NormalizedAcpUpdate["text"];
  if (kind === "agent_message_chunk") {
    const content = update.content as { type?: string; text?: string };
    if (content?.type === "text") {
      text = {
        messageId:
          typeof update.messageId === "string" ? update.messageId : undefined,
        text: content.text ?? "",
        replace: false,
      };
    }
  } else if (kind === "agent_message") {
    const content = Array.isArray(update.content) ? update.content : [];
    const messageText = content
      .flatMap((item) => {
        const block = item as { type?: string; text?: string };
        return block.type === "text" ? [block.text ?? ""] : [];
      })
      .join("");
    text = {
      messageId:
        typeof update.messageId === "string" ? update.messageId : undefined,
      text: messageText,
      replace: true,
    };
  }
  const state =
    kind === "state_update" ? (update as { state?: string }).state : undefined;
  return {
    sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
    kind,
    update,
    raw: params,
    ...(text ? { text } : {}),
    ...(state === "idle" && typeof update.stopReason === "string"
      ? { stopReason: update.stopReason }
      : {}),
    ...(state === "idle" && update.stopReason === "error"
      ? {
          error:
            update.error && typeof update.error === "object"
              ? (update.error as NormalizedAcpUpdate["error"])
              : { message: "ACP v2 prompt failed" },
        }
      : {}),
  };
}

function normalizeConfigOptions(
  options: unknown[],
): Array<Record<string, unknown>> {
  return options.map((option) => {
    const value = option as Record<string, unknown>;
    return {
      ...value,
      id: value.configId,
      ...(value.type === "id" ? { type: "select" } : {}),
    };
  });
}

function flattenOptions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    return Array.isArray(entry.options)
      ? (entry.options as Array<Record<string, unknown>>)
      : [entry];
  });
}

function modesFromOptions(
  options: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const mode = options.find((option) => option.category === "mode");
  if (!mode) return undefined;
  return {
    currentModeId: mode.currentValue,
    availableModes: flattenOptions(mode.options).map((option) => ({
      id: option.value,
      name: option.name,
      description: option.description,
    })),
  };
}
