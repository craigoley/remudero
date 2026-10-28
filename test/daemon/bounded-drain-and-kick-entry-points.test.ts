// @census-reads: src/run-task.ts src/lib/drain.ts src/lib/daemon.ts src/cli/commands/daemon.ts src/lib/fleet-control.ts src/lib/panel-actions.ts src/lib/action-executor.ts src/lib/serve.ts src/lib/product-build.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { clearKick, consumeDrainNow, kickFilePath, pendingKicks, requestDrainNow, requestKick } from "#src/lib/fleet-control.js";

// @source-text-subject: W1-T10797 is a recon map. Its claim is WHERE each bounded-drain and kick entry
// point is called in production, and which side is caller and which is implementation. No behaviour of
// the verbs exposes a call site's location, so the map asserts on the source text. The marker-file
// handoff those call sites share is driven for real in the last test.
//
// Each row is keyed on the enclosing symbol and the call text, never on a line number: a line number
// moves on any insertion above it, and a row keyed that way goes stale with no change to the wiring.

type Role = "caller" | "implementation" | "consumer";

interface EntryPoint {
  /** What the row maps, in words. */
  readonly what: string;
  readonly role: Role;
  /** Repository-relative source file. */
  readonly file: string;
  /** Text that starts the enclosing region, and must appear in the file exactly once. */
  readonly from: string;
  /** Text that ends the region, the first occurrence after `from`. Defaults to the closing brace of a
   *  top-level declaration. */
  readonly to?: string;
  /** Call or wiring text that must appear inside the region. */
  readonly calls: readonly string[];
  /** The bounds and admission gates this site applies or hands on. */
  readonly bounds: string;
}

/** BOUNDED DRAIN. `runDrain` is the implementation, `drainCommand` (`rmd drain`) is its only production
 *  caller, and the daemon tick runs the same admission chain through `runnableCandidates`. */
const BOUNDED_DRAIN: readonly EntryPoint[] = [
  {
    what: "`rmd drain` in the CLI verb table, which loads the heavy verb and calls drainCommand",
    role: "caller",
    file: "src/run-task.ts",
    from: '    "drain",\n    async (rest) => {',
    to: "\n  ],",
    calls: ['await loadHeavyVerb("drain");', "return await drainCommand(rest);"],
    bounds: "none of its own; every bound is set by drainCommand",
  },
  {
    what: "drainCommand builds DrainOpts and calls runDrain through its deps seam",
    role: "caller",
    file: "src/run-task.ts",
    from: "async function drainCommand(",
    calls: [
      'unknownArgError("drain", rest, ["--until", "--max", "--repo", "--curated"]',
      "const drainMax = loadPolicy(policyPath(repoRoot)).values.drain.max;",
      "max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : drainMax,",
      "laneCount: DEFAULT_SWEEP_POLICY.dispatchLanes,",
      "wipLimit: DEFAULT_SWEEP_POLICY.wipLimit,",
      "applyCuratedSelection(baseOpts, curatedSelection)",
      "const runDrainFn = deps.runDrain ?? runDrain;",
      "await runDrainFn(",
    ],
    bounds: "--until, --max (default plan/policy.yaml drain.max), --curated, laneCount = sweep.dispatchLanes, wipLimit = sweep.wipLimit",
  },
  {
    what: "runDrain, the bounded loop, which hands a lane count of 2 or more to runDrainLanes",
    role: "implementation",
    file: "src/lib/drain.ts",
    from: "export async function runDrain(",
    calls: ["if ((opts.laneCount ?? 1) >= 2) return runDrainLanes(plan, deps, opts);", "const max = opts.max ?? DEFAULT_MAX;"],
    bounds: "max (DEFAULT_MAX), until, laneCount, wipLimit, headroom governor",
  },
  {
    what: "createNativeTargetJobRunner (W1-T10799) runs ONE bounded native job for a managed target through runDrain",
    role: "caller",
    file: "src/cli/commands/daemon.ts",
    from: "export function createNativeTargetJobRunner(",
    calls: ["(ctx.runDrain ?? runDrain)(plan, {", "return await runBoundedTargetJob(kick, jobDeps);"],
    bounds: "runBoundedTargetJob's curation: one task, depth 1, max 1, laneCount 1; the core daemon's own governors from its deps",
  },
  {
    what: "runBoundedTargetJob folds the one kicked task id into the drain's own curated selection",
    role: "implementation",
    file: "src/lib/daemon.ts",
    from: "export async function runBoundedTargetJob(",
    calls: ["applyCuratedSelection({ ...baseOpts, laneCount: 1, wipLimit: 1 }, { taskIds: [taskId], depth: 1 })"],
    bounds: "one task, depth 1, max 1, one lane; a closed job's origin never dispatches again",
  },
  {
    what: "the admission chain both nextRunnable and runnableCandidates select through",
    role: "implementation",
    file: "src/lib/drain.ts",
    from: "function dispatchEligibleCandidates(",
    calls: ["isDispatchEligible(plan, t, isMerged, opts)"],
    bounds: "isDispatchEligible: merged, verify not auto, blocked, unmet deps, foreign repo, credit indeterminate, held refusal, run branch pushed",
  },
  {
    what: "the daemon tick selects its batch through the same drain admission chain",
    role: "consumer",
    file: "src/lib/daemon.ts",
    from: "export async function runDaemon(",
    calls: ["const candidates = runnableCandidates(planForBatch, isMerged, budget, selection.opts);"],
    bounds: "laneDispatchBudget and wipLimit, through the same isDispatchEligible chain as rmd drain",
  },
];

/** KICK. `requestKick` writes a marker, `pendingKicks` reads it, and `clearKick` deletes it. Four
 *  production callers write a marker. The daemon alone admits and consumes it. `drain.ts` has no kick
 *  path. */
const KICK: readonly EntryPoint[] = [
  {
    what: "requestKick, the marker writer, which refuses an unsafe task id or repo",
    role: "implementation",
    file: "src/lib/fleet-control.ts",
    from: "export function requestKick(",
    calls: ["if (!isSafeTaskId(taskId)) throw", "if (repo !== undefined && !isSafeRepoName(repo)) throw"],
    bounds: "isSafeTaskId / isSafeRepoName, fail-closed at write",
  },
  {
    what: "armKick, the panel's kick arm, which writes the marker and ledgers console.kick_requested",
    role: "caller",
    file: "src/lib/panel-actions.ts",
    from: "export function armKick(",
    calls: ["requestKick(deps.root, taskId, origin);"],
    bounds: "none of its own; the daemon applies admission",
  },
  {
    what: "POST /v1/drain/kick, the console's per-row Run button",
    role: "caller",
    file: "src/lib/panel-actions.ts",
    from: "export function buildKickRoute(",
    calls: ['path: "/v1/drain/kick",', 'scope: "write",', 'tier: "high",', "armKick(deps, input.taskId, bearerTokenId(req));"],
    bounds: "write scope, high tier, validateTaskId",
  },
  {
    what: "the serve route assembly registers the kick and drain-now routes",
    role: "caller",
    file: "src/lib/serve.ts",
    from: "function assembleServeRoutes(",
    calls: ["buildKickRoute(fleetControlDeps),", "buildDrainNowRoute(fleetControlDeps),"],
    bounds: "the route table's own auth and tier checks",
  },
  {
    what: "the rmd.task.kick automation action, which runs armKick",
    role: "caller",
    file: "src/lib/action-executor.ts",
    from: '    capability: "rmd.task.kick",',
    to: "\n  },",
    calls: ['handler: "armKick",', 'approval: "human",', 'mode: "irreversible"', "armKick(paths, taskId, origin, link)"],
    bounds: "human approval, irreversible rollback",
  },
  {
    what: "escalation triage's rekick_once resolver",
    role: "caller",
    file: "src/run-task.ts",
    from: "        rekick_once: (e) => {",
    to: "        apply_default: (e) => {",
    calls: ["if (!task || !taskAwaitsAmendment(task)) throw", 'requestKick(config.root, e.taskId, "escalation-triage", repo);'],
    bounds: "task present in the plan and awaiting amendment",
  },
  {
    what: "ProductBuildService's default kick seam",
    role: "caller",
    file: "src/lib/product-build.ts",
    from: "export class ProductBuildService {",
    calls: ["this.kick = options.kick ?? ((root, taskId, origin, repo) => { requestKick(root, taskId, origin, repo); });"],
    bounds: "isSafeTaskId at the service boundary",
  },
  {
    what: "daemonKickPort binds pendingKicks and clearKick to the markers addressed to this daemon's repo",
    role: "consumer",
    file: "src/cli/commands/daemon.ts",
    from: "export function daemonKickPort(",
    calls: [
      "pendingKicks(root).filter((kick) => addressed(kick) && existsSync(kickFilePath(root, kick.taskId, kick.repo)))",
      "clearKick(root, taskId, repo);",
    ],
    bounds: "repo-scoped markers (W1-T10615), and only a marker whose exact file exists",
  },
  {
    what: "daemonCommand wires the kick port and drain-now into runDaemon",
    role: "consumer",
    file: "src/cli/commands/daemon.ts",
    from: "export async function daemonCommand(",
    calls: ["...daemonKickPort(config.root, target),", "consumeDrainNow: () => consumeDrainNow(config.root),"],
    bounds: "none of its own",
  },
  {
    what: "the runDaemon tick admits each kick, and clears it at refusal or at an accepted start",
    role: "consumer",
    file: "src/lib/daemon.ts",
    from: "export async function runDaemon(",
    calls: [
      "for (const kick of deps.pendingKicks()) {",
      'refuse("unknown task id")',
      'refuse("already merged — stale kick")',
      "if (deps.isCreditIndeterminate?.(kick.taskId)) {",
      "const openPr = deps.isOpenPr?.(kick.taskId);",
      "assertRunnable(planForBatch, task, mergedTask, tickReleases.ids);",
      'log("console.kick_dispatched"',
      "const drain = deps.consumeDrainNow();",
    ],
    bounds: "known task, not merged, credit readable (else held), no open PR, assertRunnable",
  },
];

const sources = new Map<string, string>();
function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(join(REPO_ROOT, ...file.split("/")), "utf8");
    sources.set(file, text);
  }
  return text;
}

function region(entry: EntryPoint): string {
  const text = source(entry.file);
  const start = text.indexOf(entry.from);
  assert.notEqual(start, -1, `${entry.file}: ${JSON.stringify(entry.from)} is present (${entry.what})`);
  assert.equal(text.indexOf(entry.from, start + 1), -1, `${entry.file}: ${JSON.stringify(entry.from)} anchors one place`);
  const end = text.indexOf(entry.to ?? "\n}\n", start + entry.from.length);
  assert.notEqual(end, -1, `${entry.file}: the region from ${JSON.stringify(entry.from)} closes`);
  return text.slice(start, end);
}

function assertMapped(entries: readonly EntryPoint[]): void {
  for (const entry of entries) {
    const body = region(entry);
    for (const call of entry.calls) {
      assert.ok(body.includes(call), `${entry.file} ${entry.role} (${entry.what}) contains ${JSON.stringify(call)}`);
    }
    assert.ok(entry.bounds.length > 0, `${entry.what} records its bounds`);
  }
}

test("W1-T10797: bounded drain and kick entry points are mapped to exact production call sites", () => {
  assertMapped(BOUNDED_DRAIN);
  assertMapped(KICK);

  for (const [name, entries] of [["bounded drain", BOUNDED_DRAIN], ["kick", KICK]] as const) {
    const roles = new Set(entries.map((e) => e.role));
    assert.ok(roles.has("caller") && roles.has("implementation"), `${name} has a caller row and an implementation row`);
  }

  // runDrain has TWO production callers: drainCommand, and (W1-T10799) the core daemon's bounded native job. Any other
  // caller must be added to the map.
  const runDrainCallers = ["src/run-task.ts", "src/lib/daemon.ts", "src/cli/commands/daemon.ts", "src/lib/serve.ts"]
    .filter((file) => /\brunDrain\b(?!Lanes|Fn)/.test(source(file).replace(/^\s*(?:\/\/|\*).*$/gm, "")));
  assert.deepEqual(runDrainCallers, ["src/run-task.ts", "src/cli/commands/daemon.ts"], "runDrain is called from run-task.ts and the bounded native job only");

  // drain.ts writes, reads and clears no kick. Only runDaemon services one.
  const drainCode = source("src/lib/drain.ts").replace(/^\s*(?:\/\/|\*).*$/gm, "");
  assert.doesNotMatch(drainCode, /requestKick|pendingKicks|clearKick/, "drain.ts has no kick path");
});

test("W1-T10797: a kick marker is written, read and cleared through the call sites the map names", (t) => {
  const root = ownedFixtureDir(t, "kick-entry-points").dir;

  const written = requestKick(root, "W1-T1", "test-origin");
  assert.equal(written.taskId, "W1-T1");
  assert.deepEqual(pendingKicks(root).map((k) => k.taskId), ["W1-T1"], "the marker the daemon reads is the one written");
  assert.equal(clearKick(root, "W1-T1"), true, "the daemon's clear removes it");
  assert.deepEqual(pendingKicks(root), [], "a cleared kick is gone");
  assert.equal(clearKick(root, "W1-T1"), false, "a second clear finds nothing");

  requestKick(root, "W1-T2", "test-origin", "other-repo");
  assert.match(kickFilePath(root, "W1-T2", "other-repo"), /other-repo/, "a repo-scoped marker names its repo");
  assert.deepEqual(pendingKicks(root).map((k) => [k.taskId, k.repo]), [["W1-T2", "other-repo"]]);

  assert.throws(() => requestKick(root, "../escape", "test-origin"), /unsafe task id/, "an unsafe id is refused at write");

  requestDrainNow(root, "test-origin");
  assert.equal(consumeDrainNow(root)?.origin, "test-origin", "drain-now is consumed once");
  assert.equal(consumeDrainNow(root), null, "and is gone after");
});
