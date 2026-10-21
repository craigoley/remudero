import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";
import { escalateAsync, type AsyncIssueGateway, type Escalation } from "./escalate.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

/**
 * 2026-10-10/11 -- HOST-SIDE ALERTS WENT NOWHERE. The Azure host's service user has no GitHub
 * credential (`gh auth status`: not logged in), so every escalation raised OUTSIDE the daemon
 * containers -- `rmd deploy-run`'s refusal issue, the `rmd live-edits` restore notice -- either died
 * on an unreadable dedup read or was never attempted. Core sat stuck about six hours and no human
 * was told. The daemon, which mints the fleet App's installation token, can post; the host cannot.
 *
 * THE SPOOL CARRIES THE ALERT ACROSS THAT BOUNDARY. A host-side producer that cannot post writes the
 * escalation (or the close/comment it owes an open issue) to `<state>/escalation-spool/<key>.json`,
 * the state dir both sides share: the host's `$STATE_DIR/state` is the container's
 * `/home/node/Remudero/state`. The daemon drains it on every freshness read and posts through the
 * same `escalate` transport and dedup as its own issues. One file per key, so a condition re-raised
 * every tick is one entry with a count, never a queue of copies. When the daemon cannot drain it,
 * `scripts/fleet-heartbeat.sh` publishes the undrained entries and the off-host heartbeat watch
 * raises them. No new credential lands on the host.
 *
 * 2026-10-15 (W1-T9625): THE ONE ALERT THE DAEMON CANNOT CARRY IS ITS OWN DEATH. A crash-loop
 * escalation raised while the daemon's container is down is posted by `rmd host-alert` itself, with
 * the credential the host already holds (launcher-host-alerts.ts), and recorded here as delivered
 * (recordHostDeliveredEscalation) so this drain never posts it twice.
 */
export const ESCALATION_SPOOL_DIRNAME = "escalation-spool";
/** The daemon's last drain pass: ISO start time on line 1. Plain text, so bash can read it. */
export const ESCALATION_SPOOL_DRAIN_PASS = ".drain-pass";
const DELIVERED_DIRNAME = "delivered";
const HEADLINE_CHARS = 240;

export const HOST_ESCALATION_STEPS = {
  spooled: "host_escalation.spooled",
  delivered: "host_escalation.delivered",
  drainFailed: "host_escalation.drain_failed",
  withdrawn: "host_escalation.withdrawn",
} as const;

export type SpoolActionKind = "close" | "comment";

interface SpoolEntryBase {
  v: 1;
  key: string;
  /** The host-side producer, e.g. `deploy-run` or `live-edits`. */
  source: string;
  host: string;
  firstAt: string;
  lastAt: string;
  count: number;
  /** One line, no quotes or backslashes, so the heartbeat's grep can publish it verbatim. */
  headline: string;
  /** Why the producer spooled rather than posted, when it tried. */
  directError?: string;
}
export type SpoolEntry =
  | (SpoolEntryBase & { kind: "escalate"; escalation: Escalation })
  | (SpoolEntryBase & { kind: SpoolActionKind; url: string; body: string });

export interface SpoolMeta {
  source: string;
  host: string;
  clock: Clock;
  directError?: string;
}

export function escalationSpoolDir(stateDir: string): string {
  return join(stateDir, ESCALATION_SPOOL_DIRNAME);
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Stable per condition: `escalate` dedups on the same task id and title, so the spool does too. */
export function escalationSpoolKey(e: Pick<Escalation, "taskId" | "summary">): string {
  return `escalate-${digest(e.taskId, e.summary)}`;
}

function actionKey(kind: SpoolActionKind, url: string, body: string): string {
  return kind === "close" ? `close-${digest(url)}` : `comment-${digest(url, body)}`;
}

function headline(source: string, text: string): string {
  return `${source}: ${text}`.replace(/["\\\s]+/g, " ").trim().slice(0, HEADLINE_CHARS);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined; // absent; a torn write cannot exist (every write is a rename)
  }
}

/** Written whole and renamed into place: the other side never reads a half-written entry. */
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, body, { flush: true });
  renameSync(tmp, path);
}

function ledger(stateDir: string, taskId: string, step: string, extra: Record<string, unknown>): void {
  appendLedger(join(stateDir, LEDGER_FILENAME), { run_id: "HOST-ESCALATION", task_id: taskId, step, ...extra });
}

function upsert(stateDir: string, next: SpoolEntry, taskId: string): void {
  const dir = escalationSpoolDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${next.key}.json`);
  const prior = readJson<SpoolEntry>(path);
  const directError = next.directError ?? prior?.directError;
  const entry = prior ? { ...next, firstAt: prior.firstAt, count: prior.count + 1, ...(directError ? { directError } : {}) } : next;
  writeAtomic(path, `${JSON.stringify(entry)}\n`);
  if (!prior) ledger(stateDir, taskId, HOST_ESCALATION_STEPS.spooled, { key: next.key, kind: next.kind, source: next.source, direct_error: next.directError ?? null });
}

function base(key: string, meta: SpoolMeta, text: string): SpoolEntryBase {
  const now = meta.clock.iso();
  return {
    v: 1, key, source: meta.source, host: meta.host, firstAt: now, lastAt: now, count: 1, headline: headline(meta.source, text),
    ...(meta.directError ? { directError: meta.directError } : {}),
  };
}

interface Delivered {
  url?: string;
  /** Digest of the delivered detail: the same detail again has nothing new to tell the issue. */
  detail?: string;
}

function delivered(stateDir: string, e: Pick<Escalation, "taskId" | "summary">): Delivered {
  return readJson<Delivered>(join(escalationSpoolDir(stateDir), DELIVERED_DIRNAME, `${escalationSpoolKey(e)}.json`)) ?? {};
}

/** The issue the daemon opened for this condition, once it has: `""` while it is still spooled. */
export function deliveredEscalationUrl(stateDir: string, e: Pick<Escalation, "taskId" | "summary">): string {
  return delivered(stateDir, e).url ?? "";
}

/**
 * Queue one escalation for the daemon to post, unless the daemon already delivered this exact text.
 * A changed detail is a new observation, so it is (re)spooled and lands as a comment through
 * `escalate`'s dedup. Returns the issue URL once the daemon has delivered this condition, so a caller
 * that tracks its issue (the deploy refusal streak, the ladder) learns it on its next pass.
 */
export function spoolEscalation(stateDir: string, e: Escalation, meta: SpoolMeta): string {
  const prior = delivered(stateDir, e);
  if (prior.url && prior.detail === digest(e.detail)) return prior.url;
  upsert(stateDir, { ...base(escalationSpoolKey(e), meta, e.summary), kind: "escalate", escalation: e }, e.taskId);
  return prior.url ?? "";
}

/**
 * The memory budget's starvation alert (host-memory-admission.ts, OPERATOR RULING 2026-10-19 (3)) as a sink run-task
 * installs: spooled for the daemon's drain under the state root's own state directory, which it never creates.
 */
export function spoolingStarvationAlert(meta: Omit<SpoolMeta, "directError">): (root: string, e: Escalation) => void {
  return (root, e) => {
    const stateDir = join(root, "state");
    if (!existsSync(stateDir)) throw Object.assign(new Error(`ENOENT: ${stateDir}`), { code: "ENOENT" });
    spoolEscalation(stateDir, e, meta);
  };
}

/**
 * W1-T9625 -- the HOST posted this escalation itself (`rmd host-alert`, while the daemon that drains
 * the spool was down). Recorded exactly as the drain records its own delivery: the delivered record
 * the daemon's drain and spoolEscalation read, so neither posts it again, and the pending entry is
 * dropped. A drain already mid-post meanwhile lands on the same title, where `escalate`'s dedup
 * turns it into a comment on this issue, never a second one.
 */
export function recordHostDeliveredEscalation(stateDir: string, e: Escalation, url: string, meta: SpoolMeta): void {
  const key = escalationSpoolKey(e);
  const dir = escalationSpoolDir(stateDir);
  mkdirSync(join(dir, DELIVERED_DIRNAME), { recursive: true });
  writeAtomic(join(dir, DELIVERED_DIRNAME, `${key}.json`), `${JSON.stringify({ url, detail: digest(e.detail), deliveredAt: meta.clock.iso(), by: meta.source })}\n`);
  rmSync(join(dir, `${key}.json`), { force: true });
  ledger(stateDir, e.taskId, HOST_ESCALATION_STEPS.delivered, { key, kind: "escalate", source: meta.source, issue_url: url, direct: true });
}

/** Queue a close or a comment on an issue the host cannot reach. A close also drops any still-spooled
 *  observation of that issue's condition: posted after the close, it would only reopen it. */
export function spoolIssueAction(stateDir: string, action: { kind: SpoolActionKind; url: string; body: string }, meta: SpoolMeta): void {
  const dir = escalationSpoolDir(stateDir);
  if (action.kind === "close") {
    for (const name of deliveredNamesFor(dir, action.url)) {
      if (!readJson(join(dir, name))) continue;
      rmSync(join(dir, name), { force: true });
      ledger(stateDir, "HOST-ESCALATION", HOST_ESCALATION_STEPS.withdrawn, { key: name.replace(/\.json$/, ""), closed: action.url });
    }
  }
  const key = actionKey(action.kind, action.url, action.body);
  upsert(stateDir, { ...base(key, meta, `${action.kind} ${action.url}`), ...action }, "HOST-ESCALATION");
}

/**
 * The condition cleared on the host. A still-spooled escalation is dropped (nobody was told, and
 * there is nothing left to tell); one the daemon already opened gets a spooled close citing why.
 */
export function withdrawSpooledEscalation(stateDir: string, e: Pick<Escalation, "taskId" | "summary">, comment: string, meta: SpoolMeta): void {
  const key = escalationSpoolKey(e);
  const pending = join(escalationSpoolDir(stateDir), `${key}.json`);
  if (readJson(pending)) {
    rmSync(pending, { force: true });
    ledger(stateDir, e.taskId, HOST_ESCALATION_STEPS.withdrawn, { key });
  }
  const url = deliveredEscalationUrl(stateDir, e);
  if (url) spoolIssueAction(stateDir, { kind: "close", url, body: comment }, meta);
}

/** The ladder's `escalate`/`comment` for a host actor: both land in the spool. */
export function spoolingIssueVoice(stateDir: string, meta: SpoolMeta): {
  escalate: (e: Escalation) => Promise<string>;
  comment: (url: string, body: string) => Promise<void>;
} {
  return {
    escalate: async (e) => spoolEscalation(stateDir, e, meta),
    comment: async (url, body) => spoolIssueAction(stateDir, { kind: "comment", url, body }, meta),
  };
}

export interface SpoolDrainResult {
  delivered: number;
  failed: number;
}

export interface SpoolPoster {
  /** Opens (or dedups onto) the issue; returns its URL, or `""` when none was opened. */
  escalate: (e: Escalation) => Promise<string>;
  close: (url: string, body: string) => Promise<void>;
  comment: (url: string, body: string) => Promise<void>;
  clock: Clock;
}

function provenance(entry: SpoolEntry): string {
  return (
    `\n\n---\nRaised on the host by \`${entry.source}\` on ${entry.host} (first ${entry.firstAt}, latest ${entry.lastAt}, ` +
    `seen ${entry.count} time(s)). The host has no GitHub credential, so it was spooled under ` +
    `\`<state>/${ESCALATION_SPOOL_DIRNAME}/\` and posted by the daemon.` +
    (entry.directError ? ` The host's own attempt failed: ${entry.directError.slice(0, 300)}` : "")
  );
}

/** The last error logged per key, so a failing entry writes one ledger row per distinct error. */
const loggedFailures = new Map<string, string>();

/**
 * Post every spooled entry once. Never throws. An entry leaves the spool only after GitHub took it,
 * and only if the host did not re-spool it meanwhile (a newer observation is posted next pass, where
 * `escalate`'s own dedup turns it into a comment). Records the pass's start for the heartbeat.
 */
export async function drainEscalationSpool(stateDir: string, d: SpoolPoster): Promise<SpoolDrainResult> {
  const dir = escalationSpoolDir(stateDir);
  const result: SpoolDrainResult = { delivered: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return result; // no spool yet: nothing has ever been spooled on this state dir
  }
  const startedAt = d.clock.iso();
  for (const name of names) {
    const path = join(dir, name);
    const entry = readJson<SpoolEntry>(path);
    if (!entry) {
      // Withdrawn since the listing, or not an entry this drain can read: the latter stays visible
      // to the heartbeat and is counted here, never silently skipped.
      if (existsSync(path)) {
        result.failed += 1;
        logFailure(stateDir, name, "HOST-ESCALATION", { kind: "unknown", source: "unknown" }, "unreadable spool entry");
      }
      continue;
    }
    const taskId = entry.kind === "escalate" ? entry.escalation.taskId : "HOST-ESCALATION";
    try {
      let url: string;
      if (entry.kind === "escalate") {
        url = await d.escalate({ ...entry.escalation, detail: entry.escalation.detail + provenance(entry) });
        if (!url) throw new Error("escalate opened no issue (its dedup read was unreadable, or it refused)");
        mkdirSync(join(dir, DELIVERED_DIRNAME), { recursive: true });
        writeAtomic(join(dir, DELIVERED_DIRNAME, name), `${JSON.stringify({ url, detail: digest(entry.escalation.detail), deliveredAt: d.clock.iso() })}\n`);
      } else {
        url = entry.url;
        await (entry.kind === "close" ? d.close(url, entry.body) : d.comment(url, entry.body));
        if (entry.kind === "close") forgetDelivered(dir, url);
      }
      const now = readJson<SpoolEntry>(path);
      if (now && now.lastAt === entry.lastAt && now.count === entry.count) rmSync(path, { force: true });
      loggedFailures.delete(entry.key);
      result.delivered += 1;
      ledger(stateDir, taskId, HOST_ESCALATION_STEPS.delivered, { key: entry.key, kind: entry.kind, source: entry.source, issue_url: url, spooled_count: entry.count, first_spooled_at: entry.firstAt });
    } catch (e) {
      // Kept in the spool and ledgered as host_escalation.drain_failed; the next pass retries it.
      result.failed += 1;
      logFailure(stateDir, entry.key, taskId, entry, String((e as Error)?.message ?? e));
    }
  }
  writeAtomic(join(dir, ESCALATION_SPOOL_DRAIN_PASS), `${startedAt}\ndelivered=${result.delivered}\nfailed=${result.failed}\n`);
  return result;
}

function logFailure(stateDir: string, key: string, taskId: string, entry: { kind: string; source: string }, error: string): void {
  if (loggedFailures.get(key) === error) return;
  loggedFailures.set(key, error);
  ledger(stateDir, taskId, HOST_ESCALATION_STEPS.drainFailed, { key, kind: entry.kind, source: entry.source, error });
}

/** The delivered records (named like their spool entries) that hold `url`. */
function deliveredNamesFor(dir: string, url: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, DELIVERED_DIRNAME));
  } catch {
    return []; // nothing delivered on this state dir yet
  }
  return names.filter((name) => readJson<Delivered>(join(dir, DELIVERED_DIRNAME, name))?.url === url);
}

/** A closed issue's delivered record is spent: the next episode of that condition opens afresh. */
function forgetDelivered(dir: string, url: string): void {
  for (const name of deliveredNamesFor(dir, url)) rmSync(join(dir, DELIVERED_DIRNAME, name), { force: true });
}

/** The daemon's drain, speaking as the fleet through the needs-human transport. */
export function escalationSpoolDrain(w: { stateDir: string; ledgerPath: string; issues: () => AsyncIssueGateway; clock: Clock }): () => Promise<SpoolDrainResult> {
  return () => drainEscalationSpool(w.stateDir, {
    clock: w.clock,
    escalate: (e) => escalateAsync(e, { issues: w.issues(), ledgerPath: w.ledgerPath, runId: e.runId ?? e.taskId }),
    close: async (url, body) => {
      const issues = w.issues();
      if (!issues.closeWithComment) throw new Error("issue gateway cannot close issues");
      await issues.closeWithComment(url, body);
    },
    comment: async (url, body) => {
      const issues = w.issues();
      if (!issues.comment) throw new Error("issue gateway cannot comment");
      await issues.comment(url, body);
    },
  });
}

/** Run the drain beside a periodic read (the daemon's freshness read), one pass at a time. */
export function withEscalationSpoolDrain<T>(read: () => Promise<T>, drain: () => Promise<unknown>): () => Promise<T> {
  let running = false;
  return async () => {
    const value = await read();
    if (running) return value;
    running = true;
    try {
      await drain();
    } catch {
      // The drain never throws by design; a fault here (an unwritable state dir) leaves the spool in
      // place for the next read and must never fail the read it rides beside.
    } finally {
      running = false;
    }
    return value;
  };
}
