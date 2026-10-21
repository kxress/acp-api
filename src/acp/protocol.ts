import type { AgentDefinition } from "../agents/types.ts";
import type { startAgent } from "../runtime/process.ts";

export type AcpProtocol = "v1" | "v2";

export interface NormalizedAcpUpdate {
  sessionId: string;
  kind: string;
  update: unknown;
  raw: unknown;
  text?: { messageId?: string; text: string; replace: boolean };
  stopReason?: string;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpPermissionRequest {
  sessionId: string;
  title?: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
}

export type AcpPermissionResponse = {
  outcome:
    | { outcome: "selected"; optionId: string }
    | {
        outcome: "cancelled";
      };
};

/** ACP prompt blocks accepted from API adapters. */
export type AcpPromptBlock = Record<string, unknown> & { type: string };

export interface ProtocolSessionInfo {
  sessionId: string;
  capabilities: unknown;
  authMethods: unknown;
  configOptions: Array<Record<string, unknown>>;
  modes?: Record<string, unknown>;
}

export interface ProtocolInitialization {
  capabilities: unknown;
  authMethods: unknown;
}

export interface ProtocolDriver {
  readonly protocol: AcpProtocol;
  readonly process: Awaited<ReturnType<typeof startAgent>>;
  initialize(): Promise<ProtocolInitialization>;
  newSession(cwd: string): Promise<ProtocolSessionInfo>;
  resumeSession(sessionId: string, cwd: string): Promise<ProtocolSessionInfo>;
  prompt(
    sessionId: string,
    prompt: string | AcpPromptBlock[],
  ): Promise<string | undefined>;
  cancel(sessionId: string): Promise<void>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
    option?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
  setMode(
    sessionId: string,
    modeId: string,
    configOptions: Array<Record<string, unknown>>,
    modes?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  closeSession(sessionId: string): Promise<void>;
  closeConnection(error?: unknown): void;
}

export type ProtocolCallbacks = {
  update: (update: NormalizedAcpUpdate) => void;
  permission: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;
};

export type ProtocolFactory = (
  protocol: AcpProtocol,
  definition: AgentDefinition,
  process: Awaited<ReturnType<typeof startAgent>>,
  callbacks: ProtocolCallbacks,
) => ProtocolDriver;
