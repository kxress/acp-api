import type { AgentDefinition } from "../agents/types.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
  configId: string;
  available: true;
  selected: boolean;
  availabilitySource: "acp";
  /** Optional agent-specific enrichment; availability fields above stay ACP-owned. */
  metadata?: Record<string, unknown>;
}

function choices(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.options) && typeof record.value !== "string") {
      return choices(record.options);
    }
    return typeof record.value === "string" ? [record] : [];
  });
}

export function discoverAdvertisedModels(
  configOptions: Array<Record<string, unknown>>,
  agent: AgentDefinition,
): DiscoveredModel[] {
  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const option of configOptions) {
    const configId = typeof option.id === "string" ? option.id : undefined;
    const isModelOption =
      option.category === "model" ||
      ((option.category === undefined || option.category === null) &&
        configId === agent.modelConfigId);
    if (!configId || option.type !== "select" || !isModelOption) continue;
    const currentValue =
      typeof option.currentValue === "string" ? option.currentValue : undefined;
    for (const choice of choices(option.options)) {
      const id = choice.value as string;
      const key = `${configId}\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id,
        name: typeof choice.name === "string" ? choice.name : id,
        configId,
        available: true,
        selected: currentValue === id,
        availabilitySource: "acp",
      });
    }
  }
  return result;
}
