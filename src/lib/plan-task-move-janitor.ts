/**
 * W1-T13681 — the daemon's move janitor: one `rmd move-task` step per converged tick.
 *
 * Each daemon iteration may start one tick, detached as the `plan-task-move` action, and none while one is in flight.
 * A tick reads, in order, and stands down at the first gate that is closed:
 *
 *   1. the switch: `move_public_tasks` in the host's plan-destination.json. Absent or false: nothing, no row.
 *      `dispatch_ops_tasks` off stands the tick down too, since a moved task would then never dispatch;
 *   2. both mains, pinned: the ref listings of both repositories and their head commits;
 *   3. the step this janitor opened last: until GitHub reads its pull request merged into the pinned main, or closed,
 *      nothing else runs (GitHub's search can lag a pull request just opened, so the mover's own WAIT is not enough);
 *   4. the mover's dry run at those heads (`movePlanTask` without --apply): WAIT, HELD, UNKNOWN or nothing to move
 *      stands down. A dry-run answer is kept until a ref of either repository moves, so a quiet pair of mains
 *      costs no repeated catalog read; an UNKNOWN answer is never kept;
 *   5. a converging step (REMOVE, ROLLBACK, RESTORE) runs even while the pick gates below are closed, so a
 *      stranded transient is repaired as soon as it can be. A new pick (COPY) also needs the daemon's ops dispatch
 *      unheld and the ops catalog read the claim path uses answering `ok`;
 *   6. the one effect: `movePlanTask --apply` at the same heads.
 *
 * No timer, interval or count: a closed gate reopens on the first tick after its condition clears, and the rate of
 * steps follows the merge latency of the two repositories. A stand-down writes one `plan.move.stand_down` row per
 * change of reason. The janitor acts on the remote catalogs through the mover, which only ever converges.
 * The public head read can fast-forward the code root's local origin/main tracking ref to the pinned head.
 *
 * W1-T14345: a step may carry a batch (the mover's preview fills it with open records, oldest filing first, as far as
 * the ops catalog's daily growth allows); the step row then names every task the step carried.
 */
import { createHash } from "node:crypto";
import { execFileRouted } from "./spawn-helper.js";
import { ghJsonAsync } from "./github-transport.js";
import { gitReservationRunnerAsync } from "./task-id-reservation.js";

export const PLAN_TASK_MOVE_ACTION = "plan-task-move";
export const PLAN_MOVE_STAND_DOWN = "plan.move.stand_down";
export const PLAN_MOVE_JANITOR_STEP = "plan.move.janitor_step";
/** BACKSTOP: a mover child that never answers is killed, so the in-flight guard frees; the next step converges. */
export const PLAN_TASK_MOVE_CHILD_TIMEOUT_MS = 30 * 60_000;

type Json = Record<string, unknown>;
export type Side = "public" | "ops";
/** One flag of the selection file, read with the canonical repository validation and changed-file refusal. */
export type PlanTaskMoveFlag = { outcome: "off" } | { outcome: "on"; repository: string; checkoutDir: string }
  | { outcome: "unavailable"; reason: string };
export interface PlanTaskMoveSwitch { move: PlanTaskMoveFlag; dispatch: PlanTaskMoveFlag }
export interface OpsTarget { repository: string; checkoutDir: string }
/** Both mains as one tick pins them; `key` changes whenever any ref of either repository moves. */
export interface MovePin { ops: OpsTarget; publicRepository: string; publicCommit: string; opsCommit: string; key: string }
export interface MoveRun { status: number; out: Json }
export type MoverPull = { state: "OPEN" } | { state: "CLOSED" } | { state: "MERGED"; mergeCommit: string };

export interface PlanTaskMovePorts {
  readSwitch(): PlanTaskMoveSwitch;
  /** The outcome of the ops catalog read the claim path uses (`ok`, `ref_moved`, `stale`, ...); undefined: none yet. */
  readOpsCatalog(): string | undefined;
  readHeads(ops: OpsTarget): Promise<MovePin>;
  /** movePlanTask at the pinned heads; `apply` false is the dry run. The janitor's only write to either remote. */
  move(pin: MovePin, apply: boolean): Promise<MoveRun>;
  /** A direct read of one pull request (never a search), so one just opened is never missed. */
  readPull(pin: MovePin, side: Side, number: number): Promise<MoverPull>;
  /** Is `commit` on the pinned main of that side? */
  onMain(pin: MovePin, side: Side, commit: string): Promise<boolean>;
}

/** What a janitor keeps between ticks in one daemon process. */
export interface PlanTaskMoveMemory {
  standDown?: string;
  lastStep?: { side: Side; number: number };
  answer?: { key: string; run: MoveRun };
}
export interface PlanTaskMover { ports: PlanTaskMovePorts; memory: PlanTaskMoveMemory }
export interface PlanTaskMoveTickInputs {
  /** The daemon's own ops dispatch hold this iteration, or undefined while ops dispatch is not held. */
  opsDispatchHold: string | undefined;
  log: (step: string, fields: Json) => void;
}
export type PlanTaskMoveTickOutcome = { outcome: "off" } | { outcome: "stand_down"; reason: string; detail?: string }
  | { outcome: "step"; step: string };

const CONVERGING = new Set(["remove", "rollback", "restore"]);
/** Answers that change only when a ref moves; an UNKNOWN answer (an API blip, a moved head) is read again next tick. */
const KEPT = new Set(["wait", "held", "none", "complete", "copy"]);
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
/** The failure a stand-down names: a one-token message (a port's own code, an errno, a status) as it is, else the
 *  error's class, so a message that varies per call never writes a new row per tick. */
const failureOf = (error: unknown): string => error instanceof Error ? (/^[\w.-]{1,64}$/.test(error.message) ? error.message : error.name) : typeof error;

export function createPlanTaskMover(ports: PlanTaskMovePorts): PlanTaskMover {
  return { ports, memory: {} };
}

/** Has the step this janitor opened last landed on its main? Anything but `landed` or `closed` holds every step. */
async function lastStepState(ports: PlanTaskMovePorts, pin: MovePin, last: { side: Side; number: number }): Promise<{ state: string; detail?: string }> {
  let pull: MoverPull;
  try { pull = await ports.readPull(pin, last.side, last.number); }
  catch (error) { const failed = failureOf(error); return { state: "last_step_unreadable", detail: failed }; }
  if (pull.state === "OPEN") return { state: "mover_pull_request_open" };
  if (pull.state === "CLOSED") return { state: "closed" };
  try { return { state: await ports.onMain(pin, last.side, pull.mergeCommit) ? "landed" : "last_step_unverified" }; }
  catch (error) { const failed = failureOf(error); return { state: "last_step_unreadable", detail: failed }; }
}

/** One tick. It never throws: any failure is a stand-down, and the next tick reads everything again. */
export async function runPlanTaskMoveTick(inputs: PlanTaskMoveTickInputs, mover: PlanTaskMover): Promise<PlanTaskMoveTickOutcome> {
  const { ports, memory } = mover;
  const standDown = (reason: string, detail?: string): PlanTaskMoveTickOutcome => {
    const signature = JSON.stringify([reason, detail ?? null]);
    if (memory.standDown !== signature) {
      memory.standDown = signature;
      try { inputs.log(PLAN_MOVE_STAND_DOWN, { reason, ...(detail === undefined ? {} : { detail }) }); }
      catch (error) { void error; /* A row that cannot be written never takes a step. */ }
    }
    return { outcome: "stand_down", reason, ...(detail === undefined ? {} : { detail }) };
  };
  try {
    const sw = ports.readSwitch();
    if (sw.move.outcome === "off") { memory.standDown = undefined; return { outcome: "off" }; }
    if (sw.move.outcome === "unavailable") return standDown("move_switch_unavailable", sw.move.reason);
    if (sw.dispatch.outcome === "off") return standDown("ops_dispatch_off");
    if (sw.dispatch.outcome === "unavailable") return standDown("ops_dispatch_unavailable", sw.dispatch.reason);
    if (sw.dispatch.repository !== sw.move.repository) return standDown("move_switch_unavailable", "selection_changed");
    let pin: MovePin;
    try { pin = await ports.readHeads({ repository: sw.move.repository, checkoutDir: sw.move.checkoutDir }); }
    catch (error) { const failed = failureOf(error); return standDown("heads_unreadable", failed); }
    if (memory.lastStep) {
      const last = await lastStepState(ports, pin, memory.lastStep);
      if (last.state !== "landed" && last.state !== "closed") return standDown(last.state, last.detail);
      memory.lastStep = undefined;
      memory.answer = undefined;
    }
    let dry = memory.answer?.key === pin.key ? memory.answer.run : undefined;
    if (dry === undefined) {
      dry = await ports.move(pin, false);
      memory.answer = KEPT.has(String(dry.out.step)) ? { key: pin.key, run: dry } : undefined;
    }
    const step = text(dry.out.step) ?? "unknown";
    if (step === "wait") return standDown("mover_pull_request_open");
    if (step === "held") return standDown("move_held", text(dry.out.reason));
    if (step === "none" || step === "complete") return standDown("nothing_to_move");
    if (step !== "copy" && !CONVERGING.has(step)) return standDown("preview_unknown", text(dry.out.reason));
    if (step === "copy") {
      if (inputs.opsDispatchHold !== undefined) return standDown("ops_dispatch_held", inputs.opsDispatchHold);
      const catalog = ports.readOpsCatalog();
      if (catalog !== "ok") return standDown("ops_catalog_unavailable", catalog ?? "pending");
    }
    memory.answer = undefined;
    memory.standDown = undefined;
    const ran = await ports.move(pin, true);
    const repository = text(ran.out.repository);
    const opened = ran.out.applied === true && typeof ran.out.pullRequest === "number" && repository !== undefined;
    if (opened) memory.lastStep = { side: repository === pin.publicRepository ? "public" : "ops", number: ran.out.pullRequest as number };
    try {
      inputs.log(PLAN_MOVE_JANITOR_STEP, { move_step: text(ran.out.step) ?? null, applied: opened, task_id: text(ran.out.id) ?? null,
        ...(Array.isArray(ran.out.ids) ? { task_ids: ran.out.ids.map(String) } : {}),
        side: memory.lastStep?.side ?? null, pull_request: opened ? ran.out.pullRequest : null, exit: ran.status });
    } catch (error) { void error; /* The mover's own plan.move.step row is the record of the write. */ }
    if (!opened) return standDown("step_not_applied", text(ran.out.outcome) ?? text(ran.out.reason) ?? text(ran.out.step));
    return { outcome: "step", step: text(ran.out.step)! };
  } catch (error) {
    const failed = failureOf(error);
    return standDown("tick_failed", failed);
  }
}

/** The daemon's ops catalog feed, read for its outcome only: the private plan never reaches the janitor. */
export function opsCatalogOutcomeReader(feed: { forDispatch(): { outcome: string } | undefined } | undefined): () => string | undefined {
  return () => feed?.forDispatch()?.outcome;
}

type GitRunner = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
type RoutedExec = (file: string, args: readonly string[], options: { cwd?: string; encoding: "utf8"; timeout: number; killSignal: "SIGKILL"; maxBuffer: number }) =>
  Promise<{ stdout: string; stderr: string }>;
export interface PlanTaskMoveHost {
  publicRoot: string;
  publicRepository: string;
  readSwitch: () => PlanTaskMoveSwitch;
  readOpsCatalog: () => string | undefined;
  /** The rmd CLI entry the step runs in: its own process, so the catalog read never holds the daemon loop. */
  cliEntry: string;
  execArgv?: readonly string[];
  git?: (root: string) => GitRunner;
  exec?: RoutedExec;
  gh?: (args: string[]) => Promise<unknown>;
}

const url = (repository: string) => `https://github.com/${repository}.git`;
const TRACKING_REF = "refs/remotes/origin/main";

/** Fast-forward the code root's origin/main to `commit`, the head ls-remote named in `listing`, so the task-id gate's
 *  moved_from proof sees the commit the mover pins. Any doubt changes nothing: a missing or unreadable ref, a listing
 *  whose main is not that head, or a ref that is not an ancestor of it. update-ref with the old value refuses a ref
 *  that moved in between. */
async function advancePublicTrackingRef(run: GitRunner, commit: string, listing: string): Promise<"advanced" | "unchanged"> {
  if (/^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(listing)?.[1] !== commit) return "unchanged";
  const current = await run(["rev-parse", "--verify", "--quiet", `${TRACKING_REF}^{commit}`]);
  const old = current.stdout.trim();
  if (current.status !== 0 || !/^[0-9a-f]{40}$/.test(old) || old === commit) return "unchanged";
  if ((await run(["merge-base", "--is-ancestor", old, commit])).status !== 0) return "unchanged";
  return (await run(["update-ref", "-m", "plan-task-move: fast-forward to the live head", TRACKING_REF, commit, old])).status === 0 ? "advanced" : "unchanged";
}
/** The last JSON line a mover run printed; an unparsable answer reads as unknown, naming why. */
function lastLine(stdout: string): Json {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let value: unknown;
  try { value = JSON.parse(line); }
  catch (error) { const failed = failureOf(error); return { reason: "answer_unparsable", detail: failed }; }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : { reason: "answer_not_an_object" };
}

/** The host's ports: bounded git reads off the loop, GitHub's REST pull read, and the verb in its own process. */
export function planTaskMovePorts(host: PlanTaskMoveHost): PlanTaskMovePorts {
  const git = host.git ?? ((root: string) => gitReservationRunnerAsync(root));
  const exec: RoutedExec = host.exec ?? execFileRouted;
  const gh = host.gh ?? ((args: string[]) => ghJsonAsync(args));
  const head = async (root: string, repository: string): Promise<{ commit: string; listing: string }> => {
    const run = git(root);
    const listed = await run(["ls-remote", url(repository)]);
    const commit = /^([0-9a-f]{40})\tHEAD$/m.exec(listed.stdout)?.[1];
    if (listed.status !== 0 || commit === undefined) throw new Error("ls_remote_unreadable");
    // The mover reads its catalog at this commit from the local checkout: fetch its objects, and write no ref.
    if ((await run(["cat-file", "-e", `${commit}^{commit}`])).status !== 0) {
      await run(["fetch", "--quiet", "--no-write-fetch-head", url(repository), "HEAD"]);
      if ((await run(["cat-file", "-e", `${commit}^{commit}`])).status !== 0) throw new Error("head_unfetched");
    }
    return { commit, listing: listed.stdout };
  };
  const rootOf = (pin: MovePin, side: Side) => side === "public" ? host.publicRoot : pin.ops.checkoutDir;
  return {
    readSwitch: host.readSwitch,
    readOpsCatalog: host.readOpsCatalog,
    readHeads: async ops => {
      // Both sides settle before either refusal is raised, so no git read of this pin outlives the call.
      const [pubRead, opsRead] = await Promise.allSettled([head(host.publicRoot, host.publicRepository), head(ops.checkoutDir, ops.repository)]);
      if (pubRead.status === "rejected") throw pubRead.reason;
      if (opsRead.status === "rejected") throw opsRead.reason;
      const pub = pubRead.value, opsHead = opsRead.value;
      // The public side only: the gate reads the code root's origin/main. The ops side writes no ref.
      await advancePublicTrackingRef(git(host.publicRoot), pub.commit, pub.listing);
      const key = createHash("sha256").update(pub.listing).update("\0").update(opsHead.listing).digest("hex");
      return { ops, publicRepository: host.publicRepository, publicCommit: pub.commit, opsCommit: opsHead.commit, key };
    },
    move: async (pin, apply) => {
      const args = [...(host.execArgv ?? process.execArgv), host.cliEntry, "move-task",
        "--public-root", host.publicRoot, "--public-commit", pin.publicCommit, "--public-repo", pin.publicRepository,
        "--ops-root", pin.ops.checkoutDir, "--ops-commit", pin.opsCommit, "--ops-repo", pin.ops.repository, ...(apply ? ["--apply"] : [])];
      try {
        const out = await exec(process.execPath, args, { cwd: host.publicRoot, encoding: "utf8", timeout: PLAN_TASK_MOVE_CHILD_TIMEOUT_MS,
          killSignal: "SIGKILL", maxBuffer: 1 << 24 });
        return { status: 0, out: lastLine(out.stdout) };
      } catch (error) {
        // The verb exits 1 on unknown evidence or a failed write and still prints its one line: that line is the answer.
        const failed = error as { code?: unknown; stdout?: unknown };
        return { status: typeof failed.code === "number" ? failed.code : 1, out: lastLine(typeof failed.stdout === "string" ? failed.stdout : "") };
      }
    },
    readPull: async (pin, side, number) => {
      const row = await gh(["api", `repos/${side === "public" ? pin.publicRepository : pin.ops.repository}/pulls/${number}`]) as
        { state?: unknown; merged?: unknown; merge_commit_sha?: unknown } | null;
      if (row?.merged === true && typeof row.merge_commit_sha === "string") return { state: "MERGED", mergeCommit: row.merge_commit_sha };
      if (row?.state === "open") return { state: "OPEN" };
      if (row?.state === "closed" && row.merged === false) return { state: "CLOSED" };
      throw new Error("pull_request_unreadable");
    },
    onMain: async (pin, side, commit) => {
      const ancestor = await git(rootOf(pin, side))(["merge-base", "--is-ancestor", commit, side === "public" ? pin.publicCommit : pin.opsCommit]);
      if (ancestor.status === 0 || ancestor.status === 1) return ancestor.status === 0;
      throw new Error("ancestry_unreadable");
    },
  };
}
