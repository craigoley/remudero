import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { decideFreshnessRestart, DEPLOY_RESTART_SCORE_THRESHOLD } from "./deploy-judge.js";
import type { DaemonFreshness } from "./daemon.js";
import type { Escalation } from "./escalate.js";
import type { Clock } from "./clock.js";
import type { AsyncGitRunner } from "./git-fetch-retry.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { asyncGit, parseAdvanceCommits } from "./self-sync.js";

/**
 * 2026-10-10/11 -- TRACKED EDITS IN A LIVE CHECKOUT BLOCKED CORE FOR FIVE HOURS, AND NOTHING SAID SO.
 * Four tracked files were edited by hand in the host's checkouts. From then on the daemon's freshness
 * read answered `arm=dirty`, the watchdog's `deploy_code_clean` logged "local edits; deferring" on
 * every tick and converge_host_units wrote `units-converge-refused-since`: core stayed on 81bb8c305
 * and nothing escalated. Deferring is right -- an edit is never discarded unseen -- but deferring
 * FOREVER, SILENTLY, is not. This ladder keeps the deferral and gives it a record, a voice and an end:
 *
 *   tier 1, at once  -- the tracked edits are written to a patch under the state root and an immutable
 *                       recovery ref (W1-T6362's shape: a commit on HEAD, CAS-created from zero, its
 *                       tree proven equal to the edits). Still defers.
 *   tier 2           -- once the tree's staleness pressure reaches the daemon's own restart threshold,
 *                       one needs-human issue names the files, the patch, the ref and the lag.
 *   tier 3           -- at two thresholds, and ONLY when this exact edit set has a copy that was read
 *                       back and re-applied to the same tree, the tracked paths are restored to HEAD so
 *                       the checkout can fast-forward. The ledger and the issue say so.
 */

/**
 * PRESSURE IS THE DAEMON'S OWN, NOT A TIMEOUT. {@link decideFreshnessRestart} scores the advances the
 * edits are holding back plus staleness that reaches the threshold at one horizon (W1-T4945/W1-T5308),
 * from the first reading of the tree both dirty and behind. A blocked change to the daemon's own code
 * therefore escalates at once and restores one horizon later; a docs-only lag waits one, then two.
 *
 * TWO ACTORS, ONE RECORD. The host watchdog runs this through `rmd live-edits` for both trees; the
 * daemon runs it in its freshness read. Both share `<state>/live-edits/<tree>.json`, every step is
 * idempotent, and only an actor handed `escalate` speaks: the host's service user has no GitHub
 * credential, so a restore it performs leaves `noticePending` for the daemon to post.
 */
export type LiveEditTree = "daemon-checkout" | "install-checkout";
export const LIVE_EDIT_TREES: readonly LiveEditTree[] = ["daemon-checkout", "install-checkout"];

export const LIVE_EDIT_RECOVERY_REF_PREFIX = "refs/rmd-recovery/live-edits";

export const LIVE_EDIT_STEPS = {
  preserved: "live_edits.preserved",
  preserveFailed: "live_edits.preserve_failed",
  escalated: "live_edits.escalated",
  escalationFailed: "live_edits.escalation_failed",
  restored: "live_edits.restored",
  restoreRefused: "live_edits.restore_refused",
  noticeDelivered: "live_edits.notice_delivered",
} as const;

/** The recovery commit's author: the fleet bot, never whoever happens to run the ladder (a CI
 *  runner has no git identity at all). The same identity W1-T6362's fix-dirty refs carry. */
const RECOVERY_IDENTITY = {
  GIT_AUTHOR_NAME: "remudero-fleet[bot]",
  GIT_AUTHOR_EMAIL: "remudero-fleet[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "remudero-fleet[bot]",
  GIT_COMMITTER_EMAIL: "remudero-fleet[bot]@users.noreply.github.com",
} as const;
const ZERO_OID = "0".repeat(40);
/** A status read never refreshes the live index: a concurrent git in that checkout must not meet our lock. */
const NO_OPTIONAL_LOCKS = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const PATH_BOUND = 20;

export interface LiveEditState {
  /** First reading of this tree dirty AND behind origin/main, epoch ms: the staleness clock. */
  since?: number;
  /** The tracked-edit tree last preserved, and whether that copy was read back and re-applied. */
  tree?: string;
  confirmedTree?: string;
  patch?: string;
  ref?: string;
  /** The tree whose preservation last failed: logged once per failing tree, not once per tick. */
  failedTree?: string;
  escalatedUrl?: string;
  escalationFailedLogged?: boolean;
  restoreRefusedTree?: string;
  restoredAtMs?: number;
  /** A restore whose issue comment no actor could post yet. */
  noticePending?: string;
}

export interface LiveEditRungInput {
  tree: LiveEditTree;
  repoDir: string;
  stateDir: string;
  host: string;
  clock: Clock;
  /** Fetch origin/main first. The watchdog's install checkout is fetched by nothing while it is dirty. */
  fetch?: boolean;
  git?: (repoDir: string) => AsyncGitRunner;
  /** Opens (or dedups onto) the needs-human issue; returns its URL, or "" when none was opened. */
  escalate?: (e: Escalation) => Promise<string>;
  comment?: (url: string, body: string) => Promise<void>;
}

export interface LiveEditLadderResult {
  tree: LiveEditTree;
  tier: 0 | 1 | 2 | 3;
  dirty: boolean;
  restored: boolean;
  /** Epoch ms the staleness clock started; a restart decision may count its lag from here. */
  since?: number;
  pressure?: number;
  paths?: string[];
  patch?: string;
  ref?: string;
  issueUrl?: string;
  reason: string;
}

export function liveEditStatePath(stateDir: string, tree: LiveEditTree): string {
  return join(stateDir, "live-edits", `${tree}.json`);
}

function readState(path: string): LiveEditState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LiveEditState) : {};
  } catch {
    // An absent or torn record starts a fresh episode: the worst case is one more preserved copy.
    return {};
  }
}

/** Read-merge-write, renamed into place: the other actor's fields survive a concurrent write. */
function writeState(path: string, changes: Partial<Record<keyof LiveEditState, unknown>>): void {
  const next: Record<string, unknown> = { ...readState(path), ...changes };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, { flush: true });
  renameSync(tmp, path);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Parse `status --porcelain=v1 -z -uno`: every tracked path an entry names, a rename's source too. */
export function trackedEditPaths(porcelainZ: string): string[] {
  const tokens = porcelainZ.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(tokens[++i]!);
  }
  return [...new Set(paths)].sort();
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>, seed?: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-live-edits-index-"));
  try {
    const index = join(dir, "index");
    if (seed !== undefined) writeFileSync(index, readFileSync(seed));
    return await fn({ ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Snapshot { head: string; worktreeTree: string; indexTree: string; pathspec: string }

/** The tracked edits as trees, built in throwaway indexes: the checkout's own index is never written. */
async function snapshot(git: AsyncGitRunner, repoDir: string, head: string, pathspec: string): Promise<Snapshot> {
  const worktreeTree = await withTempIndex(async (env) => {
    await git(["read-tree", head], undefined, env);
    await git(["add", "-A", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], undefined, env);
    return (await git(["write-tree"], undefined, env)).trim();
  });
  const realIndex = resolve(repoDir, (await git(["rev-parse", "--git-path", "index"])).trim());
  const indexTree = await withTempIndex(async (env) => (await git(["write-tree"], undefined, env)).trim(), realIndex);
  return { head, worktreeTree, indexTree, pathspec };
}

/** The patch is written by git itself (byte-exact), fsynced, then proven by re-applying THE FILE ON
 *  DISK to HEAD and comparing trees -- a copy that cannot be read back is not a copy. */
async function writeAndConfirmPatch(git: AsyncGitRunner, head: string, tree: string, path: string): Promise<void> {
  await git(["diff", "--binary", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", head, tree, `--output=${path}`]);
  fsyncPath(path);
  fsyncPath(dirname(path));
  const headTree = (await git(["rev-parse", `${head}^{tree}`])).trim();
  const applied = statSync(path).size === 0 ? headTree : await withTempIndex(async (env) => {
    await git(["read-tree", head], undefined, env);
    await git(["apply", "--cached", "--binary", "--whitespace=nowarn", path], undefined, env);
    return (await git(["write-tree"], undefined, env)).trim();
  });
  if (applied !== tree) throw new Error(`patch ${path} re-applies to ${applied}, not the edits' tree ${tree}`);
}

async function recoveryRef(git: AsyncGitRunner, ref: string, head: string, tree: string, message: string): Promise<void> {
  const commit = (await git(["commit-tree", tree, "-p", head, "-m", message], undefined, { ...process.env, ...RECOVERY_IDENTITY })).trim();
  await git(["update-ref", ref, commit, ZERO_OID]);
  const [refTree, parent] = (await git(["rev-parse", `${ref}^{tree}`, `${ref}^1`])).trim().split("\n");
  if (refTree !== tree || parent !== head) throw new Error(`recovery ref ${ref} does not reproduce tree ${tree} on ${head}`);
}

/** Tier 1: preserve and confirm. Throws on any failure; the caller records it and confirms nothing. */
async function preserve(d: LiveEditRungInput, git: AsyncGitRunner, snap: Snapshot): Promise<{ patch: string; ref: string }> {
  const dir = join(d.stateDir, "recovery", "live-edits", d.tree);
  mkdirSync(dir, { recursive: true });
  const keep = join(dirname(dir), ".rmd-scratch-keep");
  if (!existsSync(keep)) writeFileSync(keep, "live-edit ladder: preserved live-checkout edits\n", { flush: true });
  const host = d.host.replace(/[^A-Za-z0-9._-]/g, "_") || "host";
  const ts = stamp(d.clock.iso());
  const base = `${host}-${ts}-${snap.worktreeTree.slice(0, 12)}`;
  const patch = join(dir, `${base}.patch`);
  if (existsSync(patch)) throw new Error(`patch ${patch} already exists`);
  await writeAndConfirmPatch(git, snap.head, snap.worktreeTree, patch);
  const ref = `${LIVE_EDIT_RECOVERY_REF_PREFIX}/${host}/${ts}`;
  await recoveryRef(git, ref, snap.head, snap.worktreeTree, `chore(recovery): preserve live edits in the ${d.tree}`);
  const headTree = (await git(["rev-parse", `${snap.head}^{tree}`])).trim();
  if (snap.indexTree !== headTree && snap.indexTree !== snap.worktreeTree) {
    await writeAndConfirmPatch(git, snap.head, snap.indexTree, join(dir, `${base}.index.patch`));
    await recoveryRef(git, `${ref}-index`, snap.head, snap.indexTree, `chore(recovery): preserve the staged edits in the ${d.tree}`);
  }
  return { patch: relative(d.stateDir, patch), ref };
}

function escalation(d: LiveEditRungInput, r: { paths: string[]; patch?: string; ref?: string; behind: number; pressure: number; threshold: number; head: string; main: string }): Escalation {
  const shown = r.paths.slice(0, PATH_BOUND).map((p) => `- \`${p}\``).join("\n") + (r.paths.length > PATH_BOUND ? `\n- …and ${r.paths.length - PATH_BOUND} more` : "");
  return {
    class: "BLOCKED",
    taskId: `LIVE-EDITS-${d.tree}`,
    runId: `LIVE-EDITS-${d.tree}`,
    // STABLE across ticks and actors: escalate dedups on it, so the daemon and the watchdog share one issue.
    summary: `tracked edits in the live ${d.tree} are holding it behind origin/main`,
    detail:
      `The live ${d.tree} (\`${d.repoDir}\` as seen by ${d.host}) carries tracked edits no PR made, so it ` +
      `cannot fast-forward: it is ${r.behind} commit(s) behind origin/main (${r.head.slice(0, 9)}..${r.main.slice(0, 9)}), ` +
      `staleness pressure ${r.pressure} against the restart threshold ${r.threshold}.\n\nEdited tracked paths:\n${shown}\n\n` +
      (r.patch && r.ref
        ? `The edits are preserved and were read back: patch \`<state root>/${r.patch}\`, recovery ref \`${r.ref}\` in that checkout.`
        : `The edits could NOT be preserved yet (see the \`${LIVE_EDIT_STEPS.preserveFailed}\` ledger rows), so nothing will be restored.`),
    options: [
      { label: "land the edits as a PR", detail: `apply the patch on a branch and open a PR; once it merges the ladder's restore loses nothing.` },
      { label: "let the ladder restore", detail: `at pressure ${2 * r.threshold} the ladder restores the tracked paths to HEAD (only with a confirmed copy) and the checkout fast-forwards.` },
    ],
    recommendation: "land the edits as a PR",
    consequence: `the ${d.tree} stays behind origin/main until pressure ${2 * r.threshold}, when the ladder restores the tracked paths to HEAD`,
  };
}

/** One rung of the ladder for one tree. Never throws: an unreadable checkout defers, as before. */
export async function runLiveEditLadder(d: LiveEditRungInput): Promise<LiveEditLadderResult> {
  try {
    return await ladder(d);
  } catch (e) {
    return { tree: d.tree, tier: 0, dirty: false, restored: false, reason: `ladder unreadable: ${String((e as Error)?.message ?? e)}` };
  }
}

async function ladder(d: LiveEditRungInput): Promise<LiveEditLadderResult> {
  const git = (d.git ?? ((dir: string) => asyncGit(dir, { maxBuffer: 1 << 26 })))(d.repoDir);
  const statePath = liveEditStatePath(d.stateDir, d.tree);
  const ledgerPath = join(d.stateDir, LEDGER_FILENAME);
  const nowMs = d.clock.now();
  const log = (step: string, extra: Record<string, unknown>): void =>
    appendLedger(ledgerPath, { run_id: `LIVE-EDITS-${d.tree}`, task_id: `LIVE-EDITS-${d.tree}`, step, tree: d.tree, ...extra });
  let state = readState(statePath);

  const paths = trackedEditPaths(await git(["status", "--porcelain=v1", "-z", "-uno"], undefined, NO_OPTIONAL_LOCKS));
  if (paths.length === 0) {
    await deliverNotice(d, state, statePath, log);
    // The episode is over. A notice nobody could post yet outlives it; nothing else does.
    if (readState(statePath).noticePending) {
      writeState(statePath, { since: undefined, tree: undefined, confirmedTree: undefined, failedTree: undefined, restoreRefusedTree: undefined, escalationFailedLogged: undefined });
    } else if (existsSync(statePath)) unlinkSync(statePath);
    return { tree: d.tree, tier: 0, dirty: false, restored: false, reason: "no tracked edits" };
  }

  // Fetched only when dirty, so a clean tree costs one status. Objects and origin/main only.
  if (d.fetch) await git(["fetch", "--quiet", "origin", "main"]).catch(() => undefined /* offline: judge against the last fetched origin/main */);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const main = (await git(["rev-parse", "--verify", "--quiet", "origin/main"]).catch(() => "" /* no origin/main: never behind, so tier 1 only */)).trim();
  const behind = main && main !== head
    ? Number((await git(["rev-list", "--count", `${head}..${main}`])).trim()) || 0
    : 0;
  const threshold = DEPLOY_RESTART_SCORE_THRESHOLD.value;
  let pressure = 0;
  if (behind > 0) {
    if (state.since === undefined || state.since > nowMs) writeState(statePath, { since: nowMs });
    state = readState(statePath);
    const changes = await git(["log", "--format=%x1e%H%x1f%s", "--name-only", `${head}..${main}`]).then(parseAdvanceCommits, () => undefined /* unreadable: decideFreshnessRestart weighs it as a full threshold */);
    pressure = decideFreshnessRestart({ changes, busy: true, staleSinceMs: state.since!, nowMs, state: { total: 0, scoredShas: [] } }).pressure;
  }

  const pathspecDir = mkdtempSync(join(tmpdir(), "rmd-live-edits-paths-"));
  try {
    const pathspec = join(pathspecDir, "paths");
    writeFileSync(pathspec, paths.join("\0"));
    const snap = await snapshot(git, d.repoDir, head, pathspec);
    // The edit set's identity: its working-tree content AND what is staged, both preserved.
    const key = `${snap.worktreeTree}:${snap.indexTree}`;
    if (state.confirmedTree !== key) {
      try {
        const kept = await preserve(d, git, snap);
        writeState(statePath, { tree: key, confirmedTree: key, patch: kept.patch, ref: kept.ref, failedTree: undefined });
        log(LIVE_EDIT_STEPS.preserved, { paths: paths.slice(0, PATH_BOUND), path_count: paths.length, patch: kept.patch, ref: kept.ref, head, behind });
      } catch (e) {
        if (state.failedTree !== key) {
          log(LIVE_EDIT_STEPS.preserveFailed, { error: String((e as Error)?.message ?? e), path_count: paths.length, head });
        }
        writeState(statePath, { tree: key, confirmedTree: undefined, failedTree: key });
      }
      state = readState(statePath);
    }
    const confirmed = state.confirmedTree === key;
    const base = { tree: d.tree, dirty: true, since: state.since, pressure, paths, patch: confirmed ? state.patch : undefined, ref: confirmed ? state.ref : undefined };
    const facts = { paths, patch: base.patch, ref: base.ref, behind, pressure, threshold, head, main: main || head };

    if (pressure < threshold) return { ...base, tier: 1, restored: false, reason: `pressure ${pressure} < ${threshold}: preserved, deferring` };

    if (!state.escalatedUrl && d.escalate) {
      const url = await d.escalate(escalation(d, facts)).catch((e: unknown) => {
        if (!state.escalationFailedLogged) log(LIVE_EDIT_STEPS.escalationFailed, { error: String((e as Error)?.message ?? e) });
        writeState(statePath, { escalationFailedLogged: true });
        return "";
      });
      if (url) {
        writeState(statePath, { escalatedUrl: url });
        log(LIVE_EDIT_STEPS.escalated, { issue_url: url, pressure, behind, path_count: paths.length });
      }
      state = readState(statePath);
    }
    if (pressure < 2 * threshold) {
      const voice = state.escalatedUrl ? "escalated" : "escalation due, left to the daemon";
      return { ...base, tier: 2, restored: false, issueUrl: state.escalatedUrl, reason: `pressure ${pressure} >= ${threshold}: ${voice}; deferring` };
    }

    if (!confirmed) {
      if (state.restoreRefusedTree !== key) {
        log(LIVE_EDIT_STEPS.restoreRefused, { reason: "no confirmed durable copy of these edits", pressure, path_count: paths.length });
        writeState(statePath, { restoreRefusedTree: key });
      }
      return { ...base, tier: 3, restored: false, issueUrl: state.escalatedUrl, reason: `pressure ${pressure} >= ${2 * threshold}, but no confirmed copy: refusing to restore` };
    }
    // An edit landing after the snapshot has no copy yet: the next run preserves it before any restore.
    const recheck = await snapshot(git, d.repoDir, head, pathspec);
    if (`${recheck.worktreeTree}:${recheck.indexTree}` !== key || trackedEditPaths(await git(["status", "--porcelain=v1", "-z", "-uno"], undefined, NO_OPTIONAL_LOCKS)).join("\0") !== paths.join("\0")) {
      return { ...base, tier: 3, restored: false, issueUrl: state.escalatedUrl, reason: "the edits changed after their copy was confirmed; preserving them first" };
    }
    await git(["restore", "--source=HEAD", "--staged", "--worktree", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], undefined, { ...process.env, GIT_LITERAL_PATHSPECS: "1" });
    const left = trackedEditPaths(await git(["status", "--porcelain=v1", "-z", "-uno"], undefined, NO_OPTIONAL_LOCKS));
    const notice =
      `The ladder restored ${paths.length} tracked path(s) in the live ${d.tree} to HEAD ${head.slice(0, 9)} at staleness ` +
      `pressure ${pressure} (>= ${2 * threshold}) so it can fast-forward. Nothing was lost: patch \`<state root>/${state.patch}\`, ` +
      `recovery ref \`${state.ref}\`.`;
    writeState(statePath, { restoredAtMs: nowMs, noticePending: notice, restoreRefusedTree: undefined });
    log(LIVE_EDIT_STEPS.restored, { paths: paths.slice(0, PATH_BOUND), path_count: paths.length, patch: state.patch, ref: state.ref, pressure, head, behind, still_dirty: left.length });
    await deliverNotice(d, readState(statePath), statePath, log);
    state = readState(statePath);
    return { ...base, tier: 3, restored: left.length === 0, issueUrl: state.escalatedUrl, reason: left.length === 0 ? "restored to HEAD from a confirmed copy" : `restore left ${left.length} path(s) dirty` };
  } finally {
    rmSync(pathspecDir, { recursive: true, force: true });
  }
}

/** Post a pending restore notice: a comment on the open issue, else a new escalation carrying it. */
async function deliverNotice(d: LiveEditRungInput, state: LiveEditState, statePath: string, log: (step: string, extra: Record<string, unknown>) => void): Promise<void> {
  if (!state.noticePending) return;
  try {
    if (state.escalatedUrl && d.comment) await d.comment(state.escalatedUrl, state.noticePending);
    else if (!state.escalatedUrl && d.escalate) {
      const url = await d.escalate({
        class: "BLOCKED",
        taskId: `LIVE-EDITS-${d.tree}`,
        runId: `LIVE-EDITS-${d.tree}`,
        summary: `tracked edits in the live ${d.tree} are holding it behind origin/main`,
        detail: state.noticePending,
        options: [{ label: "land the preserved edits as a PR", detail: "apply the patch on a branch if the edits are still wanted." }],
        recommendation: "land the preserved edits as a PR",
        consequence: null,
      });
      if (!url) return;
      writeState(statePath, { escalatedUrl: url });
    } else return;
  } catch {
    return; // the notice stays pending; the next run retries it
  }
  writeState(statePath, { noticePending: undefined });
  log(LIVE_EDIT_STEPS.noticeDelivered, { issue_url: readState(statePath).escalatedUrl });
}

export interface LiveEditLadderWiring {
  daemonRepoDir: string;
  installRepoDir?: string;
  stateDir: string;
  host: string;
  clock: Clock;
  escalate?: (e: Escalation) => Promise<string>;
  comment?: (url: string, body: string) => Promise<void>;
  git?: (repoDir: string) => AsyncGitRunner;
}

/** The daemon's freshness read with the ladder run beside it, for its own tree and the install tree.
 *  A restore of its own tree is re-read at once, and the stale reading carries the episode's start so
 *  the restart decision counts the lag from when the edits first held the tree back. */
export function withLiveEditLadders(read: () => Promise<DaemonFreshness>, w: LiveEditLadderWiring): () => Promise<DaemonFreshness> {
  let running = false;
  return async () => {
    const first = await read();
    if (running) return first;
    running = true;
    let restoredSince: number | undefined;
    try {
      const shared = { stateDir: w.stateDir, host: w.host, escalate: w.escalate, comment: w.comment, git: w.git };
      const own = await runLiveEditLadder({ ...shared, tree: "daemon-checkout", repoDir: w.daemonRepoDir, clock: w.clock });
      if (own.restored) restoredSince = own.since;
      if (w.installRepoDir && resolve(w.installRepoDir) !== resolve(w.daemonRepoDir) && existsSync(w.installRepoDir)) {
        await runLiveEditLadder({ ...shared, tree: "install-checkout", repoDir: w.installRepoDir, clock: w.clock, fetch: true });
      }
    } finally {
      running = false;
    }
    if (restoredSince === undefined) return first;
    const again = await read();
    return again.stale ? { ...again, staleSinceMs: restoredSince } : again;
  };
}
