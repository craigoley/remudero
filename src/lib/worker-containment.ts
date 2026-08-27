/**
 * lib/worker-containment.ts — W1-T117: worker process-tree containment.
 *
 * LIVE FINDING this closes (plan/tasks.yaml W1-T117 rationale): orphaned PID
 * 87119 — a `gh pr create --fill --base main` armed with a sleep-until-
 * exact-quota-reset, spawned from a worker's shell snapshot — was discovered
 * AFTER its run had already ended. worker.ts spawned the Claude Code CLI via
 * the Agent SDK's default local spawn, and neither worker.ts nor daemon.ts
 * contained any process-group, session, or teardown-kill logic: a background
 * process the CLI itself spawns (e.g. a Bash-tool `cmd &`) had no mechanism
 * bounding WHEN its effects stop, only what it touches WHILE the run is live.
 *
 * VERIFIED GROUND TRUTH (SDK 0.3.217, `node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts,sdk.mjs}`
 * — this task's own flagged "first question", distrust-the-prompt Standing
 * rule 7): `Options.spawnClaudeCodeProcess` is the SDK's injected
 * process-spawn surface. When supplied it REPLACES the SDK's default local
 * spawn (`ProcessTransport.spawnLocalProcess`) entirely; the SDK reads only
 * `.stdin`/`.stdout` off whatever it returns (`this.processStdin =
 * this.process.stdin; this.processStdout = this.process.stdout` — sdk.mjs)
 * and — CRITICALLY — never touches `.stderr`: that wiring
 * (`s.stderr.on("data", ...this.options.stderr?.(y))`) lives ONLY inside the
 * SDK's own default `spawnLocalProcess`, so a custom spawn that does not
 * independently pipe stderr into the caller's own sink silently blacks out
 * the WS-0 billing-boundary stderr proof. `spawnDetachedGroup` below pipes it
 * itself for exactly that reason. A real Node `ChildProcess` already
 * satisfies the SDK's `SpawnedProcess` interface (sdk.d.ts's own doc comment:
 * "ChildProcess already satisfies this interface"), so this wraps
 * `node:child_process.spawn` directly rather than hand-rolling a shim.
 *
 * `detached: true` (POSIX; Node docs) makes the spawned child BOTH a new
 * process-group leader AND a new session leader — equivalent to calling
 * `setsid()` — so its own pid becomes its pgid and `process.kill(-pid, sig)`
 * reaches the whole group with one signal. This covers the incident's actual
 * shape: a `bash -c` background job (`cmd &`) run non-interactively has no
 * job control, so it stays in the PARENT's process group rather than forking
 * into a new one — see `test/worker-containment.test.ts`'s fixture, which
 * spawns exactly that shape and proves group-kill reaches it.
 *
 * BLAST RADIUS (design part iv): every kill in this module is either (a) a
 * process-GROUP signal scoped to a pgid THIS module itself created via
 * `spawnDetachedGroup` (teardown path — never reaches the daemon, a sibling
 * run, or the operator's shell, because those live in different groups by
 * construction), or (b) gated behind an explicit attribution match in
 * `sweepOrphanWorkers` (orphan-sweep path) — an unattributable process is
 * reported, never signalled, no matter how suspicious it looks.
 */
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { SpawnedProcess as SdkSpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

/** Env var names carrying run/task attribution into a spawned worker's
 * child process — inherited automatically by every descendant that does not
 * explicitly strip its env (the same propagation that let the incident's
 * `gh pr create` bomb survive: env flows downhill through `bash -c` by
 * default), which is exactly what makes them a reliable orphan-sweep marker. */
export const RUN_ID_ENV = "REMUDERO_RUN_ID";
export const TASK_ID_ENV = "REMUDERO_TASK_ID";

/** Structural mirror of the SDK's own `SpawnOptions` (sdk.d.ts) — kept local
 *  (rather than imported) so this module's PUBLIC signature never depends on
 *  the SDK package's own type surface staying byte-identical release to
 *  release; a real call site (worker.ts) still receives the SDK's own value,
 *  which is structurally assignable here. */
export interface ContainedSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** One spawned, contained process: the SDK-facing handle plus its own pid
 *  (== pgid under `detached: true` — the attribute teardown/sweep key off). */
export interface ContainedProcess {
  process: SdkSpawnedProcess;
  pid: number;
}

/** Longest args excerpt {@link describeSpawnTarget} will put on a throw. The
 *  worker's prompt travels over STDIN, not argv, so argv here is CLI flags and
 *  is normally far shorter — the cap exists so a future caller that does pass
 *  something large cannot turn one failed spawn into a multi-megabyte ledger
 *  row, not because anything today approaches it. */
export const SPAWN_TARGET_ARGS_EXCERPT_MAX = 240;

/**
 * The SYNCHRONOUS half of a no-pid diagnosis: everything that IS in hand at
 * throw time, in one line fit for an error message.
 *
 * `exists`/`executable` are probed LIVE against `command` rather than trusted
 * from whatever resolved it, because the gap between "resolved once, minutes or
 * hours ago" and "exists now" is precisely the failure this is meant to make
 * legible — a per-process memo of a path that has since been swapped out is
 * indistinguishable, on the evidence the ledger used to carry, from a transient
 * resource exhaustion.
 *
 * `opts.env` IS DELIBERATELY ABSENT AND MUST STAY ABSENT: it is the billing
 * boundary and carries credentials. Only command, args and cwd are named.
 */
export function describeSpawnTarget(opts: ContainedSpawnOptions): string {
  const args = opts.args.join(" ");
  const argsExcerpt =
    args.length > SPAWN_TARGET_ARGS_EXCERPT_MAX ? `${args.slice(0, SPAWN_TARGET_ARGS_EXCERPT_MAX)}…` : args;
  return [
    `command=${opts.command}`,
    `exists=${commandExists(opts.command)}`,
    `executable=${commandExecutable(opts.command)}`,
    `cwd=${opts.cwd ?? "<inherited>"}`,
    `args=[${argsExcerpt}]`,
  ].join(" ");
}

/** Does `command` exist on disk right now? A bare name (resolved via PATH by
 *  the OS, never by us) is reported `unresolved` rather than a misleading
 *  `false` — W1-T119: a probe that could not look is not a probe that said no. */
export function commandExists(command: string): string {
  if (!command.includes("/")) return "unresolved";
  // No try/catch: `existsSync` answers false rather than throwing, even for an
  // unrepresentable path (verified against a NUL-bearing string). A catch arm
  // here would be dead code that no falsifier could redden.
  return String(existsSync(command));
}

/** Is `command` executable by this process right now? Same `unresolved`
 *  discipline as {@link commandExists} for a bare, PATH-resolved name. */
export function commandExecutable(command: string): string {
  if (!command.includes("/")) return "unresolved";
  try {
    accessSync(command, fsConstants.X_OK);
    return "true";
  } catch {
    return "false";
  }
}

/**
 * Spawn `opts.command` DETACHED into its own process group/session (see file
 * header) and pipe its stderr into `onStderr` — replicating the SDK's own
 * default-spawn stderr wiring, which a custom `spawnClaudeCodeProcess` does
 * not get for free. Returns the real `ChildProcess` (already
 * `SpawnedProcess`-shaped, per the SDK's own doc comment) plus its pid.
 *
 * `onSpawnError` is the ASYNCHRONOUS half of the W1-T442 diagnosis and is
 * appended LAST so no positional caller shifts. It is optional, and an omitting
 * caller behaves exactly as before this existed.
 */
export function spawnDetachedGroup(
  opts: ContainedSpawnOptions,
  onStderr?: (chunk: string) => void,
  onSpawnError?: (err: NodeJS.ErrnoException) => void,
): ContainedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A no-pid spawn (below) still fires its 'error' event ASYNCHRONOUSLY after
  // this function has already thrown — with no listener attached, Node
  // treats that as an uncaught exception (crashing the caller's process)
  // rather than the ordinary, already-surfaced failure it is. Attached
  // UNCONDITIONALLY, before the pid check, so this holds on every path.
  //
  // W1-T442: it now takes the ERROR OBJECT rather than dropping it. The errno
  // that explains the failure (ENOENT / EAGAIN / EMFILE / EACCES) arrives ONLY
  // here — the throw below cannot carry it, because this event fires after the
  // throw has already unwound. A sink that throws is swallowed: a diagnostic
  // must never become the crash it exists to explain, and re-throwing from an
  // 'error' listener is an uncaught exception by another name.
  child.on("error", (err: NodeJS.ErrnoException) => {
    try {
      onSpawnError?.(err);
    } catch {
      /* a diagnostic sink must never become the crash it exists to explain */
    }
  });
  if (onStderr) {
    child.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
  }
  if (typeof child.pid !== "number") {
    // Synchronous spawn failure (e.g. a bad cwd) — the SDK's own default
    // spawn surfaces the same class of failure via the child's 'error'
    // event instead; without a pid there is nothing for teardown to track,
    // so this fails loud immediately rather than handing back an untracked
    // handle.
    //
    // W1-T442: what IS in hand synchronously goes on the message. The live
    // exists/executable probe is one `stat` and it is the DECISIVE bit: a
    // command that has VANISHED separates a stale resolved path from a
    // transient resource failure (EAGAIN/EMFILE), which is exactly the
    // distinction two events ten hours apart could not be read for. NEVER
    // `opts.env` — that is the billing boundary and carries credentials.
    throw new Error(`spawnDetachedGroup: child process has no pid (spawn failed synchronously) — ${describeSpawnTarget(opts)}`);
  }
  // `stdio: ["pipe","pipe","pipe"]` above GUARANTEES stdin/stdout/stderr are
  // real streams, never null (null only happens for "inherit"/"ignore"/an fd
  // spec, none of which are used here) — the cast covers TS's conservative
  // `ChildProcess.stdin: Writable | null` typing, which does not narrow off
  // the literal `stdio` tuple. The SDK's own doc comment on `SpawnedProcess`
  // states "ChildProcess already satisfies this interface".
  return { process: child as unknown as SdkSpawnedProcess, pid: child.pid };
}

/**
 * Best-effort SIGKILL to the whole process group (negative pid — POSIX
 * `kill(2)` semantics). Already-dead (ESRCH — the group exited on its own
 * before teardown ran) is treated as success, never thrown: teardown must
 * never crash a run's own success/error handling over a group that is
 * already gone.
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") throw err;
  }
}

/** `process.kill(pid, 0)` liveness probe, wrapped — true iff `pid` still
 *  answers. `ESRCH` ("no such process") is the only CONFIRMED absence;
 *  `EPERM` ("process exists, no permission to signal it") is still alive,
 *  just not ours to signal — everything else is treated conservatively as
 *  "still there" rather than guessed dead. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function defaultPsGroupListing(): string {
  return execFileSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8" });
}

/**
 * List the live member pids of process group `pgid` (a real `ps` scan over
 * `pid=,pgid=,stat=` columns — POSIX-portable across macOS/Linux, no `/proc`
 * dependency). Injectable via `listFn` for tests. Best-effort: a `ps`
 * failure (e.g. a sandboxed environment with no `ps`) reports an EMPTY list
 * rather than throwing — the caller degrades to "kill sent, survivors
 * unknown ⇒ assumed none" rather than crashing the run's own teardown.
 *
 * A ZOMBIE (`stat` starting `Z`) is deliberately EXCLUDED, not counted as a
 * survivor: its own parent already reaped its exit status at the kernel
 * level — it holds nothing but a process-table slot pending a `wait()` its
 * parent (this Node process, for the group's own leader) has not yet gotten
 * an event-loop tick to perform, cannot execute any code, and answers no
 * further signal. Observed empirically as a source of test flake: a
 * `SIGKILL`ed leader can still show up in `ps` as `Z` for a few ms.
 */
export function listProcessGroupMembers(pgid: number, listFn: () => string = defaultPsGroupListing): number[] {
  let out: string;
  try {
    out = listFn();
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const line of out.split("\n")) {
    const [pidStr, pgidStr, stat] = line.trim().split(/\s+/);
    const pid = Number(pidStr);
    const rowPgid = Number(pgidStr);
    if (stat?.startsWith("Z")) continue;
    if (Number.isFinite(pid) && Number.isFinite(rowPgid) && rowPgid === pgid) members.push(pid);
  }
  return members;
}

/**
 * Kill-and-verify bundled: sends SIGKILL to the group, then re-scans for any
 * still-live member. Returns the survivor list (empty ⇒ clean teardown) —
 * this function never throws over a nonempty result; a caller that cares
 * (e.g. a test asserting containment) reads the returned list itself.
 */
export function teardownProcessGroup(
  pgid: number,
  deps: { kill?: (pgid: number, signal?: NodeJS.Signals) => void; list?: () => string } = {},
): { survivors: number[] } {
  const kill = deps.kill ?? killProcessGroup;
  kill(pgid);
  const survivors = listProcessGroupMembers(pgid, deps.list);
  return { survivors };
}

/**
 * Build the child env carrying the attribution markers (see `RUN_ID_ENV`/
 * `TASK_ID_ENV`, above) — extracted as its OWN pure function (worker.ts's
 * established discipline: small, directly-testable pieces around the
 * SDK-spawn boundary, e.g. `workerKeychainGrantApps`, `cacheTokenLedgerFields`)
 * so the merge logic is provable without invoking `spawnWorker` itself, which
 * cannot be unit-tested past its real `query()` call. Either id absent ⇒ that
 * key is simply omitted, never written as `"undefined"`.
 */
export function workerMarkerEnv(runId?: string, taskId?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (runId) env[RUN_ID_ENV] = runId;
  if (taskId) env[TASK_ID_ENV] = taskId;
  return env;
}

/**
 * Build the `Options.spawnClaudeCodeProcess` closure `spawnWorker` installs:
 * delegates to `spawnContained` (real: `spawnDetachedGroup`; test: a fake),
 * routes its stderr into `onStderr` (the SAME sink `collectWorkerResult`'s
 * `stderrChunks` reads — see the file header's stderr note), and records the
 * resulting pid into `pidRef` for `withWorkerGroupTeardown` to tear down
 * later. Extracted so this wiring is directly unit-testable with a FAKE
 * `spawnContained` — `spawnWorker` itself cannot be unit-tested past its real
 * `query()` call (every existing spawnWorker test throws before reaching it).
 */
export function buildContainedSpawnFn(
  spawnContained: (
    opts: ContainedSpawnOptions,
    onStderr?: (chunk: string) => void,
    onSpawnError?: (err: NodeJS.ErrnoException) => void,
  ) => ContainedProcess,
  onStderr: (chunk: string) => void,
  pidRef: { pid?: number },
  onSpawnError?: (err: NodeJS.ErrnoException) => void,
): (spawnOpts: ContainedSpawnOptions) => SdkSpawnedProcess {
  return (spawnOpts) => {
    const spawned = spawnContained(spawnOpts, onStderr, onSpawnError);
    pidRef.pid = spawned.pid;
    return spawned.process;
  };
}

/**
 * Run `run()` (the SDK message-stream collection, in worker.ts's real call
 * site) with a GUARANTEED process-group teardown afterward, on EITHER path —
 * success or a thrown error (W1-T117 acceptance: "no worker child survives
 * run teardown, on any verdict path"). `pidRef.pid` is populated by the
 * caller's own `spawnClaudeCodeProcess` closure once the SDK actually spawns
 * (lazily, on the returned async iterable's first pull) — a `finally` with
 * no pid recorded (the real spawn never ran, e.g. an earlier guard threw
 * first) is a correct no-op, never an error.
 */
export async function withWorkerGroupTeardown<T>(
  pidRef: { pid?: number },
  run: () => Promise<T>,
  teardown: (pgid: number) => void = (pgid) => void teardownProcessGroup(pgid),
): Promise<T> {
  try {
    return await run();
  } finally {
    if (pidRef.pid !== undefined) teardown(pidRef.pid);
  }
}

// ── Orphan sweep (daemon boot + poll) ───────────────────────────────────────

/** One process the sweep considered a candidate — real: a live `ps` row. */
export interface OrphanCandidate {
  pid: number;
  cmdline: string;
}

/** Attribution extracted from a candidate's markers (see `RUN_ID_ENV`/`TASK_ID_ENV`). */
export interface OrphanMarkers {
  runId: string;
  taskId: string;
}

export interface OrphanSweepDeps {
  /** Candidate processes to consider (real: a live `ps` scan; test: seeded). */
  listCandidates: () => OrphanCandidate[];
  /**
   * Attribution: the markers `pid` carries, or `undefined` when unattributable
   * (real: best-effort env read off the live process; test: seeded per pid).
   * BLAST RADIUS (design part iv): `undefined` here means "never signalled",
   * no matter what else is true about the process — the sweep never guesses.
   */
  readMarkers: (pid: number) => OrphanMarkers | undefined;
  /**
   * True while `runId` is still tracked as in-flight. An attributable
   * process belonging to a STILL-ACTIVE run is left alone too — it is
   * legitimately running, not a stray from an ENDED run.
   */
  isRunActive: (runId: string) => boolean;
  /** Best-effort termination (real: `killProcessGroup`; test: a spy). */
  kill: (pid: number) => void;
  /** One ledger line per kill — `worker_orphan_killed` (design part ii). */
  ledger: (line: { run_id: string; task_id: string; pid: number; cmdline: string }) => void;
}

export interface OrphanSweepReport {
  killed: Array<{ pid: number; run_id: string; task_id: string; cmdline: string }>;
  leftAlone: Array<{ pid: number; reason: "unattributable" | "run_active" }>;
}

/**
 * Daemon boot + poll orphan sweep (W1-T117 design ii/iv): terminate stray
 * processes ATTRIBUTABLE to an ENDED run, ledger each; an UNATTRIBUTABLE
 * process is reported but NEVER signalled. Attribution precedes every
 * signal — a process only dies here when `readMarkers` names a run AND
 * `isRunActive` says that run is no longer tracked as in-flight.
 */
export function sweepOrphanWorkers(deps: OrphanSweepDeps): OrphanSweepReport {
  const killed: OrphanSweepReport["killed"] = [];
  const leftAlone: OrphanSweepReport["leftAlone"] = [];
  for (const candidate of deps.listCandidates()) {
    const markers = deps.readMarkers(candidate.pid);
    if (!markers) {
      leftAlone.push({ pid: candidate.pid, reason: "unattributable" });
      continue;
    }
    if (deps.isRunActive(markers.runId)) {
      leftAlone.push({ pid: candidate.pid, reason: "run_active" });
      continue;
    }
    deps.kill(candidate.pid);
    const line = { run_id: markers.runId, task_id: markers.taskId, pid: candidate.pid, cmdline: candidate.cmdline };
    killed.push(line);
    deps.ledger(line);
  }
  return { killed, leftAlone };
}

/**
 * W1-T2407: name the third party BY ITS COMMAND LINE, from data the sweep already computed.
 *
 * THE GAP THIS CLOSES (plan/tasks.yaml W1-T2407 design part ii). `sweepOrphanWorkers`'s report
 * already carries `cmdline` for every process it killed — nothing new is fetched and nothing new
 * is signalled here. When the wiring assertion in test/{daemon,worker-containment}.test.ts's
 * "W1-T356 wiring" tests fails because a THIRD fixture's stray was misattributed and killed
 * instead of the one under test, this turns that failure from "a pid disappeared, cause unknown"
 * into a printed line naming exactly which process died and what it was running — read straight
 * off `report.killed`, never re-derived.
 *
 * `report.killed.length === 0` still returns an EXPLICIT, non-empty string rather than `""`: a
 * sweep that killed nothing must be legible as "read and empty", not indistinguishable from a
 * diagnostic nobody called. Synchronous and pure — no `ps`, no signal, no pacing, no `await`.
 */
export function describeOrphanSweepKills(report: Pick<OrphanSweepReport, "killed">): string {
  if (report.killed.length === 0) return "orphan sweep killed: (none)";
  const lines = report.killed.map(
    (k) => `  pid=${k.pid} run_id=${k.run_id} task_id=${k.task_id} cmdline=${k.cmdline}`,
  );
  return [`orphan sweep killed ${report.killed.length} process(es):`, ...lines].join("\n");
}

/**
 * Real-world candidate listing: every live pid + its command line (`ps -eo
 * pid=,command=`). Best-effort — a `ps` failure yields an empty list rather
 * than throwing, so a sweep hiccup costs one skipped cycle, never the
 * daemon's liveness (same discipline as `deps.sweep`'s own try/catch in
 * daemon.ts).
 */
export function defaultListCandidates(): OrphanCandidate[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows: OrphanCandidate[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), cmdline: m[2] });
  }
  return rows;
}

/**
 * Real-world marker read: parses `ps eww -o command= -p <pid>` output for
 * `KEY=value` tokens matching the marker env names — macOS/Linux `ps eww`
 * appends a process's environment after its argv for processes the caller
 * owns. A process this cannot introspect (permission, already exited, or
 * genuinely marker-less) yields `undefined`, the safe never-guess default
 * the blast-radius rule requires — this is deliberately NOT a fail-open
 * "assume attributable" default.
 */
export function defaultReadMarkers(pid: number): OrphanMarkers | undefined {
  let out: string;
  try {
    out = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return undefined;
  }
  const runId = out.match(new RegExp(`(?:^|\\s)${RUN_ID_ENV}=(\\S+)`))?.[1];
  const taskId = out.match(new RegExp(`(?:^|\\s)${TASK_ID_ENV}=(\\S+)`))?.[1];
  return runId && taskId ? { runId, taskId } : undefined;
}
