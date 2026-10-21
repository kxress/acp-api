import type { AcpPromptBlock } from "../acp/protocol.ts";
import type { OpenAiAgentConfig, OpenAiProxyConfig } from "./config.ts";
import type { PromptHandle, SessionSnapshot } from "../sessions/manager.ts";
import { SessionManager } from "../sessions/manager.ts";
import { agentMap } from "./config.ts";

interface Worker {
  config: OpenAiAgentConfig;
  session: SessionSnapshot;
  busy: number;
  failures: number;
  cooldownUntil: number;
  tail: Promise<void>;
}

export interface GenerationResult {
  text: string;
  stopReason?: string;
  workerId: string;
  upstreamModel?: string;
}

export type TextUpdate = (text: string) => void | Promise<void>;
export type RuntimeSelected = (selection: {
  workerId: string;
  upstreamModel?: string;
}) => void;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
}

function waitBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function nestedValues(
  option: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      result.push(entry);
      visit(entry.options);
    }
  };
  visit(option.options);
  return result;
}

function capabilitiesForWorker(worker: Worker): Record<string, unknown> {
  const capabilities = worker.session.capabilities;
  if (!capabilities || typeof capabilities !== "object") return {};
  const record = capabilities as Record<string, unknown>;
  const prompt = record.promptCapabilities ?? record.prompt_capabilities;
  return prompt && typeof prompt === "object"
    ? (prompt as Record<string, unknown>)
    : {};
}

function supportsBlocks(worker: Worker, blocks: AcpPromptBlock[]): boolean {
  const capabilities = capabilitiesForWorker(worker);
  return blocks.every((block) => {
    if (block.type === "image") return Boolean(capabilities.image);
    if (block.type === "audio") return Boolean(capabilities.audio);
    if (block.type === "resource") return Boolean(capabilities.embeddedContext);
    return true;
  });
}

export class OpenAiRuntime {
  readonly manager: SessionManager;
  private readonly config: OpenAiProxyConfig;
  private readonly workers: Worker[];
  private roundRobin = 0;
  private closed = false;

  private constructor(
    config: OpenAiProxyConfig,
    manager: SessionManager,
    workers: Worker[],
  ) {
    this.config = config;
    this.manager = manager;
    this.workers = workers;
  }

  static async start(config: OpenAiProxyConfig): Promise<OpenAiRuntime> {
    const manager = new SessionManager(
      agentMap(config),
      30_000,
      5_000,
      config.maxSessions,
    );
    const workers: Worker[] = [];
    try {
      for (const agent of config.agents) {
        const session = await manager.start(
          agent.id,
          agent.cwd,
          {},
          undefined,
          agent.permissionPolicy,
        );
        workers.push({
          config: agent,
          session,
          busy: 0,
          failures: 0,
          cooldownUntil: 0,
          tail: Promise.resolve(),
        });
      }
    } catch (error) {
      await manager.closeAll();
      throw error;
    }
    return new OpenAiRuntime(config, manager, workers);
  }

  listModels(): Array<Record<string, unknown>> {
    const modelIds = [
      ...new Set(this.workers.flatMap((worker) => worker.config.models)),
    ];
    return modelIds.sort().map((id) => {
      const pool = this.workers.filter((worker) =>
        worker.config.models.includes(id),
      );
      return {
        id,
        object: "model",
        created: 0,
        owned_by:
          pool.length > 1
            ? "acp-agent-pool"
            : (pool[0]?.config.name ?? "acp-agent"),
        acp_agents: pool.map((worker) => worker.config.id),
        x_acp_pool_size: pool.length,
        x_acp_routing_strategy: this.config.routingStrategy,
      };
    });
  }

  hasModel(model: string): boolean {
    return this.workers.some((worker) => worker.config.models.includes(model));
  }

  model(model: string): Record<string, unknown> | undefined {
    return this.listModels().find((item) => item.id === model);
  }

  capabilitiesForModel(model: string): unknown {
    const union: Record<string, unknown> = {};
    for (const worker of this.workers) {
      if (worker.config.models.includes(model)) {
        for (const [name, value] of Object.entries(
          capabilitiesForWorker(worker),
        )) {
          if (value) union[name] = value;
        }
      }
    }
    return { promptCapabilities: union };
  }

  supportsInput(model: string, blocks: AcpPromptBlock[]): boolean {
    return this.workers.some(
      (worker) =>
        worker.config.models.includes(model) && supportsBlocks(worker, blocks),
    );
  }

  async generate(
    model: string,
    blocks: AcpPromptBlock[],
    affinityKey: string,
    signal: AbortSignal,
    onSelected?: RuntimeSelected,
    onText?: TextUpdate,
  ): Promise<GenerationResult> {
    if (this.closed) throw new Error("OpenAI proxy is shutting down");
    const candidates = this.orderWorkers(model, affinityKey);
    if (!candidates.length) throw new Error(`Model not found: ${model}`);
    const compatible = candidates.filter((worker) =>
      supportsBlocks(worker, blocks),
    );
    if (!compatible.length) {
      throw new Error(
        `No ACP runtime supporting the requested input is available for model '${model}'`,
      );
    }
    const maxAttempts = Math.min(compatible.length, this.config.maxRetries + 1);
    let lastError: unknown;

    for (const [attempt, worker] of compatible
      .slice(0, maxAttempts)
      .entries()) {
      if (signal.aborted) throw abortReason(signal);
      if (attempt > 0) await waitBackoff(this.config.retryBackoffMs, signal);
      const release = await this.acquire(worker, signal);
      worker.busy++;
      let emitted = false;
      let prompt: PromptHandle | undefined;
      try {
        const upstreamModel = await this.selectModel(worker, model);
        onSelected?.({ workerId: worker.config.id, upstreamModel });
        prompt = this.manager.beginPrompt(worker.session.id, blocks);
        let sent = "";
        let version = prompt.activityVersion;

        for (;;) {
          if (signal.aborted) {
            await this.manager.cancelPrompt(worker.session.id, prompt.id);
            throw abortReason(signal);
          }
          const current = this.manager.getPromptHandle(
            worker.session.id,
            prompt.id,
          );
          const delta = current.text.startsWith(sent)
            ? current.text.slice(sent.length)
            : current.text;
          sent = current.text;
          if (delta && onText) {
            await onText(delta);
            emitted = true;
          }
          version = current.activityVersion;
          if (current.state !== "running") break;
          const waiter = this.manager.waitForPromptActivity(
            worker.session.id,
            prompt.id,
            version,
          );
          let onAbort!: () => void;
          const aborted = new Promise<void>((resolve) => {
            onAbort = resolve;
            signal.addEventListener("abort", onAbort, { once: true });
          });
          await Promise.race([waiter.promise, aborted]);
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            waiter.cancel();
            await this.manager.cancelPrompt(worker.session.id, prompt.id);
            throw abortReason(signal);
          }
        }
        const completed = this.manager.getPromptHandle(
          worker.session.id,
          prompt.id,
        );
        if (completed.state === "failed")
          throw new Error(completed.error ?? "ACP prompt failed");
        if (completed.state === "cancelled" && !signal.aborted) {
          throw new Error("ACP prompt was cancelled");
        }
        worker.failures = 0;
        worker.cooldownUntil = 0;
        return {
          text: completed.text,
          stopReason: completed.stopReason,
          workerId: worker.config.id,
          upstreamModel,
        };
      } catch (error) {
        lastError = error;
        if (signal.aborted || emitted) throw error;
        worker.failures++;
        worker.cooldownUntil = Date.now() + this.config.failureCooldownMs;
      } finally {
        worker.busy--;
        release();
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "ACP request failed"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.manager.closeAll();
  }

  private async acquire(
    worker: Worker,
    signal: AbortSignal,
  ): Promise<() => void> {
    let unlock!: () => void;
    const slot = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const previous = worker.tail;
    worker.tail = previous.then(() => slot);
    if (signal.aborted) {
      unlock();
      throw abortReason(signal);
    }
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const acquired = await Promise.race([
      previous.then(() => true as const),
      aborted.then(() => false as const),
    ]);
    signal.removeEventListener("abort", onAbort);
    if (!acquired || signal.aborted) {
      unlock();
      throw abortReason(signal);
    }
    return unlock;
  }

  private orderWorkers(model: string, key: string): Worker[] {
    const pool = this.workers.filter((worker) =>
      worker.config.models.includes(model),
    );
    if (!pool.length) return [];
    let ordered = [...pool];
    if (this.config.routingStrategy === "round_robin") {
      const first = this.roundRobin++ % ordered.length;
      ordered = [...ordered.slice(first), ...ordered.slice(0, first)];
    } else if (this.config.routingStrategy === "sticky_failover") {
      const first = hash(`${model}\u0000${key}`) % ordered.length;
      ordered = [...ordered.slice(first), ...ordered.slice(0, first)];
    } else if (this.config.routingStrategy === "least_busy") {
      ordered.sort((a, b) => a.busy - b.busy || a.failures - b.failures);
    }
    const healthy = ordered.filter(
      (worker) => worker.cooldownUntil <= Date.now(),
    );
    const cooling = ordered.filter(
      (worker) => worker.cooldownUntil > Date.now(),
    );
    ordered = [...healthy, ...cooling];
    return ordered;
  }

  private async selectModel(
    worker: Worker,
    model: string,
  ): Promise<string | undefined> {
    const selection = worker.config.modelSelection;
    if (!selection) return undefined;
    const session = this.manager.getSessionSnapshot(worker.session.id);
    const option = selection.configId
      ? session.configOptions.find((item) => item.id === selection.configId)
      : session.configOptions.find(
          (item) => item.category === "model" || item.id === "model",
        );
    if (!option) {
      if (selection.required)
        throw new Error(
          `Agent '${worker.config.id}' does not expose an ACP model config option`,
        );
      return undefined;
    }
    const mapped = selection.values[model];
    const advertised = nestedValues(option);
    const resolved =
      mapped ??
      advertised.find(
        (item) =>
          item.value === model || item.name === model || item.id === model,
      )?.value;
    if (
      typeof resolved !== "string" ||
      (advertised.length && !advertised.some((item) => item.value === resolved))
    ) {
      if (selection.required)
        throw new Error(
          `Agent '${worker.config.id}' cannot map model '${model}' to an advertised ACP model value`,
        );
      return undefined;
    }
    await this.manager.setConfigOption(
      worker.session.id,
      String(option.id),
      resolved,
    );
    this.manager.recordModelSelection(worker.session.id, { model });
    return resolved;
  }
}
