import {
  appendFileSync,
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { ExternalEffectResult } from "./action-reconciliation.js";
import { defaultIsPidAlive, parseDrainLockInfo, type DrainLockInfo } from "./drain-lock.js";
import { sameHost } from "./host-identity.js";
import { isHolderStale, reclaimStaleLock, writeAtomic, type FileIdentity } from "./fs-race-safe.js";
import { LEDGER_CARRIED_PREFIX_SUFFIX, LEDGER_FILENAME, LEDGER_RETAINED_STEPS_SUFFIX } from "./ledger-path.js";
import { assertLedgerPathNotLive } from "./live-write-guard.js";
import { isValidRetainedStepsMetadata, rotationStampIso } from "./ledger-union.js";
import { PLAN_ONLY_REVIEW_MARKER_STEP, planOnlyReviewMarkers, PR_TERMINAL_STEP, pruneCarriedRows } from "./ledger-carry.js";
import { resolveProducerIdentity, type ProducerIdentity } from "./producer-identity.js";
import { WORKER_SCOPE_ENV, readGardenerOrigin } from "./worker-containment.js";
import {
  assertStateRestorePaths, isEngineDependencyLinkPath, preserveEngineDependencyLinks,
  restoreEngineDependencyLinks, validateEngineDependencyLinks, ENGINE_LINK_MANIFEST,
  engineTreePath, isEngineEvidenceName, omitVanishedEngines, stateEntryVanished,
} from "./state-backup-engine-links.js";

/** Append-only NDJSON ledger (MASTER-PLAN §9). One JSON object per line, keyed by task id; `ts` and
 *  `host` are stamped at write time. Every worker and brain-plane call spreads the same telemetry
 *  shape onto its line via {@link import("./worker.js").workerLedgerFields} (W1-T6). */
export interface LedgerLine {
  run_id: string;
  task_id: string;
  step: string;
  [k: string]: unknown;
}

export const EXTERNAL_EFFECT_RECONCILED_STEP = "external_effect.reconciled" as const;

/** The durable, redacted projection of an external-effect truth read. */
export interface ExternalEffectLedgerIdentity {
  runId: string;
  taskId: string;
}

/** Append reconciliation evidence without allowing a connector's raw response into the ledger. */
export function appendExternalEffectLedger(
  path: string,
  identity: ExternalEffectLedgerIdentity,
  effect: ExternalEffectResult,
  opts: { ceilingBytes?: number; identity?: () => string; actor?: () => LedgerActor } = {},
): void {
  appendLedger(path, {
    run_id: identity.runId,
    task_id: identity.taskId,
    step: EXTERNAL_EFFECT_RECONCILED_STEP,
    external_effect: effect,
    reconciliation_state: effect.reconciliationState,
    action_id: effect.originatingActionId,
    capability_grant_id: effect.capabilityGrantId,
    evidence_reference: effect.evidenceReference,
  }, opts);
}

/** worker.ts ClaudeToolchainBlockedError, duck-typed by tag to keep the "fs + JSON only" contract.
 * The SDK never launched: no worker ran or was billed, so {@link isRealStrike} excludes it.
 * Trap: spawn-ENOENT once cost a strike (W1-T127, #212/#213).
 * See docs/forensics/ledger.md#isspawninfrablockederror and runFixRung. */
export function isSpawnInfraBlockedError(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

// ── W1-T429: task-id-keyed decision reads are repo-blind ────────────────────────────────────
// Only `run.start` carries a `repo:` dimension, and the fleet's plans share one id scheme, so a
// second driven repo makes one repo's read count against the other's history of the same id.

/** The one key-renderer every task-id-keyed decision read and write goes through: `<repo>:<task_id>`
 *  when `repo` is known, else the BARE `task_id` (W1-T429 design note i). The bare form is the
 *  deliberate legacy fallback, so a line ledgered before this key existed keeps matching. */
export function repoScopedTaskKey(repo: string | undefined, taskId: string): string {
  return repo ? `${repo}:${taskId}` : taskId;
}

/** True iff `line` records a decision for the same (repo, task_id) pair — the read side of
 *  {@link repoScopedTaskKey}. Lines whose own `repo` differs never match. A line carrying no `repo`
 *  must still be found by a read that knows one, so an upgrade never orphans a dedup marker (design
 *  note iii). Falsifier, both directions: test/ledger-repo-scope.test.ts. */
export function matchesRepoScopedTask(line: { task_id?: unknown; repo?: unknown }, repo: string | undefined, taskId: string): boolean {
  if (typeof line.task_id !== "string") return false;
  const lineRepo = typeof line.repo === "string" ? line.repo : undefined;
  if (repoScopedTaskKey(lineRepo, line.task_id) === repoScopedTaskKey(repo, taskId)) return true;
  return lineRepo === undefined && line.task_id === taskId;
}

/** Cost-line tag (W1-T127 design note iii). `"task"` is the implicit attribution for real billed
 *  work; `"infra"` marks a $0 line logged for a spawn-infrastructure refusal, so a per-task rollup
 *  can exclude it while a fleet-health rollup still finds it. See {@link isSpawnInfraBlockedError}. */
export const LEDGER_COST_TAG_TASK = "task" as const;
export const LEDGER_COST_TAG_INFRA = "infra" as const;
export type LedgerCostTag = typeof LEDGER_COST_TAG_TASK | typeof LEDGER_COST_TAG_INFRA;

/** Durable follow-up-policy-v1 events. These stay in the decision-retention set because a
 * restart must preserve human stops, deduplication, and delivery receipts. */
export const FOLLOW_UP_CANDIDATE_STEP = "panel.follow_up_candidate";
export const FOLLOW_UP_STATE_STEP = "panel.follow_up_state";
export const FOLLOW_UP_CONTROL_STEP = "panel.follow_up_control";
export const FOLLOW_UP_RECEIPT_STEP = "panel.follow_up_receipt";
export const FOLLOW_UP_POLICY_STEP = "panel.follow_up_policy";

export const HUMAN_HANDOFF_LEDGER_STEP = "panel.human_handoff";

/** THE #212 CONJUNCTION (W1-T127 design note i): a strike is recorded only where a worker RAN and a
 *  judgment was POSTED. Both halves are asserted, never either, so this cannot degrade to one half
 *  of the conjunction it checks. Pure and total; callers supply what they observed. */
export function isRealStrike(evidence: { workerRan: boolean; judgmentPosted: boolean }): boolean {
  return evidence.workerRan && evidence.judgmentPosted;
}

// W1-T2697: stamp the actor at write time from process context, never caller claims or inference.
// Previously worker, daemon and operator rows were indistinguishable (design note i, plan/tasks.d).
/** Who wrote a ledger row, as {@link deriveLedgerActor} derives it. */
export type LedgerActor = "daemon" | "worker" | "service" | "host_automation" | "test" |
  "operator_human" | "operator_ai" | "unknown" | "operator" | "run_child";

export function markLedgerProcessActor(actor: "daemon" | "service" | "host_automation" | "run_child"): void {
  process.env.REMUDERO_PROCESS_ACTOR = actor;
}

/** In-process signal the daemon's OWN command sets on itself once, at boot — see
 *  {@link markDaemonProcessActor}. Nothing else ever sets this. */
const DAEMON_PROCESS_ACTOR_ENV = "REMUDERO_DAEMON_PROCESS";

export const DAEMON_PID_ENV = "REMUDERO_DAEMON_PID";

/** W1-T9085: mark THIS process as a run child (src/run-child-main.ts): every ledger row it writes from here on reports
 *  `actor: "run_child"` (ADR 0007 A.3). The daemon spawned it, so it inherited the daemon's own marker; that one is dropped.
 *  Returns the call that puts both back. */
export function markRunChildProcessActor(env: NodeJS.ProcessEnv = process.env): () => void {
  const kind = env.REMUDERO_PROCESS_ACTOR;
  const daemon = env[DAEMON_PROCESS_ACTOR_ENV];
  env.REMUDERO_PROCESS_ACTOR = "run_child";
  delete env[DAEMON_PROCESS_ACTOR_ENV];
  return () => {
    if (kind === undefined) delete env.REMUDERO_PROCESS_ACTOR;
    else env.REMUDERO_PROCESS_ACTOR = kind;
    if (daemon !== undefined) env[DAEMON_PROCESS_ACTOR_ENV] = daemon;
  };
}

/** Mark the daemon once at daemonCommand boot, before its first appendLedger.
 * In-process calls inherit this actor; worker markers win in {@link deriveLedgerActor}. */
export function markDaemonProcessActor(): void {
  markLedgerProcessActor("daemon");
  process.env[DAEMON_PROCESS_ACTOR_ENV] = "1";
  process.env[DAEMON_PID_ENV] = String(process.pid); // children read the daemon's /proc growth (host-memory-shadow.ts)
}

/**
 * W1-T4068: tests win over inherited markers; workers win over their spawning service's kind.
 * An operator requires a Claude session marker or a terminal; absence is unknown.
 */
export function deriveLedgerActor(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = env === process.env && process.stdin.isTTY === true,
): LedgerActor {
  if (env.NODE_TEST_CONTEXT) return "test";
  if (env[WORKER_SCOPE_ENV]) return "worker";
  const kind = env.REMUDERO_PROCESS_ACTOR;
  if (kind === "service" || kind === "host_automation" || kind === "daemon" || kind === "run_child") return kind;
  if (env[DAEMON_PROCESS_ACTOR_ENV]) return "daemon";
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) return "operator_ai";
  return isTTY ? "operator_human" : "unknown";
}

/** Historical `operator` rows remain readable but cannot establish positive operator evidence. */
export type LedgerRowActor = LedgerActor;

/** Read a parsed ledger line's actor. A missing or malformed `actor` field reports `"unknown"`,
 *  NEVER inferred from any other field on the row — the one read-side rule this task adds.
 *  Falsifier: test/hand-run-census.test.ts. */
export function ledgerRowActor(line: { actor?: unknown }): LedgerRowActor {
  switch (line.actor) {
    case "daemon": case "worker": case "service": case "host_automation": case "test":
    case "operator_human": case "operator_ai": case "operator": case "run_child": return line.actor;
    default: return "unknown";
  }
}

export const LEDGER_FUTURE_STAMP_TOLERANCE_MS = 10 * 60_000;
export const LEDGER_FUTURE_STAMP_STEP = "ledger.future_stamp";

/** W1-T5407: the flag for a row whose `ts` runs past `mtimeMs`, a kernel clock no skewed process clock moves. */
function futureStampRow(record: Record<string, unknown>, mtimeMs: number): Record<string, unknown> | undefined {
  const skewMs = Date.parse(String(record.ts)) - mtimeMs;
  if (!(skewMs > LEDGER_FUTURE_STAMP_TOLERANCE_MS)) return undefined;
  return {
    ts: fixedClock(mtimeMs).iso(),
    host: record.host,
    actor: record.actor,
    actor_pid: record.actor_pid,
    run_id: record.run_id,
    task_id: record.task_id,
    step: LEDGER_FUTURE_STAMP_STEP,
    claimed_ts: record.ts,
    skew_ms: skewMs,
    flagged_step: record.step,
    flagged_actor: record.actor,
    flagged_host: record.host,
  };
}

/** Append with one checked writeSync: never split a record around another appender's write.
 * O_APPEND provides concurrency safety, not a lock; short writes are loud and never retried
 * (W1-T206; test/ledger-atomic.test.ts; docs/forensics/ledger.md#appendledger).
 * Stamp host last using identity, injectable for test/ledger-host-identity.test.ts (W1-T972).
 * Stamp actor via opts.actor or deriveLedgerActor (W1-T2697 design i), plus the writer's actor_pid
 * for hand-run-census.ts (design ii). Do not use pid: fix.spawn_reclaimed already uses that key
 * for the reclaimed process, and ...line would overwrite the writer's stamp. */
/** W1-T4107: the one shape every "append a row, spy on the writer in a test" seam shared under four
 *  names (mutation-gate verdicts, follow-up harvest, contradiction resolution, replay results). */
export interface LedgerWriterDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

export function appendLedger(
  path: string,
  line: LedgerLine,
  opts: {
    ceilingBytes?: number;
    identity?: () => string;
    actor?: () => LedgerActor;
    clock?: Clock;
    fstat?: (fd: number) => { mtimeMs: number };
  } = {},
): void {
  const actor = (opts.actor ?? deriveLedgerActor)();
  if (deriveLedgerActor() === "test" || actor === "test") {
    const outside = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (outside(relative(resolve(tmpdir()), resolve(path)))) {
      throw new Error(`ledger: REFUSED test append outside the temporary root: ${path}`);
    }
    let ancestor = resolve(path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    const rel = relative(realpathSync(tmpdir()), realpathSync(ancestor));
    if (outside(rel)) {
      throw new Error(`ledger: REFUSED test append outside the temporary root: ${path}`);
    }
    assertLedgerPathNotLive(path, { ...process.env, NODE_TEST_CONTEXT: "test", RMD_ALLOW_LIVE_WRITES: undefined });
  } else {
    assertLedgerPathNotLive(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    ts: (opts.clock ?? systemClock).iso(),
    host: (opts.identity ?? hostname)(),
    actor_pid: process.pid,
    ...line,
    gardener_origin: readGardenerOrigin(),
    actor,
  };
  const buf = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const rows = [buf];
  let behind: Buffer[];
  const fd = openSync(path, "a+");
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.error(
        `ledger: short write for ${path} (${written}/${buf.length} bytes written) — ` +
          `the record may be torn; see readLedgerLines' torn-line handling`,
      );
    }
    let flag: Record<string, unknown> | undefined;
    try {
      flag = futureStampRow(record, (opts.fstat ?? fstatSync)(fd).mtimeMs);
    } catch (err) {
      console.error(`ledger: could not stat ${path} to check the row's ts for future skew: ${String(err)}`);
    }
    if (flag) {
      rows.push(Buffer.from(JSON.stringify(flag) + "\n", "utf8"));
      writeSync(fd, rows[1]!, 0, rows[1]!.length);
    }
    behind = rowsBehindRotationSeal(fd, rows);
  } finally {
    closeSync(fd);
  }
  if (behind.length > 0) reappendBehindSeal(path, behind);
  // W1-T209: opportunistic, lazy rotation — the only place the ledger grows, so the only place
  // that needs to notice it has grown past the ceiling. A stat and small sidecar read on each
  // call; the full read-and-rewrite cost only on the call that crosses the effective ceiling.
  if (ledgerExceedsRotationCeiling(path, opts.ceilingBytes)) {
    rotateLedger(path, { ceilingBytes: opts.ceilingBytes });
  }
}

/** Append for a pseudo sender (daemon, retro, drain, sweep), gated by producer-identity.ts's registry.
 * Refuse undeclared senders; keep task_id exactly as passed and never rewrite historical rows (W1-T2495). */
export function appendProducerLedger(
  path: string,
  senderId: string,
  line: Omit<LedgerLine, "task_id">,
  opts: { ceilingBytes?: number; identity?: () => string } = {},
): ProducerIdentity {
  const identity = resolveProducerIdentity(senderId);
  appendLedger(path, { ...line, task_id: senderId } as LedgerLine, opts);
  return identity;
}

// ── THE ACCOUNT DIMENSION (W1-T268, MASTER-PLAN §9) ─────────────────────────
// appendLedger only ever appends, so a line written before `account_label` existed can never be
// retrofitted with one. Any accounting built on the label below has a HARD START DATE and must
// REFUSE an older line rather than guess (docs/forensics/ledger.md#account_attribution_epoch).

/** THE ACCOUNT ATTRIBUTION EPOCH — the boot that re-provisioned the worker keychain store after the
 *  operator's manual account switch (W1-T265). Every earlier line belongs to the account active
 *  before that switch and none says so. Named so a reader binds to the value, not a copy. */
export const ACCOUNT_ATTRIBUTION_EPOCH = "2026-07-31T16:39:00.582Z";

/** One account's summed, attributed spend — an entry of {@link AccountSpendSummary.byAccount}. */
export interface AccountSpendGroup {
  accountLabel: string;
  totalCostUsd: number;
  lineCount: number;
}

/**
 * Spend {@link groupSpendByAccount} REFUSED to attribute to any account, split by why —
 * visible and countable, never silently dropped or silently credited to whichever label
 * happens to be current.
 */
export interface RefusedSpend {
  /** Lines older than {@link ACCOUNT_ATTRIBUTION_EPOCH} (or with no parseable `ts`, which
   *  is treated identically — an unattributable line is never guessed to be recent). */
  preEpochCount: number;
  preEpochCostUsd: number;
  /** Lines AT/AFTER the epoch that still carry no `account_label` — a caller that bypassed
   *  the ledgering helpers ({@link import("./worker.js").workerLedgerFields} and friends). */
  unlabelledCount: number;
  unlabelledCostUsd: number;
}

/** Result of {@link groupSpendByAccount}. */
export interface AccountSpendSummary {
  byAccount: AccountSpendGroup[];
  refused: RefusedSpend;
}

/** Group every spend-carrying line by `account_label`, REFUSING — never guessing — a line older
 *  than {@link ACCOUNT_ATTRIBUTION_EPOCH} or one carrying spend with no label (W1-T268 note 3). A
 *  line with neither `total_cost_usd` nor `cost_usd` is skipped: refusal is for spend this function
 *  chose not to credit. Falsifier: test/ledger-account-dimension.test.ts. */
export function groupSpendByAccount(lines: readonly LedgerLine[]): AccountSpendSummary {
  const epochMs = Date.parse(ACCOUNT_ATTRIBUTION_EPOCH);
  const totals = new Map<string, { totalCostUsd: number; lineCount: number }>();
  const refused: RefusedSpend = { preEpochCount: 0, preEpochCostUsd: 0, unlabelledCount: 0, unlabelledCostUsd: 0 };

  for (const line of lines) {
    const cost =
      typeof line.total_cost_usd === "number"
        ? line.total_cost_usd
        : typeof line.cost_usd === "number"
        ? line.cost_usd
        : undefined;
    if (cost === undefined) continue; // not a spend-carrying line — no claim to refuse or credit

    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const tsMs = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(tsMs) || tsMs < epochMs) {
      refused.preEpochCount++;
      refused.preEpochCostUsd += cost;
      continue;
    }

    const label = typeof line.account_label === "string" && line.account_label.length > 0 ? line.account_label : undefined;
    if (!label) {
      refused.unlabelledCount++;
      refused.unlabelledCostUsd += cost;
      continue;
    }

    const entry = totals.get(label) ?? { totalCostUsd: 0, lineCount: 0 };
    entry.totalCostUsd += cost;
    entry.lineCount++;
    totals.set(label, entry);
  }

  const byAccount = [...totals.entries()].map(([accountLabel, v]) => ({ accountLabel, ...v }));
  return { byAccount, refused };
}

// W1-T4100 design (i): 369 archives/day reflected concentrated bytes/hour from noisy steps.
// Pure over raw lines: callers choose a rotation snapshot, live file or stitched corpus.
/** One step's measured share of a ledger-line corpus — the unit {@link topLedgerWriters} ranks. */
export interface LedgerWriterShare {
  step: string;
  bytes: number;
  lineCount: number;
  /** This step's share of the WHOLE corpus's measured bytes, 0..1. */
  shareOfBytes: number;
}

/** Rank every distinct `step` in `lines` by bytes written, heaviest first. A line with no
 *  parseable JSON or no string `step` is measured (it still occupies real disk) under
 *  `"(unparseable)"`/`"(unknown)"` respectively, so noise is visible rather than silently dropped
 *  from the total. `bytes` counts each line's own length plus the newline it owns on disk, the
 *  same unit {@link readLedgerCorpusPressure} (ledger-compaction-rung.ts) already measures. */
export function topLedgerWriters(lines: readonly string[], limit = 10): LedgerWriterShare[] {
  const byStep = new Map<string, { bytes: number; lineCount: number }>();
  let totalBytes = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    totalBytes += bytes;
    let step = "(unparseable)";
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      step = typeof json.step === "string" && json.step.length > 0 ? json.step : "(unknown)";
    } catch {
      // step stays "(unparseable)" — a torn/corrupt line still counts toward the total
    }
    const entry = byStep.get(step) ?? { bytes: 0, lineCount: 0 };
    entry.bytes += bytes;
    entry.lineCount += 1;
    byStep.set(step, entry);
  }
  return [...byStep.entries()]
    .map(([step, v]) => ({ step, bytes: v.bytes, lineCount: v.lineCount, shareOfBytes: totalBytes > 0 ? v.bytes / totalBytes : 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

/** Flag growth against each step's own baseline (W1-T4100 design i), not the largest step:
 * an evenly spread corpus must not flag its own top entry. */
export interface LedgerWriterFlag extends LedgerWriterShare {
  aboveHistoricalShare: boolean;
}

/** Rank `current`'s top writers exactly as {@link topLedgerWriters} does, and flag any whose share
 *  of `current` is at least `thresholdMultiplier` times its share of `baseline` — a real shift in
 *  WHERE the bytes are going, not just the top of an otherwise-flat distribution. A step absent
 *  from `baseline` entirely (its share there is 0) is flagged the moment it writes anything in
 *  `current`, since no multiple of zero is ever "above" it. */
export function flagAnomalousLedgerWriters(
  current: readonly string[],
  baseline: readonly string[],
  opts: { limit?: number; thresholdMultiplier?: number } = {},
): LedgerWriterFlag[] {
  const thresholdMultiplier = opts.thresholdMultiplier ?? 2;
  const currentTop = topLedgerWriters(current, opts.limit ?? 10);
  const baselineShares = new Map(topLedgerWriters(baseline, Number.MAX_SAFE_INTEGER).map((w) => [w.step, w.shareOfBytes]));
  return currentTop.map((w) => {
    const baselineShare = baselineShares.get(w.step) ?? 0;
    const aboveHistoricalShare = baselineShare > 0 ? w.shareOfBytes >= baselineShare * thresholdMultiplier : w.shareOfBytes > 0;
    return { ...w, aboveHistoricalShare };
  });
}

/** SIZE CEILING (W1-T209, recon R-9). Below the size a real never-rotated ledger reaches, so one
 *  actually crosses it, and above any single run's appends, so a rotating ledger never thrashes.
 *  Why: the ledger measured at intake (docs/forensics/ledger.md#ledger_rotation_ceiling_bytes). */
export const LEDGER_ROTATION_CEILING_BYTES = 4 * 1024 * 1024; // 4 MiB

/** W1-T4100 — THE SMOOTHING WINDOW. 369 archives in a day (READ 2026-09-23, ~13/hour) is what a
 *  size-only ceiling does under bursty write volume: every append that crosses `ceilingBytes`
 *  rotates again immediately, so a burst of writes multiplies into a burst of archives — each one
 *  more a union read must open. This is the minimum real time between two rotations of the SAME
 *  ledger under ordinary growth: a rotation that would otherwise fire again before the window has
 *  elapsed since the last one instead waits, letting the burst's later writes land in the ALREADY
 *  rotated live file rather than minting a fresh archive each. Five minutes: short enough that a
 *  genuinely steady-state ledger (roughly one rotation every 5-8 real minutes, per the same 2026-
 *  09-23 read) rotates close to its old cadence, long enough that a burst of dozens of crossings
 *  inside a minute collapses to one. See {@link LEDGER_ROTATION_BACKSTOP_MULTIPLIER} for the bound
 *  that keeps this a courtesy, never a way to grow the live file without limit. */
export const LEDGER_ROTATION_SMOOTHING_WINDOW_MS = 5 * 60_000;

/** W1-T4100 — THE BACKSTOP. The smoothing window above is a courtesy, never a way to hold the live
 *  ledger past a size this repo has already been burned by keeping in memory whole (see ledger-
 *  compaction-rung.ts's own OOM account of a 4 GB corpus against an 8 GB heap). A live file that
 *  reaches this multiple of `ceilingBytes` rotates immediately regardless of how recently the last
 *  rotation fired — the one case where the window itself would be the defect. */
export const LEDGER_ROTATION_BACKSTOP_MULTIPLIER = 4;

/** W1-T4393: least real time since the last archive that measures an append rate; less is a burst. */
export const LEDGER_ROTATION_MIN_RATE_SAMPLE_MS = 60_000;

/** W1-T2244: the one row an operator produces when they act on a risk-judge escalation instead of
 *  taking its "merge it by hand" escape hatch in silence. Written by `recordRiskOverride`, read
 *  back head-bound by {@link riskOverrideFromLedger} so a record never outlives the diff it judged
 *  (design viii). RECORDING ONLY: nothing here decides dispatch or merge. */
export const RISK_OVERRIDE_RECORDED_STEP = "panel.risk_override_recorded";

/** Personal-context governance rows are deciding state, not display telemetry. Losing a context
 * item, revocation, or deletion receipt during rotation would restore memory after restart. */
export const CONTEXT_ITEM_LEDGER_STEP = "panel.context_item";
export const CONTEXT_REVOKED_LEDGER_STEP = "panel.context_revoked";
export const CONTEXT_DELETED_LEDGER_STEP = "panel.context_deleted";

/** W1-T3900: an emergency stop MUST survive a daemon restart mid-incident — losing one on
 *  rotation would silently reopen the exact blast-radius an operator just closed. Only issuance
 *  and clear are deciding rows; refusal/cancellation receipts are audit trail, not state. */
export const EMERGENCY_STOP_ISSUED_LEDGER_STEP = "panel.emergency_stop_issued";
export const EMERGENCY_STOP_CLEARED_LEDGER_STEP = "panel.emergency_stop_cleared";

export const OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP = "panel.operator_preference_proposed";
export const OPERATOR_PREFERENCE_EVENT_LEDGER_STEP = "panel.operator_preference_event";

/** W1-T2244 (design vii): the two signals an override can carry, OPPOSITE for a calibrator.
 *  `judge_wrong` says the escalation was a miscalibration; `risk_accepted` says it was correct and
 *  the operator knowingly took the cost. One "overridden" flag would collapse both into judge error.
 *  Free text (`reason`) rides alongside, never replacing it. */
export const RISK_OVERRIDE_REASON_CLASSES = ["judge_wrong", "risk_accepted"] as const;
export type RiskOverrideReasonClass = (typeof RISK_OVERRIDE_REASON_CLASSES)[number];

/** W1-T2244 (design vi): what the operator actually did with the escalated head — a closed set
 *  for the same reason {@link RISK_OVERRIDE_REASON_CLASSES} is closed. */
export const RISK_OVERRIDE_DISPOSITIONS = ["merged_by_hand", "redispatched", "abandoned"] as const;
export type RiskOverrideDisposition = (typeof RISK_OVERRIDE_DISPOSITIONS)[number];

/**
 * Ledger steps a DECIDING reader consults — never a merely-displaying one. Rotation must never
 * archive one away; {@link MAX_RETAINED_LINES_PER_STEP} is their only bound.
 *
 * Trap: for these steps the line IS the bound, so a step that "forgets" is a breaker or a dedup
 * that silently resets. Each entry below names its reader and what losing it would do. Telemetry
 * and display-only reads are archived; operator-visible history lives in
 * {@link RENDER_RELEVANT_LEDGER_STEPS}; `daemon.boot` and `deploy.*` are members but heartbeats,
 * bounded by {@link HEALTH_STEP_RETENTION_WINDOW_MS} instead. Falsifier:
 * test/ledger-rotation.test.ts re-derives this set from every consumer's own source, so treat it,
 * not this comment, as the source of truth. Why: the per-consumer table and the W1-T244 incident —
 * docs/forensics/ledger.md#decision_relevant_ledger_steps.
 */
export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "auto_triage.run_failed", // W1-T9853: failedFireBackoff derives the per-entry retry from these rows.
  "retro_triggered", // W1-T9119: the retro cadence reader learns the persistent-deferral interval from these rows.
  "implement.preopen_gate", // preopen-gate.ts counts the fleet streak across rotations.
  "implement.preopen_gate.alert", // preopen-gate.ts dedups raises and clears on recovery.
  "run.start",
  "dispatch.claim", // W1-T9001: promise recovery uses the earliest claim to bound its archive read.
  "memory_read.recovered", // W1-T7720: past recovery durations derive the sustained-unreadable bound.
  "sweep.fix.owner_residue_preserved", // W1-T6434: the next fix round reads the preserved patch it names.
  // The sweep reads these exact-head security decisions from the live ledger after async judgment.
  // Archiving them re-judges settled alerts or forgets an already admitted repair.
  "code_scanning.judged_fix",
  "code_scanning.judged_false_positive",
  "code_scanning.fix_dispatch",
  "automerge.rearmed_after_disarm",
  "automerge.rearm_exhausted",
  "automerge.stale_rollup_refreshed", // W1-T6404: the once-per-PR refresh bound; forgotten, it loops.
  "automerge.stale_rollup_refresh_exhausted",
  "automerge.stale_check_rerun", // W1-T8620: the once-per-(head, run id) job re-run; forgotten, it loops.
  "automerge.merge_refusal_escalated", // W1-T8620: once per (head, refusal text); forgotten, it re-escalates.
  "automerge.risk_override_observed",
  "incident.event", // W1-T4385: sre-lane.ts files once per fingerprint from these two;
  "incident.sampled", // rotated away, a still-burning incident reads as new and is re-filed.
  // W1-T8264: sre-lane.ts routeOperatorInterventions dedupes a hand action by this row; rotated away, the same
  // intervention reads as new and is routed to the SRE lane a second time.
  "operator.intervention",
  "verify_human.mechanical_ruling", // W1-T10371: verifyHumanCadence reads these rows (priorMechanicalKeys) so a ruled shard is not re-written.
  // W1-T3646: the advisory repair lease. `priorRepairLease` reads this row to decide whether a
  // second fix lane may claim a PR already under repair, so it is decision-relevant by the same
  // test that derives this set from its consumers -- not a log line nobody reads.
  "repair.lease_posted",
  "pr.opened",
  "pr.open_satisfied_by_main", // the backlog gardener retires the task from it; rotated away, a satisfied task is rebuilt.
  "pr.identity_trailer.started", // W1-T9055: a retried trailer commit on the same head reuses its started row; rotated away, it writes a second.
  "pr.identity_trailered", // W1-T9055: a completed trailer commit is never repeated for the same head.
  "pr.stuck", // W1-T5900: runSweep dedupes a stalled stage across passes and rotation.
  "pr.stuck.resolved", // Retain its resolution so rotation cannot resolve the same stage again.
  "selector-shadow.observation", // W1-T5925: the shadow verdict folds every row; rotated away, it forgets.
  // W1-T2594: provider-diverse reviewer routing resolves this row by exact task + PR + head.
  // Rotating it away would make an unchanged head route differently after maintenance.
  "pr.head_provider",
  // W1-T2425: `seedCountFromCircuitBreak` (status.ts) reads this row's `freshCount` for the
  // baseline a restarted process cannot carry; archived away, a rotation un-trips a tripped breaker.
  "dispatch.circuit_broken",
  "dispatch.circuit_broken.escalated",
  "dispatch.circuit_broken.verified", // W1-T4678 dedup survives rotation.
  // W1-T4691: `rmd release`'s row — `seedCountFromCircuitBreak` and `dispatchStreakTally` (status.ts)
  // both read it as forward progress, resetting a halted task's breaker. Rotated away, a released
  // task's next restart would seed straight back from the still-live `dispatch.circuit_broken` row above.
  "dispatch.breaker_released",
  "dispatch.breaker_judged", // W1-T7742: a judge's continue resets the streak like a release; its rulings dedup.
  "run.freshness_handoff", // W1-T7747: a parked checkpoint's resume receipt (daemon.ts pendingWorkerBoundaryHandoffs).
  "implement.checkpoint_dropped", // Retain the resolution too, so rotation cannot revive a dropped handoff receipt.
  // W1-T8676: pendingWorkerBoundaryHandoffs (daemon.ts) re-pends the receipt a worker-error verdict consumed from
  // this row; rotated away while that receipt stayed, the receipt would read consumed again.
  "implement.checkpoint_kept",
  // W1-T8676: independentFailureLatch (status.ts) reads it as the release's receipt; rotated away, it is re-written.
  "dispatch.independent_block_released",
  // W1-T2910: `status.ts`'s projection reads this row to derive an independent-failure block and
  // clears it on a later dispatch (src/lib/status.ts, the `line.step === "dispatch.blocked_independent"`
  // arm). Rotated away, a block that was recorded stops being visible and the subtree is re-dispatched
  // as if it had never failed — the exact "derived from consumers, not hardcoded" case this set exists for.
  "dispatch.blocked_independent",
  // W1-T3978: the status projection pairs the producer-owned implement refusal with this one-time
  // re-offer marker. Both survive rotation so a restart cannot turn the retry into a loop.
  "implement.harness_commit_refused",
  "dispatch.harness_commit_retry",
  // W1-T3758: lifetime pressure subtracts capacity refusals and dedups infra-only markers.
  // Losing either row on rotation spends task budget or repeats a marker after a daemon restart.
  // Readers: taskAttributableLifetimeDispatches and routeAdaptiveLifetimePressure.
  "daemon.spawn_infra_blocked",
  "dispatch.lifetime_pressure.infra_only",
  "dispatch.cost_of_delay.fallback", // W1-T4064: dispatchValueContextForSelection dedups on the last of
  "dispatch.cost_of_delay.ready", // these two; rotated away, a restart re-logs the same fallback.
  // W1-T7814: the memory governor's history read calibrates the dispatch memory floor.
  // Losing its observations would make it relearn from an empty window after each rotation.
  "dispatch_memory_observed",
  // W1-T316: `escalateLifetimeCapExceeded`'s (run-task.ts) dedup marker, written whether or not
  // delivery succeeds; dropping it re-opens a duplicate lifetime-cap escalation.
  "dispatch.lifetime_capped.escalated",
  // W1-T215: `escalateCrashLoop`'s (run-task.ts) dedup marker, read per boot; dropping it re-opens
  // one duplicate needs-human issue per boot, roughly one a minute while the storm lasts.
  "daemon.crashloop.escalated",
  "daemon.headroom_reserve.escalated",
  // `escalateHeadroomParkCeiling` (run-task.ts) compares this row against the newest
  // `daemon.headroom`; dropping it re-pages once per daemon boot while the probe stays broken.
  "daemon.headroom.park_ceiling.escalated",
  // …and the row that ENDS a blind stretch, which that dedup compares against. Retention costs
  // nothing (`isRenderRelevantStep` keeps it already); this entry records the decision read.
  "daemon.headroom",
  // W1-T372: `escalateQuotaExhaustion`'s (run-task.ts) dedup marker, read per bucket; dropping it
  // re-opens one duplicate quota-exhaustion notice per tick while the bucket stays exhausted.
  "daemon.quota_exhausted.escalated",
  // W1-T1082: `escalateDiskHeadroomBreach`'s (run-task.ts) dedup marker, compared against an
  // episode window; it is what stops a daemon RESTART mid-episode from re-opening the issue.
  "daemon.disk_headroom.escalated",
  // W1-T3368: THE COMPACTION THROTTLE'S ONLY INPUT. `lastLedgerCompactionFiredAtMs`
  // (run-task.ts) scans the live ledger for the newest row of this step and hands it to
  // `decideLedgerCompaction(pressure, lastFiredAtMs, now)`. Rotated away, that read returns
  // `undefined`, the throttle sees "never fired", and compaction re-fires on the very next
  // daemon tick — the marker is what bounds it, so losing it converts a throttled rung into a
  // loop. Deliberately NOT joined by "ledger_compaction.ran"/".nothing_eligible"/".run_failed":
  // those are outcome records nothing decides off, the same reasoning as `worker.state`.
  "ledger_compaction.fired",
  // W1-T2988: `escalateRetroPublicationFailure`'s (retro.ts) episode dedup marker, read back by
  // THAT function — a rotation dropping it re-opens one duplicate needs-human issue on every retro
  // fire while the condition persists, which is the very loop this step exists to stop.
  "retro.publication.escalated",
  "dispatch.starvation.escalated",
  // `escalateStarvationCleared`'s (run-task.ts) referent boundary, read alongside
  // "dispatch.starvation.escalated"; losing it re-closes a stale issue or skips a new episode.
  "dispatch.starvation.cleared",
  "verdict",
  "verdict.merged",
  PR_TERMINAL_STEP, // W1-T5318: pruneCarriedRows' terminal fact, and runPrTerminalReconcile's live dedup
  "correction.provenance",
  "sweep.disposed",
  "sweep.merge_probe", // W1-T9578: exact head/main conflict evidence selects the regeneration route.
  "sweep.conflict_regenerated", // W1-T9578: retain the once-per-(head, main) attempt receipt.
  // W1-T4351: sweep.ts's `decideBaseRed` reads main's latest run and each head's base-red record;
  // rotated away, a red main carries reads as the PR's own and a fix worker is spent on it again.
  "main.health.observed",
  "sweep.base_red.stood_down",
  "sweep.base_red.refresh",
  "sweep.base_fixed.refresh", // baseRedHistoryFromLedger and refreshRecordsFromLedger read prior refreshes.
  "sweep.contract_amended.refresh", // A failed narrative-adoption attempt remains a decision input after rotation.
  "sweep.head_contract_refresh.attempted", // An interrupted intent refuses a repeat refresh across rotation.
  "refresh.clearance", // refusedRefreshClearancesFromLedger memoizes refusal evidence across passes.
  "sweep.base_red.refresh_admission", // W1-T9595: the light pass replays its held heads; pacing reads its cohort.
  "sweep.ratchet_judge.decided", // W1-T9962: the armed re-judge's once-per-(head, main tip) memo reads it back.
  "sweep.ci_timeout_refresh.attempted",
  "sweep.ci_timeout_refresh.outcome",
  "sweep.ci_timeout_refresh.escalated",
  "sweep.own_task_record.refresh", // W1-T9232: the sweep's once-per-PR refresh bound reads it back.
  "review.reviewer.skipped", // W1-T9232: ownTaskRecordMissingRow reads the cause row for the PR's head.
  "sweep.actions_incident_hold",
  "sweep.actions_incident_hold.escalated",
  "sweep.base_reproduction", // W1-T5528: sweep.ts's probe cache and prior reproduced verdict
  "main.rule_checks.observed", // W1-T7848: mainLatestRunFromLedger folds it into main's reading; lost, an inherited rule red reads green.
  "sweep.fold_debt_pull.ingested", // W1-T7853: foldDebtRunIdsFromLedger dedups on it; lost, CI fold debt is pulled and landed again.
  "sweep.fold_debt_pull.dropped", // W1-T7853: the same dedup for a run whose PR closed unmerged or merged at a later head.
  "sweep.reviewer_freshness_probe", // W1-T5771: freshnessBackoff's held re-probe backoff; lost, it resets
  "sweep.capped_host_gap_rereview", // W1-T7837: releases the delivered-review key; demand alone never spends an admitted attempt.
  "sweep.review_host_gap_rereview", // W1-T7850: same demand release for a refused POST, not completed review work.
  "sweep.fix.checkout_claim_declined",
  "sweep.fix.dispatch_failed",
  "sweep.fix.prepare_timing", // The scanner fold reads the latest preparation owner across rotation.
  "fix.strike_refunded", // W1-T5528: `fixLedgerRowsForHead` drops each refunded strike by this row
  "escalation.issue_opened",
  // W1-T3166. READER: the operator asking "has the judge ever run, and what has it demoted", and
  // W1-T3167's re-judge rung, which must not re-ask a settled question. "escalation.demoted" was
  // ALREADY absent here: a demotion is the one outcome invisible on the needs-human board, so
  // rotating it away loses the only evidence the judge acted.
  "escalation.judged",
  // W1-T8868. READER: the stale re-judge pass skips an issue state already settled here
  // (`escalation.rejudged`), and `escalation.auto_resolve_attempted` is the only record that a
  // reversible triage action ran before its issue was opened — the audit row an undo starts from.
  "escalation.rejudged",
  "escalation.auto_resolve_attempted",
  // W1-T3212: `ruling.judged` is the ONLY record of what the ruling judge decided and why, on
  // both arms. Nothing else writes it, and no measurement yet establishes that this judge
  // calibrates well — reading the first weeks of these rows is what will settle that, so a
  // rotation that dropped them would erase the evidence before it could be read.
  "ruling.judged",
  // W1-T3188: `isSettled` (verify-human-judge.ts) READS these rows to avoid re-asking a settled
  // question — rotated away, one judge call per parked shard is re-spent every pass.
  "verify_human.judged",
  "escalation.demoted",
  // impl-FL: daemon.ts counts these back to decide whether a reset string was already announced,
  // so the line IS the dedup key. Registered by exact name — a dotted child inherits nothing.
  "daemon.usage_reset_unrecognised",
  // impl-EV: ops.ts's `priorReconciledAlertFeedbackIds` counts these to decide whether an
  // alert-feedback entry was already closed; the local entry stays `new`, so the line IS the dedup.
  "ops.feedback_reconciled",
  "ratify.approved",
  "approve.id_materialized", // The saved improvement filing receipt recovers the actual task identities from this row.
  "ratify.reframed",
  // W1-T2604: inbox.ts's `declinedReasonInLedger` reads this row — the decline's one receipt.
  // Rotating it away un-declines a proposal and re-offers ratify on something already refused.
  "panel.proposal_declined",
  // W1-T3407: the RESTORE half of that receipt, and it must be retained for the MIRROR of the
  // reason above — rotating a restore away silently RE-DECLINES a proposal an operator deliberately
  // re-opened, on a reason they had already rejected. Both halves are read by one latest-wins pass,
  // so losing either one inverts the answer.
  "panel.proposal_restored",
  "fix.dispatch",
  "fix.retrigger",
  "fix.review",
  // W1-T1110: sweep.ts's `fixRungStalledWithoutNewHead` reads "fix.ci_not_green"/"fix.resolved"
  // beside "fix.review"; losing either re-strands the PR against a head nothing will move again.
  // W1-T1211: `runIsAwaitingExternal` (run-task.ts) reads "run.awaiting_external", written once per
  // wait; losing it reads a WAITING run as WORKING and freezes the fix rung for that run.
  "run.awaiting_external",
  "fix.ci_not_green",
  // W1-T3868: sweep.ts reads this fix-lane refusal to release the unchanged-head claim after the
  // harness declined to create a commit; rotating it away would strand that head again.
  "fix.commit_refused",
  // W1-T4207: `lastCommitRefusalPromptLines` (run-task.ts) reads its `subtype` to name the last refused paths.
  "fix.done",
  "fix.progress_judged", // the sweep labels each judged PR from its newest judgement; rotated away, the label reverts to the stale strike ratio.
  "fix.progress_reused", // fixSeedRead distinguishes reused judgment metadata from an owning worker rung.
  "fix.needs_design", // W1-T5532: preserve the explicit hand-off for the next fix-lane decision.
  "fix.contract_hold", // The sweep compares the actual refused head contract with the approved amendment.
  "fix.scope_amendment", // W1-T5534: runFixRung and lookupIdentity resume pending amendments after rotation.
  "fix.resolved",
  "fix.exhausted", // W1-T5966: with fix.done/resolved, status.ts FIX_LANE_TERMINAL_STEPS ends a fix.dispatch
  "fix.stood_down", // round on these; lost, a finished round reads in flight. autonomy.ts strikeCount reads
  "fix.superseded", // fix.exhausted beside fix.resolved, and a fix.stood_down's issue_url as human evidence.
  "fix.superseded_unknown",
  "fix.spawn_abandoned",
  "sweep.fix.error", // the same round's crashed-spawn outcome, with its cost.
  "fix.base_refreshed", // ci-friction-gardener prices a round by it (CI_FRICTION_LEDGER_STEPS).
  "sweep.check_requeued", // W1-T5935: requeuedCheckKeysFromLedger (sweep.ts) bounds one requeue per head and check.
  "sweep.check_requeue.deferred", // W1-T5920: voids a spent key in that same fold.
  "sweep.ci_gate_reaggregated", // W1-T5958: reaggregatedCiGateKeysFromLedger, once per head and sibling run.
  "main.run_gap.dispatched", // mainRunGapHistoryFromLedger: lost, a gap commit's workflows dispatch again.
  "main.repair.bisecting", // W1-T7760 mainBisectionFromLedger: lost, a probe in flight is dispatched a second time.
  "main.repair.probe_concluded", // W1-T7760 mainBisectionFromLedger: lost, a concluded probe is re-run and the bisection restarts.
  "main.repair.fix_opened", // W1-T8575 mainRepairPrUrlsFromLedger (sweep.ts): lost, a red-main repair PR is held for the red it repairs.
  "main.repair.located", // W1-T8042 mainRepairRedsFromLedger (sweep.ts): lost, a red shared across PRs opens a second record.
  "main.repair.resolved", // W1-T8042 same fold: lost, a repaired red's record reads open and absorbs a new red.
  "main.repair.inherited", // W1-T8042 same fold and mainRepairRecordsFromLedger: lost, the shared red is handed over again.
  "refusal_amendment.drafted", // noPrVerdictRowsFromLedger: lost, a settled no_pr refusal is re-drafted.
  "sre.governor", // governorTiersFromLedger: lost, a stopped runbook re-pauses and re-pages; on change only.
  "sweep.plan_repair", // planRepairHistoryFromLedger: the per-head repair and once-per-PR stale-base key.
  "plan_repair.dispatch", // priorPlanRepairStrikesFromLedger: lost, the plan-repair strike budget resets.
  "sweep.missing_task_trailer_repaired", // priorActionsFromLedger: one body edit per PR, head and task.
  "sweep.codeql_blocker.dispatch", // codeqlBlockerDispatched: one CodeQL repair per PR, head and alert.
  // W1-T1095: `fixRebaseAlreadySpent` (run-task.ts) reads this to enforce "at most one rebase per
  // blocked PR"; no timer backs it, so losing it restores an unbounded rebase-and-retry.
  "fix.rebased",
  // W1-T2436: `priorPrerequisitePrFor` (run-task.ts) folds these by `pr_url`; the ledger is that
  // capability's only memory, so archived away the rung opens a SECOND prerequisite PR.
  "fix.prerequisite_opened",
  "fix.prerequisite_dispatch_failed", // completed no-PR attempts are reused at unchanged repair inputs.
  // W1-T3309: `previousInstrumentEntanglementFromLedger` (run-task.ts) replays these rows to compare
  // this fix round's instrument/src paths against the previous round's — an unchanged pair means the
  // last dispatch moved nothing. The read is NOT scoped to head_sha, so rotating the row away leaves
  // no prior value, which reads exactly like a first attempt and repeats the dispatch it must stop.
  "fix.instrument_entangled",
  "dep-review.decided",
  // W1-T2705: the dedup marker for a migration already submitted. `depReviewOutcomeFor`
  // (run-task.ts) reads it back per PR + head and answers "migrate" only when present —
  // archived away, a completed migration reads as `hold` and the rung submits it again.
  "dep-review.migrate.completed",
  "review.posted",
  // W1-T10221: hostGapRereviewFacts joins library-owned refusals through this unique
  // per-review carrier. Dropping it makes a completed admitted attempt look unfinished.
  "review.provider_provenance",
  "sweep.review_requeued", // W1-T9970: sweep and review read this per-head image request after rotation.
  "review.skipped_stale_reviewer_code", // W1-T3691: preserve the daemon's freshness restart history across boots.
  // status.ts's plan-only credit refusal reads it once rotation stops carrying a merged PR's review rows.
  PLAN_ONLY_REVIEW_MARKER_STEP,
  "review.post_refused",
  "review.cannot_evaluate_escalated",
  // W1-T913: `lastPendingReviewStatusFromLedger` (review.ts) reads this back for per-head
  // idempotence AND the staleness clock; dropping it makes a review stalled for hours read as fresh.
  "review.pending_posted",
  // PR-13355: the stalled-stage backstop (sweep.ts) reads it; a review refusing at a head is no live owner.
  "review.semantic_setup_refused",
  // W1-T1017: W1-T322's ships-unwired advisory floor line. The deciding reader is not code — it is
  // the operator adjudicating W1-T323's advisory-versus-blocking flip against this exact corpus.
  // Why: rotation was dropping 95%+ of these rows (W1-T1017; docs/forensics/ledger.md).
  "review.unwired_advisory",
  "automerge.capped_override_granted",
  // W1-T2244: the risk-judge escalation's override record, beside its capped-verdict sibling.
  // `panel.escalation_marked_handled` stays out: it carries nothing a calibrator could read back.
  RISK_OVERRIDE_RECORDED_STEP,
  "daemon.boot",
  // fixSeedRead needs both the empty boot census and later ownership/uncertainty:
  // dropping either side changes whether an old fix can re-enter the checkout claim.
  "run_child.adoption_pass",
  "run_child.adopted",
  "run_child.adoption_unreadable",
  "run_child.adoption_misidentified",
  // impl-DF: the idle rung's reason tally. A HUMAN reads it to tell "starved of work" from
  // "everything filtered"; it is emitted only on change, so rotation would drop a long idle's cause.
  "daemon.idle_reasons",
  // W1-T4939: `rmd status` sums these hourly (and restart-flushed partial) rows over the last 24 hours. The
  // daemon restarts on merges, so each row is scarce and a rotation that archived it loses the account.
  "lane.idle_summary",
  "sweep.post_fix_redriven",
  "sweep.stale_red_redrive.released",
  "sweep.strike_ladder.refreshed",
  "sweep.strike_ladder.requeued",
  "sweep.strike_ladder.digest_opened",
  "sweep.strike_ladder.digest_appended",
  "sweep.strike_ladder.held", // W1-T5635: a conflict hold at this main tip counts as already refreshed
  "sweep.plan_round.pushed",
  "sweep.plan_round.refused",
  // W1-T970: sweep.ts builds a sha-keyed `riskRefused` set off the escalated row, and (W1-T5403)
  // `handedOffHeadAwaitingJudgment` reads the decision row; losing either re-arms or re-judges a head.
  "risk_judge.escalated",
  "risk_judge.decision",
  // W1-T186: `priorActionsFromLedger` counts these to enforce ABSENT_REPUSH_CAP. The line IS the
  // bound — archived away, every rotation re-earns the PR another empty commit.
  "sweep.absent_repush",
  // `escalatePostReviewStall` (run-task.ts) counts these back for its episode key. `escalate()`
  // skips its dedup when no PR is named, so archiving this marker pages PER SWEEP TICK.
  "sweep.post_review.stalled.escalated",
  // `detectPostReviewStall` counts `.failed` and resets on `.done`; rotation must not reset its streak.
  "sweep.post_review.done",
  "sweep.post_review.failed",
  // Exact-input delay joins retain the per-step bound; missing source receipts remain unmeasured.
  "sweep.review_eligible",
  "sweep.review_admitted",
  // W1-T393 (MASTER-PLAN §11 D-10): retro.ts's `mutationGateLifetime` folds this into
  // `mutation-ratchet`'s LIFETIME record, so archiving it resets that figure on every rotation.
  "mutation.ratchet_verdict",
  // W1-T435: sweep.ts's `operatorVerdictEvidence` quotes a wrong or needs-follow-up steering note
  // into the next fix-rung dispatch — a DECIDING read (it drives the re-arm), not display-only.
  "operator_feedback",
  // W1-T470: `injectCoverageImprovementTask`'s dedup marker, read back via a ledger UNION rather
  // than the live file alone. Dropping it re-files the same debt profile on every red-band run.
  "coverage.improvement.filed",
  // W1-T2862: the source-size follow-up consumer reads this exact signature from the archive +
  // live ledger union before deciding whether the same maintainability obligation may file again.
  "source_size.followup.filed",
  // W1-T2697: hand-run-census.ts's dedup marker — `handRunCensus` reads this exact signature back
  // via a ledger UNION before proposing the same recurring hand-run sequence a second time.
  // Dropping it re-files the same routine proposal on every cadence tick after a rotation, the
  // same W1-T470 discipline `coverage.improvement.filed` above already follows.
  "hand_run.census_proposed",
  // W1-T949: the reservation-REFUSAL record for each id-filing lane, carrying `id`/`ref`/`outcome`
  // as structured fields so "why did this filing open no PR" stays queryable a week later. Like
  // "review.unwired_advisory" the deciding reader is a HUMAN, so these never appear in the
  // derived-from-consumers test's scanned corpus — expected, not a gap.
  "triage.id_reservation_failed",
  "plan.id_reservation_failed",
  "approve.id_reservation_failed",
  // W1-T1029: `latestManualCompletion` (status.ts) reads this back for hand-execution credit. The
  // line IS the credit: archiving it re-parks every task depending on the one it credited.
  "manual.completed",
  // W1-T1000002: review.ts's `automergeHoldFromLedger` reads both back, "last one wins", with NO
  // head-sha binding — a hold must outlive a push. Dropping "hold_engaged" lifts a hold the operator
  // believes still stands; dropping "hold_released" re-freezes a PR they already released.
  "automerge.hold_engaged",
  "automerge.hold_released",
  // W1-T1215: `armRunIdFromLedger` (run-task.ts) reads these rows to name WHICH lane armed a PR
  // that merged behind a refused verdict; dropping them turns that attribution into "unattributed".
  "automerge.armed",
  "automerge.arm_skipped",
  // W1-T968: `priorArmOnHead` (run-task.ts) reads a withdrawal on the same head as superseding the
  // arm before it. Archive this row while `automerge.armed` is retained and the operator's console
  // line reports a PR armed that a later verdict already disarmed.
  "automerge.disarmed",
  // W1-T1212: run-task.ts derives `updatedForWorkflow` from this row's `stale_workflow` field;
  // dropping it re-selects the same stale-gate PR every pass, spending the head for nothing.
  "sweep.update_branch.updated",
  // W1-T1015: reviewOrphansFor joins the successful update row to the reviewed old head. Its
  // attempted/conflict/error/head-moved/up-to-date siblings (W1-T5949) are kept so rotation cannot
  // erase evidence that an update ran but minted no new head; only `.updated` suppresses an orphan.
  "sweep.update_branch.attempted",
  "sweep.update_branch.pending_guard",
  "sweep.update_branch.conflict",
  "sweep.update_branch.error",
  "sweep.update_branch.head-moved",
  "sweep.update_branch.up-to-date",
  // W1-T5903: runSweep reads this row back to write ONE skipped_queue row per PR and head; dropping
  // it on rotation would re-log the same stand-down every pass.
  "sweep.update_branch.skipped_queue",
  // W1-T7735: the refresh value test reads its own decision rows back. Judge rulings are spent once
  // per head, a repeated skip writes no second row, and a request is consumed once. Outcomes join
  // decisions to derive the benefit weight. Each row dropped on rotation would re-spend a judge call
  // or re-consume a request.
  "sweep.refresh.decided",
  "sweep.refresh.outcome",
  "sweep.refresh.requested",
  // W1-T1235: `latestGhRateLimitRefusalsFromLedger` (run-task.ts) reads the newest row per bucket
  // for `rmd status`'s GITHUB BUCKETS section. Kept here, not in the render set, because GitHub's
  // resets outlast RENDER_STEP_RETENTION_WINDOW_MS and an operator needs the LAST refusal however
  // old. Sparse by construction, so permanent retention costs nothing beyond the per-step cap.
  "automerge.rate_limit_refused",
  // W1-T2558: cost-anomaly.ts's idempotence marker — `alreadyLedgeredCostAnomalyRunIds` reads every
  // `cost.anomaly` row back to decide whether a run was already flagged; before this entry the
  // dedup worked only until the next rotation.
  // Why: 471 raw rows collapsed to 45 run ids, one re-flagged 26 times (W1-T2558;
  // docs/forensics/ledger.md#decision_relevant_ledger_steps).
  "cost.anomaly",
  // W1-T3879: follow-up-policy-v1 folds these rows after restart. Losing a candidate, control,
  // state, policy, or receipt would re-arm a stopped or already delivered reminder.
  FOLLOW_UP_CANDIDATE_STEP,
  FOLLOW_UP_STATE_STEP,
  FOLLOW_UP_CONTROL_STEP,
  FOLLOW_UP_RECEIPT_STEP,
  FOLLOW_UP_POLICY_STEP,
  HUMAN_HANDOFF_LEDGER_STEP,
  CONTEXT_ITEM_LEDGER_STEP,
  CONTEXT_REVOKED_LEDGER_STEP,
  CONTEXT_DELETED_LEDGER_STEP,
  EMERGENCY_STOP_ISSUED_LEDGER_STEP,
  EMERGENCY_STOP_CLEARED_LEDGER_STEP,
  OPERATOR_PREFERENCE_PROPOSED_LEDGER_STEP,
  OPERATOR_PREFERENCE_EVENT_LEDGER_STEP,
  "review.finding", // W1-T5019: verifiedReviewFindingsForFix (run-task.ts) feeds repair prompts.
  // KEEP THE W1-T964 TRIO LAST, immediately before the Set's close: test/ledger-rotation.test.ts
  // anchors its mutation check on those three lines followed by `]);` and asserts the needle occurs
  // EXACTLY once. A block appended after them silently breaks that anchor.
  // W1-T964: `mineFollowups` (retro.ts) matches a harvest mark back to its source entry to decide
  // whether to mint a fresh candidate, and a followup must survive PAST either recency window. All
  // three must land TOGETHER: source without marks RE-MINTS an adjudicated entry, marks without
  // source LOSES it. Falsifier: test/followup-rotation-idempotency.test.ts.
  "report.followups",
  "followup.harvested",
  "followup.deduped",
]);

/** W1-T2244: one recorded operator override of a risk-judge escalation. The judged VERDICT and
 *  CONFIDENCE are carried VERBATIM, copied at write time and never re-derived, so the row stays
 *  self-contained once the escalation itself has rotated away. */
export interface RiskOverrideRecord {
  taskId: string;
  issueUrl: string;
  headSha: string;
  verdict: "low" | "high";
  confidence: number;
  disposition: RiskOverrideDisposition;
  reasonClass: RiskOverrideReasonClass;
  reason?: string;
}

/** Last valid override wins, as in cappedOverrideFromLedger (W1-T2244 design viii–x).
 * Require the caller's headSha: an old head describes a vanished diff. Skip unknown dispositions
 * and reason classes. Display only; never decide dispatch or merge from this record.
 * Falsifier: test/risk-override-reader-refusals.test.ts. */
export function riskOverrideFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  headSha: string,
): RiskOverrideRecord | undefined {
  let found: RiskOverrideRecord | undefined;
  for (const line of lines) {
    if (line.step !== RISK_OVERRIDE_RECORDED_STEP || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    if (line.verdict !== "low" && line.verdict !== "high") continue;
    if (typeof line.confidence !== "number") continue;
    if (typeof line.issue_url !== "string") continue;
    if (typeof line.disposition !== "string" || !(RISK_OVERRIDE_DISPOSITIONS as readonly string[]).includes(line.disposition)) continue;
    if (typeof line.reason_class !== "string" || !(RISK_OVERRIDE_REASON_CLASSES as readonly string[]).includes(line.reason_class)) continue;
    found = {
      taskId,
      issueUrl: line.issue_url,
      headSha: line.head_sha,
      verdict: line.verdict,
      confidence: line.confidence,
      disposition: line.disposition as RiskOverrideDisposition,
      reasonClass: line.reason_class as RiskOverrideReasonClass,
      ...(typeof line.reason === "string" ? { reason: line.reason } : {}),
    };
  }
  return found;
}

/** Steps matched by PREFIX rather than enumerated — currently only `deploy.*` (deployer.ts's
 *  `runDeployCycle`). Prefix matching covers a future `deploy.*` step automatically, the same
 *  "derived, not a stale hardcoded list" doctrine {@link DECISION_RELEVANT_LEDGER_STEPS} states. */
const HEALTH_RELEVANT_LEDGER_STEP_PREFIXES: readonly string[] = ["deploy."];

/** True for `daemon.boot` and any `deploy.*` step — W1-T244's health-window-bounded steps
 *  (see {@link DECISION_RELEVANT_LEDGER_STEPS}'s doc for why these are NOT kept unconditionally
 *  like the rest of the decision-relevant set). */
function isHealthOrDeployStep(step: string): boolean {
  return step === "daemon.boot" || HEALTH_RELEVANT_LEDGER_STEP_PREFIXES.some((prefix) => step.startsWith(prefix));
}

/** How far back a health-window-bounded step survives rotation. Comfortably larger than any real
 *  health window here (deployer.ts's own default is 45s), so `assessBootHealth` never loses a line
 *  still inside its window, while a restart storm's boot count stays bounded rather than kept. */
export const HEALTH_STEP_RETENTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Rows retained for per-model attribution, not daemon decisions. W1-T3080 needs `implement.done`
 * to survive rotation because it carries `served_model`/`routed_model` from `workerLedgerFields`;
 * `verdict` remains the terminal decision row, so `implement.done` deliberately stays outside
 * {@link DECISION_RELEVANT_LEDGER_STEPS}.
 */
export const MODEL_ATTRIBUTION_LEDGER_STEPS: ReadonlySet<string> = new Set(["implement.done"]);

function isModelAttributionStep(step: string): boolean {
  return MODEL_ATTRIBUTION_LEDGER_STEPS.has(step);
}

/** Recency-bounded console history, never daemon decisions or the permanent decision core.
 * Each entry names its consumer; test/ledger-render-retention.test.ts re-derives membership.
 * Trap: ACCOUNT read "unknown" on a healthy fleet (docs/forensics/ledger.md#render_relevant_ledger_steps). */
export const RENDER_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "daemon.headroom",
  "console.kick_refused",
  "console.kick_dispatched",
  // W1-T282's LANE_START_STEPS (status.ts) let the NOW panel open a run on any lane's start, and
  // none was retained, so a long-running lane vanished from "currently running" at the next
  // rotation. This window equals `deriveRunState`'s 30-minute liveness bound, so a start ages out
  // exactly when NOW stops calling it live. `run.start` and `plan.start` are deliberately absent.
  "daemon.start",
  "drain.start",
  "retro.start",
  "serve.start",
  "triage.start",
  // THE GOVERNOR'S TWO "I CANNOT READ USAGE" SIGNALS, by exact name because `isRenderRelevantStep`
  // is a `Set.has` and a dotted child inherits nothing. A blind governor fails closed and idles the
  // fleet, and these are how it says so. The window suffices because `degraded` re-fires every tick
  // and each row's `consecutive_unreadable` states the duration. Protected for an unmerged
  // consumer, at a known cost.
  "daemon.headroom.degraded",
  "daemon.headroom.unavailable",
  // W1-T329: the two dispatch-deferring governors' heartbeats, written on every tick either defers
  // NEW dispatch, carrying the observed figure against its ceiling. Nothing in the dispatch path
  // re-reads them — sweep.ts's predicates are fresh each tick — so they exist purely so a human can
  // see WHY the fleet looks idle. account-usage.ts reads the newest line of each.
  "daemon.cost_governor",
  "daemon.queue_governor",
  // W1-T333: who, when, from and to for every console write to the daily-cost-ceiling override.
  // The CURRENT value is state read fresh by policy.ts, so this line is HISTORY, not a decision.
  "console.ceiling_override_written",
  // W1-T1237: the sweep's per-pass heartbeat, in NEITHER retention set before that task. BOTH by
  // exact name: doctor.ts's `judgeSweepLiveness` derives two faults from the PAIR.
  "sweep.pass",
  "sweep.summary",
  // W1-T3080: union-retention-census parses the historic retention-set exports; the actual
  // rotator treats this through MODEL_ATTRIBUTION_LEDGER_STEPS below (no render recency window).
  "implement.done",
]);

/** True for any step in {@link RENDER_RELEVANT_LEDGER_STEPS}. */
function isRenderRelevantStep(step: string): boolean {
  return RENDER_RELEVANT_LEDGER_STEPS.has(step);
}

/** How far back a render-relevant step survives rotation. SIZED FROM THE CONSUMER: account-usage.ts
 *  declares the ACCOUNT strip's staleness bound as `USAGE_CACHE_MAX_AGE_MS` (30 minutes), so less
 *  here would make the strip read "unknown" straight after a rotation. Restated rather than
 *  imported — account-usage.ts already depends transitively on this module. */
export const RENDER_STEP_RETENTION_WINDOW_MS = 30 * 60 * 1000;

// ── CONSOLE WRITE AUDIT: the daily-cost-ceiling override (W1-T333) ─────────────────────────────
//
// Who, when, from and to for every console write, queryable at runtime rather than only in git.
// `appendLedger` is append-only, so ONE LINE PER WRITE is the full history, never a summary.

/** The step name a console write to the daily-cost-ceiling override is ledgered under — see
 *  {@link RENDER_RELEVANT_LEDGER_STEPS}'s entry for this exact string for why it is render-, not
 *  decision-, relevant, and {@link appendDailyCostCeilingOverrideAudit} for what it carries. */
export const CEILING_OVERRIDE_WRITTEN_STEP = "console.ceiling_override_written";

/** Audit who/from/to and the resulting effective ceiling. appendLedger stamps when as ts;
 * a caller-supplied timestamp could drift from the actual write. */
export interface DailyCostCeilingOverrideAudit {
  runId: string;
  taskId: string;
  /** Who performed the write — an operator identity/session label, never blank. */
  who: string;
  fromUsd: number;
  toUsd: number;
  /** policy.ts resolveDailyCostCeiling after writing; record independently of toUsd so a refused
   * override stays visible as a mismatch rather than an assumed success. */
  effectiveUsd: number;
}

/** Ledger one console write to the daily cost ceiling override. The caller — the console WRITE
 *  control, which W1-T333 explicitly did not build — must invoke this alongside policy.ts's
 *  `writeDailyCostCeilingOverride`, so a write auditable but never applied cannot happen. */
export function appendDailyCostCeilingOverrideAudit(ledgerPath: string, audit: DailyCostCeilingOverrideAudit): void {
  appendLedger(ledgerPath, {
    run_id: audit.runId,
    task_id: audit.taskId,
    step: CEILING_OVERRIDE_WRITTEN_STEP,
    who: audit.who,
    from_usd: audit.fromUsd,
    to_usd: audit.toUsd,
    effective_usd: audit.effectiveUsd,
  });
}

/** Keep newest-N per decision step, except sweep.disposed and health steps with their own bounds.
 * Without this cap the core alone exceeds the ceiling and every append re-rotates: 80+ archives,
 * bursts of 12 rotations/second (docs/forensics/ledger.md#max_retained_lines_per_step).
 * Consumers read recent history. */
export const MAX_RETAINED_LINES_PER_STEP = 200;

export const REVIEW_POSTED_RETAINED_ROWS = 140; // W1-T5517 PRIMARY CONTROL: 200 x the 70% of rows newest for their task
export const SWEEP_DISPOSED_RECENT_WINDOW_MS = 24 * 3_600_000; // W1-T5517: every sweep.disposed row inside it carries
export const SWEEP_DISPOSED_STANDING_WINDOW_MS = 7 * 24 * 3_600_000; // W1-T5517: dueRepairFilings' default window
export const LEDGER_CORE_TARGET_SHARE = 0.9; // W1-T5517: the carried core's declared share of the fixed ceiling
const SWEEP_REPAIR_DISPOSITIONS: ReadonlySet<unknown> = new Set(["blocked-fixable", "blocked-ambiguous", "stale", "conflicted"]);

/** Minimal fs surface {@link ledgerExceedsRotationCeiling} and {@link rotateLedger} need,
 *  injectable so a test proves the ceiling check without ever touching a real file. */
export interface LedgerRotationFsDeps {
  existsSync: (path: string) => boolean;
  statSize: (path: string) => number;
}

const realRotationFs: LedgerRotationFsDeps = {
  existsSync: (path) => existsSync(path),
  statSize: (path) => statSync(path).size,
};

/** True iff `path` exceeds its carried effective ceiling, base `ceilingBytes` (default {@link
 *  LEDGER_ROTATION_CEILING_BYTES}). An absent ledger never "exceeds" anything: nothing to rotate. */
export function ledgerExceedsRotationCeiling(
  path: string,
  ceilingBytes: number = LEDGER_ROTATION_CEILING_BYTES,
  fsDeps: LedgerRotationFsDeps = realRotationFs,
): boolean {
  if (!fsDeps.existsSync(path)) return false;
  const carried = readCarriedPrefix(path);
  const effective = carried?.effectiveCeilingBytes;
  const rate = carried?.rateBytesPerHour;
  const limit = typeof effective === "number" && Number.isSafeInteger(effective) &&
    typeof rate === "number" && Number.isFinite(rate) && rate > 0
    ? Math.min(ceilingBytes * LEDGER_ROTATION_BACKSTOP_MULTIPLIER, Math.max(ceilingBytes, effective))
    : ceilingBytes;
  return fsDeps.statSize(path) > limit;
}

/** Parse once; carry object identity through classification, windows, sweep dedup, caps and shedding.
 * Regroup freely, then recover file order by identity without re-parsing or fuzzy text matching. */
interface ParsedLedgerLine {
  raw: string;
  json?: Record<string, unknown>;
  step?: string;
  /** `Date.parse(json.ts)` when `ts` is a valid ISO string; `undefined` otherwise — a line
   *  with no parseable timestamp is never guessed at (see the health-window/shed passes). */
  tsMs?: number;
}

function parseLedgerLine(raw: string): ParsedLedgerLine {
  try {
    const json = JSON.parse(raw.trim()) as Record<string, unknown>;
    const step = typeof json.step === "string" ? json.step : undefined;
    const tsMs = typeof json.ts === "string" ? Date.parse(json.ts) : NaN;
    return { raw, json, step, tsMs: Number.isFinite(tsMs) ? tsMs : undefined };
  } catch {
    return { raw };
  }
}

function readSyncRange(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, end - start, start);
    return buf;
  } finally {
    closeSync(fd);
  }
}

const ROTATION_SEAL_STEP = "ledger.rotation_sealed";
const ROTATION_SEAL_MARK = Buffer.from(`"step":"${ROTATION_SEAL_STEP}"`, "utf8");

/** W1-T5514: seal the replaced inode (`fd`, O_APPEND), then copy every row before the seal from
 *  `from` on into the NEW live `path`, a torn tail newline-terminated (see {@link rotateLedger}). */
function drainReplacedInode(fd: number, from: number, path: string, nowIso: string): void {
  const seal = Buffer.from(rotationRow(ROTATION_SEAL_STEP, { nonce: randomUUID() }, nowIso), "utf8");
  writeSync(fd, seal, 0, seal.length);
  const buf = Buffer.alloc(fstatSync(fd).size - from);
  const view = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
  const sealAt = view.indexOf(seal);
  let rows = view.subarray(0, sealAt < 0 ? view.length : sealAt);
  if (rows.length > 0 && rows[rows.length - 1] !== 0x0a) {
    console.error(`ledger: rotation drained a torn ${rows.length}-byte tail into ${path}; kept, newline-terminated`);
    rows = Buffer.concat([rows, Buffer.from("\n")]);
  }
  if (rows.length > 0) appendFileSync(path, rows);
}

/** W1-T5514: `rows` this appender wrote AFTER a rotation's seal on an inode it already replaced
 *  (`nlink` 0), so its drain never copied them. Before the seal, or no seal yet: the drain has them. */
function rowsBehindRotationSeal(fd: number, rows: Buffer[]): Buffer[] {
  const st = fstatSync(fd);
  if (st.nlink > 0) return [];
  const all = Buffer.alloc(st.size);
  readSync(fd, all, 0, st.size, 0);
  const sealAt = all.indexOf(ROTATION_SEAL_MARK);
  return sealAt < 0 ? [] : rows.filter((row) => all.lastIndexOf(row) > sealAt);
}

function reappendBehindSeal(path: string, rows: Buffer[]): void {
  for (let behind: Buffer[] = [Buffer.concat(rows)]; behind.length > 0; ) {
    const fd = openSync(path, "a+");
    try {
      writeSync(fd, behind[0]!, 0, behind[0]!.length);
      behind = rowsBehindRotationSeal(fd, behind);
    } finally {
      closeSync(fd);
    }
  }
}

/** The rotation's atomic write — the shared primitive since W1-T2899. `content` accepts a
 *  `Buffer` (gzip's output, W1-T2482). `beforeRename` (R-1) runs with the stage fully written,
 *  immediately before the rename; returning `false` withdraws the swap, which is how
 *  {@link rotateLedger} refuses to rename over a file that is no longer the inode it snapshotted.
 *  The `rotate-tmp` tag is kept so ledger-grep.ts's `ledgerRotationEntries` cannot mistake a
 *  stage for an archive. */
function writeFileAtomic(path: string, content: string | Buffer, beforeRename?: () => boolean): boolean {
  return writeAtomic(path, content, { beforeRename, tmpTag: "rotate-tmp" });
}

/** The whole live file read through ONE descriptor, with that descriptor's `fstat` identity, so
 *  `size`, `content` and `{dev, ino}` describe the same open file rather than three separate path
 *  re-resolutions. {@link rotateLedger} compares `identity` against a by-name `stat` right before
 *  its final rename: a mismatch means the path no longer holds the snapshotted file. */
function readSnapshotWithIdentity(path: string): { size: number; content: string; bytes: Buffer; identity: FileIdentity } {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return { size: st.size, content: buf.toString("utf8"), bytes: buf, identity: { dev: st.dev, ino: st.ino } };
  } finally {
    closeSync(fd);
  }
}

/** Sibling of the live ledger that serialises {@link rotateLedger} across processes,
 *  `<ledgerPath>.rotate.lock`. It ends in neither `.ndjson` nor `.ndjson.gz`, so ledger-grep.ts's
 *  `ledgerRotationEntries` never mistakes it for an archive — the same reason
 *  `writeFileAtomic`'s `.rotate-tmp-*` staging names are invisible to that reader. */
export function ledgerRotationLockPath(ledgerPath: string): string {
  return `${ledgerPath}.rotate.lock`;
}

/** Sidecar naming the retained core the last rotation wrote back as the live file's prefix, as
 *  `{bytes, sha256, rateBytesPerHour, effectiveCeilingBytes}`. Every prefix row is already archived, so the next
 *  rotation archives only the bytes after it. Ends in `.json`, so no reader lists it as an archive. */
export function ledgerCarriedPrefixPath(ledgerPath: string): string {
  return `${ledgerPath}${LEDGER_CARRIED_PREFIX_SUFFIX}`;
}

export function ledgerRetainedStepsPath(ledgerPath: string): string {
  return `${ledgerPath}${LEDGER_RETAINED_STEPS_SUFFIX}`;
}

interface RetainedStepsRecord {
  steps: string[];
  lastFullRotationMs?: number;
  lastDeferral?: { key: string; atMs: number };
}

type RetainedStepsRead = { status: "absent" } | { status: "unreadable" } | { status: "ok"; record: RetainedStepsRecord };

function readRetainedSteps(ledgerPath: string): RetainedStepsRead {
  const path = ledgerRetainedStepsPath(ledgerPath);
  if (!existsSync(path)) return { status: "absent" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RetainedStepsRecord>;
    if (!isValidRetainedStepsMetadata(raw)) return { status: "unreadable" };
    const last = typeof raw.lastFullRotationMs === "number" && Number.isFinite(raw.lastFullRotationMs) ? raw.lastFullRotationMs : undefined;
    const deferral = raw.lastDeferral && typeof raw.lastDeferral.key === "string" && typeof raw.lastDeferral.atMs === "number" ? raw.lastDeferral : undefined;
    return { status: "ok", record: { steps: raw.steps as string[], lastFullRotationMs: last, lastDeferral: deferral } };
  } catch {
    return { status: "unreadable" };
  }
}

function lastByKey(rows: readonly ParsedLedgerLine[], keyOf: (p: ParsedLedgerLine) => string | undefined): Map<string, ParsedLedgerLine> {
  const last = new Map<string, ParsedLedgerLine>();
  for (const p of rows) {
    const key = keyOf(p);
    if (key !== undefined) last.set(key, p);
  }
  return last;
}

function dropSupersededReviews<T extends ParsedLedgerLine>(rows: T[]): T[] { // W1-T5517: superseded for every live reader
  const newest = lastByKey(rows, (p) => (p.step === "review.posted" && typeof p.json?.task_id === "string" ? p.json.task_id : undefined));
  const input = (j: Record<string, unknown>): string => JSON.stringify([j.pr_url, j.head_sha, j.review_input_digest]);
  return rows.filter((p) => {
    const n = p.step === "review.posted" && typeof p.json?.task_id === "string" ? newest.get(p.json.task_id) : undefined;
    if (n === undefined || n === p || !p.json || !n.json) return true;
    return input(p.json) === input(n.json) // reviewAttemptsForInput counts every row of the newest input
      || p.json.failure_class === "instrument_entangled" // previousInstrumentEntanglementFromLedger reads any head
      || (n.json.state !== "success" && !Array.isArray(n.json.unmet_criteria)); // unmetFromLedger carries claims past it
  });
}

function boundSweepRows(rows: readonly ParsedLedgerLine[], nowMs: number): ParsedLedgerLine[] { // W1-T5517: while a reader reads it
  const newestWhere = (has: (j: Record<string, unknown>) => boolean): Map<string, ParsedLedgerLine> =>
    lastByKey(rows, (p) => (p.step === "sweep.disposed" && p.json && has(p.json) ? String(p.json.pr_number) : undefined));
  const newest = [newestWhere(() => true), newestWhere((j) => typeof j.main_tip_sha === "string"), newestWhere((j) => typeof j.blocker === "string")];
  return rows.filter((p) => {
    const j = p.json;
    const ageMs = p.tsMs === undefined ? undefined : nowMs - p.tsMs;
    if (p.step !== "sweep.disposed" || !j || ageMs === undefined || ageMs <= SWEEP_DISPOSED_RECENT_WINDOW_MS) return true;
    if (typeof j.keep_head_branch === "string") return true; // keepReversiblyClosedHeads, at any age
    if (ageMs > SWEEP_DISPOSED_STANDING_WINDOW_MS) return false;
    return (j.acted === true && SWEEP_REPAIR_DISPOSITIONS.has(j.disposition)) // dueRepairFilings and the stale close
      || newest.some((byPr) => byPr.get(String(j.pr_number)) === p); // streaks, merge state, base-caused tip, blocker clock
  });
}

function rotationRow(step: string, fields: Record<string, unknown>, nowIso: string): string {
  return JSON.stringify({ ts: nowIso, run_id: "ledger-rotation", task_id: "_ledger", step, host: hostname(), ...fields }) + "\n";
}

function rowsToRecarry(
  dir: string,
  lastFullRotationMs: number,
  retained: ReadonlySet<string>,
  live: ReadonlySet<string>,
  fs: ArchiveNamingFs,
): { rows: ParsedLedgerLine[]; archives: string[]; torn: Array<{ name: string; reason: string }> } {
  const rows: ParsedLedgerLine[] = [];
  const archives: string[] = [];
  const torn: Array<{ name: string; reason: string }> = [];
  for (const { name, mtimeMs } of archiveMtimes(dir, fs)) {
    if (mtimeMs <= lastFullRotationMs || Date.parse(rotationStampIso(name)!) <= lastFullRotationMs) continue;
    let text: string;
    try {
      const buf = readFileSync(join(dir, name));
      text = (name.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
    } catch (error) {
      torn.push({ name, reason: String((error as Error)?.message ?? error).slice(0, 120) });
      continue;
    }
    let found = false;
    for (const raw of text.split("\n")) {
      if (raw.trim() === "" || live.has(raw)) continue;
      const parsed = parseLedgerLine(raw);
      if (!parsed.step || !retained.has(parsed.step)) continue;
      rows.push(parsed);
      found = true;
    }
    if (found) archives.push(name);
  }
  rows.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  return { rows, archives, torn };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface CarriedPrefix {
  bytes?: unknown;
  sha256?: unknown;
  rateBytesPerHour?: unknown;
  effectiveCeilingBytes?: unknown;
}

function readCarriedPrefix(ledgerPath: string): CarriedPrefix | null {
  try {
    return JSON.parse(readFileSync(ledgerCarriedPrefixPath(ledgerPath), "utf8")) as CarriedPrefix | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`ledger: unreadable carried prefix ${ledgerCarriedPrefixPath(ledgerPath)}: ${String(error)}`);
    }
    return null;
  }
}

/** Leading bytes already archived; an unknown prefix duplicates the snapshot and never loses a row. */
function archivedPrefixBytes(carried: CarriedPrefix | null, snapshot: Buffer): number | undefined {
  const bytes = carried?.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > snapshot.length) return undefined;
  return sha256Hex(snapshot.subarray(0, bytes)) === carried?.sha256 ? bytes : undefined;
}

/** Share acquireDrainLock's {pid, host, startedAt} shape and parser, so isHolderStale applies
 * the same host, pid-liveness and process-start-time checks without rotation-specific drift. */
type LedgerRotationLockInfo = DrainLockInfo;

export function isRotationLockHolderStale(
  held: DrainLockInfo,
  opts: { hostname?: () => string; inContainer?: () => boolean; nowMs?: number; isPidAlive?: (pid: number) => boolean } = {},
): boolean {
  const myHost = (opts.hostname ?? hostname)();
  if (!sameHost(held.host, myHost)) {
    const startedMs = Date.parse(held.startedAt);
    return !Number.isFinite(startedMs) || (opts.nowMs ?? systemClock.now()) - startedMs > LEDGER_ROTATION_SMOOTHING_WINDOW_MS;
  }
  return isHolderStale(held, { isPidAlive: opts.isPidAlive ?? defaultIsPidAlive, hostname: opts.hostname, inContainer: opts.inContainer });
}

/** Take O_EXCL rotation lock; reclaim dead holders via reclaimStaleLock, as acquireDrainLock does.
 * Skip live holders immediately: append already landed and the holder's catch-up folds it in.
 * W1-T4820: judge other-container holders by age; treating daemon/serve peers as dead cut twin archives.
 * Falsifiers: test/ledger-rotation-is-locked.test.ts, test/the-status-board-reads-each-ledger-row-once.test.ts.
 * See docs/forensics/ledger.md#tryacquirerotationlock (R-1). */
function tryAcquireRotationLock(lockPath: string): (() => void) | null {
  const info: LedgerRotationLockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseDrainLockInfo,
        isStale: (held) => isRotationLockHolderStale(held),
      });
      if (result.outcome === "live") return null;
      // "missing" | "reclaimed" | "lost" → retry the atomic create from the top.
    }
  }
  // `force`: a lock some other actor already cleared (a reclaimer that mis-judged this holder
  // stale) must not turn release into a throw — the rotation's own outcome was decided by the
  // identity guard, not by whether the lock file survived.
  return () => rmSync(lockPath, { force: true });
}

function datedArchivePath(path: string, now: Date): string {
  const base = basename(path).replace(/\.ndjson$/, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(path), `${base}.${stamp}.ndjson`);
}

/** Heal archive names against each file's own OS mtime (W1-T4100).
 * Incident, 2026-09-23: ledger.2027-10-14T21-24-52-494Z.ndjson.gz had mtime 2026-09-13;
 * newest-by-name readers (rotationStampIso callers) picked that stale file over every later write.
 * datedArchivePath trusted its caller's Date; formatting was not the defect.
 * On every rotation, check all existing archives and heal each to its own mtime, never promote
 * stale history to newest. Nudge millisecond collisions minimally without reordering other mtimes.
 * Return the newest safe stamp so the genuinely new archive sorts no earlier than existing ones.
 * healIfAheadOfOwnMtime checks the new write independently of its caller's clock.
 * Falsifier: test/the-ledger-rotates-at-a-steady-pace.test.ts. */
function reconcileArchiveStamps(dir: string, fs: ArchiveNamingFs): number | undefined {
  let maxSafeMs: number | undefined;
  for (const { name, mtimeMs } of archiveMtimes(dir, fs)) {
    const nameMs = Date.parse(rotationStampIso(name)!);
    if (!Number.isFinite(nameMs)) continue;
    let safeMs = nameMs;
    if (nameMs > mtimeMs) {
      const renamed = renameArchiveTo(join(dir, name), name, mtimeMs, fs);
      // A failed rename leaves the old (unsafe) name on disk; a nudged one lands a little later.
      safeMs = renamed === undefined ? nameMs : Date.parse(rotationStampIso(basename(renamed))!);
    }
    if (maxSafeMs === undefined || safeMs > maxSafeMs) maxSafeMs = safeMs;
  }
  return maxSafeMs;
}

/** Every rotation-archive-shaped entry in `dir` with its real (OS-assigned) mtime. An unreadable
 *  dir reads as no archives and an entry gone since the readdir is skipped — both best-effort, so
 *  naming and pacing never fail the rotation that asked. */
function archiveMtimes(dir: string, fs: ArchiveNamingFs): Array<{ name: string; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // state dir unreadable — nothing to reconcile or pace against, same as no archives
  }
  const out: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (rotationStampIso(name) === undefined) continue; // only real archive-shaped names count
    try {
      out.push({ name, mtimeMs: fs.mtimeMs(join(dir, name)) });
    } catch {
      continue; // gone since the readdir — nothing to heal, count or pace against
    }
  }
  return out;
}

/** Rename the archive at `fullPath` (current basename `currentName`) to the name `stampMs`
 *  encodes, preserving its gzip/plain form, and return its new path. A name another archive already
 *  holds is nudged forward a millisecond at a time — `renameSync` would silently replace that file.
 *  Best-effort: a failed rename returns `undefined` and must never fail the rotation that triggered
 *  the heal — the file is simply left as it was, never deleted or truncated. */
function renameArchiveTo(fullPath: string, currentName: string, stampMs: number, fs: ArchiveNamingFs): string | undefined {
  const ext = currentName.endsWith(".gz") ? ".ndjson.gz" : ".ndjson";
  const nameAt = (ms: number): string => `ledger.${fixedClock(ms).iso().replace(/[:.]/g, "-")}${ext}`;
  let ms = Math.floor(stampMs);
  if (nameAt(ms) === currentName) return fullPath; // already safe under its own name
  while (existsSync(join(dirname(fullPath), nameAt(ms)))) ms++;
  const target = join(dirname(fullPath), nameAt(ms));
  try {
    fs.renameSync(fullPath, target);
    return target;
  } catch {
    return undefined; // best-effort — a failed rename must never fail the rotation that triggered it
  }
}

/** Check the new archive against its own real mtime after writeArchive (W1-T4100).
 * The naming clock now caused the incident; rereading it cannot validate the name.
 * lastArchiveMs from reconcileArchiveStamps keeps the healed name monotonic against existing files. */
function healIfAheadOfOwnMtime(archivePath: string, lastArchiveMs: number | undefined, fs: ArchiveNamingFs): string {
  let mtimeMs: number;
  try {
    mtimeMs = fs.mtimeMs(archivePath);
  } catch {
    return archivePath; // can't stat the archive just written — leave its name exactly as it is
  }
  const name = basename(archivePath);
  const iso = rotationStampIso(name);
  const nameMs = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(nameMs) || nameMs <= mtimeMs) return archivePath; // not ahead — leave it
  // FLOOR, never round: mtimeMs is sub-millisecond and a stamp is not, so a rounded-UP ms could
  // still land a fraction of a millisecond ahead of the real mtime it was meant to cap at.
  let safeMs = Math.floor(mtimeMs);
  if (lastArchiveMs !== undefined && safeMs <= lastArchiveMs) safeMs = lastArchiveMs + 1;
  return renameArchiveTo(archivePath, name, safeMs, fs) ?? archivePath;
}

/** Minimal fs surface {@link writeArchive} needs for compression, injectable so a test can force
 *  compression to fail — proving the fallback below — without monkey-patching `node:zlib`. */
export interface LedgerArchiveFsDeps {
  gzipSync: (buf: Buffer) => Buffer;
  /** W1-T4100: the archive-naming and pacing reads, each defaulting to node:fs, so every
   *  best-effort arm of {@link archiveMtimes}/{@link renameArchiveTo} is provable. */
  readdirSync?: (dir: string) => string[];
  mtimeMs?: (path: string) => number;
  renameSync?: (from: string, to: string) => void;
}

type ArchiveNamingFs = Required<LedgerArchiveFsDeps>;

const realArchiveFs: ArchiveNamingFs = {
  gzipSync: (buf) => gzipSync(buf),
  readdirSync: (dir) => readdirSync(dir),
  mtimeMs: (path) => statSync(path).mtimeMs,
  renameSync: (from, to) => renameSync(from, to),
};

/** Compress rotation snapshots (W1-T2482); ledger-grep.ts already reads gzip since W1-T444.
 * Append .gz only after compression succeeds. On failure archive plain, preserving the snapshot:
 * relocated, never deleted. Falsifier: test/rotation-compresses-what-the-reader-already-decompresses.test.ts. */
function writeArchive(plainArchivePath: string, snapshot: string, fsDeps: LedgerArchiveFsDeps): string {
  try {
    const compressed = fsDeps.gzipSync(Buffer.from(snapshot, "utf8"));
    const gzipPath = `${plainArchivePath}.gz`;
    writeFileAtomic(gzipPath, compressed);
    return gzipPath;
  } catch (err) {
    console.error(
      `ledger: rotation compression failed for ${plainArchivePath}, archiving plain (${(err as Error)?.message ?? String(err)})`,
    );
    writeFileAtomic(plainArchivePath, snapshot);
    return plainArchivePath;
  }
}

/** What one {@link rotateLedger} call did. */
export interface LedgerRotationResult {
  /** False when the ledger was absent or already at/under the ceiling — nothing to do. */
  rotated: boolean;
  /** Absolute path to the dated archive holding every pre-rotation line verbatim past the carried
   *  prefix (see {@link ledgerCarriedPrefixPath}) — set only when `rotated` and that delta is non-empty. Ends in `.ndjson.gz` (the form {@link writeArchive}/ledger-grep.ts's
   *  `ledgerRotationEntries` both already call "gzip") unless compression itself failed, in
   *  which case it ends in plain `.ndjson` — see {@link writeArchive}'s own doc. */
  archivePath?: string;
  /** Lines relocated to the archive because they were neither decision-relevant nor parseable. */
  archivedLineCount?: number;
  /** Lines retained live — the ones matching {@link DECISION_RELEVANT_LEDGER_STEPS}, any
   *  model-attribution line, any health/render-relevant line still inside its own retention window
   *  (see {@link HEALTH_STEP_RETENTION_WINDOW_MS}/{@link RENDER_STEP_RETENTION_WINDOW_MS}), plus
   *  anything appended after the snapshot (see doc below). */
  retainedLineCount?: number;
  deferredMissingSteps?: string[];
  recarriedLineCount?: number;
}

/**
 * Roll, but keep a decision tail (W1-T209). Move the file byte-for-byte into a dated archive —
 * relocated, never deleted; since the delta change, only the bytes past the already-archived carried
 * prefix — then rewrite the live path to hold only the decision-relevant lines.
 * A rotation that shrinks the file but drops one of those is worthless, so the acceptance test is
 * the breaker, not the file size. Only the snapshot is gzipped (W1-T2482), and this is a no-op when
 * the ledger is absent or under `ceilingBytes`.
 *
 * Two rotators (R-1, 2026-09-05). Four invariants, all falsified by
 * test/ledger-rotation-is-locked.test.ts:
 *   1. {@link tryAcquireRotationLock} serialises rotation across processes, taken after the cheap
 *      ceiling check and before the snapshot.
 *   2. A rotator meeting a live holder returns `{ rotated: false }` at once, because append is the
 *      priority and the holder's catch-up read folds that append in.
 *   3. The ceiling is re-checked once the lock is held, or a rotator queued behind a completed
 *      rotation re-archives the freshly shrunk file.
 *   4. The rename is withdrawn when a `dev`+`ino` compare shows the live path is no longer the
 *      snapshotted inode, leaving the archive already written on disk.
 *
 * Concurrent appenders (W1-T5514): rows landing after the catch-up read hit the old inode. An fd held
 * across the rename seals it and drains every row before the seal into the new live file; an appender
 * that finds its row AFTER the seal on an unlinked inode re-appends it. No row is lost or doubled.
 * Why: without the lock the second rotator's catch-up saw the first's smaller live file, took an
 * empty tail and renamed over it (R-1; docs/forensics/ledger.md#rotateledger).
 */
// W1-T3237: compact archives without losing unique history; never delete them for retention.
// Fleet 2026-09-09: 646 gzip + 2 plain archives + live, 2,709,938,810 uncompressed bytes;
// 900,813 distinct rows = 283,539,709 bytes (9.6x collapse). The pile OOM-killed retro (W1-T3229).
// Rotation caps newest-per-step live rows but archives the rest; no archive retention was chosen.
// Archives are not cumulative: deleting one destroys unique data and invalidates history counts.
// Compaction is an operator act, like deploy/host-update.sh and image rebuilds, never a rotation
// side effect: a multi-hundred-megabyte rewrite would block the daemon's ledger append path.
/** What one compaction did, in terms a caller can assert on rather than infer from bytes. */
export interface LedgerCompactionResult {
  /** Rotations read and replaced. */
  sourceCount: number;
  /** DISTINCT rows written — the set that must be identical to the union of the sources. */
  rowsWritten: number;
  /** Duplicate lines collapsed. The reclaim is exactly this many rows' worth. */
  duplicatesCollapsed: number;
  /** The NEWEST compacted archive's filename, whose stamp is the newest row it carries — see below. */
  archiveName: string;
  /** Every archive written, one per UTC day of the rows' ts, oldest first. */
  archiveNames: string[];
}

/**
 * The name a compacted archive must take.
 *
 * ITS STAMP IS THE NEWEST ROW IT CARRIES, AND THAT IS NOT A STYLE CHOICE. `rotationBeforeWindow`
 * (lib/ledger-union.ts) SKIPS a rotation whose filename stamp is older than the window's start, so
 * a compacted file stamped with its OLDEST row would be skipped whole by any window beginning
 * mid-range — silently losing every newer row inside it. Stamped with the NEWEST row, the file is
 * never wrongly skipped, and rows outside the window are still filtered per-row by
 * `recordMatchesFilters`, exactly as they are today.
 *
 * The format mirrors `rotationStampIso`'s parser byte for byte, because a name that parser cannot
 * read is a file every windowed union silently ignores.
 */
export function compactedArchiveName(newestTs: string): string {
  // toISOString() already ends in Z; the replace only rewrites : and . — appending another Z
  // produced `...-000ZZ`, which rotationStampIso does not match, so every windowed union would
  // have silently ignored the compacted file. Caught by the round-trip case below.
  return `ledger.${fixedClock(Date.parse(newestTs)).iso().replace(/[:.]/g, "-")}.ndjson.gz`;
}

/**
 * Compact a set of rotations into deduped archives, one per UTC day, preserving every distinct row.
 *
 * PURE OVER INJECTED I/O so its falsifier can assert ROW-SET EQUALITY rather than a size drop. A
 * compaction that shrinks the corpus is trivial to write and worthless to trust: a byte-count
 * assertion passes on a TRUNCATION, which is the one outcome this must never ship.
 *
 * MEMORY IS BOUNDED BY THE CALLER'S CHOICE OF SOURCES, not by this function. It holds the distinct
 * rows of what it is given, so an operator compacts a window at a time; handing it all 646
 * rotations at once would hold ~283MB of strings and is the caller's decision to make.
 */
export function compactRotations(
  sources: readonly string[],
  io: {
    readRows: (path: string) => string[];
    write: (name: string, body: string) => void;
    remove: (path: string) => void;
    clock?: Clock;
  },
): LedgerCompactionResult {
  const seen = new Set<string>();
  const rows: string[] = [];
  let read = 0;
  for (const path of sources) {
    for (const raw of io.readRows(path)) {
      const line = raw.trim();
      if (!line) continue;
      read += 1;
      if (seen.has(line)) continue;
      seen.add(line);
      rows.push(line);
    }
  }
  if (rows.length === 0) {
    return { sourceCount: sources.length, rowsWritten: 0, duplicatesCollapsed: 0, archiveName: "", archiveNames: [] };
  }
  // Ordered by each row's OWN ts, so the compacted archive reads chronologically like the rotations
  // it replaces. A row with no parseable ts sorts last rather than being dropped — losing a torn
  // row to tidy the ordering would be exactly the truncation this refuses.
  const tsOf = (line: string): number => {
    const m = /"ts":"([^"]+)"/.exec(line);
    const parsed = m ? Date.parse(m[1]) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  rows.sort((a, b) => tsOf(a) - tsOf(b));
  const clock = io.clock ?? systemClock;
  const nowMs = clock.now();
  // ONE ARCHIVE PER UTC DAY of the rows' ts, so a window read opens only the days it needs rather
  // than a ~1M-row whole-corpus file (fleet host, 2026-09-23). A row stamped in the future (one read
  // 2027-10-14 on 2026-09-23) joins today's file: a future name is immune to every time window, and
  // capping two future days to now would give them one name. An undated row joins the newest day.
  const byDay = new Map<string, { rows: string[]; newestMs: number }>();
  const undated: string[] = [];
  for (const line of rows) {
    const ts = tsOf(line);
    if (!Number.isFinite(ts)) {
      undated.push(line);
      continue;
    }
    const capped = Math.min(ts, nowMs);
    const day = fixedClock(capped).iso().slice(0, 10);
    const bucket = byDay.get(day) ?? { rows: [], newestMs: capped };
    bucket.rows.push(line);
    bucket.newestMs = Math.max(bucket.newestMs, capped);
    byDay.set(day, bucket);
  }
  const days = [...byDay.values()];
  if (days.length === 0) days.push({ rows: [], newestMs: nowMs });
  days[days.length - 1]!.rows.push(...undated);
  const archiveNames = days.map((d) => compactedArchiveName(fixedClock(d.newestMs).iso()));
  days.forEach((d, i) => io.write(archiveNames[i]!, d.rows.join("\n") + "\n"));
  const archiveName = archiveNames[archiveNames.length - 1]!;
  // THE SOURCES GO ONLY AFTER EVERY REPLACEMENT IS WRITTEN. A crash between the two costs a duplicate
  // archive, which the union dedupes anyway; the other order costs history.
  //
  // AND NEVER A FILE JUST WRITTEN. A day's stamp is its newest row's ts, which is very often the
  // stamp of a SOURCE — so an output lands on that source's own name and the cleanup would then
  // delete the replacement, taking every row with it. Found by the window case below, which read
  // back an empty union.
  const written = new Set(archiveNames);
  for (const path of sources) {
    if (written.has(basename(path))) continue;
    io.remove(path);
  }
  return { sourceCount: sources.length, rowsWritten: rows.length, duplicatesCollapsed: read - rows.length, archiveName, archiveNames };
}

/** W1-T4100 — THE SMOOTHING CHECK ITSELF. Real elapsed time only, read from the newest archive
 *  ALREADY on disk (never a marker this module would have to invent and clean up — the archive
 *  corpus itself is the durable record of "when did a rotation last actually land"), independent
 *  of whatever `now` a caller hands {@link rotateLedgerLocked} for naming/retention purposes. The
 *  backstop is checked FIRST and unconditionally, so a live file that has genuinely outgrown the
 *  window's patience is never held hostage by it. */
function ledgerRotationDue(sizeBytes: number, ceilingBytes: number, dir: string, fs: ArchiveNamingFs, windowMs: number): boolean {
  if (sizeBytes > ceilingBytes * LEDGER_ROTATION_BACKSTOP_MULTIPLIER) return true;
  // Zero disables pacing, including when an archive's mtime is ahead of the real clock.
  if (windowMs === 0) return true;
  // The newest archive's FILE mtime, not its name's stamp — the window paces real rotations, and a
  // name is exactly what reconcileArchiveStamps exists because it cannot always be trusted.
  const mtimes = archiveMtimes(dir, fs).map((a) => a.mtimeMs);
  if (mtimes.length === 0) return true; // no prior rotation to smooth against
  return systemClock.now() - mtimes.reduce((a, b) => Math.max(a, b)) >= windowMs;
}

export function rotateLedger(
  path: string,
  opts: {
    ceilingBytes?: number;
    fsDeps?: LedgerRotationFsDeps;
    now?: () => Date;
    archiveFsDeps?: LedgerArchiveFsDeps;
    /** Cadence window, default {@link LEDGER_ROTATION_SMOOTHING_WINDOW_MS}; 0 rotates on every crossing. */
    smoothingWindowMs?: number;
    retainedSteps?: ReadonlySet<string>;
    /** Test seam (W1-T5514): runs with the new live file staged, immediately before the rename. */
    beforeRename?: () => void;
  } = {},
): LedgerRotationResult {
  const ceilingBytes = opts.ceilingBytes ?? LEDGER_ROTATION_CEILING_BYTES;
  const windowMs = opts.smoothingWindowMs ?? LEDGER_ROTATION_SMOOTHING_WINDOW_MS;
  const fsDeps = opts.fsDeps ?? realRotationFs;
  const archiveFsDeps: ArchiveNamingFs = { ...realArchiveFs, ...opts.archiveFsDeps };
  if (!ledgerExceedsRotationCeiling(path, ceilingBytes, fsDeps)) return { rotated: false };
  // W1-T4100: a burst of appends each crossing the ceiling again must not each mint a fresh
  // archive — see LEDGER_ROTATION_SMOOTHING_WINDOW_MS's own doc for why and
  // LEDGER_ROTATION_BACKSTOP_MULTIPLIER for the bound that still applies regardless.
  if (!ledgerRotationDue(fsDeps.statSize(path), ceilingBytes, dirname(path), archiveFsDeps, windowMs)) return { rotated: false };

  const release = tryAcquireRotationLock(ledgerRotationLockPath(path));
  if (release === null) return { rotated: false }; // a live rotator holds it — its catch-up covers us
  try {
    // Re-check under the lock: if the holder we queued behind just rotated, the file is
    // already small and there is nothing left to do (see the doc above).
    if (!ledgerExceedsRotationCeiling(path, ceilingBytes, fsDeps)) return { rotated: false };
    if (!ledgerRotationDue(fsDeps.statSize(path), ceilingBytes, dirname(path), archiveFsDeps, windowMs)) return { rotated: false };
    const own = opts.retainedSteps ?? DECISION_RELEVANT_LEDGER_STEPS;
    const shared = readRetainedSteps(path);
    const record = shared.status === "ok" ? shared.record : undefined;
    const missing = (record?.steps ?? []).filter((step) => !own.has(step)).sort();
    if (missing.length > 0 && fsDeps.statSize(path) <= ceilingBytes * LEDGER_ROTATION_BACKSTOP_MULTIPLIER) {
      deferStaleRotation(path, record!, missing, opts.now);
      return { rotated: false, deferredMissingSteps: missing };
    }
    const result = rotateLedgerLocked(path, ceilingBytes, archiveFsDeps, opts.now, {
      retained: new Set([...own, ...(record?.steps ?? [])]),
      current: missing.length === 0,
      record,
      unreadable: shared.status === "unreadable",
    }, opts.beforeRename);
    if (result.rotated) {
      const steps = [...new Set([...own, ...(record?.steps ?? [])])].sort();
      const lastFullRotationMs = missing.length === 0 ? systemClock.now() : record?.lastFullRotationMs;
      writeFileAtomic(ledgerRetainedStepsPath(path), JSON.stringify({ steps, lastFullRotationMs, lastDeferral: record?.lastDeferral }));
    }
    return result;
  } finally {
    release();
  }
}

function deferStaleRotation(path: string, record: RetainedStepsRecord, missing: string[], now: (() => Date) | undefined): void {
  const key = missing.join(",");
  const nowMs = systemClock.now();
  const last = record.lastDeferral;
  if (last && last.key === key && nowMs - last.atMs < LEDGER_ROTATION_SMOOTHING_WINDOW_MS) return;
  appendFileSync(path, rotationRow("ledger.rotation_deferred", { missing_steps: missing }, now ? now().toISOString() : systemClock.iso()));
  writeFileAtomic(ledgerRetainedStepsPath(path), JSON.stringify({ ...record, lastDeferral: { key, atMs: nowMs } }));
}

interface RotationRetention {
  retained: ReadonlySet<string>;
  current: boolean;
  record: RetainedStepsRecord | undefined;
  unreadable: boolean;
}

/** The rotation proper — runs ONLY with the rotation lock held (see {@link rotateLedger}). */
function rotateLedgerLocked(
  path: string,
  fixedCeilingBytes: number,
  archiveFsDeps: ArchiveNamingFs,
  now: (() => Date) | undefined,
  retention: RotationRetention,
  beforeRename?: () => void,
): LedgerRotationResult {
  const { size: size0, content: snapshot, bytes: snapshotBytes, identity: snapshotIdentity } = readSnapshotWithIdentity(path);
  const lastFull = retention.current ? retention.record?.lastFullRotationMs : undefined;
  const recarry =
    lastFull === undefined
      ? { rows: [] as ParsedLedgerLine[], archives: [] as string[], torn: [] as Array<{ name: string; reason: string }> }
      : rowsToRecarry(dirname(path), lastFull, retention.retained, new Set(snapshot.split("\n")), archiveFsDeps);

  // W1-T4100: heal on-disk names that ran ahead of their write time; the newest safe stamp is the
  // floor this rotation's own name must clear.
  const dir = dirname(path);
  const previous = readCarriedPrefix(path);
  const prefixBytes = archivedPrefixBytes(previous, snapshotBytes);
  const mtimes = archiveMtimes(dir, archiveFsDeps).map((a) => a.mtimeMs);
  const elapsedMs = mtimes.length > 0 ? systemClock.now() - mtimes.reduce((a, b) => Math.max(a, b)) : 0;
  // A sub-minute burst extrapolates to an hourly rate that pins the ceiling at the backstop: skip it.
  const sample = prefixBytes !== undefined && elapsedMs >= LEDGER_ROTATION_MIN_RATE_SAMPLE_MS
    ? (size0 - prefixBytes) * 3_600_000 / elapsedMs : 0;
  const priorRate = previous?.rateBytesPerHour;
  const rateBytesPerHour = sample > 0 && Number.isFinite(sample)
    ? typeof priorRate === "number" && Number.isFinite(priorRate) && priorRate > 0
      ? priorRate / 2 + sample / 2 : sample
    : 0;
  const lastArchiveMs = reconcileArchiveStamps(dir, archiveFsDeps);
  let requestedMs = now ? now().getTime() : systemClock.now();
  if (lastArchiveMs !== undefined && requestedMs <= lastArchiveMs) requestedMs = lastArchiveMs + 1;
  // DELTA ARCHIVING: the carried prefix is the core the previous rotation wrote back, already
  // archived, so only what follows it goes to a new archive. Re-copying it made adjacent archives
  // share 99.3% of rows (fleet host, 2026-09-23). An empty delta writes no archive at all.
  const delta = snapshotBytes.subarray(prefixBytes ?? 0);
  const plainArchivePath = datedArchivePath(path, new Date(requestedMs));
  // The landed archive's own mtime is the clock `now` cannot corrupt (see healIfAheadOfOwnMtime).
  const archivePath =
    delta.length > 0
      ? healIfAheadOfOwnMtime(writeArchive(plainArchivePath, delta.toString("utf8"), archiveFsDeps), lastArchiveMs, archiveFsDeps)
      : undefined;

  // ONE clock read for the whole rotation — the health-window filter, the shed pointer's size
  // estimate, and the shed pointer's actual `ts` all agree on the same instant.
  const nowDate = now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  let archivedLineCount = 0;

  // Parsed exactly once, in file order — every retention pass below tracks lines by object
  // identity (never re-parses/re-matches raw text) so original order is always recoverable.
  const originalOrder: ParsedLedgerLine[] = [
    ...recarry.rows,
    ...snapshot
      .split("\n")
      .filter((raw) => raw.trim() !== "")
      .map(parseLedgerLine),
  ];

  // ── PASS 1: classify — decision, model-attribution, health and render-relevant candidates
  // against pure noise. Render membership (W1-T275) keeps daemon.headroom and the kick rows out of
  // the archive here, so PASS 2's window can bound them instead. ───────────────────────────────
  let candidates: ParsedLedgerLine[] = [];
  for (const parsed of originalOrder) {
    if (
      parsed.step &&
      (retention.retained.has(parsed.step) ||
        isModelAttributionStep(parsed.step) ||
        isHealthOrDeployStep(parsed.step) ||
        isRenderRelevantStep(parsed.step))
    ) {
      candidates.push(parsed);
    } else {
      archivedLineCount++;
    }
  }

  // ── PASS 2: recency-window bound — health and render steps are heartbeats, not one-shot
  // decisions, so only lines inside their own window are retained; that stops a restart storm's
  // boot spam bloating the core. A line with no parseable `ts` is kept, never guessed away. ────
  // W1-T3755: retain exactly the newest daemon.boot beyond the health window, not every boot.
  // 2026-09-18: a 00:49 daemon still ran at 06:00; its boot row survived 00:52/01:52 snapshots
  // but vanished by 04:28. readLatestBootSha returned undefined, the board falsely reported STALE
  // and prescribed rmd deploy, which skipped on the same missing row.
  // assessBootHealth needs 45s; readLatestBootSha needs the process lifetime. Do not widen
  // HEALTH_STEP_RETENTION_WINDOW_MS to couple those consumers. Older boots name replaced
  // processes and must age out, or a restart storm bloats the core again.
  // Falsifier: test/the-newest-boot-row-outlives-the-health-window.test.ts.
  const newestBootLine = candidates.reduce<ParsedLedgerLine | undefined>(
    (best, p) =>
      p.step === "daemon.boot" && p.tsMs !== undefined && (best?.tsMs === undefined || p.tsMs > best.tsMs) ? p : best,
    undefined,
  );

  candidates = candidates.filter((p) => {
    if (!p.step) return true;
    if (isModelAttributionStep(p.step)) return true;
    if (newestBootLine !== undefined && p === newestBootLine) return true;
    const isHealth = isHealthOrDeployStep(p.step);
    const isRender = isRenderRelevantStep(p.step);
    if (!isHealth && !isRender) return true;
    if (p.tsMs === undefined) return true;
    const windowMs = isHealth ? HEALTH_STEP_RETENTION_WINDOW_MS : RENDER_STEP_RETENTION_WINDOW_MS;
    const withinWindow = nowMs - p.tsMs <= windowMs;
    if (!withinWindow) archivedLineCount++;
    return withinWindow;
  });

  const carried = dropSupersededReviews(pruneCarriedRows(candidates));
  const reviewMarkers = planOnlyReviewMarkers(candidates, carried);
  archivedLineCount += candidates.length - carried.length;
  candidates = carried;

  // ── PASS 3: sweep.disposed dedup — one line per `pr@head` (its newest acted:true, else its newest);
  // every other is a same-outcome re-poll (W1-T244). Then W1-T5517's age bound, boundSweepRows. ─
  const sweepGroups = new Map<string, ParsedLedgerLine[]>();
  const nonSweepCandidates: ParsedLedgerLine[] = [];
  for (const p of candidates) {
    if (p.step === "sweep.disposed" && p.json) {
      const prNumber = typeof p.json.pr_number === "number" ? p.json.pr_number : "?";
      const headSha = typeof p.json.head_sha === "string" ? p.json.head_sha : "";
      const key = `${prNumber}@${headSha}`;
      const group = sweepGroups.get(key) ?? [];
      group.push(p);
      sweepGroups.set(key, group);
    } else {
      nonSweepCandidates.push(p);
    }
  }
  const dedupedSweep: ParsedLedgerLine[] = [];
  for (const group of sweepGroups.values()) {
    const actedTrue = group.filter((p) => p.json?.acted === true);
    // group is in file order (push preserves it); the LAST entry of whichever pool applies
    // is the most recent — the acted:true evidence line if one exists, else the latest poll.
    dedupedSweep.push(actedTrue.length > 0 ? actedTrue[actedTrue.length - 1] : group[group.length - 1]);
    archivedLineCount += group.length - 1;
  }
  candidates = [...nonSweepCandidates, ...dedupedSweep];
  const passed = new Set(candidates);
  const bounded = new Set(boundSweepRows(originalOrder.filter((p) => passed.has(p)), nowMs));
  archivedLineCount += candidates.length - bounded.size;
  candidates = candidates.filter((p) => bounded.has(p));

  // ── PASS 4: per-step count cap — the newest MAX_RETAINED_LINES_PER_STEP lines of every OTHER
  // decision/model-attribution step (review.posted: REVIEW_POSTED_RETAINED_ROWS), else unbounded.
  // sweep.disposed and the health, deploy and render steps carry their own bound. ──────────────
  const byStep = new Map<string, ParsedLedgerLine[]>();
  for (const p of candidates) {
    const key = p.step ?? "";
    const group = byStep.get(key) ?? [];
    group.push(p);
    byStep.set(key, group);
  }
  const capped: ParsedLedgerLine[] = [];
  for (const [step, group] of byStep.entries()) {
    if (
      step === "sweep.disposed" ||
      isHealthOrDeployStep(step) ||
      (!isModelAttributionStep(step) && isRenderRelevantStep(step)) ||
      group.length <= (step === "review.posted" ? REVIEW_POSTED_RETAINED_ROWS : MAX_RETAINED_LINES_PER_STEP)
    ) {
      capped.push(...group);
      continue;
    }
    // group is in file order (chronological); drop the oldest excess, keep the newest cap.
    const excess = group.length - (step === "review.posted" ? REVIEW_POSTED_RETAINED_ROWS : MAX_RETAINED_LINES_PER_STEP);
    archivedLineCount += excess;
    capped.push(...group.slice(excess));
  }

  // Restore original file order — every pass above regrouped by key/step, losing it. Filtering
  // `originalOrder` (parsed once, never cloned) by identity recovers it directly.
  const survivors = new Set(capped);
  let keptCandidates = originalOrder.filter((p) => survivors.has(p));

  // Catch-up to the last newline; the post-rename drain copies everything from `drainFrom` on.
  const sizeNow = statSync(path).size;
  const rawTail = sizeNow > size0 ? readSyncRange(path, size0, sizeNow) : Buffer.alloc(0);
  const tailBytes = rawTail.lastIndexOf(0x0a) + 1;
  const tail = rawTail.subarray(0, tailBytes).toString("utf8");
  const drainFrom = size0 + tailBytes;

  let keptLines = keptCandidates.map((p) => p.raw);
  let keptBytes = keptLines.length > 0 ? Buffer.byteLength(keptLines.join("\n") + "\n", "utf8") : 0;
  // W1-T4393: preserve passes 1-4's core and add an hour of smoothed appends, within the backstop.
  const ceilingBytes = rateBytesPerHour > 0
    ? Math.min(fixedCeilingBytes * LEDGER_ROTATION_BACKSTOP_MULTIPLIER, Math.max(fixedCeilingBytes, Math.ceil(keptBytes + rateBytesPerHour)))
    : fixedCeilingBytes;

  // ── THE CONVERGENCE INVARIANT (W1-T244). Even after every bound above the retained core can
  // still exceed the ceiling. Post-rotation the live ledger MUST be strictly below it, or rotation
  // cannot terminate. Shed the OLDEST retained lines by `ts`, never the newest nor a correction (W1-T5551),
  // and leave one pointer line naming the archive. Falsifier: test/ledger-rotation-convergence.test.ts. Why: the
  // core once exceeded the ceiling live (docs/forensics/ledger.md#rotateledger). ───────────────
  let shedCount = 0;
  if (keptBytes + tailBytes >= ceilingBytes) {
    // Reserve room for the pointer line itself — sized against a worst-case shed_count
    // (6 digits) so the one estimate covers any real run without re-measuring per victim.
    const pointerBytes = Buffer.byteLength(
      JSON.stringify({
        ts: nowIso,
        run_id: "ledger-rotation",
        task_id: "_ledger",
        step: "ledger.rotation_shed",
        shed_count: 999999,
        archive_path: archivePath,
      }) + "\n",
      "utf8",
    );
    // Shed to a TARGET below the ceiling rather than to its edge, so the converged ledger has real
    // headroom — otherwise the very next append could put it straight back over. The invariant is
    // strictly enforced either way; this makes "converged" durable rather than a hair's-width pass.
    const targetBytes = Math.floor(ceilingBytes * 0.9);
    const sheddable = keptCandidates.filter((p) => p.step !== "correction.provenance");
    const byAge = sheddable.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    const stillKept = new Set(keptCandidates);
    for (const victim of byAge) {
      if (keptBytes + tailBytes + pointerBytes < targetBytes) break;
      stillKept.delete(victim);
      keptBytes -= Buffer.byteLength(victim.raw + "\n", "utf8");
      shedCount++;
    }
    keptCandidates = keptCandidates.filter((p) => stillKept.has(p));
    keptLines = keptCandidates.map((p) => p.raw);
  }

  // The pointer sits AFTER the carried prefix: it is a new row, archived by the next rotation.
  const coreContent = keptLines.length > 0 ? keptLines.join("\n") + "\n" : "";
  let pointerContent = "";
  if (shedCount > 0) {
    archivedLineCount += shedCount;
    pointerContent =
      JSON.stringify({
        ts: nowIso,
        run_id: "ledger-rotation",
        task_id: "_ledger",
        step: "ledger.rotation_shed",
        shed_count: shedCount,
        archive_path: archivePath,
      }) + "\n";
  }

  const coreBytes = Buffer.from(coreContent, "utf8");
  const stepBytes = new Map<string, number>();
  for (const p of keptCandidates) stepBytes.set(p.step ?? "", (stepBytes.get(p.step ?? "") ?? 0) + Buffer.byteLength(p.raw, "utf8") + 1);
  const coreShare = Number((coreBytes.length / fixedCeilingBytes).toFixed(4));
  const coreRecord = { core_bytes: coreBytes.length, ceiling_bytes: fixedCeilingBytes, core_share: coreShare, target_share: LEDGER_CORE_TARGET_SHARE,
    heaviest_steps: [...stepBytes].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  const recarriedCount = recarry.rows.filter((p) => keptCandidates.includes(p)).length;
  const noteContent =
    (recarriedCount > 0 || recarry.torn.length > 0
      ? rotationRow("ledger.recarried", { count: recarriedCount, archives: recarry.archives, unreadable_archives: recarry.torn }, nowIso)
      : "") +
    reviewMarkers.map((marker) => rotationRow(PLAN_ONLY_REVIEW_MARKER_STEP, marker, nowIso)).join("") +
    (retention.unreadable ? rotationRow("ledger.retained_steps_unreadable", { path: ledgerRetainedStepsPath(path) }, nowIso) : "") +
    (rateBytesPerHour > 0
      ? rotationRow("ledger.rotation_headroom", { rate_bytes_per_hour: rateBytesPerHour, ceiling_bytes: ceilingBytes }, nowIso)
      : "") +
    (coreShare > LEDGER_CORE_TARGET_SHARE ? rotationRow("ledger.rotation_core_over_target", coreRecord, nowIso) : "");
  const newLiveContent = coreContent + noteContent + pointerContent + tail;
  let replaced: number | undefined;
  try {
    const swapped = writeFileAtomic(path, newLiveContent, () => {
      beforeRename?.();
      replaced = openSync(path, "a+");
      const st = fstatSync(replaced);
      return st.dev === snapshotIdentity.dev && st.ino === snapshotIdentity.ino;
    });
    if (!swapped) {
      console.error(
        `ledger: rotation of ${path} withdrawn — the live file changed identity since the snapshot ` +
          `(another rotator replaced it); its lines are untouched and the snapshot archive ${archivePath} is kept`,
      );
      return { rotated: false };
    }
    drainReplacedInode(replaced!, drainFrom, path, nowIso);
  } finally {
    if (replaced !== undefined) closeSync(replaced);
  }
  writeFileAtomic(ledgerCarriedPrefixPath(path), JSON.stringify({
    bytes: coreBytes.length, sha256: sha256Hex(coreBytes), rateBytesPerHour, effectiveCeilingBytes: ceilingBytes, core: coreRecord,
  }));

  return {
    rotated: true,
    archivePath,
    archivedLineCount,
    retainedLineCount: keptLines.length + noteContent.split("\n").filter(Boolean).length + (pointerContent ? 1 : 0),
    recarriedLineCount: recarriedCount,
  };
}

// ── W1-T234: STATE BACKUP/RESTORE ORGAN (MASTER-PLAN §10 WS-7) ──────────────────────────────
// state/ holds the ledger, the run locks, the worker-keychain tokens and the proposals register,
// and none of it was backed up. It lives here because it reuses this file's atomic-write and
// dated-archive idiom: a half-written backup must never be mistaken for a whole one. SCOPE (i):
// back up what is IRREPLACEABLE — only `status.json` is excluded, proven rederivable. VERIFY,
// DON'T TRUST (ii): `snapshotState` re-lists the STAGED copy from disk before publishing. FAILURE
// ESCALATES LOUDLY (iv): every failure path throws {@link StateBackupError}, never a logged no-op.

/** Loud, typed failure for every state-backup or restore operation — always THROWN, never
 *  swallowed (design note iv). `cause` carries the underlying fs error, so a log keeps its stack. */
export class StateBackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StateBackupError";
  }
}

/** Relative path (from `state/`) of the ledger this module treats as authoritative-by-name
 *  when verifying a snapshot — mirrors `ledgerPathFor`'s own basename through the shared
 *  filename constant, without depending on run-task.ts (a CLI entrypoint). */
export const STATE_BACKUP_LEDGER_RELPATH = LEDGER_FILENAME;

/** Relative path (from `state/`) of the proposals register this module treats as
 *  authoritative-by-name — mirrors the inbox registry's own basename (run-task.ts:
 *  `join(config.root, "state", "inbox-proposals.json")`), the file this task's rationale
 *  names as having gained nine entries (P37-P45) that exist on exactly one disk. */
export const STATE_BACKUP_PROPOSALS_REGISTER_RELPATH = "inbox-proposals.json";

/** Relative paths under `state/` excluded from every snapshot because they are cheaply rederivable,
 *  not because they merely look unimportant. `status.json` is the only entry: W1-T234's rationale
 *  states outright that it is rederivable and does not matter. */
export const STATE_BACKUP_EXCLUDED_RELPATHS: ReadonlySet<string> = new Set(["status.json"]);

/** One completed snapshot. */
export interface StateBackupSnapshot {
  /** Absolute path to the finished, verified snapshot directory. */
  archiveDir: string;
  /** Sorted paths of copied files, archive metadata and preserved links, relative to `state/`. */
  entries: string[];
  /** W1-T5545: rotations hard-linked to the last snapshot, files removed mid-copy, torn bytes cut. */
  linked: string[];
  vanished: string[];
  ledgerTrimmedBytes: number;
}

/** Test-only strike points (`beforeCopy`, `afterLedgerRead`); `maxRaceAttempts` bounds every race. */
export interface SnapshotStateOptions {
  now?: () => Date;
  copy?: (srcRoot: string, dstRoot: string, relPaths: readonly string[]) => void;
  beforeCopy?: (rel: string) => void;
  afterLedgerRead?: (attempt: number) => void;
  maxRaceAttempts?: number;
}

// KIND: BACKSTOP — a healthy ledger settles on the first or second read (a few MB, read in ms).
export const STATE_BACKUP_MAX_RACE_ATTEMPTS = 5;

/** A rotation archive (`ledger.<ISO stamp>.ndjson[.gz]`): renamed in once, never modified. */
export function isLedgerArchiveRelPath(rel: string): boolean {
  return /^ledger\.\d{4}-\d{2}-\d{2}T[^/]*\.ndjson(\.gz)?$/.test(rel);
}

/** Files and preserved engine links under `root`, sorted, minus `excluded`, for staging and restore. Types
 *  come from readdir, so a temp file renamed away mid-walk cannot fail it (W1-T5545). */
function listStateFiles(root: string, excluded: ReadonlySet<string> = new Set(), vanished?: string[], evidenceOnly = false): string[] {
  const out: string[] = [];
  const ancestors = new Set<string>();
  const walk = (relDir: string): void => {
    const absDir = relDir ? join(root, relDir) : root;
    let identity: string | undefined;
    try {
      identity = realpathSync(absDir);
      if (ancestors.has(identity)) throw new StateBackupError(`state backup: directory link cycle at ${absDir}`);
      ancestors.add(identity);
      for (const d of readdirSync(absDir, { withFileTypes: true })) {
        const rel = relDir ? join(relDir, d.name) : d.name;
        if (excluded.has(rel)) continue;
        if (evidenceOnly && engineTreePath(relDir) === relDir && !isEngineEvidenceName(d.name)) continue;
        if (d.isSymbolicLink() && isEngineDependencyLinkPath(rel)) {
          out.push(rel);
          continue;
        }
        let kind;
        try {
          kind = d.isSymbolicLink() ? statSync(join(absDir, d.name)) : d;
        } catch (error) {
          if (vanished && engineTreePath(rel) && stateEntryVanished(error, join(root, rel))) {
            vanished.push(engineTreePath(rel) ?? rel);
            continue;
          }
          if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new StateBackupError(`state backup: directory link cycle at ${rel}`, { cause: error });
          }
          throw error;
        }
        if (kind.isDirectory()) walk(rel);
        else if (kind.isFile()) out.push(rel);
      }
    } catch (error) {
      if (!vanished || !engineTreePath(relDir) || !stateEntryVanished(error, absDir)) throw error;
      vanished.push(engineTreePath(relDir) ?? relDir);
    } finally {
      if (identity !== undefined) ancestors.delete(identity);
    }
  };
  walk("");
  return out.sort();
}

/** Copies `relPaths` from `srcRoot` to `dstRoot`, creating destination directories as needed and
 *  preserving each file's permission bits, best-effort. The service-token files under `state/` are
 *  0600 by design, and a backup that widened them on restore would be a regression. */
function copyStateFiles(srcRoot: string, dstRoot: string, relPaths: readonly string[]): void {
  for (const rel of relPaths) {
    copyOneStateFile(join(srcRoot, rel), join(dstRoot, rel), statSync(join(srcRoot, rel)).mode);
  }
}

function copyOneStateFile(src: string, dst: string, mode: number): void {
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { force: true, preserveTimestamps: true });
  try {
    chmodSync(dst, mode);
  } catch {
    // best-effort: the bytes are copied; permission preservation is a hardening, not the contract.
  }
}

/** Rotations first, the live ledger LAST, so rows rotated out before the read are already copied. */
function liveCopyOrder(entries: readonly string[]): string[] {
  const rank = (rel: string): number => (isLedgerArchiveRelPath(rel) ? 0 : rel === STATE_BACKUP_LEDGER_RELPATH ? 2 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The live ledger cut at its last `\n`, re-read while size/mtime/inode move; one fd checks AND reads. */
function readLedgerThroughFd(src: string, attempt: number, afterRead?: (attempt: number) => void) {
  const fd = openSync(src, "r");
  try {
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    afterRead?.(attempt);
    return { before, bytes, after: fstatSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function captureLiveLedger(src: string, dst: string, attempts: number, afterRead?: (attempt: number) => void): number {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { before, bytes, after } = readLedgerThroughFd(src, attempt, afterRead);
    const renamed = statSync(src).ino !== before.ino;
    const raced = renamed || bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs;
    if (raced) continue;
    const whole = bytes.lastIndexOf(0x0a) + 1;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, bytes.subarray(0, whole), { mode: before.mode & 0o777 });
    return bytes.length - whole;
  }
  throw new StateBackupError(
    `state backup: the live ledger ${src} changed during each of ${attempts} copy attempts — refusing to publish a torn copy`,
  );
}

/** Default copier: an unchanged rotation is hard-linked; a vanished file is RECORDED, never hidden. */
function liveStateCopier(previous: string | undefined, opts: SnapshotStateOptions, report: Omit<StateBackupSnapshot, "archiveDir" | "entries">) {
  const attempts = opts.maxRaceAttempts ?? STATE_BACKUP_MAX_RACE_ATTEMPTS;
  return (srcRoot: string, dstRoot: string, relPaths: readonly string[]): void => {
    for (const rel of relPaths) {
      opts.beforeCopy?.(rel);
      const src = join(srcRoot, rel);
      const dst = join(dstRoot, rel);
      if (rel === STATE_BACKUP_LEDGER_RELPATH) {
        report.ledgerTrimmedBytes = captureLiveLedger(src, dst, attempts, opts.afterLedgerRead);
        continue;
      }
      try {
        const st = statSync(src);
        const prior = previous !== undefined && isLedgerArchiveRelPath(rel) ? join(previous, rel) : undefined;
        const priorSt = prior !== undefined && existsSync(prior) ? statSync(prior) : undefined;
        if (prior !== undefined && priorSt?.size === st.size && Math.abs(priorSt.mtimeMs - st.mtimeMs) < 1) {
          mkdirSync(dirname(dst), { recursive: true });
          rmSync(dst, { force: true });
          linkSync(prior, dst);
          report.linked.push(rel);
          continue;
        }
        copyOneStateFile(src, dst, st.mode);
      } catch (err) {
        if (!stateEntryVanished(err, src)) throw err;
        report.vanished.push(rel);
      }
    }
  };
}

function newestStateBackup(backupsRoot: string): string | undefined {
  const name = readdirSync(backupsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("state-backup."))
    .map((d) => d.name)
    .sort()
    .pop();
  return name === undefined ? undefined : join(backupsRoot, name);
}

/** Read from DISK whichever copier ran: after the trim, an unparseable line is corruption. */
function assertStagedLedgerParses(stagedLedger: string, stateDir: string): void {
  const lines = readFileSync(stagedLedger, "utf8").split("\n");
  const tail = lines.pop();
  const bad = lines.findIndex((line) => parseLedgerLine(line).json === undefined);
  if (bad >= 0 || tail !== "") {
    const where = bad >= 0 ? `line ${bad + 1} does not parse as JSON` : "its last line has no newline";
    throw new StateBackupError(`state backup: the ledger copied from ${stateDir}: ${where} — refusing to publish it`);
  }
}

function datedStateBackupDir(backupsRoot: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(backupsRoot, `state-backup.${stamp}`);
}

/**
 * Snapshots `stateDir` into a dated directory under `backupsRoot` (never inside `stateDir`): staged,
 * verified from disk, then renamed. Throws {@link StateBackupError} on an empty copy, a lost ledger or
 * proposals register, or an unparseable ledger line; `opts.copy` only makes the lost-file arm falsifiable.
 * LIVE-SAFE (W1-T5545): runs with the fleet up; a mid-copy rotation is chased by re-listing, and only a
 * race outlasting the bound refuses.
 */
export function snapshotState(stateDir: string, backupsRoot: string, opts: SnapshotStateOptions = {}): StateBackupSnapshot {
  const now = opts.now ?? systemClock.date;
  const attempts = opts.maxRaceAttempts ?? STATE_BACKUP_MAX_RACE_ATTEMPTS;
  const report: Omit<StateBackupSnapshot, "archiveDir" | "entries"> = { linked: [], vanished: [], ledgerTrimmedBytes: 0 };
  let tmpDir: string | undefined;
  try {
    if (!existsSync(stateDir)) {
      throw new StateBackupError(`state backup: source state dir does not exist: ${stateDir}`);
    }
    mkdirSync(backupsRoot, { recursive: true });
    const copy = opts.copy ?? liveStateCopier(newestStateBackup(backupsRoot), opts, report);
    tmpDir = mkdtempSync(join(backupsRoot, ".state-backup-tmp-"));
    const sourceEntries = listStateFiles(stateDir, STATE_BACKUP_EXCLUDED_RELPATHS, report.vanished, true);
    let engineLinks = preserveEngineDependencyLinks(stateDir, tmpDir, sourceEntries, report.vanished);
    const linkPaths = new Set(engineLinks?.links.map((link) => link.path));
    const omittedEngines = new Set(report.vanished.map(engineTreePath).filter((rel) => rel !== undefined));
    copy(stateDir, tmpDir, liveCopyOrder(sourceEntries.filter((rel) => !linkPaths.has(rel) && !omittedEngines.has(engineTreePath(rel) ?? rel))));
    for (let pass = 1; ; pass++) {
      const have = new Set([...listStateFiles(tmpDir), ...report.vanished]);
      // Only root-level ledger archives are eligible for catch-up. The complete
      // initial inventory is already copied; walking live engines again races pruning.
      // Preserve the old file-link/error semantics for archive-shaped entries.
      const late = readdirSync(stateDir, { withFileTypes: true })
        .filter((entry) => isLedgerArchiveRelPath(entry.name) && (entry.isFile() ||
          (entry.isSymbolicLink() && statSync(join(stateDir, entry.name)).isFile())))
        .map((entry) => entry.name).filter((rel) => !have.has(rel));
      if (late.length === 0) break;
      if (pass >= attempts) {
        throw new StateBackupError(
          `state backup: rotations kept landing in ${stateDir} across ${attempts} copy passes (${late.join(", ")}) — refusing to publish a snapshot that may miss their rows`,
        );
      }
      copy(stateDir, tmpDir, liveCopyOrder([...late, STATE_BACKUP_LEDGER_RELPATH]));
    }

    engineLinks = omitVanishedEngines(tmpDir, report.vanished, engineLinks);
    const staged = listStateFiles(tmpDir);
    validateEngineDependencyLinks(tmpDir, staged, engineLinks);
    if (staged.length === 0) {
      throw new StateBackupError(`state backup: snapshot of ${stateDir} would be an empty archive — refusing to publish it`);
    }
    const missing = [STATE_BACKUP_LEDGER_RELPATH, STATE_BACKUP_PROPOSALS_REGISTER_RELPATH].filter(
      (rel) => (sourceEntries.includes(rel) || report.vanished.includes(rel)) && !staged.includes(rel),
    );
    if (missing.length > 0) {
      throw new StateBackupError(
        `state backup: snapshot of ${stateDir} is missing ${missing.join(", ")}, present in the source — refusing to publish it`,
      );
    }
    if (staged.includes(STATE_BACKUP_LEDGER_RELPATH)) assertStagedLedgerParses(join(tmpDir, STATE_BACKUP_LEDGER_RELPATH), stateDir);

    const archiveDir = datedStateBackupDir(backupsRoot, now());
    renameSync(tmpDir, archiveDir);
    tmpDir = undefined;
    return { archiveDir, entries: staged, ...report };
  } catch (err) {
    if (err instanceof StateBackupError) throw err;
    throw new StateBackupError(`state backup: snapshot of ${stateDir} failed: ${(err as Error).message}`, { cause: err });
  } finally {
    if (tmpDir !== undefined && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/** Restores every file under a snapshot directory into `targetStateDir` byte-for-byte, permission
 *  bits preserved best-effort. THE RESTORE IS A VERB, NOT A RUNBOOK PARAGRAPH (design note iii):
 *  this is the one command an operator runs mid-incident. Refuses — throwing
 *  {@link StateBackupError} — an absent or empty archive rather than no-op'ing over a live dir.
 *  Engine links are returned as requiring dependency reconstruction; no install is attempted. */
export function restoreState(archiveDir: string, targetStateDir: string): { reconstructionRequired: string[] } {
  try {
    if (!existsSync(archiveDir)) {
      throw new StateBackupError(`state backup: restore source does not exist: ${archiveDir}`);
    }
    const entries = listStateFiles(archiveDir);
    const engineLinks = validateEngineDependencyLinks(archiveDir, entries);
    if (entries.length === 0) {
      throw new StateBackupError(`state backup: refusing to restore from an empty archive: ${archiveDir}`);
    }
    assertStateRestorePaths(targetStateDir, entries, engineLinks);
    const linkPaths = new Set(engineLinks?.links.map((link) => link.path));
    mkdirSync(targetStateDir, { recursive: true });
    copyStateFiles(archiveDir, targetStateDir, entries.filter((rel) => !linkPaths.has(rel) && rel !== ENGINE_LINK_MANIFEST));
    restoreEngineDependencyLinks(targetStateDir, engineLinks);
    return { reconstructionRequired: [...linkPaths] };
  } catch (err) {
    if (err instanceof StateBackupError) throw err;
    throw new StateBackupError(
      `state backup: restore into ${targetStateDir} from ${archiveDir} failed: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * W1-T2383 — IS THIS `run.start` A QUEUE DISPATCH, OR A LANE RUN? Until this task every `run.start`
 * row was an implement dispatch, so the two were the same fact and three readers were written on
 * that identity. Adding rows for the triage and retro lanes separates them, and this states the
 * separation ONCE rather than re-deriving it at each reader. TRUE for an implement dispatch, and
 * for a row declaring no `type` at all, because the pre-schema rows were all implement dispatches;
 * FALSE only for a row that positively declares another lane. Why: the three readers that need it,
 * and what each would get wrong (W1-T2383; docs/forensics/ledger.md#isqueuedispatchrunstart).
 */
export function isQueueDispatchRunStart(line: Record<string, unknown>): boolean {
  if (line.step !== "run.start") return false;
  const type = line.type;
  return type === undefined || type === "implement";
}
