import type { DiscoveredModel } from "./discovery.ts";

export const MODEL_SIZES = ["small", "medium", "large", "xlarge"] as const;
export type ModelSize = (typeof MODEL_SIZES)[number];

export const THINKING_EFFORTS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface ModelSizeMapping {
  model?: string;
  modelsByThinkingEffort?: Partial<Record<ThinkingEffort, string>>;
  maxThinkingEffort?: ThinkingEffort;
}

export interface ThinkingEffortMapping {
  configOption: string;
  values: Partial<Record<ThinkingEffort, string>>;
}

export interface ModelDefault {
  model?: string;
  modelSize?: ModelSize;
  thinkingEffort?: ThinkingEffort;
}

export interface AgentModelPolicy {
  default?: ModelDefault;
  allowedModels?: string[];
  deniedModels?: string[];
  modelSizes?: Partial<Record<ModelSize, ModelSizeMapping>>;
  thinkingEffort?: ThinkingEffortMapping;
}

export interface ModelSelectionRequest {
  model?: string;
  modelSize?: ModelSize;
  thinkingEffort?: ThinkingEffort;
}

export interface EffectiveModelSelection {
  model?: DiscoveredModel;
  modelSize?: ModelSize;
  configId?: string;
  configValue?: string;
  thinkingEffort?: ThinkingEffort;
  thinkingConfigId?: string;
  thinkingConfigValue?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
  path: string,
  agentId: string,
  field: string,
  detail: string,
): never {
  throw new Error(`${path}: agents.${agentId}.models.${field} ${detail}`);
}

function isOneOf<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function validateEffort(
  value: unknown,
  path: string,
  agentId: string,
  field: string,
): asserts value is ThinkingEffort {
  if (!isOneOf(THINKING_EFFORTS, value)) {
    fail(path, agentId, field, `has unsupported value '${String(value)}'`);
  }
}

export function validateModelPolicy(
  value: unknown,
  agentId: string,
  path: string,
): AgentModelPolicy {
  if (!isRecord(value)) fail(path, agentId, "", "must be an object");
  const policy: AgentModelPolicy = {};
  if (value.default !== undefined) {
    if (!isRecord(value.default)) {
      fail(path, agentId, "default", "must be an object");
    }
    const model = value.default.model;
    const modelSize = value.default.modelSize;
    if ((model === undefined) === (modelSize === undefined)) {
      fail(
        path,
        agentId,
        "default",
        "must specify exactly one of model or modelSize",
      );
    }
    if (model !== undefined && (typeof model !== "string" || !model)) {
      fail(
        path,
        agentId,
        "default.model",
        "must be a non-empty exact model ID",
      );
    }
    if (modelSize !== undefined && !isOneOf(MODEL_SIZES, modelSize)) {
      fail(
        path,
        agentId,
        "default.modelSize",
        `has unsupported value '${String(modelSize)}'`,
      );
    }
    const effort = value.default.thinkingEffort;
    if (effort !== undefined) {
      validateEffort(effort, path, agentId, "default.thinkingEffort");
    }
    policy.default = {
      ...(model === undefined ? {} : { model: model as string }),
      ...(modelSize === undefined ? {} : { modelSize: modelSize as ModelSize }),
      ...(effort === undefined ? {} : { thinkingEffort: effort }),
    };
  }
  for (const name of ["allowedModels", "deniedModels"] as const) {
    const patterns = value[name];
    if (patterns !== undefined) {
      if (
        !Array.isArray(patterns) ||
        !patterns.every((x) => typeof x === "string" && x.length > 0)
      ) {
        fail(
          path,
          agentId,
          name,
          "must be an array of non-empty model-ID patterns",
        );
      }
      policy[name] = [...patterns] as string[];
    }
  }
  if (value.modelSizes !== undefined) {
    if (!isRecord(value.modelSizes)) {
      fail(path, agentId, "modelSizes", "must be an object");
    }
    const modelSizes: NonNullable<AgentModelPolicy["modelSizes"]> = {};
    for (const [size, rawMapping] of Object.entries(value.modelSizes)) {
      if (!isOneOf(MODEL_SIZES, size)) {
        fail(path, agentId, `modelSizes.${size}`, "uses an unknown model size");
      }
      const mappingField = `modelSizes.${size}`;
      if (!isRecord(rawMapping)) {
        fail(path, agentId, mappingField, "must be an object");
      }
      const model = rawMapping.model;
      const variants = rawMapping.modelsByThinkingEffort;
      if (model !== undefined && (typeof model !== "string" || !model)) {
        fail(
          path,
          agentId,
          `${mappingField}.model`,
          "must be a non-empty exact model ID",
        );
      }
      if (model !== undefined && variants !== undefined) {
        fail(
          path,
          agentId,
          mappingField,
          "must use model or modelsByThinkingEffort, not both",
        );
      }
      let modelsByThinkingEffort:
        | Partial<Record<ThinkingEffort, string>>
        | undefined;
      if (variants !== undefined) {
        if (!isRecord(variants)) {
          fail(
            path,
            agentId,
            `${mappingField}.modelsByThinkingEffort`,
            "must be an object",
          );
        }
        modelsByThinkingEffort = {};
        for (const [effort, modelId] of Object.entries(variants)) {
          if (!isOneOf(THINKING_EFFORTS, effort)) {
            fail(
              path,
              agentId,
              `${mappingField}.modelsByThinkingEffort.${effort}`,
              "uses an unknown thinking effort",
            );
          }
          if (typeof modelId !== "string" || !modelId) {
            fail(
              path,
              agentId,
              `${mappingField}.modelsByThinkingEffort.${effort}`,
              "must be a non-empty exact model ID",
            );
          }
          modelsByThinkingEffort[effort] = modelId;
        }
        if (!Object.keys(modelsByThinkingEffort).length) {
          fail(
            path,
            agentId,
            `${mappingField}.modelsByThinkingEffort`,
            "must not be empty",
          );
        }
      }
      let maxThinkingEffort: ThinkingEffort | undefined;
      if (rawMapping.maxThinkingEffort !== undefined) {
        validateEffort(
          rawMapping.maxThinkingEffort,
          path,
          agentId,
          `${mappingField}.maxThinkingEffort`,
        );
        maxThinkingEffort = rawMapping.maxThinkingEffort;
      }
      if (model === undefined && variants === undefined) {
        fail(
          path,
          agentId,
          mappingField,
          "must specify model or modelsByThinkingEffort",
        );
      }
      modelSizes[size] = {
        ...(model === undefined ? {} : { model: model as string }),
        ...(modelsByThinkingEffort ? { modelsByThinkingEffort } : {}),
        ...(maxThinkingEffort ? { maxThinkingEffort } : {}),
      };
    }
    policy.modelSizes = modelSizes;
  }
  if (value.thinkingEffort !== undefined) {
    if (!isRecord(value.thinkingEffort)) {
      fail(path, agentId, "thinkingEffort", "must be an object");
    }
    if (
      typeof value.thinkingEffort.configOption !== "string" ||
      !value.thinkingEffort.configOption
    ) {
      fail(
        path,
        agentId,
        "thinkingEffort.configOption",
        "must be a non-empty ACP config option ID",
      );
    }
    if (!isRecord(value.thinkingEffort.values)) {
      fail(path, agentId, "thinkingEffort.values", "must be an object");
    }
    const values: Partial<Record<ThinkingEffort, string>> = {};
    for (const [effort, downstreamValue] of Object.entries(
      value.thinkingEffort.values,
    )) {
      if (!isOneOf(THINKING_EFFORTS, effort)) {
        fail(
          path,
          agentId,
          `thinkingEffort.values.${effort}`,
          "uses an unknown thinking effort",
        );
      }
      if (typeof downstreamValue !== "string" || !downstreamValue) {
        fail(
          path,
          agentId,
          `thinkingEffort.values.${effort}`,
          "must be a non-empty advertised ACP value",
        );
      }
      values[effort] = downstreamValue;
    }
    if (!Object.keys(values).length) {
      fail(path, agentId, "thinkingEffort.values", "must not be empty");
    }
    policy.thinkingEffort = {
      configOption: value.thinkingEffort.configOption,
      values,
    };
  }
  return policy;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

export function isModelAllowed(
  policy: AgentModelPolicy,
  modelId: string,
): boolean {
  if (
    policy.allowedModels &&
    !policy.allowedModels.some((pattern) => globMatches(pattern, modelId))
  )
    return false;
  return !policy.deniedModels?.some((pattern) => globMatches(pattern, modelId));
}

export function filterModels<T extends DiscoveredModel>(
  models: T[],
  policy: AgentModelPolicy,
): T[] {
  return models.filter((model) => isModelAllowed(policy, model.id));
}

function optionValues(option: Record<string, unknown>): string[] {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.options) && typeof record.value !== "string") {
      return optionValues(record);
    }
    return typeof record.value === "string" ? [record.value] : [];
  });
}

function compareEffort(a: ThinkingEffort, b: ThinkingEffort): number {
  return THINKING_EFFORTS.indexOf(a) - THINKING_EFFORTS.indexOf(b);
}

export function resolveThinkingEffort(
  requested: ThinkingEffort,
  available: ThinkingEffort[],
  cap?: ThinkingEffort,
): ThinkingEffort | undefined {
  const supported = THINKING_EFFORTS.filter(
    (effort) =>
      available.includes(effort) && (!cap || compareEffort(effort, cap) <= 0),
  );
  if (!supported.length) return undefined;
  if (supported.includes(requested)) return requested;
  if (requested === "off") return supported[0];
  const requestedIndex = THINKING_EFFORTS.indexOf(requested);
  return (
    supported
      .filter((effort) => THINKING_EFFORTS.indexOf(effort) <= requestedIndex)
      .at(-1) ?? supported[0]
  );
}

export function policyFilteredModels(
  models: DiscoveredModel[],
  policy: AgentModelPolicy,
): DiscoveredModel[] {
  const filtered = filterModels(models, policy);
  return filtered.map((model) => {
    const mappedSize = Object.entries(policy.modelSizes ?? {}).find(
      ([, mapping]) =>
        mapping?.model === model.id ||
        Object.values(mapping?.modelsByThinkingEffort ?? {}).includes(model.id),
    )?.[0] as ModelSize | undefined;
    const mappedEffort = mappedSize
      ? (Object.entries(
          policy.modelSizes?.[mappedSize]?.modelsByThinkingEffort ?? {},
        ).find(([, id]) => id === model.id)?.[0] as ThinkingEffort | undefined)
      : undefined;
    return {
      ...model,
      ...(mappedSize ? { modelSize: mappedSize } : {}),
      ...(mappedEffort ? { thinkingEffort: mappedEffort } : {}),
    };
  });
}

export function resolveModelSelection(
  advertised: DiscoveredModel[],
  configOptions: Array<Record<string, unknown>>,
  policy: AgentModelPolicy,
  request: ModelSelectionRequest,
): EffectiveModelSelection {
  if (request.model && request.modelSize) {
    throw new Error("model and modelSize are mutually exclusive");
  }
  const selector =
    request.model !== undefined || request.modelSize !== undefined
      ? request
      : (policy.default ?? {});
  let selectedModel: DiscoveredModel | undefined;
  let mappedEffort: ThinkingEffort | undefined;
  let modelSize: ModelSize | undefined;
  if (selector.model !== undefined) {
    selectedModel = advertised.find((model) => model.id === selector.model);
    if (!selectedModel) {
      throw new Error(`Model '${selector.model}' is not advertised by ACP`);
    }
    if (!isModelAllowed(policy, selector.model)) {
      throw new Error(`Model '${selector.model}' is denied by model policy`);
    }
    for (const [size, mapping] of Object.entries(policy.modelSizes ?? {})) {
      if (mapping?.model === selector.model) modelSize = size as ModelSize;
      const entry = Object.entries(mapping?.modelsByThinkingEffort ?? {}).find(
        ([, id]) => id === selector.model,
      );
      if (entry) {
        modelSize = size as ModelSize;
        mappedEffort = entry[0] as ThinkingEffort;
      }
    }
  } else if (selector.modelSize !== undefined) {
    modelSize = selector.modelSize;
    const mapping = policy.modelSizes?.[modelSize];
    if (!mapping) {
      throw new Error(`No model mapping is configured for size '${modelSize}'`);
    }
    if (mapping.model) {
      selectedModel = advertised.find((model) => model.id === mapping.model);
      if (!selectedModel) {
        throw new Error(
          `Mapped model '${mapping.model}' for size '${modelSize}' is not advertised by ACP`,
        );
      }
    } else {
      const variants = Object.entries(
        mapping.modelsByThinkingEffort ?? {},
      ) as Array<[ThinkingEffort, string]>;
      const requestedVariantEffort =
        request.thinkingEffort ?? policy.default?.thinkingEffort;
      const available = variants.filter(
        ([, id]) =>
          advertised.some((model) => model.id === id) &&
          isModelAllowed(policy, id),
      );
      const currentVariant = available.find(([, id]) =>
        advertised.some((model) => model.id === id && model.selected),
      );
      const chosenEffort = requestedVariantEffort
        ? resolveThinkingEffort(
            requestedVariantEffort,
            available.map(([effort]) => effort),
          )
        : currentVariant?.[0];
      const selected = chosenEffort
        ? variants.find(([effort]) => effort === chosenEffort)
        : undefined;
      if (!selected) {
        throw new Error(
          `No advertised model variant for size '${modelSize}' satisfies the requested thinking effort`,
        );
      }
      mappedEffort = selected[0];
      selectedModel = advertised.find((model) => model.id === selected[1]);
    }
    if (selectedModel && !isModelAllowed(policy, selectedModel.id)) {
      throw new Error(
        `Mapped model '${selectedModel.id}' is denied by model policy`,
      );
    }
  } else if (request.thinkingEffort || policy.default?.thinkingEffort) {
    selectedModel = advertised.find((model) => model.selected);
    if (!selectedModel) {
      throw new Error(
        "Thinking effort requires a selected or configured model",
      );
    }
  }

  if (!selectedModel) {
    selectedModel = advertised.find((model) => model.selected);
  }
  if (selectedModel && !isModelAllowed(policy, selectedModel.id)) {
    throw new Error(`Model '${selectedModel.id}' is denied by model policy`);
  }

  const requestedEffort =
    request.thinkingEffort ?? policy.default?.thinkingEffort;
  let effectiveEffort = mappedEffort;
  let thinkingConfigId: string | undefined;
  let thinkingConfigValue: string | undefined;
  if (requestedEffort && selectedModel) {
    if (mappedEffort) {
      effectiveEffort = mappedEffort;
    } else {
      const mapping = policy.thinkingEffort;
      if (!mapping) {
        throw new Error(
          `Model '${selectedModel.id}' does not have a configured thinking-effort mapping`,
        );
      }
      const option = configOptions.find(
        (item) => item.id === mapping.configOption,
      );
      if (!option || option.type !== "select") {
        throw new Error(
          `Thinking-effort config option '${mapping.configOption}' is not advertised by ACP`,
        );
      }
      const liveValues = new Set(optionValues(option));
      const available = THINKING_EFFORTS.filter((effort) => {
        const mappedValue = mapping.values[effort];
        return mappedValue !== undefined && liveValues.has(mappedValue);
      });
      const sizeCap = modelSize
        ? policy.modelSizes?.[modelSize]?.maxThinkingEffort
        : undefined;
      const chosen = resolveThinkingEffort(requestedEffort, available, sizeCap);
      if (!chosen) {
        throw new Error(
          `Thinking effort '${requestedEffort}' is not supported by model '${selectedModel.id}'`,
        );
      }
      effectiveEffort = chosen;
      thinkingConfigId = mapping.configOption;
      thinkingConfigValue = mapping.values[chosen];
    }
  }

  return {
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(modelSize ? { modelSize } : {}),
    ...(selectedModel
      ? { configId: selectedModel.configId, configValue: selectedModel.id }
      : {}),
    ...(effectiveEffort ? { thinkingEffort: effectiveEffort } : {}),
    ...(thinkingConfigId ? { thinkingConfigId } : {}),
    ...(thinkingConfigValue ? { thinkingConfigValue } : {}),
  };
}
