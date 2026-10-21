import type { AgentDefinition } from "../agents/types.ts";
import type { startAgent } from "../runtime/process.ts";
import type {
  AcpProtocol,
  ProtocolCallbacks,
  ProtocolDriver,
} from "./protocol.ts";
import { V1Driver } from "./v1_driver.ts";
import { V2Driver } from "./v2_driver.ts";

export function createProtocolDriver(
  protocol: AcpProtocol,
  definition: AgentDefinition,
  process: Awaited<ReturnType<typeof startAgent>>,
  callbacks: ProtocolCallbacks,
): ProtocolDriver {
  return protocol === "v1"
    ? new V1Driver(definition, process, callbacks)
    : new V2Driver(definition, process, callbacks);
}
