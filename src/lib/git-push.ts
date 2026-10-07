import { execFile, execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { probeProofSandbox, proofChildEnv, proofSandboxArgv, ProofSandboxUnavailableError } from "./review.js";
import {
  HOST_GIT_CONFIG,
  harnessHooksDir,
  hostWorktreeGit,
  hostWorktreeGitAsync,
  pinnedConfigValue,
  pinWorktreeGit,
} from "./worktree-git.js";

/**
 * THE git-push LEAF — the single place this codebase pushes a branch to origin.
 *
 * WHY IT EXISTS. The other three outward operations already had a shared leaf that the
 * live-write guard could sit in: `ghPrCreateFillCommand` for `gh pr create`,
 * `ghIssueGateway().create` for `gh issue create`, and `ghPrMergeSquash`/`realArmDeps()`
 * for `gh pr merge`. `git push` had none — it was written out longhand at NINE call sites
 * across SEVEN top-level functions in two files, so the guard had to be repeated at each
 * one and six of those repetitions sat after a `spawnWorker` call inside commands that
 * take no injectable deps, making them unreachable from any offline test. A guard that
 * cannot be tested is a guard nobody has shown works.
 *
 * Routing every push through here means the boundary is guarded BY CONSTRUCTION: a new
 * call site cannot forget, because there is nothing to forget — it just calls this.
 * `test/live-write-guard.test.ts`'s structural test fails the build if a raw inlined git
 * push reappears anywhere in src/ outside this function. (That sentence deliberately does
 * NOT spell out the argv: the structural test matches on argv substrings, so quoting the
 * shape in a comment would recruit this comment into its own unguarded-call list.)
 *
 * The `exec` seam is the whole point of the extraction: a test drives the real guard and
 * the real argv construction with an injected recorder, no worker and no remote.
 */
export class PushFailedError extends RmdError {
  /** The child's stderr, verbatim. The whole point: a caller deciding how to REACT to a failed push
   *  needs the reason, and `execFileSync`'s own message carries only the argv. */
  readonly stderrText: string;
  constructor(message: string, stderrText: string, readonly cause: unknown) {
    // GENERIC_EXIT_CODE, which is what a plain `extends Error` already resolved to through
    // exitCodeFor — so adopting the envelope changes the discriminant and NOT the exit status.
    super("git", GENERIC_EXIT_CODE, message, { stderrText });
    this.name = "PushFailedError";
    this.stderrText = stderrText;
  }
}

/**
 * W1-T3310 — CAPTURE THE PUSH'S STDERR, AND RE-EMIT IT.
 *
 * MEASURED: with `stdio: "inherit"` the child's stderr goes straight to the terminal and
 * `execFileSync`'s thrown error keeps NONE of it —
 *
 *     execFileSync("bash", ["-c", "echo TEXT >&2; exit 1"], { stdio: "inherit" })
 *       e.message -> "Command failed: bash -c echo TEXT >&2; exit 1"
 *       e.stderr  -> null
 *
 * so the daemon saw `Command failed: git -C <worktree> push origin HEAD` and could not tell this
 * repo's own pre-push gate refusing from a dead credential or a non-fast-forward. It therefore
 * classified every push failure as a crash and spent three of docker's five restarts on gate
 * refusals in one day, while dispatching normally in between.
 *
 * THE TRADE, STATED. stderr is now PIPED rather than inherited, which means git's progress output is
 * buffered for the duration of the push instead of streaming. It is re-emitted immediately
 * afterwards, on success and on failure alike, so nothing is hidden — only delayed, by the length of
 * one push. That is the right side of the trade: a push takes seconds, and a failure whose reason
 * was invisible to the process that had to react to it took the fleet down three times.
 * `stdio: "ignore"` is untouched — those two fix-rung call sites asked for silence deliberately.
 */
export function defaultPushExec(file: string, args: string[], opts: { stdio: "inherit" | "ignore" }): void {
  if (opts.stdio === "ignore") {
    execFileSync(file, args, opts);
    return;
  }
  try {
    const out = execFileSync(file, args, { stdio: ["inherit", "inherit", "pipe"] });
    void out;
  } catch (err) {
    const captured = (err as { stderr?: Buffer | string } | null)?.stderr;
    const text = captured === undefined || captured === null ? "" : String(captured);
    // RE-EMITTED BEFORE THROWING, so the operator's terminal shows exactly what it showed before
    // this change — the refusal, verbatim — and the caller additionally gets it as data.
    if (text.length > 0) process.stderr.write(text);
    throw new PushFailedError(`${String((err as Error)?.message ?? err)}\n${text}`.trimEnd(), text, err);
  }
}

const execFilePromise = promisify(execFile);

/** W1-T5284 — {@link defaultPushExec} off the event loop: the run-branch push held the daemon loop
 *  14.7 s in one profile window. The child's stdout is written through as `inherit` would; a failed
 *  push re-emits its stderr and throws the same {@link PushFailedError}. */
export async function defaultPushExecAsync(file: string, args: string[], opts: { stdio: "inherit" | "ignore" }): Promise<void> {
  if (opts.stdio === "ignore") {
    await execFilePromise(file, args, { encoding: "utf8" });
    return;
  }
  try {
    const { stdout } = await execFilePromise(file, args, { encoding: "utf8" });
    if (stdout) process.stdout.write(stdout);
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string } | null;
    if (failed?.stdout) process.stdout.write(failed.stdout);
    const text = failed?.stderr ?? "";
    if (text.length > 0) process.stderr.write(text);
    throw new PushFailedError(`${String((err as Error)?.message ?? err)}\n${text}`.trimEnd(), text, err);
  }
}

/** Injected by tests to observe the argv without running git. */
export type PushExec = (file: string, args: string[], opts: { stdio: "inherit" | "ignore" }) => void;

/** {@link PushExec} for {@link gitPushRunBranchAsync}: awaited when it returns a promise. */
export type PushExecAsync = (file: string, args: string[], opts: { stdio: "inherit" | "ignore" }) => void | Promise<void>;

/** Options per call site — every divergence between the nine sites is a parameter here,
 *  never a second implementation. `stdio` is "ignore" only at the two best-effort fix-rung
 *  sites; `setUpstream` is true only at spike.ts's push-fallback, which used `push -u`.
 *  `force` (W1-T1012) is true only at the two call sites that just amended the worktree's
 *  own last commit (appending the `Remudero-Task:` trailer, `appendTaskTrailerToCommit`,
 *  run-task.ts) AFTER that commit was already on origin — the amend rewrites the tip sha,
 *  so a plain push is a non-fast-forward rejection.
 *
 *  THAT LAST SENTENCE USED TO READ "owned exclusively by this one run, so nobody else's work
 *  is ever discarded". W1-T3221 measured it false — an operator now works lane-owned PRs by
 *  hand, so the branch is SHARED — and `force` therefore carries a lease; see
 *  {@link leasedForcePushSteps}. */
export interface PushRunBranchOpts {
  stdio?: "inherit" | "ignore";
  setUpstream?: boolean;
  force?: boolean;
  exec?: PushExec;
  /**
   * W1-T2610 — THE POST-CONDITION. The sha the CALLER believes it is landing (a fix rung
   * passes the sha it just committed). OPTIONAL and additive: omitted, this function is
   * byte-identical to its pre-W1-T2610 self — the seven non-fix call sites that never pass
   * this stay untouched.
   *
   * WHY THIS CATCHES THE ZERO-REFS-PUSHED CASE A NON-FAST-FORWARD CHECK CANNOT (the incident
   * behind DAEMON-1788016810368 / PR #3261): when a fix round's own worktree gets rewound
   * back to origin's tip BETWEEN the commit and this push, the ref this push actually sends
   * is already on the remote — `git push` sees a legal, zero-ref fast-forward and exits 0
   * with nothing to report, especially with `stdio: "ignore"` (the two fix-rung sites this
   * option exists for). A fast-forward check never fires there; it isn't a disagreement, it's
   * an agreement on the WRONG sha. So this never inspects git's push output at all — it reads
   * the worktree's OWN head with `capture` (the same seam {@link gitPushEmptyCommit} uses,
   * never `stdio`, which the fix-rung sites throw away) right before the push runs, and
   * compares that reading against `expectedHeadSha`. A mismatch means the local ref already
   * drifted off the sha the caller believes it is landing — pushing it would just move the
   * WRONG commit (or move nothing), so this raises instead of pushing.
   */
  expectedHeadSha?: string;
  /** Injected by tests to observe the pre-push reads without a real repo. Defaults to
   *  {@link defaultGitCapture}. Consulted when `expectedHeadSha` is supplied, and by
   *  {@link leasedForcePushSteps} to derive the lease when `force` is set. */
  capture?: GitCapture;
}

export function gitPushRunBranch(worktreePath: string, opts: PushRunBranchOpts = {}): void {
  runStepsSync(
    pushRunBranchSteps(worktreePath, opts, {
      capture: opts.capture ?? worktreeGitCapture(worktreePath),
      exec: opts.exec ?? worktreePushExec(worktreePath),
    }),
  );
}

/** W1-T5284 — {@link gitPushRunBranch}'s options with an awaited `capture`/`exec`. */
export interface PushRunBranchAsyncOpts extends Omit<PushRunBranchOpts, "capture" | "exec"> {
  exec?: PushExecAsync;
  capture?: GitCaptureAsync;
}

/**
 * W1-T5284 — {@link gitPushRunBranch} for the daemon's lanes, with every git child awaited. It is
 * the SAME steps under an async driver ({@link pushRunBranchSteps}), so the guard, the head
 * post-condition, the lease, the discard and foreign-head refusals and their messages cannot drift
 * from the sync form that CLI callers keep.
 */
export async function gitPushRunBranchAsync(worktreePath: string, opts: PushRunBranchAsyncOpts = {}): Promise<void> {
  await runStepsAsync(
    pushRunBranchSteps(worktreePath, opts, {
      capture: opts.capture ?? worktreeGitCaptureAsync(worktreePath),
      exec: opts.exec ?? worktreePushExecAsync(worktreePath),
    }),
  );
}

/** The two git effects a push makes; each driver supplies its own (sync, or awaited). */
interface PushIo {
  capture: GitCaptureAsync;
  exec: PushExecAsync;
}

function* pushRunBranchSteps(
  worktreePath: string,
  opts: Pick<PushRunBranchOpts, "expectedHeadSha" | "stdio" | "setUpstream" | "force">,
  io: PushIo,
): Steps<void> {
  // THE GUARD, at the leaf. Every one of the nine former call sites is covered by this
  // single line, and it fires wherever the helper is called from — including before a
  // worker spawn, which none of the old per-site guards could do.
  assertLiveWriteAllowed("git-push", "pushing the run branch to origin");
  if (opts.expectedHeadSha !== undefined) {
    // THE POST-CONDITION READ (W1-T2610) — see `PushRunBranchOpts.expectedHeadSha`'s own doc
    // for why this is a pre-push local read rather than trusting the push's own exit code or
    // output. `capture`, never `stdio`: the two fix-rung call sites this guards run with
    // `stdio: "ignore"`, so this must hold with the push's own output thrown away.
    const observedHeadSha = (yield* step(() => io.capture("git", ["-C", worktreePath, "rev-parse", "HEAD"]))).trim();
    if (observedHeadSha !== opts.expectedHeadSha) {
      throw new LanePushForeignHeadError(
        `refusing to push the run branch at ${worktreePath}: it was asked to land ` +
          `${opts.expectedHeadSha} but the worktree's HEAD now reads ${observedHeadSha} — the local ` +
          `ref moved between the commit and this push, so pushing now would either transfer zero refs ` +
          `(a legal, silent fast-forward no-op if HEAD was rewound back to the remote tip) or push the ` +
          `wrong commit entirely; nothing was pushed`,
        worktreePath,
        opts.expectedHeadSha,
      );
    }
  }
  const stdio = opts.stdio ?? "inherit";
  if (opts.force) {
    yield* leasedForcePushSteps(worktreePath, { ...io, stdio, setUpstream: opts.setUpstream === true });
    return;
  }
  const args = ["-C", worktreePath, "push"];
  if (opts.setUpstream) args.push("-u");
  args.push("origin", "HEAD");
  yield* step(() => io.exec("git", args, { stdio }));
}

/**
 * THE FORCE PATH, LEASED (W1-T3221). The `force: true` sites amend the tip to append the
 * `Remudero-Task:` trailer (W1-T1012) after that commit is already on origin, so the push must
 * rewrite history. What it must NOT do is rewrite history it never saw: a bare `--force` cannot
 * tell "my own amended commit" from "my own commit plus someone else's on top".
 *
 * THE LEASE IS DERIVED, NOT PASSED, so no call site changes. `refs/remotes/origin/<branch>` is
 * updated by this lane's OWN push moments earlier and by nothing else in between, so a foreign
 * commit landing after that leaves the tracking ref behind the real remote — the disagreement.
 *
 * NO LEASE ⇒ NO PUSH. A detached HEAD or a missing tracking ref cannot state the precondition,
 * and a push that cannot state it is the bare `--force` this removes. Refusing costs a bounded,
 * known thing — the trailer — and `findMergedByHeadBranch` credits a merged `run-<id>-<digits>`
 * head without one (MEASURED on #1657). Pushing costs someone else's commit, with an exit 0.
 *
 * A REFUSAL IS REPORTED AND RETURNS, never throws: the work is already on origin, and aborting
 * before the PR is opened would trade an invisible loss for a louder one.
 *
 * THE ELISION CHECK IS NOT OPTIONAL — `task-id-reservation.ts`'s header records the trap and
 * {@link gitPushEmptyCommit} already answers it: a lease git ELIDES still exits 0, so the remote
 * ref is re-read afterwards and must equal what was pushed.
 */
function* leasedForcePushSteps(
  worktreePath: string,
  io: PushIo & { stdio: "inherit" | "ignore"; setUpstream: boolean },
): Steps<void> {
  const read = function* (args: string[]): Steps<string | undefined> {
    try {
      const out = (yield* step(() => io.capture("git", ["-C", worktreePath, ...args]))).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      // An absent ref, not a fault -- every caller below names its own reason for `undefined`.
      return undefined;
    }
  };
  const branch = yield* read(["rev-parse", "--abbrev-ref", "HEAD"]);
  // "HEAD" is what a DETACHED worktree reports, which names no ref to lease against.
  if (branch === undefined || branch === "HEAD") {
    reportLeaselessRefusal(`the worktree at ${worktreePath} is not on a named branch`);
    return;
  }
  const ref = `refs/heads/${branch}`;
  const lastPublished = yield* read(["rev-parse", `refs/remotes/origin/${branch}`]);
  if (lastPublished === undefined) {
    reportLeaselessRefusal(`no refs/remotes/origin/${branch} to lease against — this lane has published nothing there`);
    return;
  }
  const newSha = yield* read(["rev-parse", "HEAD"]);
  if (newSha === undefined) {
    reportLeaselessRefusal(`the worktree at ${worktreePath} has no readable HEAD`);
    return;
  }
  // THE DISCARD CHECK, AND IT IS THE ONE THE LEASE CANNOT MAKE. A lease answers "did the ref move
  // since I last looked" — it compares the local tracking ref against the remote. That is a
  // different question from "would this push destroy work", and the gap is not theoretical:
  // MEASURED 2026-09-09 against a real local remote, once the lane FETCHES (a rebuild, a
  // re-dispatch, any refresh at all) its tracking ref already contains the foreign commit, the
  // lease is satisfied, and the force-push discards that commit anyway. The probe ended with the
  // lane's amend as the remote head and the operator's commit unreachable.
  //
  // "REACHABLE FROM THE REMOTE BUT NOT FROM MY HEAD" IS THE WRONG SET, and getting that wrong is
  // how a guard fires on the healthy path: an amend REPLACES the tip, so the pre-amend commit is a
  // sibling of the new one and lands in that set every single time. MEASURED while writing this —
  // the first version refused every ordinary trailer amend, which is the bound-fires-on-healthy
  // defect this repo keeps re-earning.
  //
  // What separates the two is PARENTAGE. `appendTaskTrailerToCommit` amends, so the replacement
  // carries exactly the parents the pushed commit carries; a commit someone else added sits ON TOP
  // of the old tip and therefore has different parents. So walk the commits the remote holds and
  // this head does not, and count only those whose parents differ from this head's. The tip being
  // replaced is excused by construction, and nothing else is.
  //
  // UNREADABLE IS NOT ZERO. If the remote ref cannot be read, or the walk cannot be computed, that
  // is not evidence there is nothing to lose — it is the absence of evidence, and it refuses.
  const remoteHead = (yield* read(["ls-remote", "origin", ref]))?.split(/\s+/)[0];
  if (remoteHead !== undefined && remoteHead !== newSha) {
    // `fetch` first, or the remote sha may not be an object this worktree holds and the walk
    // cannot start. Best-effort: a failed fetch leaves the walk unreadable, which refuses.
    yield* read(["fetch", "--no-tags", "--quiet", "origin", ref]);
    const mine = yield* read(["rev-list", "--parents", "-1", newSha]);
    const theirs = yield* read(["rev-list", "--parents", remoteHead, `^${newSha}`]);
    if (mine === undefined || theirs === undefined) {
      reportLeaselessRefusal(
        `could not determine whether pushing ${newSha} over ${remoteHead} on ${branch} would discard ` +
          "commits — an unreadable walk is not a count of zero",
      );
      return;
    }
    const myParents = mine.trim().split(/\s+/).slice(1).join(" ");
    const foreign = theirs
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.split(/\s+/).slice(1).join(" ") !== myParents);
    if (foreign.length > 0) {
      reportDiscard(branch, remoteHead, newSha, foreign.length);
      return;
    }
  }
  // `setUpstream` still composes rather than being silently dropped — a flag that quietly stops
  // applying when another is set is a worse contract than one that costs a line here.
  const args = ["-C", worktreePath, "push"];
  if (io.setUpstream) args.push("-u");
  args.push(`--force-with-lease=${ref}:${lastPublished}`, "origin", `HEAD:${ref}`);
  try {
    yield* step(() => io.exec("git", args, { stdio: io.stdio }));
  } catch {
    // Rejected lease, non-fast-forward, or the ref moved — one meaning here: someone else holds
    // it. Name BOTH shas, or the reader cannot tell what was preserved from what was not.
    reportForeignHead(branch, lastPublished, newSha, (yield* read(["ls-remote", "origin", ref]))?.split(/\s+/)[0]);
    return;
  }
  const observed = (yield* read(["ls-remote", "origin", ref]))?.split(/\s+/)[0];
  if (observed !== newSha) {
    reportForeignHead(branch, lastPublished, newSha, observed);
  }
}

/** Both refusals go to stderr, never a throw — see {@link leasedForcePushSteps}. Exported so the
 *  suite can assert the wording carries the shas rather than a bare "refused". */
export function leaselessRefusalMessage(reason: string): string {
  return (
    `git-push: refusing to force-push the run branch without a lease — ${reason}. ` +
    `The commit is already on origin; only the Remudero-Task: trailer amend is skipped, and a ` +
    `merged run-<id>-<epochMs> head is credited without one (W1-T3221).`
  );
}

/** The refusal for a push that WOULD have destroyed work, as distinct from one whose ref moved.
 *  Exported so the suite can assert it names the count and both shas. */
export function discardRefusalMessage(
  branch: string,
  remoteHead: string,
  newSha: string,
  count: number,
): string {
  return (
    `git-push: refusing to force-push ${branch} — origin is at ${remoteHead}, and pushing ${newSha} ` +
    `over it would discard ${count} commit(s) reachable from the remote and not from this head. ` +
    "The lease held (this lane had already fetched them), so only this check could see it; nothing " +
    "was pushed and nothing was discarded (W1-T3221)."
  );
}

export function foreignHeadRefusalMessage(
  branch: string,
  lastPublished: string,
  newSha: string,
  observed: string | undefined,
): string {
  return (
    `git-push: refusing to force-push ${branch} — this lane last published ${lastPublished} and ` +
    `would have replaced the remote with ${newSha}, but origin now reads ` +
    `${observed ?? "an unreadable ref"}. Someone else's commit is on that branch; nothing was ` +
    `pushed and nothing was discarded (W1-T3221).`
  );
}

function reportLeaselessRefusal(reason: string): void {
  console.error(leaselessRefusalMessage(reason));
}

function reportDiscard(branch: string, remoteHead: string, newSha: string, count: number): void {
  console.error(discardRefusalMessage(branch, remoteHead, newSha, count));
}

function reportForeignHead(
  branch: string,
  lastPublished: string,
  newSha: string,
  observed: string | undefined,
): void {
  console.error(foreignHeadRefusalMessage(branch, lastPublished, newSha, observed));
}

/** W1-T6106 — the run-branch push's default git: the steps' `["-C", <worktree>, …]` argv, minus that
 *  prefix, through {@link hostWorktreeGit}, which pins the repository and runs no worktree hook. */
function leafArgs(worktreePath: string, args: string[]): string[] {
  if (args[0] !== "-C" || args[1] !== worktreePath) {
    throw new Error(`git-push: a worktree push step must address ${worktreePath} with -C; got ${args.slice(0, 2).join(" ")}`);
  }
  return args.slice(2);
}

export function worktreeGitCapture(worktreePath: string): GitCapture {
  return (_file, args) => hostWorktreeGit(worktreePath, leafArgs(worktreePath, args));
}

export function worktreeGitCaptureAsync(worktreePath: string): GitCaptureAsync {
  return (_file, args) => hostWorktreeGitAsync(worktreePath, leafArgs(worktreePath, args));
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

/** The gate a push runs: the harness's hook, its argv, the stdin line git would have given it, its env. */
interface PrePushGate {
  hook: string;
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
}

/**
 * THE PRE-PUSH GATE, FROM THE HARNESS'S COPY. git runs no hook on a host push now, so the push leaf runs
 * the gate itself, first: the HARNESS's `hooks/pre-push` ({@link harnessHooksDir}), never the worktree's
 * tracked copy, fed the stdin line git would have given it. Only for a worktree whose pinned
 * (daemon-owned) config enables hooks, so a worktree that ran no hook before still runs none.
 */
function* prePushGateSteps(
  worktreePath: string,
  pushArgs: string[],
  read: (args: string[]) => string | Promise<string>,
): Steps<PrePushGate | undefined> {
  const pin = pinWorktreeGit(worktreePath);
  const configured = pinnedConfigValue(pin, "core.hooksPath");
  if (configured === undefined || configured === "" || configured === "/dev/null") return undefined;
  const hook = join(harnessHooksDir(), "pre-push");
  if (!existsSync(hook)) return undefined;
  const tryRead = function* (args: string[]): Steps<string | undefined> {
    try {
      const out = String(yield* step(() => read(args))).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      // An absent ref or an unreachable remote; each read below names the placeholder git itself uses.
      return undefined;
    }
  };
  const positional = pushArgs.slice(1).filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  const refspec = positional[1] ?? "HEAD";
  const [src, dst] = refspec.includes(":") ? (refspec.split(":", 2) as [string, string]) : [refspec, undefined];
  const headRef = yield* tryRead(["symbolic-ref", "-q", "HEAD"]);
  const localRef = src === "HEAD" ? (headRef ?? "HEAD") : src.startsWith("refs/") || /^[0-9a-f]{40,64}$/.test(src) ? src : `refs/heads/${src}`;
  const localSha = (yield* tryRead(["rev-parse", src])) ?? ZERO_SHA;
  const remoteRef = dst ?? localRef;
  // Unreadable reads as a new ref: the hook's only reader (identity-transition) abstains on it, and the
  // push that follows reports the transport failure itself.
  const remoteSha = (yield* tryRead(["ls-remote", remote, remoteRef]))?.split(/\s+/)[0] ?? ZERO_SHA;
  if (remoteSha === localSha) return undefined; // up to date: git sends nothing and runs no pre-push
  const url = (yield* tryRead(["remote", "get-url", remote])) ?? remote;
  return { hook, args: [remote, url], input: `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`, env: prePushGateEnv() };
}

const GATE_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "RMD_PREPUSH_GATES"] as const;

/** W1-T6120 — the gate's env is an ALLOWLIST: GH_TOKEN, GH_APP_* and provider keys stay with the push. Its git calls
 *  carry {@link HOST_GIT_CONFIG}, and {@link withGateHome} gives it a throwaway HOME. */
export function prePushGateEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GATE_ENV_ALLOWLIST) if (typeof base[key] === "string") env[key] = base[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = String(HOST_GIT_CONFIG.length);
  HOST_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** W1-T6138: branch-owned checks get the proof sandbox with every persistent bind read-only. */
export function createPrePushSandboxRunner(cwd: string, {
  probe = probeProofSandbox,
  run = (file, args, options) => spawnSync(file, args, options),
}: {
  probe?: typeof probeProofSandbox;
  run?: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
} = {}) {
  const status = probe();
  return (file: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): SpawnSyncReturns<string> => {
    if (status.mode !== "bwrap") throw new ProofSandboxUnavailableError(status.reason);
    const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prepush-sandbox-home-`));
    try {
      const env = { ...prePushGateEnv(proofChildEnv(home, prePushGateEnv())), HOME: home, TMPDIR: "/tmp" };
      const sandbox = proofSandboxArgv({ cwd, home, env: { HOME: home, GH_APP_PRIVATE_KEY_PATH: process.env.GH_APP_PRIVATE_KEY_PATH } });
      const realHome = realpathSync(home);
      for (let i = 0; i < sandbox.length; i++) {
        if (sandbox[i] === "--bind" && sandbox[i + 1] !== realHome) sandbox[i] = "--ro-bind";
      }
      const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
        cwd, env, encoding: "utf8", timeout: options.timeout ?? 60_000, maxBuffer: options.maxBuffer ?? GATE_MAX_BUFFER,
      };
      const started = run(status.binary, [...sandbox, process.execPath, "-e", ""], { ...spawnOptions, timeout: 10_000 });
      if (started.error || started.status !== 0) {
        throw new ProofSandboxUnavailableError(started.error?.message || started.stderr.trim() || `sandbox probe exited ${started.status}, signal ${started.signal}`);
      }
      return run(status.binary, [...sandbox, file, ...args], spawnOptions);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Runs `run` with `gate.env.HOME` a fresh empty directory, removed once `run` (or the promise it returns) settles. */
function withGateHome<T>(gate: PrePushGate, run: (env: NodeJS.ProcessEnv) => T): T {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prepush-home-`));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  let settlesLater = false;
  try {
    const result = run({ ...gate.env, HOME: home });
    settlesLater = result instanceof Promise;
    return settlesLater ? ((result as Promise<unknown>).finally(cleanup) as T) : result;
  } finally {
    if (!settlesLater) cleanup();
  }
}

export function gateHookRefused(res: { error?: Error; status: number | null }): boolean {
  if (res.error !== undefined && (res.error as NodeJS.ErrnoException).code !== "EPIPE") return true;
  return res.status !== 0;
}

function gateFailureDetail(err: unknown): string {
  const failed = err as { status?: unknown; signal?: unknown; code?: unknown; error?: { code?: unknown } } | null;
  const spawned = failed?.error?.code ?? (typeof failed?.code === "string" ? failed.code : undefined);
  if (spawned !== undefined && spawned !== "EPIPE") return `spawn ${String(spawned)}`;
  return typeof failed?.signal === "string" ? `signal ${failed.signal}` : `exit ${String(failed?.status ?? failed?.code)}`;
}

/** A refused gate, in the shape a refused `git push` had: `runErrorCause` and `censusPushRefusal` read it. */
function gateRefusal(worktreePath: string, pushArgs: string[], err: unknown): PushFailedError {
  const text = String((err as { stderr?: unknown } | null)?.stderr ?? "");
  return new PushFailedError(
    `Command failed: git -C ${worktreePath} ${pushArgs.join(" ")}\n` +
      `the harness's pre-push gate (${harnessHooksDir()}/pre-push) refused this push (${gateFailureDetail(err)}); nothing was pushed\n${text}`.trimEnd(),
    text,
    err,
  );
}

function writeThrough(err: unknown): void {
  const failed = err as { stdout?: unknown; stderr?: unknown } | null;
  if (failed?.stdout) process.stdout.write(String(failed.stdout));
  if (failed?.stderr) process.stderr.write(String(failed.stderr));
}

function pushFailure(err: unknown): PushFailedError {
  const text = String((err as { stderr?: unknown } | null)?.stderr ?? "");
  return new PushFailedError(`${String((err as Error)?.message ?? err)}\n${text}`.trimEnd(), text, err);
}

const GATE_MAX_BUFFER = 64 * 1024 * 1024;

/** The default exec for a run-branch push: the harness's gate, then the push through the leaf. */
export function worktreePushExec(worktreePath: string): PushExec {
  return (_file, args, opts) => {
    const pushArgs = leafArgs(worktreePath, args);
    const gate = runStepsSync(prePushGateSteps(worktreePath, pushArgs, (a) => hostWorktreeGit(worktreePath, a)));
    if (gate) {
      const res = withGateHome(gate, (env) => spawnSync(gate.hook, gate.args, {
        cwd: worktreePath, input: gate.input, env, encoding: "utf8", maxBuffer: GATE_MAX_BUFFER,
      }));
      if (opts.stdio !== "ignore") writeThrough(res); // on a pass too: a skipped check says so on stderr
      if (gateHookRefused(res)) throw gateRefusal(worktreePath, pushArgs, res);
    }
    try {
      hostWorktreeGit(worktreePath, pushArgs, { stdio: opts.stdio === "ignore" ? "ignore" : "inherit-stdout" });
    } catch (err) {
      if (opts.stdio !== "ignore") writeThrough({ stderr: (err as { stderr?: unknown } | null)?.stderr });
      throw pushFailure(err);
    }
  };
}

/** {@link worktreePushExec} off the event loop. */
export function worktreePushExecAsync(worktreePath: string): PushExecAsync {
  return async (_file, args, opts) => {
    const pushArgs = leafArgs(worktreePath, args);
    const gate = await runStepsAsync(prePushGateSteps(worktreePath, pushArgs, (a) => hostWorktreeGitAsync(worktreePath, a)));
    if (gate) {
      try {
        const out = await withGateHome(gate, (env) => new Promise<{ stdout: string; stderr: string }>((resolveGate, reject) => {
          const child = execFile(gate.hook, gate.args, { cwd: worktreePath, env, encoding: "utf8", maxBuffer: GATE_MAX_BUFFER },
            (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolveGate({ stdout, stderr })));
          child.stdin?.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") reject(err); });
          child.stdin?.end(gate.input);
        }));
        if (opts.stdio !== "ignore") writeThrough(out);
      } catch (err) {
        if (opts.stdio !== "ignore") writeThrough(err);
        throw gateRefusal(worktreePath, pushArgs, err);
      }
    }
    try {
      await hostWorktreeGitAsync(worktreePath, pushArgs, { stdio: opts.stdio === "ignore" ? "ignore" : "inherit-stdout" });
    } catch (err) {
      if (opts.stdio !== "ignore") writeThrough(err);
      throw pushFailure(err);
    }
  };
}

/** Captures stdout from a git plumbing read/write. Injected by tests so the argv and the
 *  sequencing are observable without a repo or a remote. */
export type GitCapture = (file: string, args: string[]) => string;

export function defaultGitCapture(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** {@link GitCapture} for {@link gitPushRunBranchAsync}: awaited when it returns a promise. */
export type GitCaptureAsync = (file: string, args: string[]) => string | Promise<string>;

/** {@link defaultGitCapture} off the event loop. */
export async function defaultGitCaptureAsync(file: string, args: string[]): Promise<string> {
  return (await execFilePromise(file, args, { encoding: "utf8" })).stdout;
}

/**
 * W1-T5284 — ONE SET OF STEPS, TWO DRIVERS. A leaf the CLI calls synchronously and the daemon must
 * await is written once, as a generator that yields each child-process effect; {@link runStepsSync}
 * calls each effect and {@link runStepsAsync} awaits it, and either resumes the generator with the
 * value or throws the failure into it at the same `yield`, so its own try/catch arms see exactly
 * what the sync form saw. The same shape as feedback-landing.ts's `driveLanding`/`driveLandingAsync`.
 */
export type StepEffect = () => unknown;
export type Steps<R> = Generator<StepEffect, R, unknown>;

/** Yield one effect; resumes with its value (awaited, under {@link runStepsAsync}). */
export function* step<T>(effect: () => T | Promise<T>): Generator<StepEffect, T, unknown> {
  return (yield effect) as T;
}

export function runStepsSync<R>(steps: Steps<R>): R {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

export async function runStepsAsync<R>(steps: Steps<R>): Promise<R> {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = await next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

export interface PushEmptyCommitOpts {
  capture?: GitCapture;
  exec?: PushExec;
}

/**
 * Raised when a lane's push is refused because the branch is not where the lane believed it
 * was (W1-T1288). `expectedHeadSha` is the head the lane carried a lease for — the value it
 * read before minting `newSha` — never the value observed on the remote, because a refused
 * push must never have to know what actually happened out there; that is an operator's read,
 * not this leaf's. See the module header on {@link gitPushEmptyCommit} for the two shapes
 * this covers: a lease git itself rejects, and a lease git elided.
 */
export class LanePushForeignHeadError extends Error {
  override name = "LanePushForeignHeadError";
  constructor(
    message: string,
    public readonly branch: string,
    public readonly expectedHeadSha: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Push an EMPTY commit onto `branch`, minting a fresh head sha — the ABSENT-check-suite
 * remedy (W1-T186 follow-up). Returns the new sha.
 *
 * WHY IT LIVES HERE. This is a `git push`, so it belongs at THE leaf for the same reason
 * every other push does: the guard above is the boundary, and
 * `test/live-write-guard.test.ts`'s structural test fails the build on a raw inlined push
 * anywhere else in src/. It is not a new outward path — it is the existing one, called with
 * a different ref.
 *
 * WHY PLUMBING RATHER THAN `commit --allow-empty`. The caller (the sweep's post-fix
 * re-verification rung) runs inside the DAEMON'S OWN CHECKOUT. A `git commit` there would move
 * that checkout's HEAD and dirty the very tree `checkCliFreshness` gates on — the exact class
 * of defect W1-T191 exists to remove. `commit-tree` against the head's OWN tree writes a commit
 * object to the object database and touches no working tree, no index, and no local branch (the
 * same discipline `feedback-landing.ts` already uses).
 *
 * W1-T1288 — THE LEASE, AND WHY A FAST-FORWARD PARENT IS NOT ENOUGH ON ITS OWN. The new
 * commit's parent is `headSha`, so the push IS a fast-forward from the head this call was
 * TOLD about — but `branch` is the PR's OWN branch (`sweepPostFixReverification`'s `redrive`
 * passes `pr.headRefName`), a ref other lanes push too, and `headSha` can go stale between the
 * caller's read and this push. A plain `newSha:refs/heads/branch` push has no way to express
 * that staleness: git's non-fast-forward check only fires when the ref EXISTS and disagrees:
 * the incident this task is filed against (oper#lane-push-clobbered-a-shared-branch-2026-08-23,
 * PR #2668) hit the window where the ref was momentarily ABSENT, so the plain push reported
 * `[new branch]` and silently replaced a concurrent lane's work rather than rejecting. So this
 * pushes with `--force-with-lease=refs/heads/<branch>:<headSha>` — a PRECONDITION, not a
 * permission: it requires the remote ref to be exactly at `headSha` right now, and refuses
 * (never creates, never replaces) the moment that stops being true, including while the ref is
 * absent (an absent ref never equals a non-empty `headSha`).
 *
 * THE MEASURED ELISION TRAP (`task-id-reservation.ts`'s header, reused here rather than
 * re-derived): a lease git can ELIDE still exits 0 without ever checking it, so a caller that
 * trusts the exit code alone can read a lease-skipped push as a lease-honoured one. This
 * function does not: after the push returns, it re-reads the remote ref
 * (`git ls-remote origin refs/heads/<branch>`) and throws {@link LanePushForeignHeadError}
 * unless it now reads exactly `newSha` — so an elided or otherwise-wrong result is never
 * mistaken for success.
 *
 * A REFUSAL RESTORES NOTHING. Whether the lease is rejected by git or the post-push read
 * disagrees, this function only throws — it never retries, never re-reads a "current" head to
 * push again, and never force-pushes a second time. The remote ref is left exactly as it was
 * found; deciding which lane's work survives a real clobber stays an operator judgement
 * (design note iv), not something this leaf attempts.
 */
export function gitPushEmptyCommit(
  repoDir: string,
  branch: string,
  headSha: string,
  message: string,
  opts: PushEmptyCommitOpts = {},
): string {
  assertLiveWriteAllowed("git-push", `pushing an empty commit to ${branch} to mint a fresh head sha`);
  const capture = opts.capture ?? defaultGitCapture;
  const exec = opts.exec ?? defaultPushExec;
  const ref = `refs/heads/${branch}`;
  // The head's OWN tree — so the commit is empty by construction, not by a flag.
  const treeSha = capture("git", ["-C", repoDir, "rev-parse", `${headSha}^{tree}`]).trim();
  const newSha = capture("git", ["-C", repoDir, "commit-tree", treeSha, "-p", headSha, "-m", message]).trim();
  try {
    exec("git", ["-C", repoDir, "push", `--force-with-lease=${ref}:${headSha}`, "origin", `${newSha}:${ref}`], {
      stdio: "ignore",
    });
  } catch (err) {
    // Rejected non-fast-forward, rejected lease, or the ref moved/vanished under the lease —
    // git's exit code is the whole signal here, and every one of those cases means the same
    // thing to this caller: refuse, touch nothing else, let the caller decide what's next.
    throw new LanePushForeignHeadError(
      `refused to push ${branch}: the branch is no longer at the believed head ${headSha} ` +
        `(a concurrent writer moved or removed it) — nothing was pushed`,
      branch,
      headSha,
      { cause: err },
    );
  }
  // THE ELISION CHECK (see the doc comment above): trust the ref's ACTUAL resulting value,
  // never the exit code alone.
  const observed = capture("git", ["-C", repoDir, "ls-remote", "origin", ref]).trim().split(/\s+/)[0];
  if (observed !== newSha) {
    throw new LanePushForeignHeadError(
      `push to ${branch} reported success but the remote ref reads ${observed ? observed : "<absent>"}, ` +
        `not the pushed ${newSha} — a lease git elided rather than checked; treating this as a refusal`,
      branch,
      headSha,
    );
  }
  return newSha;
}
