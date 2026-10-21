import type { AgentModelPolicy } from "../models/policy.ts";

export interface AgentDefinition {
  command: string;
  args: string[];
  implementation?: string;
  acpProtocol?: "v1" | "v2";
  supportedProtocols?: Array<"v1" | "v2">;
  protocolEnv?: Partial<Record<"v1" | "v2", Record<string, string>>>;
  displayName?: string;
  installHint?: string;
  env?: Record<string, string>;
  modelConfigId?: string;
  models?: AgentModelPolicy;
  runtimePrerequisites?: Array<{
    command: string;
    minimumVersion?: string;
  }>;
  requiredExecutableEnv?: string[];
}

export type AgentMap = Record<string, AgentDefinition>;
