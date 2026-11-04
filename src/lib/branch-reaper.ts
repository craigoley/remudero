/** Branch guards (W1-T447), citation/reverse-drift planning (W1-T2226), and injected effects.
 * The CLI stays in run-task.ts: importing its repoRoot/resolveOwnerRepo/argument plumbing here
 * would create a cycle. Cross-boundary helpers are exported; escapeEre and the run token stay private.
 * Guard the landing family through its owner, isLandingRef, rather than duplicating its pattern. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLandingRef } from "./feedback-landing.js";
import type { Clock } from "./clock.js";
import { runStepsSync, step, type Steps } from "./git-push.js";

export type BranchReapExec = (cmd: string, args: string[]) => string | Promise<string>;

/** Declared guards (W1-T447) complement the independent name scan: neither suffices alone.
 * Declarations can rot; a scan misses variable-derived names such as LANDING_BRANCH when absent.
 * Report scan-guarded but undeclared branches as drift; never silently delete them. */
export const DECLARED_BRANCH_GUARDS: readonly string[] = [
  "main",
  // ── THE HEARTBEAT TRANSPORTS — ONE BRANCH PER HOST, each a parentless root commit force-pushed
  // every ~5 min. All three are named by `.github/workflows/fleet-heartbeat-watch.yml` and/or
  // `scripts/fleet-heartbeat.sh`, so `namedInSource` guards them and each OWES a declaration here.
  "heartbeat-mini", // the mini's, since its cron moved to RMD_HEARTBEAT_BRANCH=heartbeat-mini
  "heartbeat-azure", // Azure's — DECLARED LATE: #1798 added it to the watcher without declaring it
  // here, so `rmd reap-branches` exited 1 naming it. Measured on the live repo before this change:
  // "1 branch(es) are named in source but MISSING from DECLARED_BRANCH_GUARDS: heartbeat-azure".
  //
  // `heartbeat` STAYS, THOUGH NOTHING WRITES OR WATCHES IT ANY MORE. `namedInSource` is
  // `git grep -l -F` — a SUBSTRING match — and the string "heartbeat" occurs in 18 files under
  // src/, scripts/, deploy/ and .github/ (re-derived at this commit; an earlier note said 5, which
  // was an artifact of a `head -5` on the measuring command, not a count). So the grep guards it
  // permanently no matter what the workflow says, and REMOVING this line would manufacture exactly
  // the drift alarm the two entries above exist to clear.
  "heartbeat",
  "feedback-landing", // LANDING_BRANCH — recreated by landFeedback, often absent between landings
  "decisions-landing", // DECISIONS_LANDING_BRANCH
  // Cited by doc comments in drain-lock.ts, inflight-lock.ts, worker.ts and run-task.ts as the
  // forensic record behind those guards — deleting them dangles four citations. DECLARED after
  // the drift alarm below reported them on the live repo, which is the alarm working as intended.
  "diag/drain-concurrency",
  "diag/drain-sequential-await",
  "diag/resume-spawn-enoent",
];

export function isDeclaredBranchGuard(name: string, declaredGuards: readonly string[] = DECLARED_BRANCH_GUARDS): boolean {
  return name === "main" || declaredGuards.includes(name) || isLandingRef(name);
}

/** Every remote branch name, newest-agnostic — `git ls-remote --heads`, parsed. */
export function remoteBranchNames(exec: (cmd: string, args: string[]) => string): string[] {
  return runStepsSync(remoteBranchNamesSteps(exec));
}

/** The reaper's one `git ls-remote` site: `ls-remote <before…> origin <after…>`, read in the managed checkout. */
function* lsRemoteOriginSteps(exec: BranchReapExec, before: readonly string[], after: readonly string[] = []): Steps<string> {
  return yield* step(() => exec("git", ["ls-remote", ...before, "origin", ...after]));
}

/** The reaper's one `git push` site: `push <before…> origin <after…>`, run in the managed checkout. The prune's
 *  chunked `--delete` and the stale-hold archive's atomic leased push both go through it. */
function* pushOriginSteps(exec: BranchReapExec, before: readonly string[], after: readonly string[]): Steps<string> {
  return yield* step(() => exec("git", ["push", ...before, "origin", ...after]));
}

export function* remoteBranchNamesSteps(exec: BranchReapExec): Steps<string[]> {
  return [...(yield* remoteBranchHeadsSteps(exec)).keys()];
}

/** Every remote branch's LIVE tip sha, from the same one `git ls-remote --heads origin` read, in listing order. */
export function* remoteBranchHeadsSteps(exec: BranchReapExec): Steps<Map<string, string>> {
  const heads = new Map<string, string>();
  for (const line of (yield* lsRemoteOriginSteps(exec, ["--heads"])).split("\n")) {
    const name = line.split("refs/heads/")[1]?.trim();
    if (name) heads.set(name, line.split(/\s/)[0] ?? "");
  }
  return heads;
}

/** Ephemeral run convention: run-<taskId>-<epochMs> (W1-T2226 rationale (2)/(3)).
 * Citations outlive deleted branches; never use a live run branch as a documentation example. */
const RUN_TASK_BRANCH_TOKEN_SRC = "run-[A-Za-z0-9]+-T[0-9]+-[0-9]{10,}";

/** Escape a literal string for use inside a POSIX ERE (`git grep -E`) alternation. */
function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One enumeration (W1-T2226 design (i)): run tokens plus literal declared guards across
 * the same four roots as namedInSource. Both reverse comparisons consume this list. */
export function branchCitationPattern(declaredGuards: readonly string[]): string {
  const alternation = [RUN_TASK_BRANCH_TOKEN_SRC, ...declaredGuards.map(escapeEre)].join("|");
  return `\\b(${alternation})\\b`;
}

/** One `git grep -n -o -E` hit: the file, its 1-indexed line, and the matched token. */
export interface BranchCitationHit {
  file: string;
  line: number;
  name: string;
}

/** Parse `git grep -n -o -E` output (`path:line:match`, one per line) into hits. */
export function parseBranchCitationHits(raw: string): BranchCitationHit[] {
  const hits: BranchCitationHit[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({ file: m[1], line: Number(m[2]), name: m[3] });
  }
  return hits;
}

export const DECLARED_BRANCH_GUARDS_FILE = "src/lib/branch-reaper.ts";

/** Find the declaration's inclusive, 1-indexed span in its CURRENT text (W1-T2226 (5)).
 * Exclude self-citations or every declared name hides its own orphan status. If markers moved,
 * return undefined so the caller excludes nothing rather than guessing. */
export function declaredGuardsBlockSpan(fileText: string): { start: number; end: number } | undefined {
  const lines = fileText.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("export const DECLARED_BRANCH_GUARDS"));
  if (startIdx === -1) return undefined;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() === "];") return { start: startIdx + 1, end: i + 1 };
  }
  return undefined;
}

/** The two reverse comparisons a forward-only `namedInSource` scan cannot make (W1-T2226). */
export interface ReverseBranchDrift {
  /** Cited in source, absent from the remote listing AND undeclared — dangling. */
  danglingCitations: string[];
  /** Declared, but never cited anywhere outside its own declaration — orphaned. */
  orphanDeclarations: string[];
}

/** Pure reverse drift (W1-T2226): dangling = citations − remote − declared; orphan =
 * declared − citations after excluding the declaration block (rationale (5)). Declared names
 * suppress dangling hits too: feedback-landing may legitimately be absent between landings (9). */
export function planReverseBranchDrift(
  citations: readonly BranchCitationHit[],
  remoteNames: readonly string[],
  declaredGuards: readonly string[],
  declarationBlock: { file: string; start: number; end: number } | undefined,
): ReverseBranchDrift {
  const remote = new Set(remoteNames);
  const declared = new Set(declaredGuards);
  const cited = new Set<string>();
  for (const hit of citations) {
    if (
      declarationBlock &&
      hit.file === declarationBlock.file &&
      hit.line >= declarationBlock.start &&
      hit.line <= declarationBlock.end
    ) {
      continue; // the declaration's own line(s) never count as a citation of the name it declares
    }
    cited.add(hit.name);
  }
  const danglingCitations = [...cited].filter((n) => !remote.has(n) && !declared.has(n)).sort();
  const orphanDeclarations = declaredGuards.filter((n) => !cited.has(n));
  return { danglingCitations, orphanDeclarations };
}

/**
 * `rmd reap-branches` — the report/prune command. Reports which remote branches are deletable,
 * guarded and why, and which are held; ledgers the answer; and deletes only with `--prune`.
 *
 * The CLI defaults to dry run; the automatic full-sweep adapter invokes this same classifier and
 * active-head screen with `--prune`. Its printed sha/name manifest makes each delete reversible,
 * and unknown SHAs are never deleted. Guard drift still exits non-zero without vetoing the prune.
 */

// ── the orphaned-head COUNT (W1-T2690) ────────────────────────────────────────────────────────

/** W1-T448: full classification is expensive; ls-remote is the cheap automatic trigger
 * on first use, branch-set change, or six hours. This count stays separate from classification.
 * Ancestry alone cannot prove safety under squash merges: merged and in-flight heads both fail
 * is-ancestor. Count only run heads with no open PR AND absent from base history (W1-T2690). */
export interface OrphanedHeadCounts {
  readonly kind: "counted";
  /** Every name one `git ls-remote --heads origin` returned — guards, non-run branches, all of it. */
  readonly totalHeads: number;
  /** Only run-<taskId>-<epochMs> heads qualify; the shape itself excludes guards. */
  readonly runShapedHeads: number;
  /** Run heads with no open PR AND absent from base history; a signal for bounded upkeep. */
  readonly orphanedHeads: number;
}

/** Unreadable is not zero: report the reason and stop, as classifyReadFailure does
 * in lib/doctor.ts. Missing information never proves an absence of orphans. */
export interface OrphanedHeadCountUnreadable {
  readonly kind: "cannot-determine";
  readonly reason: string;
}

export type OrphanedHeadReading = OrphanedHeadCounts | OrphanedHeadCountUnreadable;

const RUN_TASK_BRANCH_TOKEN = new RegExp(`^${RUN_TASK_BRANCH_TOKEN_SRC}$`);

/** Pure orphan count over a supplied listing, open-head set, and ancestry predicate.
 * The caller supplies buildOpenPrViews and is-ancestor; this function performs no exec. */
export function countOrphanedHeads(
  remoteNames: readonly string[],
  openPrHeads: ReadonlySet<string>,
  isInBaseHistory: (name: string) => boolean,
): OrphanedHeadCounts {
  const runShaped = remoteNames.filter((n) => RUN_TASK_BRANCH_TOKEN.test(n));
  const orphaned = runShaped.filter((n) => !openPrHeads.has(n) && !isInBaseHistory(n));
  return {
    kind: "counted",
    totalHeads: remoteNames.length,
    runShapedHeads: runShaped.length,
    orphanedHeads: orphaned.length,
  };
}

/** Read ls-remote once via remoteBranchNames, then apply countOrphanedHeads.
 * Any exec failure returns cannot-determine with its reason, never a healthy-looking zero. */
export function readOrphanedHeadCount(
  exec: (cmd: string, args: string[]) => string,
  openPrHeads: ReadonlySet<string>,
  isInBaseHistory: (name: string) => boolean,
): OrphanedHeadReading {
  let remoteNames: string[];
  try {
    remoteNames = remoteBranchNames(exec);
  } catch (e) {
    return { kind: "cannot-determine", reason: e instanceof Error ? e.message : String(e) };
  }
  return countOrphanedHeads(remoteNames, openPrHeads, isInBaseHistory);
}


// ── BATCHED LOCAL FACTS (W1-T4476 design (ii)) ──────────────────────────────────────────────────
//
// `reapBranchesCommand` used to spend a `git merge-base --is-ancestor`, a `git grep -l -F` and (for
// every deletable/screened head) a `git rev-parse`/`git log -1` PER BRANCH — O(branches) blocking
// spawns on the caller's own thread. The functions below read the SAME facts with a constant
// number of git calls, whatever the branch count: one `git for-each-ref` for every tip sha and
// committer time, one ancestry read against `origin/main`, and one `git grep` over every name.

/** One local remote tip (W1-T2246 §6): a missing map entry means unresolved locally,
 * never proof of absence. Its sha and committer time come from one for-each-ref read. */
export interface RemoteBranchTip {
  readonly sha: string;
  /** Undefined means an unreadable age, as with a failed per-branch git log. */
  readonly committedAtMs: number | undefined;
}

const REMOTE_BRANCH_TIP_FORMAT = "%(refname:short)\t%(objectname)\t%(committerdate:unix)";

/** Parse for-each-ref with REMOTE_BRANCH_TIP_FORMAT into plain-name tips.
 * Drop symbolic origin/HEAD; strip origin/ to match remoteBranchNames. */
export function parseRemoteBranchTips(raw: string): Map<string, RemoteBranchTip> {
  const tips = new Map<string, RemoteBranchTip>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, sha, committerSecs] = line.split("\t");
    if (!ref || !ref.startsWith("origin/") || !sha) continue;
    const name = ref.slice("origin/".length);
    if (!name || name === "HEAD") continue;
    const secs = Number(committerSecs);
    tips.set(name, { sha, committedAtMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined });
  }
  return tips;
}

/** One for-each-ref supplies manifest SHAs and active-screen ages for all branches.
 * An unreadable namespace returns an empty map: every tip remains unresolved. */
export function readRemoteBranchTips(exec: (cmd: string, args: string[]) => string): Map<string, RemoteBranchTip> {
  return runStepsSync(readRemoteBranchTipsSteps(exec));
}

export function* readRemoteBranchTipsSteps(exec: BranchReapExec): Steps<Map<string, RemoteBranchTip>> {
  let raw: string;
  try {
    raw = yield* step(() => exec("git", ["for-each-ref", `--format=${REMOTE_BRANCH_TIP_FORMAT}`, "refs/remotes/origin"]));
  } catch {
    return new Map(); // an unreadable local ref namespace — every name reads "no local tip"
  }
  return parseRemoteBranchTips(raw);
}

/** One for-each-ref --merged=origin/main replaces per-branch ancestry probes.
 * Undefined means the read failed, NEVER an empty all-false set (W1-T2246 §6). */
export function readTipInMainMembership(exec: (cmd: string, args: string[]) => string): Set<string> | undefined {
  return runStepsSync(readTipInMainMembershipSteps(exec));
}

export function* readTipInMainMembershipSteps(exec: BranchReapExec): Steps<Set<string> | undefined> {
  let raw: string;
  try {
    raw = yield* step(() => exec("git", ["for-each-ref", "--format=%(refname:short)", "--merged=origin/main", "refs/remotes/origin"]));
  } catch {
    return undefined; // the ancestry read itself failed (e.g. an unresolvable origin/main) —
    // "cannot determine", never an empty (and therefore all-false) merged set
  }
  const merged = new Set<string>();
  for (const line of raw.split("\n")) {
    const name = line.trim();
    if (!name.startsWith("origin/")) continue;
    merged.add(name.slice("origin/".length));
  }
  return merged;
}

/** Preserve the ancestry trichotomy: absent local tip or failed membership read means
 * unknown; otherwise membership decides true/false. */
export function tipInMainFor(
  name: string,
  tips: ReadonlyMap<string, RemoteBranchTip>,
  merged: ReadonlySet<string> | undefined,
): boolean | "unknown" {
  if (!tips.has(name)) return "unknown";
  if (merged === undefined) return "unknown";
  return merged.has(name);
}

/** One scan preserves per-branch -l -F unanchored SUBSTRING semantics.
 * Leftmost-longest hits may name a longer neighbor; includes recovers the shorter name. */
export function readNamedInSource(
  exec: (cmd: string, args: string[]) => string,
  names: readonly string[],
  root?: string,
  onFailure?: (why: string) => void,
): Set<string> {
  return runStepsSync(readNamedInSourceSteps(exec, names, root, onFailure));
}

export function* readNamedInSourceSteps(
  exec: BranchReapExec,
  names: readonly string[],
  root?: string,
  onFailure?: (why: string) => void,
): Steps<Set<string>> {
  const found = new Set<string>();
  if (names.length === 0) return found;
  const roots = ["src/", "scripts/", "deploy/", ".github/"].filter((p) => root === undefined || existsSync(join(root, p)));
  if (roots.length === 0) return found;
  const fixed = ["grep", "-n", "-o", "-F", ...names.flatMap((name) => ["-e", name]), "--", ...roots];
  const queue = names.every((name) => /^[\x21-\x7e]+$/.test(name))
    ? namedInSourcePatterns(names).map((pattern) => ["grep", "-n", "-o", "-P", "-e", pattern, "--", ...roots])
    : [fixed];
  let raw = "";
  while (queue.length > 0) {
    const args = queue.shift()!;
    try {
      raw += `${yield* step(() => exec("git", args))}\n`;
    } catch (err) {
      if (((err as { status?: unknown }).status ?? (err as { code?: unknown }).code) === 1) continue; // sync status and async code both identify git grep's no-match exit
      const why = String((err as Error)?.message ?? err);
      if (args !== fixed && /perl|pcre/i.test(why)) {
        queue.splice(0, queue.length, fixed); // a git built without PCRE: the -F scan finds the same names
        raw = "";
        continue;
      }
      onFailure?.(why);
      return new Set(names);
    }
  }
  const hits = parseBranchCitationHits(raw);
  return new Set(names.filter((name) => hits.some((hit) => hit.name.includes(name))));
}

/** Longest-first -P alternation preserves -F substring hits; split below argv's 128 KiB
 * string limit. Splitting can add hits, never lose them (W1-T4476). */
export function namedInSourcePatterns(names: readonly string[]): string[] {
  const sorted = [...new Set(names)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const patterns: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const name of sorted) {
    const escaped = name.replace(/[^A-Za-z0-9_]/g, "\\$&");
    if (current.length > 0 && length + escaped.length + 1 > 64 * 1024) {
      patterns.push(current.join("|"));
      current = [];
      length = 0;
    }
    current.push(escaped);
    length += escaped.length + 1;
  }
  if (current.length > 0) patterns.push(current.join("|"));
  return patterns;
}

/** Design (iii)/(iv): cache only PROVEN merged heads by resolved tip SHA.
 * GitHub cannot undo merged (foldPrState); open/closed can reopen, none uses nextNoPrHeadCache.
 * Drop missing/unknown SHAs; a changed tip must miss the cache. */
export function nextMergedHeadCache(
  facts: readonly { readonly name: string; readonly prState: string }[],
  tipShaByName: ReadonlyMap<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const f of facts) {
    if (f.prState !== "merged") continue;
    const sha = tipShaByName.get(f.name);
    if (!sha || sha === "unknown") continue;
    next[f.name] = sha;
  }
  return next;
}

/** Heads proven to have NO PR, by tip sha: a PR opened later is the newest, so the bulk walk's first page outranks this. */
export function nextNoPrHeadCache(
  facts: readonly { readonly name: string; readonly prState: string }[],
  tipShaByName: ReadonlyMap<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const f of facts) {
    const sha = tipShaByName.get(f.name);
    if (f.prState === "none" && sha && sha !== "unknown") next[f.name] = sha;
  }
  return next;
}

// ── the PRUNE (W1-T3020) ─────────────────────────────────────────────────────────────────────────

/** One deletable branch, the sha that makes its deletion reversible, and WHY `planBranchReap` put
 *  it in `deletable` — the reason is what {@link withholdActiveBranches} weighs. */
export interface BranchManifestEntry {
  readonly name: string;
  /** `"unknown"` when `git rev-parse` could not resolve the ref — see {@link pruneDeletableBranches}. */
  readonly sha: string;
  /** `planBranchReap`'s own `reasons[name]`: `merged`, `merged_squash_patch_id_differs`,
   *  `closed_unmerged`, `tip_in_main` or `patch_id_equivalent`. */
  readonly reason: string;
}

/** No-PR reasons prove content is in main, not that the worker has finished (W1-T3020).
 * A just-pushed run branch cut from main looks identical to an abandoned ref. withholdActiveBranches
 * must age-gate these reasons; merged/closed PR evidence needs no age gate. */
export const NO_PR_EVIDENCE_REASONS: readonly string[] = ["tip_in_main", "patch_id_equivalent"];

/** Cheap `git ls-remote` fingerprints trigger the expensive classifier on first use, branch-set
 * change, or this bound; keeping the policy here gives every repo target one tested cadence. */
export const AUTOMATIC_BRANCH_REAP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AutomaticBranchReapState {
  lastRunAtMs?: number;
  lastBranchFingerprint?: string;
  /** Design (iii): proven merged heads keyed by tip SHA; see nextMergedHeadCache. */
  mergedHeadShas?: Record<string, string>;
  noPrHeadShas?: Record<string, string>;
}

/** `<config.root>/state/<this>` — ONE cadence-and-cache file per repository (design (i)), so a
 *  fleet target managing several repos never collides its restarts across them. */
export function automaticBranchReapStateFileName(repo: string): string {
  return `branch-reap-state.${repo.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** Design (i): unreadable/malformed cadence state means NO STATE and forces a first pass.
 * Never infer a skip from a file that supplies no evidence a pass happened. */
export function readAutomaticBranchReapState(path: string): AutomaticBranchReapState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutomaticBranchReapState>;
    const state: AutomaticBranchReapState = {};
    if (typeof raw.lastRunAtMs === "number" && Number.isFinite(raw.lastRunAtMs)) state.lastRunAtMs = raw.lastRunAtMs;
    if (typeof raw.lastBranchFingerprint === "string") state.lastBranchFingerprint = raw.lastBranchFingerprint;
    for (const key of ["mergedHeadShas", "noPrHeadShas"] as const) {
      const cache = raw[key];
      if (!cache || typeof cache !== "object") continue;
      const shas: Record<string, string> = {};
      for (const [name, sha] of Object.entries(cache)) {
        if (typeof sha === "string") shas[name] = sha;
      }
      state[key] = shas;
    }
    return state;
  } catch {
    return {}; // absent, unreadable, or malformed — a first pass, NEVER a skip
  }
}

export function orphanRunBranchEvidenceReader(
  statePath: string,
  liveTaskIds: () => Iterable<string>,
  clock: Pick<Clock, "now">,
): () => { noPrHeadShas: Record<string, string>; nowMs: number; liveTaskIds: ReadonlySet<string> } | undefined {
  return () => {
    try {
      const noPrHeadShas = readAutomaticBranchReapState(statePath).noPrHeadShas ?? {};
      return { noPrHeadShas, nowMs: clock.now(), liveTaskIds: new Set(liveTaskIds()) };
    } catch {
      return undefined; // lock state unknown: release nothing, every pushed run ref keeps blocking
    }
  };
}

/** Best-effort persistence: failure costs a first pass after restart, never a wrong verdict.
 * Same posture as writeRefusalStreak in object-reaper.ts. */
export function writeAutomaticBranchReapState(path: string, state: AutomaticBranchReapState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // best-effort — losing this file costs a first-pass reclassification, never a wrong verdict
  }
}

export interface AutomaticBranchReapDecision {
  fire: boolean;
  reason: "first-pass" | "branch-set-changed" | "interval-elapsed" | "unchanged";
  branchFingerprint: string;
}

/** Stable, order-independent identity for the remote branch corpus. */
export function branchNamesFingerprint(names: readonly string[]): string {
  return [...new Set(names)].sort().join("\u0000");
}

/** Callers must reject unreadable/empty branch listings before cadence selection:
 * an empty fingerprint would otherwise masquerade as a legitimate branch deletion. */
export function decideAutomaticBranchReap(
  state: AutomaticBranchReapState,
  names: readonly string[],
  nowMs: number,
  intervalMs: number = AUTOMATIC_BRANCH_REAP_INTERVAL_MS,
): AutomaticBranchReapDecision {
  const branchFingerprint = branchNamesFingerprint(names);
  if (state.lastRunAtMs === undefined) return { fire: true, reason: "first-pass", branchFingerprint };
  if (state.lastBranchFingerprint !== branchFingerprint) {
    return { fire: true, reason: "branch-set-changed", branchFingerprint };
  }
  if (nowMs - state.lastRunAtMs >= intervalMs) {
    return { fire: true, reason: "interval-elapsed", branchFingerprint };
  }
  return { fire: false, reason: "unchanged", branchFingerprint };
}

export interface BranchPruneOutcome {
  readonly deleted: readonly string[];
  /** Named and NOT attempted, each with the reason it was left alone. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** A chunk whose push failed, carrying every name in it — those branches still exist. */
  readonly failed: readonly { readonly names: readonly string[]; readonly error: string }[];
}

/** Execute only the supplied BranchManifestEntry manifest with injected exec (W1-T3020).
 * planBranchReap in lib/status.ts owns every guard/hold; never reclassify or widen its set.
 * Skip unknown/empty SHAs: deletion is reversible only with a resolvable restore refspec.
 * Push in modest chunks: one rejected ref fails its whole push; report every surviving name. */
export function pruneDeletableBranches(
  manifest: readonly BranchManifestEntry[],
  exec: (cmd: string, args: string[]) => string,
  opts: { readonly chunkSize?: number } = {},
): BranchPruneOutcome {
  return runStepsSync(pruneDeletableBranchesSteps(manifest, exec, opts));
}

export function* pruneDeletableBranchesSteps(
  manifest: readonly BranchManifestEntry[],
  exec: BranchReapExec,
  opts: { readonly chunkSize?: number } = {},
): Steps<BranchPruneOutcome> {
  const chunkSize = Math.max(1, opts.chunkSize ?? 25);
  const deleted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { names: readonly string[]; error: string }[] = [];

  const deletable: BranchManifestEntry[] = [];
  for (const entry of manifest) {
    if (entry.sha === "unknown" || entry.sha === "") {
      skipped.push({ name: entry.name, reason: "sha unresolvable — deletion would not be reversible" });
      continue;
    }
    deletable.push(entry);
  }

  for (let i = 0; i < deletable.length; i += chunkSize) {
    const chunk = deletable.slice(i, i + chunkSize);
    try {
      yield* pushOriginSteps(exec, [], ["--delete", ...chunk.map((e) => e.name)]);
      for (const e of chunk) deleted.push(e.name);
    } catch (err) {
      // The whole chunk survives: git applies a rejected push atomically per invocation, so naming
      // the group is the honest report — claiming any individual name deleted would be a guess.
      failed.push({ names: chunk.map((e) => e.name), error: String((err as Error)?.message ?? err) });
    }
  }

  return { deleted, skipped, failed };
}

/** A branch the prune declined to delete, and the sentence saying why. */
export interface WithheldBranch {
  readonly name: string;
  readonly reason: string;
}

export interface ActiveBranchScreen {
  readonly proceed: readonly BranchManifestEntry[];
  readonly withheld: readonly WithheldBranch[];
}

/** Final screen at PRUNE time: only remove from planBranchReap's set, never reclassify.
 * Re-read open PR heads independently of the fold: a PR may open after classification, and
 * W1-T3020 fixed reused names where merged once outranked open. Withhold any open head.
 * For NO_PR_EVIDENCE_REASONS, withhold recent OR unreadable ages: no PR yet is not no PR ever.
 * Merged/closed PRs are decisive about completed work and are not age-gated. */
export function withholdActiveBranches(
  manifest: readonly BranchManifestEntry[],
  openPrHeads: ReadonlySet<string>,
  tipAgeMs: (name: string) => number | undefined,
  opts: { readonly minNoPrEvidenceAgeMs?: number } = {},
): ActiveBranchScreen {
  // A day. A dispatched build is bounded well under it, so this withholds an in-flight branch for
  // its whole life while costing a finished one only a later run of the same verb.
  const minAge = opts.minNoPrEvidenceAgeMs ?? 24 * 60 * 60 * 1000;
  const proceed: BranchManifestEntry[] = [];
  const withheld: WithheldBranch[] = [];

  for (const entry of manifest) {
    if (openPrHeads.has(entry.name)) {
      withheld.push({ name: entry.name, reason: "an open pull request is on this head right now" });
      continue;
    }
    if (NO_PR_EVIDENCE_REASONS.includes(entry.reason)) {
      const age = tipAgeMs(entry.name);
      if (age === undefined) {
        withheld.push({
          name: entry.name,
          reason: `classified '${entry.reason}' (no pull request) and its tip age could not be read`,
        });
        continue;
      }
      if (age < minAge) {
        withheld.push({
          name: entry.name,
          reason: `classified '${entry.reason}' (no pull request) and its tip is ${Math.round(age / 3600000)}h old — ` +
            `newer than the ${Math.round(minAge / 3600000)}h bound, so a just-started worker branch cannot be ruled out`,
        });
        continue;
      }
    }
    proceed.push(entry);
  }

  return { proceed, withheld };
}

// ── REPO HYGIENE: STALE HELD RUN BRANCHES (operator ruling 2026-11-01) ──────────────────────
//
// planBranchReap holds a no-PR run branch whose task shipped by another attempt as
// `named_task_credited`, and one whose task has not shipped as `named_task_open`, until someone
// adjudicates it. Nothing does: on 2026-11-01 remudero carried 506 branches, 311 of them no-PR run
// branches of shipped tasks (296 older than 7 days) and 83 unshipped ones older than 14 days. This
// planner names the stale ones. It does NOT change planBranchReap's verdict: the caller archives
// each tip under STALE_HOLD_ARCHIVE_PREFIX before any delete, so no commit is lost, and the lane
// starts in shadow mode, which only ledgers what it would reap.

/** BACKSTOP: a held run branch of a SHIPPED task is stale after this long without a new commit. */
export const STALE_CREDITED_HOLD_MS = 7 * 24 * 3_600_000;
/** BACKSTOP: a held run branch of an UNSHIPPED task is stale after this long without a new commit. */
export const STALE_UNSHIPPED_HOLD_MS = 14 * 24 * 3_600_000;
/** Where a stale branch's tip is archived before its branch is deleted: `<prefix><branch>/<sha>`. */
export const STALE_HOLD_ARCHIVE_PREFIX = "refs/rmd-recovery/reaped/";

export type StaleHoldReason = "credited_sibling_stale" | "orphan_unshipped_stale";

/** Structural subset of status.ts BranchFacts: importing it, even type-only, creates a cycle. */
export interface StaleHoldFacts {
  name: string;
  prState: "merged" | "closed" | "open" | "none" | "unknown";
  tipInMain: boolean | "unknown";
  namedInSource: boolean;
  namedTaskId?: string;
}

export interface StaleHoldCandidate {
  name: string;
  sha: string;
  reason: StaleHoldReason;
  ageMs: number;
  taskId: string;
}

/** Pure stale-hold planner: require confirmed no PR, tip not in main matching the live SHA,
 * readable age past threshold, resolved task ID, and a readable claim list with no live claim.
 * Undefined claims yield no candidates. */
export function planStaleHoldArchive(input: {
  facts: readonly StaleHoldFacts[];
  reasons: Readonly<Record<string, string>>;
  tips: ReadonlyMap<string, RemoteBranchTip>;
  /** The live `ls-remote --heads` sha per branch. A local remote-tracking tip that differs (or is absent here) is stale: it names nothing. */
  liveShaByName: ReadonlyMap<string, string>;
  nowMs: number;
  claimedTaskIds: ReadonlySet<string> | undefined;
  /** A `run-<taskId>-<epochMs>` branch's plan task, which the slug matcher never reads (it lands `no_pr_ever`). */
  runTaskByBranch?: ReadonlyMap<string, string>;
  /** The merge-credited task ids, or `undefined` when unread: a `no_pr_ever` run branch then names nothing. */
  creditedTaskIds?: ReadonlySet<string>;
  creditedAfterMs?: number;
  unshippedAfterMs?: number;
}): StaleHoldCandidate[] {
  if (input.claimedTaskIds === undefined) return [];
  const out: StaleHoldCandidate[] = [];
  for (const f of input.facts) {
    const reason = input.reasons[f.name];
    if (reason !== "named_task_credited" && reason !== "named_task_open" && reason !== "no_pr_ever") continue;
    if (f.prState !== "none" || f.tipInMain !== false || f.namedInSource || !/^run-.+-[0-9]+$/.test(f.name)) continue;
    const taskId = f.namedTaskId ?? input.runTaskByBranch?.get(f.name);
    if (taskId === undefined || input.claimedTaskIds.has(taskId)) continue;
    if (reason === "no_pr_ever" && input.creditedTaskIds === undefined) continue;
    const credited = reason === "named_task_credited" || (reason === "no_pr_ever" && input.creditedTaskIds!.has(taskId));
    const tip = input.tips.get(f.name);
    if (tip === undefined || tip.committedAtMs === undefined) continue;
    if (input.liveShaByName.get(f.name) !== tip.sha) continue;
    const ageMs = input.nowMs - tip.committedAtMs;
    const bound = credited ? (input.creditedAfterMs ?? STALE_CREDITED_HOLD_MS) : (input.unshippedAfterMs ?? STALE_UNSHIPPED_HOLD_MS);
    if (ageMs < bound) continue;
    out.push({ name: f.name, sha: tip.sha, reason: credited ? "credited_sibling_stale" : "orphan_unshipped_stale", ageMs, taskId });
  }
  return out;
}

/** The task ids holding a live dispatch claim, or the read's error: an unread listing is never an empty one. */
export function* readDispatchClaimTaskIdsSteps(exec: BranchReapExec): Steps<{ ids: Set<string> } | { error: string }> {
  try {
    return { ids: parseDispatchClaimTaskIds(yield* lsRemoteOriginSteps(exec, [], ["refs/rmd-dispatch/*"])) };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err) };
  }
}

/** The task ids holding a live `refs/rmd-dispatch/<id>` claim, from `git ls-remote origin 'refs/rmd-dispatch/*'`. */
export function parseDispatchClaimTaskIds(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith("refs/rmd-dispatch/")) ids.add(ref.slice("refs/rmd-dispatch/".length));
  }
  return ids;
}

// ── REPO HYGIENE, ACT MODE (operator ruling 2026-11-01: "Build act mode, flag off") ──────────────
//
// Armed only by `sweep.armStaleBranchArchive` in plan/policy.yaml (default false), and only on the
// automatic rung's prune pass or an explicit `rmd reap-branches --archive-stale`. Unarmed, the lane
// stays the shadow above: it ledgers `branch_reap.hygiene_shadow` and pushes nothing.

/** BACKSTOP: cap each stale-hold pass at one prune-sized chunk, draining the rest later.
 * The ledger's capped count names the remainder (operator ruling 2026-11-01). */
export const STALE_HOLD_ARCHIVE_CAP = 25;

export interface StaleHoldArchived {
  name: string;
  sha: string;
  reason: StaleHoldReason;
  archive_ref: string;
}

export interface StaleHoldArchiveOutcome {
  archived: StaleHoldArchived[];
  /** A push git refused: the lease failed (the branch moved) or the remote rejected it. The branch is unchanged. */
  failed: { name: string; error: string }[];
  /** Candidates past the cap, left for a later pass. */
  capped: number;
}

/** `refs/rmd-recovery/reaped/<branch>/<sha>`: where a stale hold's tip is kept once its branch is deleted. */
export function staleHoldArchiveRef(name: string, sha: string): string {
  return `${STALE_HOLD_ARCHIVE_PREFIX}${name}/${sha}`;
}

/** Restore via fetch THEN push (staleHoldRestoreCommand). The archive exists only on origin;
 * omitting fetch fails with src refspec not found in a fresh clone (real-remote falsifier). */
export function staleHoldRestoreCommand(name: string, sha: string): string {
  const ref = staleHoldArchiveRef(name, sha);
  return `git fetch origin ${ref}:${ref} && git push origin ${ref}:refs/heads/${name}`;
}

/** Archive and delete in ONE atomic push per branch, leased to the planner's exact SHA.
 * A moved head or rejected push leaves both refs unchanged and reports failed; one failed branch
 * cannot block another. Restore via staleHoldRestoreCommand, including its required fetch. */
export function* archiveStaleHoldsSteps(
  candidates: readonly StaleHoldCandidate[],
  exec: BranchReapExec,
  opts: { readonly cap?: number } = {},
): Steps<StaleHoldArchiveOutcome> {
  const cap = Math.max(0, opts.cap ?? STALE_HOLD_ARCHIVE_CAP);
  const archived: StaleHoldArchived[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const c of candidates.slice(0, cap)) {
    const archiveRef = staleHoldArchiveRef(c.name, c.sha);
    try {
      yield* pushOriginSteps(exec, ["--atomic", `--force-with-lease=refs/heads/${c.name}:${c.sha}`],
        [`${c.sha}:${archiveRef}`, `:refs/heads/${c.name}`]);
      archived.push({ name: c.name, sha: c.sha, reason: c.reason, archive_ref: archiveRef });
    } catch (err) {
      failed.push({ name: c.name, error: String((err as Error)?.message ?? err) });
    }
  }
  return { archived, failed, capped: Math.max(0, candidates.length - cap) };
}
