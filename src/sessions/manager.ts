import process from "node:process";
import type { AgentDefinition, AgentMap } from "../agents/types.ts";
import type {
  AgentModelPolicy,
  ModelSize,
  ThinkingEffort,
} from "../models/policy.ts";
import { createProtocolDriver } from "../acp/driver_factory.ts";
import type {
  AcpPermissionRequest,
  AcpProtocol,
  AcpPromptBlock,
  NormalizedAcpUpdate,
  ProtocolDriver,
} from "../acp/protocol.ts";
import { startAgent, stopAgent } from "../runtime/process.ts";

interface ManagedSession {
  id: string;
  agentId: string;
  agentDefinition: AgentDefinition;
  agent: ManagedAgent;
  cwd: string;
  acpSessionId: string;
  acpProtocol: AcpProtocol;
  driver: ProtocolDriver;
  promptActive: boolean;
  capabilities: unknown;
  authMethods: unknown;
  configOptions: Array<Record<string, unknown>>;
  modes: Record<string, unknown> | undefined;
  prompt?: PromptRecord;
  closePromise?: Promise<void>;
  events: SessionEvent[];
  nextSequence: number;
  droppedThrough: number;
  permissionPolicy: PermissionPolicy;
  modelSelection?: {
    model: string;
    modelSize?: ModelSize;
    thinkingEffort?: ThinkingEffort;
  };
  pendingPermissions: Map<string, PendingPermission>;
  permissionLease?: ReturnType<typeof setTimeout>;
}

interface ManagedAgent {
  id: string;
  agentDefinition: AgentDefinition;
  cwd: string;
  process: Awaited<ReturnType<typeof startAgent>>;
  driver: ProtocolDriver;
  capabilities: unknown;
  authMethods: unknown;
  sessions: Map<string, ManagedSession>;
  earlyUpdates: Map<string, NormalizedAcpUpdate[]>;
  closedSessionIds: Set<string>;
  closedSessionOrder: string[];
  closed: boolean;
  closePromise?: Promise<void>;
}

export interface SessionEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  update: unknown;
  raw: unknown;
}

interface PromptRecord {
  id: string;
  state: "running" | "completed" | "cancelled" | "failed";
  text: string;
  messageText: Map<string, string>;
  messageOrder: string[];
  lastActivityAt: number;
  activityVersion: number;
  activityWaiters: Set<() => void>;
  stopReason?: string;
  error?: string;
  errorCode?: number;
  errorData?: unknown;
  done: Promise<void>;
}

export type PermissionPolicy =
  | "read_only"
  | "operator"
  | "allow_all"
  | "deny_all";

export interface SessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly implementation?: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly acpProtocol: AcpProtocol;
  readonly promptActive: boolean;
  readonly capabilities: unknown;
  readonly authMethods: unknown;
  readonly configOptions: Array<Record<string, unknown>>;
  readonly modes: Record<string, unknown> | undefined;
  readonly permissionPolicy: PermissionPolicy;
  readonly modelConfigId?: string;
  readonly models?: AgentModelPolicy;
  readonly modelSelection?: {
    readonly model: string;
    readonly modelSize?: ModelSize;
    readonly thinkingEffort?: ThinkingEffort;
  };
  readonly pendingPermissions: Array<{
    id: string;
    toolCall: unknown;
    options: Array<{ optionId: string; kind: string; name: string }>;
  }>;
  readonly prompt?: {
    id: string;
    state: PromptRecord["state"];
    text: string;
    stopReason?: string;
    error?: string;
    errorCode?: number;
    errorData?: unknown;
  };
  readonly nextSequence: number;
}

export interface AgentSnapshot {
  readonly id: string;
  readonly implementation?: string;
  readonly cwd: string;
  readonly acpProtocol: AcpProtocol;
  readonly capabilities: unknown;
  readonly authMethods: unknown;
  readonly modelConfigId?: string;
  readonly models?: AgentModelPolicy;
}

export interface PromptHandle {
  readonly id: string;
  readonly state: PromptRecord["state"];
  readonly text: string;
  readonly stopReason?: string;
  readonly error?: string;
  readonly errorCode?: number;
  readonly errorData?: unknown;
  readonly lastActivityAt: number;
  readonly activityVersion: number;
  readonly done: Promise<void>;
}

export interface SessionLaunchOptions {
  agentDefinition?: AgentDefinition;
  signal?: AbortSignal;
}

type PendingPermissionSnapshot = SessionSnapshot["pendingPermissions"][number];

type ConfigOptionWaiter = {
  predicate: (options: Array<Record<string, unknown>>) => boolean;
  finish: (options: Array<Record<string, unknown>>) => void;
};

function configOptionsFromUpdate(
  event: NormalizedAcpUpdate,
): Array<Record<string, unknown>> | undefined {
  if (event.kind !== "config_option_update") return undefined;
  if (!event.update || typeof event.update !== "object") return undefined;
  const options = (event.update as { configOptions?: unknown }).configOptions;
  if (
    !Array.isArray(options) ||
    !options.every((option) => option !== null && typeof option === "object")
  )
    return undefined;
  return options as Array<Record<string, unknown>>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: (error: Error) => void,
): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    const error = abortError(signal);
    onAbort?.(error);
    throw error;
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => {
      const error = abortError(signal);
      onAbort?.(error);
      reject(error);
    };
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export const DEFAULT_SESSION_START_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_MANAGED_SESSIONS = 8;

interface PendingPermission {
  id: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
  resolve: (value: {
    outcome:
      | { outcome: "selected"; optionId: string }
      | {
          outcome: "cancelled";
        };
  }) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly managedAgents = new Map<string, ManagedAgent>();
  private readonly connectingAgents = new Map<string, Promise<AgentSnapshot>>();
  private readonly configOptionWaiters = new Map<
    string,
    Set<ConfigOptionWaiter>
  >();
  private agents: AgentMap;
  private readonly startupTimeoutMs: number;
  private readonly closeRequestTimeoutMs: number;
  private readonly maxSessions: number;
  private closing = false;

  constructor(
    agents: AgentMap,
    startupTimeoutMs = DEFAULT_SESSION_START_TIMEOUT_MS,
    closeRequestTimeoutMs = DEFAULT_SESSION_CLOSE_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_MANAGED_SESSIONS,
  ) {
    this.agents = agents;
    this.startupTimeoutMs = startupTimeoutMs;
    this.closeRequestTimeoutMs = closeRequestTimeoutMs;
    this.maxSessions = maxSessions;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  listSessionSnapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) =>
      this.sessionSnapshot(session),
    );
  }

  getSessionSnapshot(id: string): SessionSnapshot {
    return this.sessionSnapshot(this.requireSession(id));
  }

  recordModelSelection(
    sessionId: string,
    selection:
      | {
          model: string;
          modelSize?: ModelSize;
          thinkingEffort?: ThinkingEffort;
        }
      | undefined,
  ): void {
    const session = this.requireSession(sessionId);
    session.modelSelection = selection ? { ...selection } : undefined;
  }

  getPromptHandle(sessionId: string, promptId: string): PromptHandle {
    return this.promptHandle(this.requirePrompt(sessionId, promptId));
  }

  private sessionSnapshot(session: ManagedSession): SessionSnapshot {
    return {
      id: session.id,
      agentId: session.agentId,
      implementation: session.agentDefinition.implementation,
      cwd: session.cwd,
      acpSessionId: session.acpSessionId,
      acpProtocol: session.acpProtocol,
      promptActive: session.promptActive,
      capabilities: structuredClone(session.capabilities),
      authMethods: structuredClone(session.authMethods),
      configOptions: structuredClone(session.configOptions),
      modes: structuredClone(session.modes),
      permissionPolicy: session.permissionPolicy,
      modelConfigId: session.agentDefinition.modelConfigId,
      models: session.agentDefinition.models
        ? structuredClone(session.agentDefinition.models)
        : undefined,
      modelSelection: session.modelSelection
        ? { ...session.modelSelection }
        : undefined,
      pendingPermissions: [...session.pendingPermissions.values()].map(
        (pending) => ({
          id: pending.id,
          toolCall: structuredClone(pending.toolCall),
          options: structuredClone(pending.options),
        }),
      ),
      prompt: session.prompt
        ? {
            id: session.prompt.id,
            state: session.prompt.state,
            text: session.prompt.text,
            stopReason: session.prompt.stopReason,
            error: session.prompt.error,
            errorCode: session.prompt.errorCode,
            errorData: structuredClone(session.prompt.errorData),
          }
        : undefined,
      nextSequence: session.nextSequence,
    };
  }

  private agentSnapshot(agent: ManagedAgent): AgentSnapshot {
    return {
      id: agent.id,
      implementation: agent.agentDefinition.implementation,
      cwd: agent.cwd,
      acpProtocol: agent.driver.protocol,
      capabilities: structuredClone(agent.capabilities),
      authMethods: structuredClone(agent.authMethods),
      modelConfigId: agent.agentDefinition.modelConfigId,
      models: agent.agentDefinition.models
        ? structuredClone(agent.agentDefinition.models)
        : undefined,
    };
  }

  private promptHandle(prompt: PromptRecord): PromptHandle {
    return {
      get id() {
        return prompt.id;
      },
      get state() {
        return prompt.state;
      },
      get text() {
        return prompt.text;
      },
      get stopReason() {
        return prompt.stopReason;
      },
      get error() {
        return prompt.error;
      },
      get errorCode() {
        return prompt.errorCode;
      },
      get errorData() {
        return structuredClone(prompt.errorData);
      },
      get lastActivityAt() {
        return prompt.lastActivityAt;
      },
      get activityVersion() {
        return prompt.activityVersion;
      },
      done: prompt.done,
    };
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  private requirePrompt(sessionId: string, promptId: string): PromptRecord {
    const prompt = this.requireSession(sessionId).prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    return prompt;
  }

  private clearPermissionLease(session: ManagedSession): void {
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
  }

  private cancelPendingPermissions(session: ManagedSession): void {
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
  }

  async connectAgent(
    agentId: string,
    cwd = process.cwd(),
    options: SessionLaunchOptions = {},
  ): Promise<AgentSnapshot> {
    if (this.closing) throw new Error("Session manager is shutting down");
    if (options.signal?.aborted) throw abortError(options.signal);
    const active = this.managedAgents.get(agentId);
    if (active && !active.closed) return this.agentSnapshot(active);
    const connecting = this.connectingAgents.get(agentId);
    if (connecting) return await raceWithAbort(connecting, options.signal);

    const pending = this.launchAgent(agentId, cwd, options);
    this.connectingAgents.set(agentId, pending);
    try {
      return await pending;
    } finally {
      if (this.connectingAgents.get(agentId) === pending) {
        this.connectingAgents.delete(agentId);
      }
    }
  }

  private async launchAgent(
    agentId: string,
    cwd: string,
    options: SessionLaunchOptions,
  ): Promise<AgentSnapshot> {
    const def = options.agentDefinition ?? this.agents[agentId];
    if (!def) throw new Error(`Unknown agent: ${agentId}`);
    const protocol = def.acpProtocol ?? "v1";
    if (def.supportedProtocols && !def.supportedProtocols.includes(protocol)) {
      throw new Error(
        `Agent profile '${agentId}' does not confirm ACP ${protocol} support`,
      );
    }
    const launchDefinition = {
      ...def,
      env: { ...def.protocolEnv?.[protocol], ...def.env },
    };
    const childProcess = await startAgent(launchDefinition, cwd);
    let agent: ManagedAgent | undefined;
    let driver: ProtocolDriver | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      driver = createProtocolDriver(protocol, def, childProcess, {
        update: (update) => {
          if (agent) this.receiveAgentUpdate(agent, update);
        },
        permission: (request) =>
          agent
            ? this.requestPermission(request, agent)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
      });
      agent = {
        id: agentId,
        agentDefinition: def,
        cwd,
        process: childProcess,
        driver,
        capabilities: {},
        authMethods: [],
        sessions: new Map(),
        earlyUpdates: new Map(),
        closedSessionIds: new Set(),
        closedSessionOrder: [],
        closed: false,
      };
      const timedOut = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error("ACP agent initialization timed out")),
          this.startupTimeoutMs,
        );
      });
      const initialized = await raceWithAbort(
        Promise.race([driver.initialize(), timedOut]),
        options.signal,
      );
      if (this.closing) throw new Error("Session manager is shutting down");
      agent.capabilities = initialized.capabilities;
      agent.authMethods = initialized.authMethods;
      this.managedAgents.set(agentId, agent);
      return this.agentSnapshot(agent);
    } catch (error) {
      if (driver) driver.closeConnection(error);
      await stopAgent(childProcess.child, 1000);
      throw new Error(
        `Could not start ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
    }
  }

  private receiveAgentUpdate(
    agent: ManagedAgent,
    update: NormalizedAcpUpdate,
  ): void {
    const session = agent.sessions.get(update.sessionId);
    if (session) {
      this.receiveUpdate(session, update);
      return;
    }
    if (agent.closed || agent.closedSessionIds.has(update.sessionId)) return;
    let updates = agent.earlyUpdates.get(update.sessionId);
    if (!updates) {
      if (agent.earlyUpdates.size >= 128) {
        const oldest = agent.earlyUpdates.keys().next().value as
          | string
          | undefined;
        if (oldest) agent.earlyUpdates.delete(oldest);
      }
      updates = [];
      agent.earlyUpdates.set(update.sessionId, updates);
    }
    if (updates.length < 64) updates.push(update);
  }

  private closeAgent(agent: ManagedAgent, error?: unknown): Promise<void> {
    if (agent.closePromise) return agent.closePromise;
    agent.closed = true;
    if (this.managedAgents.get(agent.id) === agent) {
      this.managedAgents.delete(agent.id);
    }
    agent.earlyUpdates.clear();
    agent.driver.closeConnection(error);
    agent.closePromise = stopAgent(agent.process.child, 5000);
    return agent.closePromise;
  }

  start(
    agentId: string,
    cwd = process.cwd(),
    config: Record<string, string> = {},
    modeId?: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.connectAgent(agentId, cwd, options).then(async () => {
      const agent = this.managedAgents.get(agentId);
      if (!agent || agent.closed)
        throw new Error(`Agent is unavailable: ${agentId}`);
      const session = await this.launchSession(
        agent,
        config,
        modeId,
        permissionPolicy,
        undefined,
        cwd,
        options.signal,
      );
      return this.sessionSnapshot(session);
    });
  }

  load(
    agentId: string,
    acpSessionId: string,
    cwd: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.connectAgent(agentId, cwd, options).then(async () => {
      const agent = this.managedAgents.get(agentId);
      if (!agent || agent.closed)
        throw new Error(`Agent is unavailable: ${agentId}`);
      const session = await this.launchSession(
        agent,
        {},
        undefined,
        permissionPolicy,
        acpSessionId,
        cwd,
        options.signal,
      );
      return this.sessionSnapshot(session);
    });
  }

  private async launchSession(
    agent: ManagedAgent,
    config: Record<string, string>,
    modeId: string | undefined,
    permissionPolicy: PermissionPolicy,
    loadSessionId?: string,
    cwd = agent.cwd,
    signal?: AbortSignal,
  ): Promise<ManagedSession> {
    if (this.closing || agent.closed) {
      throw new Error("ACP agent is shutting down");
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Active session limit (${this.maxSessions}) reached`);
    }
    let session: ManagedSession | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const startup = async () => {
      const sessionResponse = loadSessionId
        ? await agent.driver.resumeSession(loadSessionId, cwd)
        : await agent.driver.newSession(cwd);
      if (agent.closed || this.closing) {
        throw new Error("ACP agent is shutting down");
      }
      const acpId = sessionResponse.sessionId;
      session = {
        id: crypto.randomUUID(),
        agentId: agent.id,
        agentDefinition: agent.agentDefinition,
        agent,
        cwd,
        acpSessionId: acpId,
        acpProtocol: agent.driver.protocol,
        driver: agent.driver,
        promptActive: false,
        capabilities: agent.capabilities,
        authMethods: agent.authMethods,
        configOptions: [...sessionResponse.configOptions],
        modes: sessionResponse.modes,
        events: [],
        nextSequence: 1,
        droppedThrough: 0,
        permissionPolicy,
        pendingPermissions: new Map(),
      };
      this.sessions.set(session.id, session);
      agent.sessions.set(acpId, session);
      agent.closedSessionIds.delete(acpId);
      const earlyUpdates = agent.earlyUpdates.get(acpId) ?? [];
      agent.earlyUpdates.delete(acpId);
      for (const update of earlyUpdates) this.receiveUpdate(session, update);

      const modelConfigIds = new Set(
        session.configOptions.flatMap((option) => {
          const id = typeof option.id === "string" ? option.id : undefined;
          if (
            id &&
            (option.category === "model" ||
              ((option.category === undefined || option.category === null) &&
                id === agent.agentDefinition.modelConfigId))
          )
            return [id];
          return [];
        }),
      );
      const desired = Object.entries(config).sort(
        ([a], [b]) =>
          Number(modelConfigIds.has(b)) - Number(modelConfigIds.has(a)),
      );
      for (const [configId, value] of desired) {
        let option = session.configOptions.find((item) => item.id === configId);
        if (!option && session.configOptions.length) {
          session.configOptions = await this.waitForConfigOptions(
            session.id,
            (options) => options.some((item) => item.id === configId),
            DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
          );
          option = session.configOptions.find((item) => item.id === configId);
        }
        if (!option && session.configOptions.length) {
          throw new Error(`Unknown config option: ${configId}`);
        }
        if (option?.type === "select" && Array.isArray(option.options)) {
          const values = (
            option.options as Array<Record<string, unknown>>
          ).flatMap((entry) =>
            Array.isArray(entry.options)
              ? (entry.options as Array<Record<string, unknown>>)
              : [entry],
          );
          if (values.length && !values.some((entry) => entry.value === value)) {
            throw new Error(
              `Invalid value '${value}' for config option '${configId}'`,
            );
          }
        }
        session.configOptions = await this.setConfigOption(
          session.id,
          configId,
          value,
        );
      }
      if (modeId) await this.setMode(session.id, modeId);
      return session;
    };
    const timedOut = new Promise<never>((_, reject) => {
      startupTimer = setTimeout(() => {
        const error = new Error(
          `ACP session startup timed out after ${this.startupTimeoutMs}ms`,
        );
        void this.closeAgent(agent, error);
        reject(error);
      }, this.startupTimeoutMs);
    });
    try {
      return await raceWithAbort(
        Promise.race([startup(), timedOut]),
        signal,
        (error) => void this.closeAgent(agent, error),
      );
    } catch (error) {
      if (session && this.sessions.has(session.id)) {
        if (agent.closed) this.removeSession(session);
        else await this.close(session.id);
      }
      throw new Error(
        `Could not start ${agent.id} session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
    }
  }

  beginPrompt(
    sessionId: string,
    prompt: string | AcpPromptBlock[],
  ): PromptHandle {
    const session = this.requireSession(sessionId);
    if (session.promptActive) {
      throw new Error("A prompt is already active for this session");
    }
    session.promptActive = true;
    const record: PromptRecord = {
      id: crypto.randomUUID(),
      state: "running",
      text: "",
      messageText: new Map(),
      messageOrder: [],
      lastActivityAt: performance.now(),
      activityVersion: 0,
      activityWaiters: new Set(),
      done: Promise.resolve(),
    };
    session.prompt = record;
    record.done = this.consumePrompt(session, record, prompt);
    return this.promptHandle(record);
  }

  waitForPromptActivity(
    sessionId: string,
    promptId: string,
    activityVersion: number,
  ): { promise: Promise<void>; cancel: () => void } {
    const prompt = this.requirePrompt(sessionId, promptId);
    if (
      prompt.state !== "running" ||
      prompt.activityVersion !== activityVersion
    ) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const waiter = () => {
      prompt.activityWaiters.delete(waiter);
      resolve();
    };
    prompt.activityWaiters.add(waiter);
    return {
      promise,
      cancel: () => prompt.activityWaiters.delete(waiter),
    };
  }

  waitForPromptCompletion(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const prompt = this.requirePrompt(sessionId, promptId);
    return prompt.done.then(() => this.promptHandle(prompt));
  }

  private recordPromptActivity(session: ManagedSession): void {
    const prompt = session.prompt;
    if (!prompt || prompt.state !== "running") return;
    this.signalPromptActivity(prompt);
  }

  private signalPromptActivity(prompt: PromptRecord): void {
    prompt.lastActivityAt = performance.now();
    prompt.activityVersion++;
    for (const waiter of [...prompt.activityWaiters]) waiter();
  }

  private async consumePrompt(
    session: ManagedSession,
    record: PromptRecord,
    prompt: string | AcpPromptBlock[],
  ): Promise<void> {
    try {
      record.stopReason = await session.driver.prompt(
        session.acpSessionId,
        prompt,
      );
      if (record.state === "running") {
        record.state =
          record.stopReason === "cancelled" ? "cancelled" : "completed";
      }
    } catch (error) {
      if (record.state === "running") {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
        )
          record.errorCode = error.code;
        if (error && typeof error === "object" && "data" in error) {
          record.errorData = error.data;
        }
      }
    } finally {
      session.promptActive = false;
      this.signalPromptActivity(record);
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
    }
  }

  async waitPrompt(
    sessionId: string,
    promptId: string,
    waitMs: number,
  ): Promise<PromptHandle> {
    const prompt = this.requirePrompt(sessionId, promptId);
    if (prompt.state === "running") {
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs))),
      ]);
    }
    return this.promptHandle(prompt);
  }

  async cancelPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const session = this.requireSession(sessionId);
    const prompt = this.requirePrompt(sessionId, promptId);
    if (prompt.state === "running") {
      prompt.state = "cancelled";
      for (const waiter of [...prompt.activityWaiters]) waiter();
      this.cancelPendingPermissions(session);
      this.clearPermissionLease(session);
      await session.driver.cancel(session.acpSessionId);
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    return this.promptHandle(prompt);
  }

  getEvents(sessionId: string, afterSequence = 0, limit = 100) {
    const session = this.requireSession(sessionId);
    const events = session.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.max(1, Math.min(limit, 500)));
    return {
      events: events.map((event) => structuredClone(event)),
      nextSequence:
        events.at(-1)?.sequence ??
        Math.max(afterSequence, session.droppedThrough),
      gap: afterSequence < session.droppedThrough,
      prompt: session.prompt
        ? {
            id: session.prompt.id,
            state: session.prompt.state,
            text: session.prompt.text,
            stopReason: session.prompt.stopReason,
          }
        : undefined,
    };
  }

  private appendEvent(
    session: ManagedSession,
    kind: string,
    update: unknown,
    raw: unknown,
  ): void {
    const event: SessionEvent = {
      sequence: session.nextSequence++,
      timestamp: new Date().toISOString(),
      kind,
      update,
      raw,
    };
    session.events.push(event);
    while (
      session.events.length > 1000 ||
      JSON.stringify(session.events).length > 4 * 1024 * 1024
    ) {
      const removed = session.events.shift();
      if (removed) session.droppedThrough = removed.sequence;
    }
  }

  private receiveUpdate(
    session: ManagedSession,
    updateEvent: NormalizedAcpUpdate,
    applyConfigOptions = true,
  ) {
    this.recordPromptActivity(session);
    const configOptions = configOptionsFromUpdate(updateEvent);
    if (configOptions && applyConfigOptions) {
      session.configOptions = configOptions;
      this.notifyConfigOptionWaiters(session);
    }
    this.appendEvent(
      session,
      updateEvent.kind,
      updateEvent.update,
      updateEvent.raw,
    );
    if (session.prompt?.state === "running" && updateEvent.text) {
      const prompt = session.prompt;
      const messageId = updateEvent.text.messageId;
      if (!messageId) {
        prompt.text += updateEvent.text.text;
      } else {
        if (!prompt.messageText.has(messageId)) {
          prompt.messageOrder.push(messageId);
        }
        const previous = prompt.messageText.get(messageId) ?? "";
        prompt.messageText.set(
          messageId,
          updateEvent.text.replace
            ? updateEvent.text.text
            : previous + updateEvent.text.text,
        );
        prompt.text = prompt.messageOrder
          .map((id) => prompt.messageText.get(id) ?? "")
          .join("");
      }
    }
    if (updateEvent.stopReason && session.prompt?.state === "running") {
      session.prompt.stopReason = updateEvent.stopReason;
      if (updateEvent.stopReason === "cancelled") {
        session.prompt.state = "cancelled";
      } else if (updateEvent.error) {
        session.prompt.state = "failed";
        session.prompt.error =
          updateEvent.error?.message ?? "ACP prompt failed";
        session.prompt.errorCode = updateEvent.error?.code;
        session.prompt.errorData = updateEvent.error?.data;
      } else {
        session.prompt.state = "completed";
      }
      session.promptActive = false;
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
    }
  }

  waitForConfigOptions(
    sessionId: string,
    predicate: (options: Array<Record<string, unknown>>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const session = this.requireSession(sessionId);
    if (predicate(structuredClone(session.configOptions)) || timeoutMs <= 0) {
      return Promise.resolve(structuredClone(session.configOptions));
    }
    return new Promise((resolve) => {
      const waiters = this.configOptionWaiters.get(sessionId) ?? new Set();
      this.configOptionWaiters.set(sessionId, waiters);
      let abort: (() => void) | undefined;
      const waiter: ConfigOptionWaiter = {
        predicate,
        finish: (options) => {
          clearTimeout(timer);
          if (signal && abort) signal.removeEventListener("abort", abort);
          waiters.delete(waiter);
          if (waiters.size === 0) this.configOptionWaiters.delete(sessionId);
          resolve(structuredClone(options));
        },
      };
      const timer = setTimeout(
        () => waiter.finish(session.configOptions),
        timeoutMs,
      );
      if (signal) {
        abort = () => waiter.finish(session.configOptions);
        signal.addEventListener("abort", abort, { once: true });
      }
      if (signal?.aborted) {
        waiter.finish(session.configOptions);
      } else {
        waiters.add(waiter);
      }
    });
  }

  private notifyConfigOptionWaiters(session: ManagedSession): void {
    const waiters = this.configOptionWaiters.get(session.id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(structuredClone(session.configOptions))) {
        waiter.finish(session.configOptions);
      }
    }
  }

  async prompt(
    sessionId: string,
    text: string | AcpPromptBlock[],
  ): Promise<{ stopReason?: string; text: string; promptId?: string }> {
    const prompt = this.beginPrompt(sessionId, text);
    await prompt.done;
    if (prompt.state === "failed") {
      throw new Error(prompt.error ?? "Prompt failed");
    }
    return { stopReason: prompt.stopReason, text: prompt.text };
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.requireSession(sessionId);
    const option = session.configOptions.find((item) => item.id === configId);
    if (!option && session.configOptions.length) {
      throw new Error(`Unknown config option: ${configId}`);
    }
    if (option?.type === "select" && Array.isArray(option.options)) {
      const values = (option.options as Array<Record<string, unknown>>).flatMap(
        (entry) =>
          Array.isArray(entry.options)
            ? (entry.options as Array<Record<string, unknown>>)
            : [entry],
      );
      if (values.length && !values.some((entry) => entry.value === value)) {
        throw new Error(
          `Invalid value '${value}' for config option '${configId}'`,
        );
      }
    }
    session.configOptions = await session.driver.setConfigOption(
      session.acpSessionId,
      configId,
      value,
      option,
    );
    if (
      option?.category === "model" ||
      configId === session.agentDefinition.modelConfigId ||
      configId === session.agentDefinition.models?.thinkingEffort?.configOption
    )
      session.modelSelection = undefined;
    return structuredClone(session.configOptions);
  }

  async setMode(sessionId: string, modeId: string) {
    const session = this.requireSession(sessionId);
    session.modes =
      (await session.driver.setMode(
        session.acpSessionId,
        modeId,
        session.configOptions,
        session.modes,
      )) ?? session.modes;
    return structuredClone(session.modes);
  }

  private async requestPermission(
    params: AcpPermissionRequest,
    agent: ManagedAgent,
  ) {
    const session = agent.sessions.get(params.sessionId);
    const options = params.options ?? [];
    const choose = (kind: string) =>
      options.find((option) => option.kind === kind);
    if (!session) return { outcome: { outcome: "cancelled" as const } };
    const policy = session.permissionPolicy;
    this.recordPromptActivity(session);
    const requestId = crypto.randomUUID();
    const raw = {
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options,
    };
    this.appendEvent(session, "permission_request", { requestId, ...raw }, raw);
    if (policy === "operator") {
      return await new Promise<{
        outcome:
          | { outcome: "selected"; optionId: string }
          | {
              outcome: "cancelled";
            };
      }>((resolve) => {
        session.pendingPermissions.set(requestId, {
          id: requestId,
          toolCall: params.toolCall,
          options,
          resolve,
        });
      });
    }
    const kind = (params.toolCall as { kind?: string | null } | undefined)
      ?.kind;
    const permit =
      policy === "allow_all" ||
      (policy === "read_only" &&
        ["read", "search", "fetch", "think"].includes(kind ?? ""));
    const option = permit
      ? (choose("allow_once") ?? choose("allow_always"))
      : (choose("reject_once") ?? choose("reject_always"));
    return {
      outcome: option
        ? { outcome: "selected" as const, optionId: option.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  beginPermissionContinuation(
    sessionId: string,
    leaseTimeoutMs: number,
  ): PendingPermissionSnapshot | undefined {
    const session = this.requireSession(sessionId);
    if (session.prompt?.state !== "running") return undefined;
    const pending = session.pendingPermissions.values().next().value as
      | PendingPermission
      | undefined;
    if (!pending) return undefined;

    this.clearPermissionLease(session);
    session.permissionLease = setTimeout(() => {
      session.permissionLease = undefined;
      const current = this.sessions.get(sessionId);
      if (
        current !== session ||
        current.prompt?.state !== "running" ||
        !current.pendingPermissions.has(pending.id)
      )
        return;
      void this.close(sessionId).catch(() => undefined);
    }, leaseTimeoutMs);

    return {
      id: pending.id,
      toolCall: structuredClone(pending.toolCall),
      options: structuredClone(pending.options),
    };
  }

  resolvePermission(sessionId: string, permissionId: string, optionId: string) {
    const session = this.requireSession(sessionId);
    const pending = session.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown permission request: ${permissionId}`);
    }
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`Invalid permission option: ${optionId}`);
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(permissionId);
    this.clearPermissionLease(session);
    return { permissionId, optionId, resolved: true };
  }

  private removeSession(session: ManagedSession): void {
    this.clearPermissionLease(session);
    for (const waiter of [...(this.configOptionWaiters.get(session.id) ?? [])])
      waiter.finish(session.configOptions);
    this.cancelPendingPermissions(session);
    this.sessions.delete(session.id);
    session.agent.sessions.delete(session.acpSessionId);
    session.agent.earlyUpdates.delete(session.acpSessionId);
    session.agent.closedSessionIds.add(session.acpSessionId);
    session.agent.closedSessionOrder.push(session.acpSessionId);
    while (session.agent.closedSessionOrder.length > 256) {
      const expired = session.agent.closedSessionOrder.shift();
      if (expired) session.agent.closedSessionIds.delete(expired);
    }
  }

  close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve();
    if (session.closePromise) return session.closePromise;
    session.closePromise = this.finishSessionClose(session);
    return session.closePromise;
  }

  private async finishSessionClose(session: ManagedSession): Promise<void> {
    if (session.prompt?.state === "running") {
      try {
        await this.cancelPrompt(session.id, session.prompt.id);
      } catch {
        /* Closing the ACP session remains authoritative. */
      }
    }
    this.removeSession(session);
    if (session.agent.closed) return;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeRequest = session.driver
      .closeSession(session.acpSessionId)
      .catch(() => undefined);
    await Promise.race([
      closeRequest,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, this.closeRequestTimeoutMs);
      }),
    ]);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
  }

  async closeAll(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.connectingAgents.values()]);
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
    const agents = [...this.managedAgents.values()];
    await Promise.allSettled(agents.map((agent) => this.closeAgent(agent)));
  }
}
