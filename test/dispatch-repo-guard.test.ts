import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepoName, taskTargetsRepo, runnableCandidates, tallyDispatchFilters } from "../src/lib/drain.js";
import { IDLE_REASON_ORDER } from "../src/lib/idle-reasons-panel.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { DispatchFilterReason } from "../src/lib/drain.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// ── W1-T988: THE DISPATCHER NEVER READ WHICH REPO A TASK BELONGS TO ─────────────────────────
//
// MEASURED at origin/main: `src/lib/drain.ts` and `src/lib/daemon.ts` read a task's `repo` ZERO
// times, against controls of 75 and 38 id reads in the same modules. Yet `repo` is required and
// validated on every task (`plan.ts`'s `req(e.repo, "repo", id)`), and the plan already carries a
// foreign one: 1321 `remudero`, 1 `remudero-site`, 1 `none`.
//
// THE FAILURE IS A PLAUSIBLE-LOOKING PULL REQUEST, NOT AN ERROR. A `remudero-site` task handed to
// a worker whose worktree is a `remudero` checkout edits the wrong tree and opens a PR against the
// wrong repository, with nothing on the path flagging it. The only reason it has not happened is
// that the one such task carries `verify: human`, which parks it earlier — a property of that
// task, not a fence.
//
// ⚠ THIS IS A SAFETY GUARD ON A SINGLE-TARGET DAEMON. Not multi-repo support, not routing, and not
// the second checkout the architecture would need — that is a second daemon with its own
// `config.root`, and an operator's decision. Nothing below routes anything anywhere.

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", verify: "auto", status: "queued", depends_on: [], attempts: 0, ...over }) as unknown as Task;

const planOf = (tasks: Task[]): Plan => ({ tasks }) as unknown as Plan;
const neverMerged = () => false;

/** Run the real selector and collect every decline reason it reported. */
function dispatch(tasks: Task[], targetRepo?: string) {
  const filtered: Array<{ id: string; reason: DispatchFilterReason }> = [];
  const eligible = runnableCandidates(planOf(tasks), neverMerged as never, 100, {
    targetRepo,
    onFiltered: (t, reason) => filtered.push({ id: t.id, reason }),
  }).map((t) => t.id);
  return { eligible, filtered };
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T988: a matching task is eligible and a foreign repo task is refused in one run", () => {
  const { eligible, filtered } = dispatch(
    [task("W1-T1"), task("W12-T1", { repo: "remudero-site" }), task("W1-T2", { repo: "none" })],
    "remudero",
  );
  assert.deepEqual(eligible, ["W1-T1"], "only the task belonging to this daemon's repo is dispatchable");
  assert.deepEqual(
    filtered.filter((f) => f.reason === "foreign-repo").map((f) => f.id).sort(),
    ["W12-T1", "W1-T2"].sort(),
    "and both foreign tasks are declined by name, in the same run",
  );
});

test("W1-T988: with NO target the guard does not fire at all — never refuse-all", () => {
  // Every existing caller (runnableCandidates, the panel, every test that builds opts by hand)
  // omits `targetRepo`. A guard that defaults to refusing is the shape that stops the fleet.
  const { eligible, filtered } = dispatch([task("W1-T1"), task("W12-T1", { repo: "remudero-site" })]);
  assert.deepEqual(eligible.sort(), ["W12-T1", "W1-T1"].sort(), "both stay eligible");
  assert.equal(filtered.filter((f) => f.reason === "foreign-repo").length, 0, "and nothing is declined for repo");
  // An empty-string target is the same case, not a target that matches nothing.
  assert.equal(dispatch([task("W12-T1", { repo: "remudero-site" })], "").eligible.length, 1);
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T988: an owner slug spelling still matches a daemon targeting the bare name", () => {
  // `resolveDaemonTarget`'s own doc documents `--repo owner/name` as an accepted input, so a guard
  // comparing raw strings would strand EVERY task the moment an operator passed that form.
  assert.equal(dispatch([task("W1-T1")], "craigoley/remudero").eligible.length, 1, "slug target, bare task");
  assert.equal(dispatch([task("W1-T1", { repo: "craigoley/remudero" })], "remudero").eligible.length, 1, "bare target, slug task");
  assert.equal(dispatch([task("W1-T1", { repo: "craigoley/remudero" })], "craigoley/remudero").eligible.length, 1, "both slug");
  // NEGATIVE CONTROL: normalising must not make DIFFERENT repos match.
  assert.equal(dispatch([task("W1-T1", { repo: "craigoley/remudero-site" })], "craigoley/remudero").eligible.length, 0);
});

test("W1-T988: normalizeRepoName reduces a slug to its bare last segment, never the reverse", () => {
  assert.equal(normalizeRepoName("remudero"), "remudero");
  assert.equal(normalizeRepoName("craigoley/remudero"), "remudero");
  assert.equal(normalizeRepoName("  craigoley/remudero/  "), "remudero", "trailing slashes and padding are not identity");
  assert.equal(normalizeRepoName("Craigoley/Remudero"), "remudero", "case is not identity either");
  // A task never carries an owner to compare against, so expanding the bare side would have to
  // invent one — the normaliser only ever reduces.
  assert.notEqual(normalizeRepoName("remudero"), "craigoley/remudero");
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T988: the self target consent flag is unaffected by the repo guard", () => {
  // `--allow-self-target` lives in src/lib/launchd.ts and gates the daemon targeting its OWN repo.
  // `DaemonTarget.isSelf` is a SEPARATE axis from "does this task belong to my target", and the
  // fleet runs with the flag — a guard that interacted with it would take the fleet down.
  const drain = readFileSync(join(REPO_ROOT, "src", "lib", "drain.ts"), "utf8");
  assert.ok(!/allow-self-target|isSelf/.test(drain), "the guard must not read the self-target axis at all");
  const launchd = readFileSync(join(REPO_ROOT, "src", "lib", "launchd.ts"), "utf8");
  assert.match(launchd, /allow-self-target/, "control: the flag really does live there, so this query can see its corpus");
  // And a self-targeted daemon dispatches its own repo's work exactly as before.
  assert.equal(dispatch([task("W1-T1")], "remudero").eligible.length, 1);
});

// ── criterion 4 ──────────────────────────────────────────────────────────────────────────────

test("W1-T988: a repo refusal marks nothing done and spends no strike", () => {
  const foreign = task("W12-T1", { repo: "remudero-site" });
  const before = JSON.stringify(foreign);
  const { filtered } = dispatch([foreign], "remudero");
  assert.equal(filtered.find((f) => f.id === "W12-T1")?.reason, "foreign-repo");
  // Exactly as inert as `verify-not-auto` is today: no status change, no attempts increment, no
  // retirement — so the task stays eligible for a differently-targeted daemon.
  assert.equal(JSON.stringify(foreign), before, "the task object is untouched");
  assert.equal(foreign.status, "queued");
  assert.equal(foreign.attempts, 0);
  assert.equal(dispatch([foreign], "remudero-site").eligible.length, 1, "and another daemon can still take it");
});

// ── criterion 5 ──────────────────────────────────────────────────────────────────────────────

test("W1-T988: the repo refusal is counted in the daemon idle reasons row", () => {
  const tally = tallyDispatchFilters();
  runnableCandidates(planOf([task("W1-T1"), task("W12-T1", { repo: "remudero-site" })]), neverMerged as never, 100, {
    targetRepo: "remudero",
    onFiltered: tally.onFiltered,
  });
  const snapshot = tally.snapshot();
  const bucket = snapshot["foreign-repo"];
  assert.equal(bucket.count, 1, "the snapshot the daemon.idle_reasons row carries must COUNT the refusal");
  assert.deepEqual(bucket.ids, ["W12-T1"], "and name which task it was");
  assert.equal(bucket.truncated, 0);
  // NEGATIVE CONTROL: the matching task is in no bucket at all — the tally is first-match, so a
  // count that swept up eligible tasks would be measuring something else.
  const total = Object.values(snapshot).reduce((n, b) => n + b.count, 0);
  assert.equal(total, 1, `exactly one decline across every bucket; got ${JSON.stringify(snapshot)}`);
});

test("W1-T988: the panel's own order is deliberately NOT extended, or every historical row breaks", () => {
  // The panel returns `kind: "unknown"` the moment any LISTED key is missing from a row, so adding
  // the new key to IDLE_REASON_ORDER would make EVERY historical row unreadable. The asymmetry is
  // load-bearing and already exists: `continued-this-pass` is in the union and not in this order.
  assert.ok(!(IDLE_REASON_ORDER as readonly string[]).includes("foreign-repo"), "the new reason must NOT be in the panel order");
  assert.ok(!(IDLE_REASON_ORDER as readonly string[]).includes("continued-this-pass"), "control: the precedent for that asymmetry is already here");
});

test("W1-T988: the daemon threads its target to the gate, and run-task threads it to the daemon", () => {
  // WITHOUT THIS THE WIRING IS UNPROVEN. Every test above drives `runnableCandidates` with an
  // explicit `targetRepo`; deleting the line in daemon.ts that supplies it from `deps` changed NO
  // test — the #339/W1-T281 shape, where a proof reads one end of a wire and passes on an unbuilt
  // one. Both hops are pinned here, each scoped to the construction that carries it.
  const daemon = readFileSync(join(REPO_ROOT, "src", "lib", "daemon.ts"), "utf8");
  const optsStart = daemon.indexOf("const dispatchOpts: NextRunnableOpts = {");
  assert.ok(optsStart >= 0, "control: the daemon really does build a NextRunnableOpts");
  const opts = daemon.slice(optsStart, daemon.indexOf("\n    };", optsStart));
  assert.match(opts, /targetRepo: deps\.targetRepo/, "the tick's opts must carry the daemon's own target");

  const runTask = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const callStart = runTask.indexOf("const summary = await runDaemonFn(");
  assert.ok(callStart >= 0, "control: run-task really does call runDaemon");
  const call = runTask.slice(callStart, callStart + 3000);
  assert.match(call, /targetRepo: target\.repo/, "and run-task must hand the resolved target down");
  // The SAME value the daemon already ledgers as `daemon.target`'s own `repo:` field — never a
  // second resolution that could drift from the one the row reports.
  assert.ok(!/targetRepo: [^t]/.test(call), "and it must come from `target`, not a re-derivation");
});

// ── criterion 6: scope ───────────────────────────────────────────────────────────────────────

test("W1-T988: this guard is not multi-repo support and does not route anything", () => {
  const drain = readFileSync(join(REPO_ROOT, "src", "lib", "drain.ts"), "utf8");
  // A builder who starts routing work to a second checkout, partitioning the ledger, or scoping
  // credentials has left this task. The guard only ever REFUSES.
  const start = drain.indexOf("export function taskTargetsRepo(");
  const body = drain.slice(start, drain.indexOf("\n}", start));
  assert.match(body, /return true;[\s\S]*return normalizeRepoName/, "the predicate only answers yes or no");
  assert.ok(!/worktree|checkout|clone|config\.root/.test(body), "and reaches for no second checkout");
});
