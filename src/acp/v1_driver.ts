import {
  client,
  type ClientConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { AgentDefinition } from "../agents/types.ts";
import type { startAgent } from "../runtime/process.ts";
import { interceptSessionUpdates } from "./session_update_stream.ts";
import type {
  AcpPermissionRequest,
  AcpPromptBlock,
  NormalizedAcpUpdate,
  ProtocolCallbacks,
  ProtocolDriver,
  ProtocolInitialization,
  ProtocolSessionInfo,
} from "./protocol.ts";

export class V1Driver implements ProtocolDriver {
  readonly definition: AgentDefinition;
  readonly process: Awaited<ReturnType<typeof startAgent>>;
  readonly protocol = "v1" as const;
  private readonly app = client({ name: "acp-api" });
  private readonly connection: ClientConnection;
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
    const stream = interceptSessionUpdates(
      ndJsonStream(process.child.stdin, process.child.stdout),
      (params) => callbacks.update(normalizeUpdate(params)),
    );
    this.connection = this.app.connect(stream);
  }

  async initialize(): Promise<ProtocolInitialization> {
    const response = await this.connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        session: { configOptions: { boolean: {} } },
      },
    });
    if (response.protocolVersion !== 1) {
      throw new Error(`ACP version mismatch: ${response.protocolVersion}`);
    }
    this.initialized = {
      capabilities: response.agentCapabilities ?? {},
      authMethods: response.authMethods ?? [],
    };
    return this.initialized;
  }

  async newSession(cwd: string): Promise<ProtocolSessionInfo> {
    const response = await this.connection.agent.request("session/new", {
      cwd,
      mcpServers: [],
    });
    return {
      sessionId: response.sessionId,
      capabilities: this.initialized?.capabilities ?? {},
      authMethods: this.initialized?.authMethods ?? [],
      configOptions: (response.configOptions ?? []) as Array<
        Record<string, unknown>
      >,
      modes: response.modes as Record<string, unknown> | undefined,
    };
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
  ): Promise<ProtocolSessionInfo> {
    const capabilities = this.initialized?.capabilities as
      | Record<string, unknown>
      | undefined;
    if (!capabilities?.loadSession) {
      throw new Error("Agent does not advertise session/load support");
    }
    const response = await this.connection.agent.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    return {
      sessionId,
      capabilities,
      authMethods: this.initialized?.authMethods ?? [],
      configOptions: (response.configOptions ?? []) as Array<
        Record<string, unknown>
      >,
      modes: response.modes as Record<string, unknown> | undefined,
    };
  }

  async prompt(
    sessionId: string,
    input: string | AcpPromptBlock[],
  ): Promise<string | undefined> {
    const prompt =
      typeof input === "string" ? [{ type: "text", text: input }] : input;
    const response = await this.connection.agent.request("session/prompt", {
      sessionId,
      prompt,
    } as never);
    return response.stopReason;
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
    const wireValue = configValue(value, option);
    const response = await this.connection.agent.request(
      "session/set_config_option",
      { sessionId, configId, ...wireValue },
    );
    return response.configOptions as Array<Record<string, unknown>>;
  }

  async setMode(
    sessionId: string,
    modeId: string,
    _configOptions: Array<Record<string, unknown>>,
    modes?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const available = modes?.availableModes as
      | Array<{ id?: unknown }>
      | undefined;
    if (!available?.length) {
      throw new Error("Agent did not advertise session modes");
    }
    if (!available.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown mode: ${modeId}`);
    }
    const response = await this.connection.agent.request("session/set_mode", {
      sessionId,
      modeId,
    });
    return response as Record<string, unknown>;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.connection.agent.request("session/close", { sessionId });
  }

  closeConnection(error?: unknown): void {
    this.connection.close(error);
  }
}

function configValue(
  value: string,
  option: Record<string, unknown> | undefined,
): { value: string } | { type: "boolean"; value: boolean } {
  if (option?.type !== "boolean") return { value };
  if (value !== "true" && value !== "false") {
    throw new Error(
      `Boolean config option '${String(option.id)}' must be 'true' or 'false'`,
    );
  }
  return { type: "boolean", value: value === "true" };
}

function normalizePermission(params: {
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
}): AcpPermissionRequest {
  return { ...params };
}

function normalizeUpdate(params: unknown): NormalizedAcpUpdate {
  const raw = params as {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      [key: string]: unknown;
    };
  };
  const update = raw.update;
  return {
    sessionId: raw.sessionId ?? "",
    kind: update?.sessionUpdate ?? "unknown",
    update,
    raw: params,
    ...(update?.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text"
      ? { text: { text: update.content.text ?? "", replace: false } }
      : {}),
  };
}
