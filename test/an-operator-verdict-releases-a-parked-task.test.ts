import { operatorReleasePin } from "#src/lib/operator-release.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";

import { RELEASE_LEDGER_STEP, assertRunnable, loadPlan, parseTasksFromYaml, releasedTaskIds as readReleasedTaskIds } from "#src/lib/plan.js";
import { nextRunnable, resolveReleasedIds, resolveReleases, runDrain } from "#src/lib/drain.js";
import { OPERATOR_RELEASES_FILE, readOperatorReleaseRecords } from "#src/lib/machine-filing-judge.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { composeSecondaryPlan, readReleasePublicPlan } from "#src/lib/task-lookup.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { readOriginMainSha } from "#src/lib/inbox.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { appendLedger } from "#src/lib/ledger.js";
import { writeDaemonTargetRecord } from "#src/lib/repo-location.js";
import { approveInChild, productionStuckStatePorts, opsRecordDigest, publicRecordDigest, runStuckStateGardener } from "#src/lib/stuck-state-gardener.js";
import { approveCommand, approveParkedTask, namesATask, stripRepoRootFlag } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T3206 — `verify: human` WAS A ONE-WAY PARK WITH NO RELEASE.
 *
 * MEASURED 2026-09-08: `isDispatchEligible` refuses it (drain.ts:418), `assertRunnable` throws
 * (plan.ts), and a grep across `src/` for any approve/release/unblock path keyed on `verify: human`
 * returned ZERO matches. 45 such shards were queued, the oldest filed 2026-07-21 — seven weeks.
 *
 * The release is NOT a plan edit: it is the `ratify.approved` row `rmd approve` already writes when
 * an operator spends his bit, so the plan record stays byte-identical and no worker rewrites a
 * `verify:` field (which Standing rule 15 forbids anyway).
 */

const row = (o: Record<string, unknown>) => JSON.stringify({
  ...(o.step === RELEASE_LEDGER_STEP && typeof o.task_id === "string" && o.task_id
    ? { release_pin: operatorReleasePin(parked(o.task_id) as never) } : {}), ...o,
});
const releasedTaskIds = (lines: readonly string[]) => readReleasedTaskIds(lines, planOf([parked("W1-T1041"), parked("W1-T2983")]));

test("W1-T3206: a ratify.approved row releases exactly the task it names", () => {
  const ids = releasedTaskIds([
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" }),
    row({ step: "sweep.disposed", task_id: "W1-T9999" }),
  ]);
  assert.deepEqual([...ids], ["W1-T1041"]);
});

test("W1-T3206: no release rows means NO releases — the wall still stands", () => {
  const ids = releasedTaskIds([row({ step: "sweep.disposed", task_id: "W1-T1041" })]);
  assert.equal(ids.size, 0);
});

test("W1-T3206: an unparseable line releases nothing rather than throwing — the safe direction", () => {
  const ids = releasedTaskIds([
    "{ this ratify.approved row is not json",
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T2983" }),
  ]);
  assert.deepEqual([...ids], ["W1-T2983"], "the good row still releases; the bad one is skipped");
});

test("W1-T3206: a row whose step merely CONTAINS the step name does not release", () => {
  // The reader cheap-rejects on substring before parsing; the parse must still be authoritative,
  // or a prose field mentioning the step name would release a task nobody ratified.
  const ids = releasedTaskIds([
    row({ step: "review.posted", task_id: "W1-T1041", note: "mentions ratify.approved in prose" }),
  ]);
  assert.equal(ids.size, 0);
});

test("W1-T3206: a release row with no task_id releases nothing", () => {
  assert.equal(releasedTaskIds([row({ step: RELEASE_LEDGER_STEP })]).size, 0);
  assert.equal(releasedTaskIds([row({ step: RELEASE_LEDGER_STEP, task_id: "" })]).size, 0);
});

test("W1-T3206 FALSIFIER: released and unreleased ids are DISTINGUISHED, not answered alike", () => {
  const ids = releasedTaskIds([row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]);
  assert.equal(ids.has("W1-T1041"), true, "the ratified one is released");
  assert.equal(ids.has("W1-T2983"), false, "an unratified sibling is NOT");
  // A reader that returned everything, or nothing, would fail exactly one of these two.
});

// ══ W1-T3216 — THE WRITER AND THE WIRING ═══════════════════════════════════════════════════════
//
// W1-T3206 shipped the READER and nothing else: on main before this task, `releasedTaskIds` had
// ZERO callers and `releasedIds` ZERO producers, so every assertion above passed against a feature
// no production path could reach. The suites below are the two halves that were missing, and the
// LAST one is the test whose absence let that ship.

const parked = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, repo: "remudero", type: "implement",
  verify: "human", status: "queued", depends_on: [], ...over,
});

/** A plan with a byId map — the only shape approveParkedTask and assertRunnable read. */
function planOf(tasks: Record<string, unknown>[]) {
  return { tasks, byId: new Map(tasks.map((t) => [t.id as string, t])) } as never;
}

const NEVER_MERGED = (() => false) as never;

test("W1-T3216: naming a parked task to approve writes exactly ONE ratify.approved row for it", () => {
  const written: [string, Record<string, unknown>][] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/nonexistent/ledger.jsonl",
    runId: "APPROVE-W1-T1041",
    ledgerLines: [],
    append: ((path: string, r: Record<string, unknown>) => void written.push([path, r])) as never,
  });
  assert.equal(out.code, 0);
  assert.equal(written.length, 1, "exactly one row — a release is one event");
  assert.equal(written[0]![1].step, RELEASE_LEDGER_STEP, "the SAME step a proposal ratification writes, never a second vocabulary");
  assert.equal(written[0]![1].task_id, "W1-T1041");
  assert.equal(written[0]![1].run_id, "APPROVE-W1-T1041", "clock-free: keyed on the task, so the row is findable by what it releases");
});

test("W1-T3216: every refusal names the state and writes NOTHING", () => {
  const cases: [string, Record<string, unknown>[], RegExp][] = [
    ["W1-T9999", [parked("W1-T1041")], /unknown task 'W1-T9999'/],
    ["W1-T1041", [parked("W1-T1041", { verify: "auto" })], /is verify:auto — it needs no release/],
    ["W1-T1041", [parked("W1-T1041", { status: "blocked" })], /is status:blocked/],
    ["W1-T1041", [parked("W1-T1041", { status: "retired" })], /is status:retired/],
  ];
  for (const [id, tasks, expected] of cases) {
    const written: unknown[] = [];
    const out = approveParkedTask(id, {
      plan: planOf(tasks), ledgerPath: "/x", runId: "R", ledgerLines: [],
      append: (() => void written.push(1)) as never,
    });
    assert.equal(out.code, 2, `${id} must be refused`);
    assert.match(out.message, expected, "the refusal NAMES the state — 'refused' alone is unactionable");
    assert.equal(written.length, 0, "a refusal writes nothing at all");
  }
});

test("W1-T3216: an ALREADY-released task returns 0 and writes no second row — a second bit is not a second release", () => {
  const written: unknown[] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/x", runId: "R",
    ledgerLines: [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })],
    append: (() => void written.push(1)) as never,
  });
  assert.equal(out.code, 0, "idempotent, not an error — the operator's intent is already recorded");
  assert.match(out.message, /already released — no second row written/);
  assert.equal(written.length, 0);
});

test("the final release writer refuses held tasks and machine high-risk releases", () => {
  const attempts: Array<{ task: ReturnType<typeof parked>; provenance: Record<string, unknown> }> = [
    { task: parked("W1-T216", { dispatch_hold: true, risk: "high" }), provenance: { author_class: "machine", released_by: "verify-human-judge" } },
    { task: parked("W1-T217", { risk: "high" }), provenance: { author_class: "machine", released_by: "verify-human-judge" } },
    { task: parked("W1-T218", { risk: "high" }), provenance: { released_by: "verify-human-judge" } },
  ];
  for (const { task, provenance } of attempts) {
    const written: unknown[] = [];
    const out = approveParkedTask(task.id, {
      plan: planOf([task]), ledgerPath: "/x", runId: "R", ledgerLines: [],
      provenance,
      append: (() => void written.push(1)) as never,
    });
    assert.equal(out.code, 2, task.id);
    assert.equal(written.length, 0, "the refusal must write no release receipt");
  }
  const humanHighRisk: unknown[] = [];
  const human = approveParkedTask("W1-T217", {
    plan: planOf([parked("W1-T217", { risk: "high" })]), ledgerPath: "/x", runId: "R", ledgerLines: [],
    append: (() => void humanHighRisk.push(1)) as never,
  });
  assert.equal(human.code, 0, "the plan risk does not erase the operator's authority");
  assert.equal(humanHighRisk.length, 1);
});

test("W1-T3216: the branch is chosen by SHAPE, so a proposal id still reaches the proposal path", () => {
  assert.equal(namesATask("W1-T1041"), true);
  assert.equal(namesATask("W2-T3a"), true);
  assert.equal(namesATask("P7"), false, "a proposal id must NOT take the task path");
  assert.equal(namesATask("P25"), false);
  assert.equal(namesATask(""), false);
  assert.equal(namesATask("W1-T"), false, "a malformed task-ish token is not a task id");
});

// ── THE WIRING: the half that was never built ─────────────────────────────────────────────────

test("W1-T3216: a released task is dispatch-eligible while an IDENTICAL unreleased one is refused", () => {
  const releasedIds = resolveReleasedIds({
    readLedgerLines: () => [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })],
  }, planOf([parked("W1-T1041")]));
  // Through nextRunnable, the REAL selector every dispatch path calls — not a direct poke at the
  // predicate. Testing the predicate alone is exactly what let the unwired version ship.
  assert.equal(nextRunnable(planOf([parked("W1-T1041")]), NEVER_MERGED, { releasedIds } as never)?.id, "W1-T1041", "the released task is SELECTED by the real drain");
  assert.equal(nextRunnable(planOf([parked("W1-T2222")]), NEVER_MERGED, { releasedIds } as never), undefined, "the IDENTICAL unreleased task is not — this is the discrimination the feature is FOR");
});

test("W1-T3216: assertRunnable admits the released task and still refuses the unreleased one", () => {
  const released = new Set(["W1-T1041"]);
  assert.doesNotThrow(() => assertRunnable(planOf([parked("W1-T1041")]), parked("W1-T1041") as never, NEVER_MERGED, released));
  assert.throws(
    () => assertRunnable(planOf([parked("W1-T2222")]), parked("W1-T2222") as never, NEVER_MERGED, released),
    /verify:human/,
    "the wall still stands for everything the operator did not name",
  );
});

test("W1-T216: a task-scoped hold outranks a daemon judge release at selection and direct admission", () => {
  const yaml = `- id: W1-T216
  title: Controlled security drill
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  status: queued
  dispatch_hold: true
`;
  const [held] = parseTasksFromYaml(yaml, "hold-fixture");
  assert.equal(held?.dispatch_hold, true, "the hold must survive YAML loading");
  assert.throws(() => parseTasksFromYaml(yaml.replace("dispatch_hold: true", 'dispatch_hold: "true"'), "bad-hold"), /dispatch_hold must be a boolean/);
  const released = resolveReleasedIds({ readLedgerLines: () => [
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T216", actor: "daemon", released_by: "verify-human-judge", release_pin: operatorReleasePin(held!) }),
    row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T2222" }),
  ] }, planOf([held! as never, parked("W1-T2222")]));
  assert.equal(released.has("W1-T216"), true, "positive control: the prior judge row still reaches the selector");
  const plan = planOf([held as never, parked("W1-T2222")]);
  assert.equal(nextRunnable(plan, NEVER_MERGED, { releasedIds: released } as never)?.id, "W1-T2222", "unrelated released work still flows");
  assert.throws(() => assertRunnable(plan, held!, NEVER_MERGED, released), /task-scoped dispatch hold/);
  const unheld = { ...held!, dispatch_hold: false };
  assert.doesNotThrow(() => assertRunnable(planOf([unheld]), unheld, NEVER_MERGED, released), "removing only the hold restores ordinary release admission");
});

test("W1-T3216: with NO reader wired the released set is EMPTY — a door added, never a wall removed", () => {
  assert.deepEqual([...resolveReleasedIds({})], [], "a caller that has not opted in behaves exactly as before this task");
  assert.equal(nextRunnable(planOf([parked("W1-T1041")]), NEVER_MERGED, { releasedIds: resolveReleasedIds({}) } as never), undefined);
});

test("W1-T3216: the ledger is read ONCE PER PASS, not once per task", () => {
  // The defect this guards: resolving inside the per-task filter puts a disk read in the selection
  // loop, once per candidate. resolveReleasedIds is called at the pass boundary and the SET is
  // threaded down, which is why releasedIds is a ReadonlySet and not a path.
  let reads = 0;
  const releasedIds = resolveReleasedIds({
    readLedgerLines: () => { reads += 1; return [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]; },
  });
  assert.equal(reads, 1, "one resolve, one read");
  for (const id of ["W1-T1041", "W1-T2222", "W1-T3333", "W1-T4444"]) {
    nextRunnable(planOf([parked(id)]), NEVER_MERGED, { releasedIds } as never);
  }
  assert.equal(reads, 1, "four eligibility questions, still ONE read — the filter never touches the disk");
});

test("W1-T3216 FALSIFIER: runDrain DISPATCHES a released verify:human task, and does NOT without the reader", async () => {
  // THIS IS THE TEST WHOSE ABSENCE LET #4715 SHIP. Every assertion above would pass against a
  // reader with zero callers; only a drive of the REAL drain fails when the wiring is missing.
  // Deliberately NOT a source-text assertion (source-text-assertion-census, W1-T2905): a grep for
  // `resolveReleasedIds(deps)` can stay green while the mechanism dies, which is the whole disease
  // this task is treating.
  const drive = async (readLedgerLines?: () => readonly string[]) => {
    const dispatched: string[] = [];
    await runDrain(
      planOf([parked("W1-T1041")]),
      {
        refreshMerged: () => NEVER_MERGED,
        runOne: async (id: string) => {
          dispatched.push(id);
          return { taskId: id, runId: `R-${id}`, merged: true, verdict: "merged", costUsd: 0 };
        },
        ...(readLedgerLines ? { readLedgerLines } : {}),
        log: () => {},
      } as never,
      { max: 1 },
    );
    return dispatched;
  };

  assert.deepEqual(
    await drive(() => [row({ step: RELEASE_LEDGER_STEP, task_id: "W1-T1041" })]),
    ["W1-T1041"],
    "with the reader wired, the REAL drain selects and dispatches the released task",
  );
  assert.deepEqual(
    await drive(undefined),
    [],
    "with no reader, the identical task is refused — a door added, never a wall removed",
  );
});

// ── The approveCommand BRANCH itself, driven end to end ───────────────────────────────────────
//
// coverage-ratchet caught that every test above reaches `approveParkedTask` DIRECTLY and none
// reaches the branch in `approveCommand` that routes a task id to it. That branch IS the wiring,
// so an untested one is this task's own defect in miniature. Driven here against a real temp root.

test("W1-T3216: `rmd approve <task-id>` reaches the release path and writes the row to the real ledger", async () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3216-`));
  try {
    mkdirSync(join(tmp, "plan"), { recursive: true });
    mkdirSync(join(tmp, "state"), { recursive: true });
    writeFileSync(
      join(tmp, "plan", "tasks.yaml"),
      [
        "- id: W1-T1041",
        "  title: a parked shard",
        "  repo: remudero",
        "  type: implement",
        "  verify: human",
        "  status: queued",
        "  depends_on: []",
      ].join("\n"),
    );
    const config = { root: tmp } as never;

    const code = await approveCommand(["W1-T1041"], { config, planPath: join(tmp, "plan", "tasks.yaml") });
    assert.equal(code, 0, "the branch is REACHED and succeeds — not a usage error from the proposal path");

    const ledger = readFileSync(ledgerPathFor({ root: tmp } as never), "utf8").split("\n").filter(Boolean);
    const rows = ledger.map((l) => JSON.parse(l) as Record<string, unknown>);
    const release = rows.filter((r) => r.step === RELEASE_LEDGER_STEP && r.task_id === "W1-T1041");
    assert.equal(release.length, 1, "exactly one release row, written by the real command against a real ledger file");
    assert.equal(release[0]!.run_id, "APPROVE-W1-T1041");

    // Idempotent through the REAL command too, not only through the pure function.
    const again = await approveCommand(["W1-T1041"], { config, planPath: join(tmp, "plan", "tasks.yaml") });
    assert.equal(again, 0);
    const after = readFileSync(ledgerPathFor({ root: tmp } as never), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.step === RELEASE_LEDGER_STEP && r.task_id === "W1-T1041");
    assert.equal(after.length, 1, "a second bit is not a second release, end to end");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("W1-T3216: an unknown but well-formed task id is refused AS A TASK, not as a missing proposal", async () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3216-`));
  try {
    mkdirSync(join(tmp, "plan"), { recursive: true });
    mkdirSync(join(tmp, "state"), { recursive: true });
    writeFileSync(join(tmp, "plan", "tasks.yaml"), "- id: W1-T1041\n  title: x\n  repo: remudero\n  type: implement\n  verify: human\n  status: queued\n  depends_on: []\n");
    const code = await approveCommand(["W1-T9999"], { config: { root: tmp } as never, planPath: join(tmp, "plan", "tasks.yaml") });
    assert.equal(code, 2, "refused — and by the TASK path, which is what the shape test buys");
    assert.equal(existsSync(ledgerPathFor({ root: tmp } as never)), false, "a refusal writes nothing at all, not even an empty ledger");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ══ W1-T13386 — A PARKED TASK THAT ONLY THE SECOND CATALOG HOLDS ═══════════════════════════════
//
// The symptom, on the fleet host: `rmd approve <id>` said "unknown task '<id>' (not found in
// …/plan/tasks.yaml)" for a queued verify:human task that the host's second catalog holds. The verb
// read the local checkouts only, so it could release no such task. Each test below drives the real command.

const OPS_REPOSITORY = "fixture-private/ops", OPS_ID = "W1-T900201", PUBLIC_ID = "W1-T1041", NOWHERE_ID = "W1-T900299";
const shardText = (id: string): string =>
  `- id: ${id}\n  title: Fixture ${id}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n`;

/** The release pin as origin/main computed it before W1-T13386, written out: sorted keys, undefined dropped,
 *  verify forced to auto, and only sourcePath, attempts and risk_ruling left out. */
function pinBeforeThisTask(task: object): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  const { sourcePath: _source, attempts: _attempts, risk_ruling: _ruling, ...contract } = task as Record<string, unknown>;
  return createHash("sha256").update(stable({ ...contract, verify: "auto" })).digest("hex");
}

/** Everything the verb prints, on either stream, for the length of one test. Called once per test. */
function everythingSaid(t: TestContext): string[] {
  const said: string[] = [];
  const say = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  t.mock.method(console, "log", say);
  t.mock.method(console, "error", say);
  return said;
}

/** A host root: a public plan holding one parked task, a state directory that names the second catalog,
 *  and that catalog's read-only routes. `transport: "down"` makes every route fail. */
function hostWithSecondCatalog(t: TestContext, opts: { opsText?: string; destination?: string; transport?: "down" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13386-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan")); mkdirSync(stateDir);
  writeFileSync(planPath, shardText(PUBLIC_ID));
  writeFileSync(join(stateDir, "plan-destination.json"), opts.destination ?? JSON.stringify({ repository: OPS_REPOSITORY, kinds: [] }));
  const text = opts.opsText ?? shardText(OPS_ID);
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path);
    if (opts.transport === "down") throw new Error("fixture transport is down");
    const base = `repos/${OPS_REPOSITORY}`;
    if (path === base) return { id: 42, full_name: OPS_REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  const config = { root } as never;
  const storePath = ledgerPathFor(config), durablePath = join(stateDir, OPERATOR_RELEASES_FILE);
  return {
    root, stateDir, planPath, api, calls, config, durablePath,
    wroteAnything: () => existsSync(storePath) || existsSync(durablePath),
    rawLines: () => existsSync(storePath) ? readFileSync(storePath, "utf8").split("\n").filter(Boolean) : [],
    releaseRows(id: string) {
      return this.rawLines().map(line => JSON.parse(line) as Record<string, unknown>).filter(r => r.step === RELEASE_LEDGER_STEP && r.task_id === id);
    },
    durableRecords: () => (JSON.parse(readFileSync(durablePath, "utf8")) as { releases: Record<string, { pin?: string }> }).releases,
    /** The plan and pin as the daemon's tick has them: its own reader, composed over the public plan. */
    async tick() {
      const snapshot = await readOpsCatalogSnapshotAsync({ repository: OPS_REPOSITORY }, api);
      assert.equal(snapshot.outcome, "ok");
      const composed = composeSecondaryPlan(loadPlan(planPath), snapshot.plan!);
      assert.equal(composed.outcome, "ok");
      if (composed.outcome !== "ok") throw new Error("unreachable");
      return { plan: composed.plan, pin: operatorReleasePin(composed.plan.byId.get(OPS_ID)!) };
    },
  };
}

/** `rmd --repo-root <host root> approve <rest>`: no plan is handed in, so the verb searches that checkout's own
 *  plan first, misses, and only then asks the catalogs. This is the order it runs in on a host. */
async function approveAsTheHostRunsIt(host: ReturnType<typeof hostWithSecondCatalog>, rest: string[]): Promise<number> {
  const argv = [...process.argv];
  process.argv.push("--repo-root", host.root);
  try {
    return await approveCommand(rest, { config: host.config, taskLookup: { api: host.api } });
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
  }
}

test("W1-T13386 criterion 1: approve releases a parked task found only in the ops catalog, with one release row and one durable record pinned as the tick composes it", async t => {
  const host = hostWithSecondCatalog(t), said = everythingSaid(t);
  const deps = { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } };
  const tick = await host.tick();
  assert.equal(loadPlan(host.planPath).byId.has(OPS_ID), false, "control: the public plan lacks the id");

  assert.equal(await approveCommand([OPS_ID], deps), 0, said.join("\n"));
  assert.match(said.join("\n"), new RegExp(`${OPS_ID} RELEASED`));
  const rows = host.releaseRows(OPS_ID);
  assert.equal(rows.length, 1, "exactly one release row");
  assert.equal(rows[0]!.run_id, `APPROVE-${OPS_ID}`);
  assert.equal(rows[0]!.release_pin, tick.pin, "pinned from the record the tick hashes");
  assert.deepEqual(Object.keys(host.durableRecords()), [OPS_ID], "exactly one durable release record");
  assert.equal(host.durableRecords()[OPS_ID]!.pin, tick.pin);
  // The reader the release is for: the tick's release read over its composed plan, from both stores and from each.
  const stores = { readLedgerLines: () => host.rawLines(), readDurableReleases: () => readOperatorReleaseRecords(host.stateDir) };
  assert.equal(resolveReleases(stores, tick.plan).ids.has(OPS_ID), true);
  assert.equal(resolveReleases({ readLedgerLines: stores.readLedgerLines }, tick.plan).ids.has(OPS_ID), true);
  assert.equal(resolveReleases({ readDurableReleases: stores.readDurableReleases }, tick.plan).ids.has(OPS_ID), true);
  assert.equal(resolveReleases(stores, tick.plan).ids.has(PUBLIC_ID), false, "the unnamed sibling stays parked");

  // A second bit is not a second release.
  const ledgerBefore = host.rawLines().join("\n"), durableBefore = readFileSync(host.durablePath, "utf8");
  assert.equal(await approveCommand([OPS_ID], deps), 0);
  assert.match(said.at(-1)!, /already released — no second row written/);
  assert.equal(host.rawLines().join("\n"), ledgerBefore, "the second approve writes no row of any kind");
  assert.equal(readFileSync(host.durablePath, "utf8"), durableBefore, "and leaves the durable record as it was");
});

test("W1-T13386 criterion 1: the verb as the host runs it, with no plan path handed in, finds the ops task after its own checkout misses", async t => {
  const host = hostWithSecondCatalog(t), said = everythingSaid(t);
  const tick = await host.tick();
  assert.equal(await approveAsTheHostRunsIt(host, [OPS_ID]), 0, said.join("\n"));
  assert.match(said.join("\n"), new RegExp(`${OPS_ID} RELEASED`));
  const rows = host.releaseRows(OPS_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.release_pin, tick.pin);
  assert.deepEqual(Object.keys(host.durableRecords()), [OPS_ID]);
});

test("W1-T13386 criterion 3: approve names an unreadable ops catalog, writes nothing, and does not call the task unknown", async t => {
  const cases: Array<{ name: string; host: Parameters<typeof hostWithSecondCatalog>[1]; reason: RegExp; reads: boolean }> = [
    { name: "the transport fails", host: { transport: "down" }, reason: /\(ops-unreadable\)/, reads: true },
    { name: "the host file that names the catalog is not JSON", host: { destination: "{not json" }, reason: /\(destination-unreadable\)/, reads: false },
  ];
  const everything = everythingSaid(t);
  for (const { name, host: shape, reason, reads } of cases) {
    // With the plan handed in, and as the host runs the verb, searching its own checkout first.
    for (const handed of [true, false]) {
      const host = hostWithSecondCatalog(t, shape), from = everything.length;
      const code = handed
        ? await approveCommand([OPS_ID], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } })
        : await approveAsTheHostRunsIt(host, [OPS_ID]);
      const said = everything.slice(from).join("\n"), label = `${name}${handed ? "" : " (no plan path)"}: ${said}`;
      assert.notEqual(code, 0, label);
      assert.match(said, reason, `the refusal names the outcome — ${label}`);
      assert.match(said, new RegExp(`cannot release '${OPS_ID}'.*cannot be read`), label);
      assert.doesNotMatch(said, /unknown task/, `an unread catalog is not an absent task — ${label}`);
      // W1-T13750: a composition refusal writes its approve.release_refused row for the stuck-state gardener; still no release and no record.
      const refusalRow = /compose-/.test(reason.source);
      assert.deepEqual(host.rawLines().map(line => String((JSON.parse(line) as Record<string, unknown>).step)), refusalRow ? ["approve.release_refused"] : [], `no release row — ${label}`);
      assert.equal(host.wroteAnything(), refusalRow, `no row and no record — ${label}`);
      if (refusalRow) assert.throws(() => host.durableRecords(), /ENOENT/, `no durable record — ${label}`);
      assert.equal(host.calls.length > 0, reads, `control: the catalog read ${reads ? "was" : "was not"} attempted — ${label}`);
    }
  }
});

test("W1-T13749 criterion 6: approve refuses an ops task held by its own edge, naming the reason and the edge, and releases the sound task beside a repeated public id", async t => {
  const everything = everythingSaid(t);
  for (const handed of [true, false]) {
    const host = hostWithSecondCatalog(t, { opsText: shardText(OPS_ID).replace("depends_on: []", `depends_on: [${NOWHERE_ID}]`) });
    const from = everything.length;
    const code = handed
      ? await approveCommand([OPS_ID], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } })
      : await approveAsTheHostRunsIt(host, [OPS_ID]);
    const said = everything.slice(from).join("\n"), label = `${handed ? "handed" : "as the host runs it"}: ${said}`;
    assert.equal(code, 1, label);
    assert.match(said, new RegExp(`cannot release '${OPS_ID}': it is held by its own edge \\(invalid_cross_catalog_dependency: ${OPS_ID} -> ${NOWHERE_ID}\\) — nothing released`), label);
    assert.doesNotMatch(said, /unknown task|cannot be read/, label);
    assert.equal(host.wroteAnything(), false, `no row and no record — ${label}`);
  }
  // The catalog repeats the public id: that id is held, and the ops task beside it is released as the tick pins it.
  const host = hostWithSecondCatalog(t, { opsText: shardText(OPS_ID) + shardText(PUBLIC_ID) }), from = everything.length;
  const tick = await host.tick();
  assert.equal(await approveCommand([OPS_ID], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } }), 0,
    everything.slice(from).join("\n"));
  assert.match(everything.slice(from).join("\n"), new RegExp(`${OPS_ID} RELEASED`));
  assert.equal(host.releaseRows(OPS_ID)[0]?.release_pin, tick.pin, "pinned from the record the tick hashes");
});

test("W1-T13750 criterion 1: the real approve and gardener replay the held edge against advancing origin/main", async t => {
  const taskId = "W1-T13599", dependency = "W1-T13733";
  const host = hostWithSecondCatalog(t, { opsText: shardText(taskId).replace("depends_on: []", `depends_on: [${dependency}]`) });
  const checkout = gitRepo({ scope: t, seedCommit: false });
  const planPath = join(checkout.dir, "plan", "tasks.yaml");
  const publicText = shardText(PUBLIC_ID);
  const publishMain = (text: string) => {
    writeFileSync(planPath, text);
    checkout.git("add", "plan/tasks.yaml");
    checkout.git("commit", "--quiet", "--allow-empty", "-m", "fixture main");
    const sha = checkout.git("rev-parse", "HEAD");
    checkout.git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  mkdirSync(join(checkout.dir, "plan"));
  const boot = publishMain(publicText);
  const publicCommit = publishMain(publicText);
  checkout.git("checkout", "--quiet", "--detach", boot);
  const ops = await readOpsCatalogSnapshotAsync({ repository: OPS_REPOSITORY }, host.api);
  const opsTask = ops.plan!.byId.get(taskId)!;
  host.calls.length = 0;
  const approve = (args: string[]) => approveCommand(args, { config: host.config, planPath, taskLookup: { api: host.api } });
  const said = everythingSaid(t);
  assert.equal(await approve([taskId]), 1, said.join("\n"));
  assert.match(said.join("\n"), /invalid_cross_catalog_dependency: W1-T13599 -> W1-T13733/);
  assert.equal(host.calls.filter(path => path === `repos/${OPS_REPOSITORY}`).length, 1, "the row uses the snapshot that made the decision");
  const rows = () => host.rawLines().map(line => JSON.parse(line) as Record<string, unknown>);
  const byStep = (step: string) => rows().filter(row => row.step === step);
  const refusal = byStep("approve.release_refused");
  assert.equal(refusal.length, 1, "the production held branch writes exactly one refusal");
  assert.deepEqual(
    [refusal[0]!.task_id, refusal[0]!.class, refusal[0]!.reason, refusal[0]!.edge, refusal[0]!.public_commit, refusal[0]!.ops_commit, refusal[0]!.ops_record_digest],
    [taskId, "release-compose", "held-invalid_cross_catalog_dependency", `${taskId} -> ${dependency}`, publicCommit, ops.binding?.commit, opsRecordDigest(opsTask)],
  );
  assert.equal(existsSync(host.durablePath), false, "refusal writes no durable release");
  const retries: string[][] = [];
  const escalations: unknown[] = [];
  const ports = productionStuckStatePorts({
    stateDir: host.stateDir, api: host.api, gardenNames: [],
    publicRoot: checkout.dir, publicMainCommit: () => readOriginMainSha(checkout.dir),
    destinationRead: async () => undefined,
    log: (step, fields) => appendLedger(ledgerPathFor(host.config), { run_id: "GARDEN", task_id: taskId, ...fields, step }),
    escalate: item => { escalations.push(item); return null; },
    approve: async (...args) => { retries.push(args); return approve(args); },
  });
  await runStuckStateGardener(ports);
  assert.equal(byStep("stuck_state.held").length, 1);
  const heldRows = host.rawLines();
  await runStuckStateGardener(ports);
  publishMain(publicText);
  await runStuckStateGardener(ports);
  assert.deepEqual(host.rawLines(), heldRows, "an unchanged cause writes no further rows");
  assert.deepEqual(retries, []);

  publishMain(publicText + shardText(dependency));
  checkout.git("checkout", "--quiet", "--detach", boot);
  assert.equal(loadPlan(planPath).byId.has(dependency), false, "the boot checkout still lacks the dependency");
  await runStuckStateGardener(ports);
  await runStuckStateGardener(ports);
  assert.deepEqual(retries, [[taskId]]);
  assert.equal(host.releaseRows(taskId).length, 1);
  assert.equal(host.durableRecords()[taskId]?.pin, operatorReleasePin(opsTask));
  assert.deepEqual(byStep("stuck_state.retried").map(row => row.exit_code), [0]);
  assert.deepEqual(byStep("stuck_state.cleared").map(row => row.retry), ["approve"]);
  assert.deepEqual(escalations, []);
});

test("W1-T13386 criterion 4: an id in neither catalog is refused as unknown and nothing is written", async t => {
  const host = hostWithSecondCatalog(t), said = everythingSaid(t);
  assert.equal(await approveCommand([NOWHERE_ID], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } }), 2);
  assert.match(said.join("\n"), new RegExp(`unknown task '${NOWHERE_ID}' — not in the plan`), "the message origin/main prints for a handed plan");
  assert.ok(host.calls.length > 4, "control: the ops catalog was read in full before the id was called unknown");
  assert.equal(host.wroteAnything(), false, "no row and no record");

  const onHost = hostWithSecondCatalog(t), from = said.length;
  assert.equal(await approveAsTheHostRunsIt(onHost, [NOWHERE_ID]), 2);
  assert.equal(said.slice(from).join("\n"), `rmd approve: unknown task '${NOWHERE_ID}' (not found in ${onHost.planPath})`,
    "the message origin/main prints when it searched the checkout itself, word for word");
  assert.ok(onHost.calls.length > 4, "control: the ops catalog was read here too");
  assert.equal(onHost.wroteAnything(), false);
});

test("W1-T13386 criterion 4: a public release keeps its pin and reads ops only while a destination is named (W1-T13785 criterion 2)", async t => {
  const host = hostWithSecondCatalog(t, { transport: "down" }), said = everythingSaid(t);
  const record = loadPlan(host.planPath).byId.get(PUBLIC_ID)!;
  assert.equal(await approveCommand([PUBLIC_ID], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } }), 0, said.join("\n"));
  // W1-T13785 criterion 2 supersedes "a public hit opens no private reader": the read is attempted, fails, and the release stands.
  assert.equal(host.calls.length, 1, "a public hit attempts one ops read while a destination is named");
  const rows = host.releaseRows(PUBLIC_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.run_id, `APPROVE-${PUBLIC_ID}`);
  assert.equal(rows[0]!.release_pin, pinBeforeThisTask(record), "the pin of a public record is the one origin/main wrote");
  assert.deepEqual(Object.keys(host.durableRecords()), [PUBLIC_ID]);
  assert.equal(host.durableRecords()[PUBLIC_ID]!.pin, pinBeforeThisTask(record));

  // And as the host runs the verb: its own checkout holds the id; the catalog is asked whether the tick holds it.
  const onHost = hostWithSecondCatalog(t, { transport: "down" });
  assert.equal(await approveAsTheHostRunsIt(onHost, [PUBLIC_ID]), 0, said.join("\n"));
  assert.equal(onHost.calls.length, 1, "W1-T13785 criterion 2: the read is attempted while a destination is named");
  assert.equal(onHost.releaseRows(PUBLIC_ID).length, 1);
  assert.equal(onHost.releaseRows(PUBLIC_ID)[0]!.release_pin, pinBeforeThisTask(record));

  for (const handed of [true, false]) {
    const off = hostWithSecondCatalog(t);
    rmSync(join(off.stateDir, "plan-destination.json"));
    const code = handed
      ? await approveCommand([PUBLIC_ID], { config: off.config, planPath: off.planPath, taskLookup: { api: off.api } })
      : await approveAsTheHostRunsIt(off, [PUBLIC_ID]);
    assert.equal(code, 0, said.join("\n"));
    assert.equal(off.calls.length, 0, "a public hit opens no ops reader while the destination is off");
    assert.deepEqual(off.releaseRows(PUBLIC_ID).map(row => row.release_pin), [pinBeforeThisTask(record)]);
  }
});

// W1-T13785: the composition holds public records too. Approve composes a public hit while a destination is named.
const DEPENDANT_ID = "W1-T1042";
const dependingOn = (id: string, dependency: string): string => shardText(id).replace("depends_on: []", `depends_on: [${dependency}]`);
/** The ops catalog repeats the public id without moved_from: both copies are held (duplicate_task_id). */
const REPEATS_PUBLIC_ID = shardText(OPS_ID) + shardText(PUBLIC_ID);

/** A public plan published at origin/main in a git checkout detached at the boot commit, as the host runs. */
function publicMainAt(t: TestContext, bootText: string, mainText = bootText) {
  const checkout = gitRepo({ scope: t, seedCommit: false });
  const planPath = join(checkout.dir, "plan", "tasks.yaml");
  mkdirSync(join(checkout.dir, "plan"));
  const publish = (text: string) => {
    writeFileSync(planPath, text);
    checkout.git("add", "plan/tasks.yaml");
    checkout.git("commit", "--quiet", "--allow-empty", "-m", "fixture main");
    const sha = checkout.git("rev-parse", "HEAD");
    checkout.git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const boot = publish(bootText);
  const main = publish(mainText);
  checkout.git("checkout", "--quiet", "--detach", boot);
  return { dir: checkout.dir, planPath, main };
}

/** `rmd --repo-root <root> approve <rest>` with the host's state directory: the verb finds the plan in that root. */
async function approveAtRoot(root: string, host: ReturnType<typeof hostWithSecondCatalog>, rest: string[], api = host.api): Promise<number> {
  const argv = [...process.argv];
  process.argv.push("--repo-root", root);
  try {
    return await approveCommand(rest, { config: host.config, taskLookup: { api } });
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
  }
}

const MODES = ["checkout, plan handed", "checkout, as the host runs it", "working tree, plan handed", "working tree, as the host runs it"] as const;
async function approveIn(mode: (typeof MODES)[number], t: TestContext, host: ReturnType<typeof hostWithSecondCatalog>, bootText: string, subject: string,
  mainText = bootText) {
  writeFileSync(host.planPath, bootText);
  if (mode.startsWith("working tree")) {
    const code = mode.endsWith("handed")
      ? await approveCommand([subject], { config: host.config, planPath: host.planPath, taskLookup: { api: host.api } })
      : await approveAsTheHostRunsIt(host, [subject]);
    return { code, main: undefined, planPath: host.planPath };
  }
  const world = publicMainAt(t, bootText, mainText);
  const code = mode.endsWith("handed")
    ? await approveCommand([subject], { config: host.config, planPath: world.planPath, taskLookup: { api: host.api } })
    : await approveAtRoot(world.dir, host, [subject]);
  return { code, main: world.main, planPath: world.planPath };
}

test("W1-T13785 criterion 1: approve refuses a public record the composition holds, handed a plan and as the host runs it, releases nothing, and writes one refusal row with the public record's digest", async t => {
  const everything = everythingSaid(t);
  const worlds = [
    { reason: "duplicate_task_id", edge: `${PUBLIC_ID} in both catalogs`, opsText: REPEATS_PUBLIC_ID, publicRecord: shardText(PUBLIC_ID) },
    { reason: "invalid_cross_catalog_dependency", edge: `${PUBLIC_ID} -> ${OPS_ID}`, opsText: shardText(OPS_ID), publicRecord: dependingOn(PUBLIC_ID, OPS_ID) },
  ];
  for (const world of worlds) {
    const publicText = world.publicRecord + dependingOn(DEPENDANT_ID, PUBLIC_ID);
    for (const subject of [PUBLIC_ID, DEPENDANT_ID]) {
      for (const mode of MODES) await t.test(`${world.reason}, ${subject}, ${mode}`, async sub => {
        const host = hostWithSecondCatalog(sub, { opsText: world.opsText }), from = everything.length;
        const { code, main, planPath } = await approveIn(mode, sub, host, publicText, subject);
        const said = everything.slice(from).join("\n");
        const whose = subject === PUBLIC_ID ? "its own edge" : `the edge of ${PUBLIC_ID}, which it depends on`;
        assert.equal(code, 1, said);
        assert.ok(said.includes(`cannot release '${subject}': it is held by ${whose} (${world.reason}: ${world.edge}) — nothing released`), said);
        assert.doesNotMatch(said, /RELEASED|unknown task|cannot be read/);
        assert.deepEqual(host.releaseRows(subject), []);
        assert.equal(existsSync(host.durablePath), false);
        const rows = host.rawLines().map(line => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(rows.map(row => row.step), ["approve.release_refused"]);
        const record = parseTasksFromYaml(publicText, "public.yaml").find(task => task.id === subject)!;
        if (world.reason === "invalid_cross_catalog_dependency") assert.throws(() => loadPlan(planPath), /depends_on unknown task/);
        const opsCommit = createHash("sha1").update(world.opsText).digest("hex");
        assert.deepEqual(
          [rows[0]!.task_id, rows[0]!.class, rows[0]!.reason, rows[0]!.edge, rows[0]!.public_commit, rows[0]!.ops_commit, rows[0]!.ops_record_digest, rows[0]!.public_record_digest],
          [subject, "release-compose", `held-${world.reason}`, world.edge, main ?? null, opsCommit, null, publicRecordDigest(record)]);
      });
    }
  }
});

test("W1-T13785 criterion 4: the real approve retry releases the verified origin/main record from the checkout that refused it", async t => {
  const currentText = shardText(PUBLIC_ID);
  const bootText = currentText.replace(`Fixture ${PUBLIC_ID}`, "Older boot record");
  const world = publicMainAt(t, bootText, currentText);
  const daemon = publicMainAt(t, bootText, bootText);
  const host = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID });
  const cleared = hostWithSecondCatalog(t);
  let api = host.api;
  const said = everythingSaid(t);
  assert.equal(await approveAtRoot(world.dir, host, [PUBLIC_ID], api), 1, said.join("\n"));
  const currentPlan = await readReleasePublicPlan(world.dir);
  const currentRecord = currentPlan.plan.byId.get(PUBLIC_ID)!;
  assert.notEqual(operatorReleasePin(loadPlan(world.planPath).byId.get(PUBLIC_ID)!), operatorReleasePin(currentRecord));
  const retries: string[][] = [];
  const ports = productionStuckStatePorts({
    stateDir: host.stateDir, api: path => api(path), gardenNames: [], publicRoot: daemon.dir,
    publicMainCommit: readOriginMainSha, destinationRead: async () => undefined, escalate: () => null,
    log: (step, fields) => appendLedger(ledgerPathFor(host.config), { run_id: "GARDEN", task_id: PUBLIC_ID, ...fields, step }),
    approve: approveInChild({ publicRoot: daemon.dir, execArgv: [], entry: "src/run-task.ts", env: {},
      run: async (_file, args) => {
        retries.push([...args]);
        assert.equal(await approveAtRoot(args[5]!, host, stripRepoRootFlag(args.slice(2)), api), 0, said.join("\n"));
      },
    }),
  });
  await runStuckStateGardener(ports);
  assert.deepEqual(retries, []);
  assert.equal(host.rawLines().some(line => JSON.parse(line).step === "stuck_state.record_changed"), false);
  api = cleared.api;
  await runStuckStateGardener(ports);
  await runStuckStateGardener(ports);
  assert.deepEqual(retries, [["src/run-task.ts", "approve", PUBLIC_ID, `--replay-public-digest=${publicRecordDigest(currentRecord)}`, "--repo-root", world.dir]]);
  assert.deepEqual(host.releaseRows(PUBLIC_ID).map(row => row.release_pin), [operatorReleasePin(currentRecord)]);
  assert.equal(host.durableRecords()[PUBLIC_ID]?.pin, operatorReleasePin(currentRecord));
  assert.deepEqual([...readReleasedTaskIds(host.rawLines(), currentPlan.plan)], [PUBLIC_ID]);
  assert.ok(host.rawLines().some(line => JSON.parse(line).step === "stuck_state.cleared" && JSON.parse(line).retry === "approve"));
});

test("W1-T13785 criterion 4: the real approve retry releases a verified working-tree record after the destination turns off", async t => {
  const host = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID });
  const said = everythingSaid(t);
  assert.equal(await approveAsTheHostRunsIt(host, [PUBLIC_ID]), 1, said.join("\n"));
  const record = loadPlan(host.planPath).byId.get(PUBLIC_ID)!;
  const run = t.mock.fn(async (_file: string, args: readonly string[]) => {
    assert.ok(args.includes("--replay-public-working-tree"));
    assert.equal(await approveAtRoot(host.root, host, stripRepoRootFlag(args.slice(2))), 0, said.join("\n"));
  });
  const ports = productionStuckStatePorts({
    stateDir: host.stateDir, api: host.api, gardenNames: [], publicRoot: host.root, publicMainCommit: () => undefined,
    destinationRead: async () => undefined, escalate: () => null,
    log: (step, fields) => appendLedger(ledgerPathFor(host.config), { run_id: "GARDEN", task_id: PUBLIC_ID, ...fields, step }),
    approve: approveInChild({ publicRoot: host.root, execArgv: [], entry: "src/run-task.ts", env: {}, run }),
  });
  rmSync(join(host.stateDir, "plan-destination.json"));
  const opsCalls = host.calls.length;
  await runStuckStateGardener(ports);
  await runStuckStateGardener(ports);
  assert.equal(run.mock.callCount(), 1, "the ops-only change is seen even before the first pass");
  assert.equal(host.calls.length, opsCalls, "the disabled destination opens no ops reader");
  assert.deepEqual(host.releaseRows(PUBLIC_ID).map(row => row.release_pin), [pinBeforeThisTask(record)]);
  assert.equal(host.durableRecords()[PUBLIC_ID]?.pin, pinBeforeThisTask(record));
});

test("W1-T13785 criterion 2: a held public record is released as on origin/main when the ops catalog cannot be read or the destination is off, and a sound public task beside a held one keeps the local pin", async t => {
  const everything = everythingSaid(t);
  const record = loadPlan(hostWithSecondCatalog(t).planPath).byId.get(PUBLIC_ID)!;
  for (const handed of [true, false]) {
    // The transport is down: the tick dispatches the public plan alone, so approve releases the public copy.
    const down = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID, transport: "down" }), from = everything.length;
    const code = handed
      ? await approveCommand([PUBLIC_ID], { config: down.config, planPath: down.planPath, taskLookup: { api: down.api } })
      : await approveAsTheHostRunsIt(down, [PUBLIC_ID]);
    const label = `${handed ? "handed" : "as the host runs it"}: ${everything.slice(from).join("\n")}`;
    assert.equal(code, 0, label);
    assert.ok(down.calls.length > 0, `the ops read is attempted while a destination is named — ${label}`);
    assert.equal(down.releaseRows(PUBLIC_ID).length, 1, label);
    assert.equal(down.releaseRows(PUBLIC_ID)[0]!.release_pin, pinBeforeThisTask(record), `the pin origin/main wrote — ${label}`);
    assert.equal(down.durableRecords()[PUBLIC_ID]!.pin, pinBeforeThisTask(record), label);

    // The destination is off: no ops read at all, and the release is origin/main's.
    const off = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID });
    rmSync(join(off.stateDir, "plan-destination.json"));
    const offCode = handed
      ? await approveCommand([PUBLIC_ID], { config: off.config, planPath: off.planPath, taskLookup: { api: off.api } })
      : await approveAsTheHostRunsIt(off, [PUBLIC_ID]);
    assert.equal(offCode, 0, label);
    assert.equal(off.calls.length, 0, `no ops read while the destination is off — ${label}`);
    assert.equal(off.releaseRows(PUBLIC_ID)[0]?.release_pin, pinBeforeThisTask(record), label);
  }
  // A sound public task beside the held copy: released from the boot's local record, never origin/main's newer one.
  const boot = shardText(PUBLIC_ID) + shardText(DEPENDANT_ID), main = shardText(PUBLIC_ID) + shardText(DEPENDANT_ID).replace(`Fixture ${DEPENDANT_ID}`, "Retitled on main");
  for (const mode of MODES.filter(m => m.startsWith("checkout"))) {
    const host = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID }), from = everything.length;
    const { code, planPath } = await approveIn(mode, t, host, boot, DEPENDANT_ID, main);
    const label = `${mode}: ${everything.slice(from).join("\n")}`;
    assert.equal(code, 0, label);
    const local = loadPlan(planPath).byId.get(DEPENDANT_ID)!;
    assert.notEqual(pinBeforeThisTask(local), pinBeforeThisTask(parseTasksFromYaml(main, "main.yaml").find(task => task.id === DEPENDANT_ID)!),
      "control: the boot's record and origin/main's pin apart");
    assert.equal(host.releaseRows(DEPENDANT_ID)[0]?.release_pin, pinBeforeThisTask(local), `pinned from the local plan as origin/main does — ${label}`);
    assert.deepEqual(host.rawLines().map(line => (JSON.parse(line) as Record<string, unknown>).step), [RELEASE_LEDGER_STEP], `no refusal row — ${label}`);
  }
});

test("W1-T13785 criterion 2: the public-only fallback rejects an unresolved dependency as the strict loader does", async t => {
  everythingSaid(t);
  const text = dependingOn(PUBLIC_ID, OPS_ID) + dependingOn(DEPENDANT_ID, PUBLIC_ID);
  for (const mode of MODES) {
    for (const destination of ["offline", "off", "malformed"] as const) {
      const host = hostWithSecondCatalog(t, { opsText: shardText(OPS_ID), transport: "down" });
      if (destination === "off") rmSync(join(host.stateDir, "plan-destination.json"));
      if (destination === "malformed") writeFileSync(join(host.stateDir, "plan-destination.json"), "{invalid");
      const error = { name: "PlanError", message: `task ${PUBLIC_ID}: depends_on unknown task '${OPS_ID}'` };
      writeFileSync(host.planPath, text);
      assert.throws(() => loadPlan(host.planPath), error, "control: strict public loader rejects the whole plan");
      await assert.rejects(approveIn(mode, t, host, text, DEPENDANT_ID, shardText(PUBLIC_ID) + shardText(DEPENDANT_ID)),
        error, `${mode}, ${destination}`);
      assert.equal(host.calls.length > 0, destination === "offline", `${mode}, ${destination}: ops read attempted`);
      assert.equal(host.wroteAnything(), false, `${mode}, ${destination}: no ledger or durable release`);
    }
  }
});

test("W1-T13785 criterion 2: a readable reverse edge holds its own record, and a sound public neighbour in that plan is refused by the strict loader as on origin/main", async t => {
  everythingSaid(t);
  const boot = dependingOn(PUBLIC_ID, OPS_ID) + shardText(DEPENDANT_ID);
  const main = boot.replace(`Fixture ${DEPENDANT_ID}`, "Retitled on main");
  const error = { name: "PlanError", message: `task ${PUBLIC_ID}: depends_on unknown task '${OPS_ID}'` };
  for (const mode of MODES) {
    const host = hostWithSecondCatalog(t);
    writeFileSync(host.planPath, boot);
    assert.throws(() => loadPlan(host.planPath), error, "control: origin/main's approve loads this plan strictly and refuses it");
    await assert.rejects(approveIn(mode, t, host, boot, DEPENDANT_ID, main), error, mode);
    assert.ok(host.calls.length > 0, `${mode}: the readable ops catalog is read`);
    assert.equal(host.wroteAnything(), false, `${mode}: no release, refusal row or durable record`);
  }
});

test("W1-T13785 criterion 2: an unreadable ops catalog leaves a deferred origin/main edge to the strict loader's fallback", async t => {
  everythingSaid(t);
  const boot = shardText(PUBLIC_ID) + shardText(DEPENDANT_ID);
  const main = dependingOn(PUBLIC_ID, OPS_ID) + shardText(DEPENDANT_ID).replace(`Fixture ${DEPENDANT_ID}`, "Retitled on main");
  const host = hostWithSecondCatalog(t, { transport: "down" });
  const { code, planPath } = await approveIn("checkout, as the host runs it", t, host, boot, DEPENDANT_ID, main);
  const local = loadPlan(planPath).byId.get(DEPENDANT_ID)!;
  assert.equal(code, 0);
  assert.equal(host.calls.length, 1, "strict fallback reuses the unsuccessful catalog read");
  assert.deepEqual(host.releaseRows(DEPENDANT_ID).map(row => row.release_pin), [pinBeforeThisTask(local)]);
});

test("W1-T13785 criterion 2: approve skips an invalid cwd plan and releases the daemon target's copy during an ops outage or shutdown", t => {
  const cwd = publicMainAt(t, shardText(PUBLIC_ID) + dependingOn(DEPENDANT_ID, OPS_ID));
  writeFileSync(join(cwd.dir, "plan", "policy.yaml"), "risk: { verifyHumanReleaseEnabled: { value: true, origin: fixture } }\n");
  assert.throws(() => loadPlan(cwd.planPath), /depends_on unknown task/, "cwd contains the id, but the strict loader rejects the plan");
  const hosts = ["offline", "off"].map(destination => {
    const host = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID, transport: "down" });
    writeFileSync(host.planPath, shardText(PUBLIC_ID).replace(`Fixture ${PUBLIC_ID}`, "Daemon target copy"));
    assert.deepEqual(writeDaemonTargetRecord(host.stateDir, {
      owner: "fixture", repo: "consumer", isSelf: false, checkoutRoot: host.root,
    }), { written: true });
    if (destination === "off") rmSync(join(host.stateDir, "plan-destination.json"));
    return host;
  });
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", `
    const { approveCommand } = await import(process.argv[2]);
    const results = [];
    for (const root of process.argv.slice(3)) {
      let reads = 0;
      const code = await approveCommand([process.argv[1]], {
        config: { root },
        taskLookup: { api: async () => { reads++; throw new Error("fixture ops outage"); } },
      });
      results.push({ code, reads });
    }
    console.log(JSON.stringify(results));
  `, PUBLIC_ID, join(REPO_ROOT, "src", "run-task.ts"), ...hosts.map(host => host.root)], {
    cwd: cwd.dir, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)!), [{ code: 0, reads: 1 }, { code: 0, reads: 0 }], child.stderr);
  for (const host of hosts) {
    const target = loadPlan(host.planPath).byId.get(PUBLIC_ID)!;
    const pin = pinBeforeThisTask(target);
    assert.deepEqual(host.releaseRows(PUBLIC_ID).map(row => row.release_pin), [pin]);
    assert.equal(host.durableRecords()[PUBLIC_ID]?.pin, pin);
  }
});

test("W1-T13785 criterion 2: the public loader still normalizes scalar dependencies before an ops outage or destination shutdown", async t => {
  everythingSaid(t);
  const text = shardText(PUBLIC_ID).replace("depends_on: []", `depends_on: ${OPS_ID}`);
  for (const mode of MODES) {
    for (const destination of ["offline", "off"] as const) {
      const host = hostWithSecondCatalog(t, { opsText: REPEATS_PUBLIC_ID, transport: "down" });
      if (destination === "off") rmSync(join(host.stateDir, "plan-destination.json"));
      const { code, planPath } = await approveIn(mode, t, host, text, PUBLIC_ID);
      const label = `${mode}, ${destination}`;
      const record = loadPlan(planPath).byId.get(PUBLIC_ID)!;
      assert.deepEqual(record.depends_on, [], label);
      assert.equal(code, 0, label);
      assert.equal(host.calls.length > 0, destination === "offline", label);
      assert.deepEqual(host.releaseRows(PUBLIC_ID).map(row => row.release_pin), [pinBeforeThisTask(record)], label);
      assert.equal(host.durableRecords()[PUBLIC_ID]?.pin, pinBeforeThisTask(record), label);
    }
  }
});
