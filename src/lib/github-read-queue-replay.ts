import { DEFAULT_GH_READ_CADENCE_S, ghReadCadenceDecision } from "./github-transport.js";

/** Source-only replay. Existing transport already coalesces argv and queues async cadence/file
 * locks. Reuse its pure floor decision here; no transport registration, I/O, timers or activation.
 * The latest-arrival baseline is synthetic, NOT the production queue's policy. */
export interface GithubReadReplayOptions {
  readonly enabled: boolean;
  readonly maxPending: number;
  readonly maxClientsPerRead: number;
  readonly maxRecords: number;
  readonly maxClients: number;
  readonly maxWaitMs: number;
  readonly agingMs: number;
}
export const GITHUB_READ_REPLAY_DEFAULTS: Readonly<GithubReadReplayOptions> = Object.freeze({
  enabled: false, maxPending: 32, maxClientsPerRead: 16, maxRecords: 256, maxClients: 1024,
  maxWaitMs: 8 * 60_000, agingMs: 2 * DEFAULT_GH_READ_CADENCE_S * 1000,
});

/** Finite, non-executable fixture descriptors. Certification authorizes no real command or API. */
export const CERTIFIED_REPLAY_READ_DESCRIPTORS = Object.freeze({
  "failed-job-diagnostic": Object.freeze({ effect: "READ", execution: "none" }),
  "pull-request-checks": Object.freeze({ effect: "READ", execution: "none" }),
  "pull-request-view": Object.freeze({ effect: "READ", execution: "none" }),
});
export interface ReplayReadIdentity {
  readonly repository: string;
  readonly authScope: string;
  readonly exactHead: string;
  readonly request: keyof typeof CERTIFIED_REPLAY_READ_DESCRIPTORS;
  readonly inputId: string;
}
export interface ReplayReadRequest {
  readonly readId: string;
  readonly clientId: string;
  readonly operation: "READ" | "WRITE";
  readonly identity: ReplayReadIdentity;
  readonly diagnostic?: boolean;
  readonly timeoutMs?: number;
}
export type ReplayObservation = {
  readonly kind: "complete" | "partial";
  readonly identity: ReplayReadIdentity;
  readonly corpusId: string;
  readonly bodyId: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
} | { readonly kind: "http-error" | "closed" | "harness-config-refusal" }
  | { readonly kind: "secondary-limit"; readonly retryAfterMs: number };
type CompleteObservation = Extract<ReplayObservation, { kind: "complete" | "partial" }>;
export interface ReplayOrigin {
  readonly evidence: "deterministic-replay-only";
  readonly identity: Readonly<ReplayReadIdentity>;
  readonly readyAtMs: number;
  readonly readyExpiresAtMs: number;
  readonly admittedAtMs: number;
  readonly observation?: Readonly<CompleteObservation>;
}
export type ReplayReason = ReplayObservation["kind"] | "replay-disabled" | "mutation-refused"
  | "malformed-request" | "malformed-observation" | "invalid-wait-bound" | "client-id-reused"
  | "read-id-reused" | "client-bound" | "queue-bound" | "history-record-bound" | "history-client-bound"
  | "invalid-owner" | "active-owner" | "secondary-backoff" | "cadence-floor" | "no-ready-read"
  | "client-expired" | "read-admission-expired" | "client-cancelled" | "owner-cancelled"
  | "identity-mismatch" | "observation-time-invalid" | "observation-expired" | "missing-client" | "pending";
export interface ReplayReceipt {
  readonly status: "KNOWN" | "UNKNOWN";
  readonly reason: ReplayReason;
  /** An admission is not evidence of an attempted HTTP call, even inside a replay. */
  readonly replayReadAdmitted: boolean;
  readonly origin?: Readonly<ReplayOrigin>;
}
interface Client {
  readonly deadlineMs: number;
  readonly readyAtMs: number;
  readonly read: Read;
  admittedAtMs?: number;
  settledAtMs?: number;
  receipt?: Readonly<ReplayReceipt>;
}
interface Read {
  readonly id: string;
  readonly key: string;
  readonly identity: Readonly<ReplayReadIdentity>;
  readonly readyAtMs: number;
  readonly readyExpiresAtMs: number;
  readonly sequence: number;
  readonly diagnostic: boolean;
  readonly clients: Client[];
  state: "READY" | "ACTIVE" | "DONE";
  owner?: string;
  admittedAtMs?: number;
}

const identityFields = ["repository", "authScope", "exactHead", "request", "inputId"] as const;
const label = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
  && !/^(?:gh[pousr]_|github_pat_)/.test(value);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Validate descriptors, never read input properties. No inherited keys, accessors or symbols.
 * Snapshot only the explicit whitelist; a revoked/malformed proxy is a refusal, not a crash.
 * This is a data contract, not a sandbox for hostile JavaScript running in the caller's process. */
function ownPlainData(input: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
  try {
    if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) return undefined;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      snapshot[key as string] = descriptor.value;
    }
    if (required.some((key) => !Object.hasOwn(snapshot, key))) return undefined;
    return Object.freeze(snapshot);
  } catch {
    // Malformed shapes and failed reflective/proxy inspection have the same remedy: resubmit
    // plain whitelisted metadata. Every caller refuses this input; request/observation callers
    // emit fixed malformed-* UNKNOWN receipts. Exception text adds no remedy and may hold secrets.
    return undefined;
  }
}
function snapshotIdentity(input: unknown): Readonly<ReplayReadIdentity> | undefined {
  const data = ownPlainData(input, identityFields);
  if (!data || !identityFields.every((field) => label(data[field]))) return undefined;
  if (!Object.hasOwn(CERTIFIED_REPLAY_READ_DESCRIPTORS, data.request as string)) return undefined;
  return Object.freeze({
    repository: data.repository as string, authScope: data.authScope as string, exactHead: data.exactHead as string,
    request: data.request as ReplayReadIdentity["request"], inputId: data.inputId as string,
  });
}
const identityKey = (id: ReplayReadIdentity): string => JSON.stringify(identityFields.map((field) => id[field]));
function snapshotObservation(input: unknown): Readonly<ReplayObservation> | undefined {
  const data = ownPlainData(input, ["kind"], ["identity", "corpusId", "bodyId", "observedAtMs", "expiresAtMs", "retryAfterMs"]);
  if (!data) return undefined;
  if (data.kind === "complete" || data.kind === "partial") {
    if (Object.keys(data).length !== 6) return undefined;
    const identity = snapshotIdentity(data.identity);
    if (!identity || !label(data.corpusId) || !label(data.bodyId) || !nonnegative(data.observedAtMs) || !nonnegative(data.expiresAtMs)) return undefined;
    return Object.freeze({ kind: data.kind, identity, corpusId: data.corpusId, bodyId: data.bodyId,
      observedAtMs: data.observedAtMs, expiresAtMs: data.expiresAtMs });
  }
  if (data.kind === "secondary-limit") {
    if (Object.keys(data).length !== 2 || !positive(data.retryAfterMs)) return undefined;
    return Object.freeze({ kind: data.kind, retryAfterMs: data.retryAfterMs });
  }
  if (Object.keys(data).length === 1 && (data.kind === "http-error" || data.kind === "closed" || data.kind === "harness-config-refusal")) {
    return Object.freeze({ kind: data.kind });
  }
  return undefined;
}
const unknown = (reason: ReplayReason, read?: Read): Readonly<ReplayReceipt> => Object.freeze({
  status: "UNKNOWN", reason, replayReadAdmitted: read?.admittedAtMs !== undefined,
});

/** Finite retained history: never evict DONE IDs to recycle READY history, and never adapt capacity
 * from a harness refusal. Owners/client IDs and virtual time are trusted replay labels, not auth. */
export class GithubReadQueueReplay {
  private readonly options: Readonly<GithubReadReplayOptions>;
  private readonly reads = new Map<string, Read>();
  private readonly clients = new Map<string, Client>();
  private nowMs = 0;
  private lastReadMs?: number;
  private backoffUntilMs = 0;
  private replayReadAdmissions = 0;
  private replayPotentialCoalescedClients = 0;
  private replaySecondaryLimitSamples = 0;
  private readonly replayAdmissionWaitMs: number[] = [];

  constructor(options: unknown = {}, private readonly policy: "fair" | "latest-arrival-baseline" = "fair") {
    const data = ownPlainData(options, [], Object.keys(GITHUB_READ_REPLAY_DEFAULTS));
    if (!data || Object.entries(data).some(([key, value]) => key === "enabled" ? typeof value !== "boolean" : !positive(value))
      || (policy !== "fair" && policy !== "latest-arrival-baseline")) throw new Error("invalid replay options");
    this.options = Object.freeze({ ...GITHUB_READ_REPLAY_DEFAULTS, ...data });
  }

  /** A malformed/backwards virtual clock is a fixed caller error and never advances state. */
  private advance(nowMs: number): void {
    if (!nonnegative(nowMs) || nowMs < this.nowMs) throw new Error("replay time must be monotonic");
    this.nowMs = nowMs;
    for (const client of this.clients.values()) {
      if (client.receipt) continue;
      const readExpiry = client.read.state === "READY" ? client.read.readyExpiresAtMs : Infinity;
      const deadline = Math.min(client.deadlineMs, readExpiry);
      if (nowMs >= deadline) {
        client.receipt = unknown(readExpiry <= client.deadlineMs ? "read-admission-expired" : "client-expired", client.read);
        client.settledAtMs = deadline;
      }
    }
    for (const read of this.reads.values()) {
      // READY expiry never steals or releases an ACTIVE owner's work, even with no clients left.
      if (read.state === "READY" && read.clients.every((c) => c.receipt)) read.state = "DONE";
    }
  }

  submit(input: unknown, nowMs: number) {
    this.advance(nowMs);
    if (!this.options.enabled) return unknown("replay-disabled");
    const data = ownPlainData(input, ["readId", "clientId", "operation", "identity"], ["diagnostic", "timeoutMs"]);
    if (!data) return unknown("malformed-request");
    if (data.operation === "WRITE") return unknown("mutation-refused");
    const identity = snapshotIdentity(data.identity);
    if (data.operation !== "READ" || !identity || !label(data.readId) || !label(data.clientId)
      || (Object.hasOwn(data, "diagnostic") && typeof data.diagnostic !== "boolean")) return unknown("malformed-request");
    const waitMs = Object.hasOwn(data, "timeoutMs") ? data.timeoutMs : this.options.maxWaitMs;
    if (!positive(waitMs) || waitMs > this.options.maxWaitMs
      || !Number.isSafeInteger(nowMs + waitMs) || !Number.isSafeInteger(nowMs + this.options.maxWaitMs)) return unknown("invalid-wait-bound");
    if (this.clients.has(data.clientId)) return unknown("client-id-reused");
    const key = identityKey(identity);
    const namedRead = this.reads.get(data.readId);
    if (namedRead && (namedRead.state === "DONE" || namedRead.key !== key)) return unknown("read-id-reused");
    let read = [...this.reads.values()].find((r) => r.state !== "DONE" && r.key === key);
    const coalesced = read !== undefined;
    if (read && read.clients.length >= this.options.maxClientsPerRead) return unknown("client-bound");
    if (this.clients.size >= this.options.maxClients) return unknown("history-client-bound");
    if (!read) {
      if (this.reads.size >= this.options.maxRecords) return unknown("history-record-bound");
      if ([...this.reads.values()].filter((r) => r.state !== "DONE").length >= this.options.maxPending) return unknown("queue-bound");
      read = {
        id: data.readId, key, identity, readyAtMs: nowMs, readyExpiresAtMs: nowMs + this.options.maxWaitMs,
        sequence: this.reads.size, diagnostic: data.diagnostic === true, clients: [], state: "READY",
      };
      this.reads.set(read.id, read);
    } else {
      this.replayPotentialCoalescedClients++;
    }
    const client: Client = { deadlineMs: nowMs + waitMs, readyAtMs: nowMs, read };
    if (read.state === "ACTIVE") {
      client.admittedAtMs = nowMs;
      this.replayAdmissionWaitMs.push(0);
    }
    read.clients.push(client);
    this.clients.set(data.clientId, client);
    return Object.freeze({ state: read.state, readId: read.id, readyAtMs: read.readyAtMs,
      readyExpiresAtMs: read.readyExpiresAtMs, coalesced });
  }

  admit(owner: string, nowMs: number) {
    this.advance(nowMs);
    if (!this.options.enabled) return unknown("replay-disabled");
    if (!label(owner)) return unknown("invalid-owner");
    if ([...this.reads.values()].some((r) => r.state === "ACTIVE")) return unknown("active-owner");
    if (nowMs < this.backoffUntilMs) return unknown("secondary-backoff");
    if (!ghReadCadenceDecision({ isWrite: false, isExempt: false, mode: "enforce", nowMs,
      lastReadMs: this.lastReadMs }).allow) return unknown("cadence-floor");
    const ready = [...this.reads.values()].filter((r) => r.state === "READY");
    ready.sort((a, b) => {
      if (this.policy === "latest-arrival-baseline") return b.sequence - a.sequence;
      const aAged = nowMs - a.readyAtMs >= this.options.agingMs;
      const bAged = nowMs - b.readyAtMs >= this.options.agingMs;
      if (aAged !== bAged) return aAged ? -1 : 1;
      if (!aAged && a.diagnostic !== b.diagnostic) return a.diagnostic ? -1 : 1;
      return a.readyAtMs - b.readyAtMs || a.sequence - b.sequence;
    });
    const read = ready[0];
    if (!read) return unknown("no-ready-read");
    read.state = "ACTIVE";
    read.owner = owner;
    read.admittedAtMs = nowMs;
    this.lastReadMs = nowMs;
    this.replayReadAdmissions++;
    const attached = read.clients.filter((c) => !c.receipt);
    for (const client of attached) client.admittedAtMs = nowMs;
    this.replayAdmissionWaitMs.push(...attached.map((c) => nowMs - c.readyAtMs));
    return Object.freeze({ state: "ACTIVE" as const, readId: read.id, owner, readyAtMs: read.readyAtMs,
      readyExpiresAtMs: read.readyExpiresAtMs, admittedAtMs: nowMs });
  }

  cancelClient(clientId: string, nowMs: number): boolean {
    this.advance(nowMs);
    const client = this.clients.get(clientId);
    if (!client || client.receipt) return false;
    client.receipt = unknown("client-cancelled", client.read);
    client.settledAtMs = nowMs;
    return true;
  }

  cancelOwner(readId: string, owner: string, nowMs: number): boolean {
    this.advance(nowMs);
    const read = this.reads.get(readId);
    if (!read || read.state !== "ACTIVE" || read.owner !== owner) return false;
    this.finish(read, "owner-cancelled", undefined, nowMs);
    return true;
  }

  complete(readId: string, owner: string, input: unknown, nowMs: number): boolean {
    this.advance(nowMs);
    const read = this.reads.get(readId);
    if (!read || read.state !== "ACTIVE" || read.owner !== owner) return false;
    const observation = snapshotObservation(input);
    let reason: ReplayReason = observation?.kind ?? "malformed-observation";
    if (observation?.kind === "complete" || observation?.kind === "partial") {
      if (identityKey(observation.identity) !== read.key) reason = "identity-mismatch";
      else if (observation.observedAtMs < read.admittedAtMs! || observation.observedAtMs > nowMs) reason = "observation-time-invalid";
      else if (observation.expiresAtMs <= nowMs) reason = "observation-expired";
    }
    if (observation?.kind === "secondary-limit") {
      const until = nowMs + Math.max(DEFAULT_GH_READ_CADENCE_S * 1000, observation.retryAfterMs);
      if (!Number.isSafeInteger(until)) reason = "malformed-observation";
      else {
        this.replaySecondaryLimitSamples++;
        this.backoffUntilMs = Math.max(this.backoffUntilMs, until);
      }
    }
    this.finish(read, reason, observation, nowMs);
    return true;
  }

  private finish(read: Read, reason: ReplayReason, observation: Readonly<ReplayObservation> | undefined, nowMs: number): void {
    const observed = observation?.kind === "complete" || observation?.kind === "partial" ? observation : undefined;
    const origin: Readonly<ReplayOrigin> = Object.freeze({ evidence: "deterministic-replay-only",
      identity: read.identity, readyAtMs: read.readyAtMs, readyExpiresAtMs: read.readyExpiresAtMs,
      admittedAtMs: read.admittedAtMs!, observation: observed });
    const receipt: Readonly<ReplayReceipt> = Object.freeze({
      status: reason === "complete" ? "KNOWN" : "UNKNOWN", reason, replayReadAdmitted: true, origin,
    });
    read.state = "DONE";
    for (const client of read.clients) if (!client.receipt) {
      client.receipt = receipt;
      client.settledAtMs = nowMs;
    }
  }

  receipt(clientId: string, nowMs: number, expectedInput?: unknown): Readonly<ReplayReceipt> {
    this.advance(nowMs);
    const client = this.clients.get(clientId);
    if (!client) return unknown("missing-client");
    const receipt = client.receipt ?? unknown("pending", client.read);
    if (receipt.status !== "KNOWN") return receipt;
    if (expectedInput !== undefined) {
      const expected = snapshotIdentity(expectedInput);
      if (!expected || identityKey(expected) !== client.read.key) return Object.freeze({ ...receipt, status: "UNKNOWN", reason: "identity-mismatch" });
    }
    if (receipt.origin!.observation!.expiresAtMs <= nowMs) return Object.freeze({ ...receipt, status: "UNKNOWN", reason: "observation-expired" });
    return receipt;
  }

  report(nowMs: number) {
    this.advance(nowMs);
    const replayWorstObservedWaitByScopeMs: Record<string, number> = {};
    for (const client of this.clients.values()) {
      const scope = JSON.stringify([client.read.identity.repository, client.read.identity.authScope]);
      const end = client.admittedAtMs ?? client.settledAtMs ?? Math.min(nowMs, client.deadlineMs);
      replayWorstObservedWaitByScopeMs[scope] = Math.max(replayWorstObservedWaitByScopeMs[scope] ?? 0, Math.max(0, end - client.readyAtMs));
    }
    return Object.freeze({ evidence: "deterministic-replay-only" as const, policy: this.policy,
      replayReadAdmissions: this.replayReadAdmissions, replayPotentialCoalescedClients: this.replayPotentialCoalescedClients,
      replaySecondaryLimitSamples: this.replaySecondaryLimitSamples,
      replayAdmissionWaitMs: Object.freeze([...this.replayAdmissionWaitMs]),
      replayWorstObservedWaitByScopeMs: Object.freeze(replayWorstObservedWaitByScopeMs),
      replayRetainedRecords: this.reads.size, replayMaxRecords: this.options.maxRecords,
      replayRetainedClients: this.clients.size, replayMaxClients: this.options.maxClients,
      replayMaxPending: this.options.maxPending, replayCadenceFloorMs: DEFAULT_GH_READ_CADENCE_S * 1000,
      replayBackoffUntilMs: this.backoffUntilMs });
  }
}
