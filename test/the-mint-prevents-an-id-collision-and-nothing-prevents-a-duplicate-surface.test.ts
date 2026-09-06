import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_SURFACE_MIN_FILES,
  duplicateSurfaceViolations,
  lintTask,
  lintPlan,
  type DuplicateSurfaceCorpusEntry,
} from "../src/lib/task-linter.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { creditedMergedIdsFrom, lintPlanCommand, surfaceCorpusFrom } from "../src/run-task.js";

// ── W1-T2676 ─────────────────────────────────────────────────────────────────────────────────
//
// `next-task-id --reserve` answers "is this NUMBER free" and answers it correctly. Nothing
// answered "is this WORK already filed". MEASURED 2026-09-01 in this repo's own plan tree:
// W1-T2589 was filed for work W1-T2581 already covered, its four declared files a STRICT SUBSET
// of W1-T2581's seven, both queued with `depends_on: []` and therefore both dispatch-eligible,
// and lint-plan said nothing. The costly part is not the redundancy: two workers editing one
// surface produce CONFLICTING PRs.
//
// The hard half is not firing. Any check keyed on shared files fires on the create-and-wire pair
// too, so the legitimate-overlap cases are asserted here beside the catch.

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `title for ${over.id}`,
    repo: "remudero",
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    depends_on: [],
    ...over,
  } as Task;
}

const SEVEN = [
  "src/lib/merge-hold.ts",
  "src/lib/serve.ts",
  "src/run-task.ts",
  "test/merge-hold.test.ts",
  "test/serve.test.ts",
  "docs/operator-guide.md",
  "plan/tasks.d/W1-T2581-expose-the-durable-merge-hold-writer.yaml",
];
const FOUR_SUBSET = ["src/lib/merge-hold.ts", "src/run-task.ts", "test/merge-hold.test.ts", "docs/operator-guide.md"];

function corpus(...entries: DuplicateSurfaceCorpusEntry[]): DuplicateSurfaceCorpusEntry[] {
  return entries;
}

// ── the observed pair ─────────────────────────────────────────────────────────────────────────

test("two queued shards declaring the same files are reported, naming BOTH ids and the overlap", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });

  assert.equal(v.length, 1);
  assert.equal(v[0]!.check, "duplicate-surface");
  assert.match(v[0]!.message, /W1-T2589/, "this task is named");
  assert.match(v[0]!.message, /W1-T2581/, "and so is the other — a pair finding that names one id is not actionable");
  assert.match(v[0]!.message, /src\/lib\/merge-hold\.ts/, "the overlap itself is named, not just its size");
  assert.match(v[0]!.message, /the same files as/, "and the relation is stated");
});

test("a SUBSET overlap is caught, not only an exact match — the shape actually observed", () => {
  // W1-T2589's four files were a strict subset of W1-T2581's seven. A check that required
  // set equality would have said nothing about the one pair it exists to catch.
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /a subset of W1-T2581/);
  assert.match(v[0]!.message, /4 shared file\(s\)/);
});

test("the subset is caught in EITHER direction — nothing makes the smaller shard the one filed second", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2581", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T2589", files: FOUR_SUBSET, status: "queued" }),
  });
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /a superset of W1-T2589/);
});

// ── severity ──────────────────────────────────────────────────────────────────────────────────

test("the finding is a WARNING, not a refusal, so a legitimate overlap is never blocked", () => {
  const t = task({ id: "W1-T2589", files: [...FOUR_SUBSET] });
  const opts = { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) };

  assert.equal(duplicateSurfaceViolations(t, opts)[0]!.severity, "warn");

  // And through the aggregator, because an unwired check reports nothing to anyone. `ok` is not
  // asserted directly: this minimal fixture trips other rules for unrelated reasons, so the
  // precise property is that ADDING the corpus adds a finding and adds NO blocking one.
  const withCorpus = lintTask(t, opts);
  const without = lintTask(t, {});
  assert.ok(
    withCorpus.violations.some((x) => x.check === "duplicate-surface"),
    "the check is WIRED INTO lintTask",
  );
  assert.ok(
    withCorpus.violations.filter((x) => x.check === "duplicate-surface").every((x) => x.severity === "warn"),
    "and contributes only warnings",
  );
  const blocking = (r: { violations: { severity: string; check: string }[] }) =>
    r.violations.filter((x) => x.severity === "block").map((x) => x.check).sort();
  assert.deepEqual(blocking(withCorpus), blocking(without), "the duplicate surface adds no blocking violation");
});

// ── wired for real, not only in a test's own hand-built opts ───────────────────────────────────
//
// `openTaskSurfaces` is a caller-supplied field, and nothing in this repo's real `--base` gate
// (`lintPlanCommand`, run-task.ts) populates it — that wiring needs a git-scoped read only that
// call site can supply, and touching it is out of this task's declared `files:`. But `lintPlan`
// itself (task-linter.ts) needs no such read: every real caller already holds the WHOLE plan, the
// one thing the check compares against. These two tests model the repo's actual two callers —
// `lintPlan(merged, () => ({}))` (inbox.ts's merge-plan gate) and `lintPlan(plan)` (onboard/
// synthesize.ts) — passing NEITHER an explicit corpus, to prove the finding is produced by the
// real function these files already call, not only by a fixture built for this suite.

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("lintPlan(plan) alone — no optsFor, no explicit corpus — still reports the pair (models onboard/synthesize.ts's own call)", () => {
  const plan = planOf([task({ id: "W1-T2581", files: [...SEVEN] }), task({ id: "W1-T2589", files: [...FOUR_SUBSET] })]);
  const results = lintPlan(plan);
  const v2589 = results.get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(v2589.length, 1, "lintPlan derives the corpus from the plan it already holds — no caller wiring needed");
  assert.match(v2589[0]!.message, /a subset of W1-T2581/);
  assert.equal(v2589[0]!.severity, "warn", "still advisory through the real call shape, not only through hand-built opts");
});

test("lintPlan(plan, () => ({})) — an optsFor that sets nothing — still reports the pair (models inbox.ts's blockingLintMessages)", () => {
  const plan = planOf([task({ id: "W1-T2581", files: [...SEVEN] }), task({ id: "W1-T2589", files: [...FOUR_SUBSET] })]);
  const results = lintPlan(plan, () => ({}));
  const v2589 = results.get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(v2589.length, 1, "an optsFor returning {} must not erase the plan-derived corpus");
});

test("an optsFor that explicitly sets openTaskSurfaces (even []) overrides the plan-derived default", () => {
  const plan = planOf([task({ id: "W1-T2581", files: [...SEVEN] }), task({ id: "W1-T2589", files: [...FOUR_SUBSET] })]);
  const results = lintPlan(plan, () => ({ openTaskSurfaces: [] }));
  assert.deepEqual(
    results.get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface"),
    [],
    "an explicit corpus, including an empty one, is the caller's own ruling and is never silently replaced",
  );
});

// ── the legitimate overlaps: the half that is hard ────────────────────────────────────────────

test("a pair whose overlap is a single shared module with different concerns is NOT reported", () => {
  // The shard's own falsifier. A wiring task and the module it wires share one file by design;
  // firing here would flag the create-and-wire shape Rule 19 already pushes to risk:high, and a
  // check that cries on legitimate work gets ignored on the case it exists for.
  const v = duplicateSurfaceViolations(task({ id: "W1-T900", files: ["src/lib/shared.ts", "src/lib/only-mine.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T901", files: ["src/lib/shared.ts", "src/lib/only-theirs.ts"], status: "queued" }),
  });
  assert.deepEqual(v, [], "one shared module is not a duplicate surface");
});

test("a one-file shard is not a duplicate of every task that touches its file", () => {
  // A single declared file is a subset of nearly everything. Keying on subset alone would fire
  // here, which is why DUPLICATE_SURFACE_MIN_FILES exists and is asserted rather than assumed.
  assert.equal(DUPLICATE_SURFACE_MIN_FILES, 2);
  const v = duplicateSurfaceViolations(task({ id: "W1-T902", files: ["src/lib/merge-hold.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, [], "a subset of size 1 is not evidence of duplicated work");
});

test("a TINY candidate is not a duplicate of this task either — the floor is on the overlap, both directions", () => {
  // The mirror of the one-file case, and the direction a `task.files.length` guard cannot see:
  // here THIS task is the superset and the other shard declares the single shared file. The
  // falsifier matrix found this gap — with only the size-of-my-own-surface guard, mutating the
  // overlap floor reddened nothing.
  const v = duplicateSurfaceViolations(task({ id: "W1-T2581", files: [...SEVEN] }), {
    openTaskSurfaces: corpus({ id: "W1-T908", files: ["src/lib/merge-hold.ts"], status: "queued" }),
  });
  assert.deepEqual(v, [], "one shared module is not a duplicate surface in either direction");
});

test("a shard whose files overlap nothing is never reported, so the check is not vacuous", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T903", files: ["src/lib/elsewhere.ts", "test/elsewhere.test.ts"] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, []);
});

// ── live work only ────────────────────────────────────────────────────────────────────────────

test("a shard marked or credited as merged is not counted as a duplicate of live work", () => {
  // Otherwise every follow-up is flagged against the task it follows, which is how an advisory
  // check earns the reputation that gets it ignored.
  for (const status of ["merged", "done", "blocked"]) {
    const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
      openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status }),
    });
    assert.deepEqual(v, [], `a ${status} candidate is history, not live work`);
  }

  const creditedInCorpus = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued", merged: true }),
  });
  assert.deepEqual(creditedInCorpus, [], "a corpus entry credited merged is history even when yaml still says queued");

  const creditedById = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    mergedTaskIds: new Set(["W1-T2581"]),
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(creditedById, [], "external merge credit by id is history even when yaml still says queued");
});

test("a task that is ITSELF merged or externally credited reports nothing — it is not competing for a dispatch slot", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", status: "merged", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(v, []);

  const credited = duplicateSurfaceViolations(task({ id: "W1-T2589", status: "queued", files: [...FOUR_SUBSET] }), {
    mergedTaskIds: new Set(["W1-T2589"]),
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.deepEqual(credited, [], "a task credited merged externally is not live work on its own side either");
});

// ── the silences that must stay silent ────────────────────────────────────────────────────────

test("absent a corpus the check is silent, and it never compares a task against itself", () => {
  const t = task({ id: "W1-T2581", files: [...SEVEN] });
  assert.deepEqual(duplicateSurfaceViolations(t, {}), [], "no corpus ⇒ silent");
  assert.deepEqual(duplicateSurfaceViolations(t, { openTaskSurfaces: [] }), [], "empty corpus ⇒ silent");
  assert.deepEqual(
    duplicateSurfaceViolations(t, { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) }),
    [],
    "a task is not its own duplicate",
  );
  assert.deepEqual(
    duplicateSurfaceViolations(task({ id: "W1-T904" }), {
      openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
    }),
    [],
    "an undeclared files: has no surface to compare",
  );
  assert.deepEqual(
    duplicateSurfaceViolations(task({ id: "W1-T905", files: [...SEVEN] }), {
      openTaskSurfaces: corpus({ id: "W1-T906", files: [], status: "queued" }),
    }),
    [],
    "a candidate with no declared surface is not a match for everything",
  );
});

test("paths are compared normalised — whitespace and duplicates in files: do not hide an overlap", () => {
  // A shard hand-edited into ` src/lib/merge-hold.ts` must not read as a different surface, and a
  // repeated path must not inflate the shared count past the real overlap.
  const v = duplicateSurfaceViolations(
    task({ id: "W1-T907", files: ["  src/lib/merge-hold.ts  ", "src/run-task.ts", "src/run-task.ts"] }),
    { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) },
  );
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /2 shared file\(s\)/, "de-duplicated, not 3");
});

test("the message tells the reader how to clear it, and refuses the answer that hides the overlap", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
  });
  assert.match(v[0]!.message, /ADVISORY, never blocking/);
  assert.match(v[0]!.message, /retire whichever shard the other supersedes, or cite W1-T2581/);
  assert.match(v[0]!.message, /Never by narrowing files:/, "narrowing files: hides the overlap rather than ruling on it");
});

// ── the merged exclusion, through the REAL call shape ─────────────────────────────────────────
//
// The three `lintPlan` tests above prove the FINDING is produced by the function this repo's two
// callers already invoke. They do not prove the SILENCE is: every merged-candidate assertion in
// this file supplies its own `openTaskSurfaces`, so the exclusion was only ever shown over a
// hand-built corpus while the production corpus is derived inside `lintPlan` from `plan.tasks`.
// Those are different objects, and a filter that worked on the fixture could still be reading a
// field the derivation never populates. These close that gap in the same shape as the pair above:
// a real plan, no explicit corpus. One branch proves the yaml-status path, and the other proves the
// external-credit path a caller gets after deriving merge status from `status.ts`.

test("lintPlan alone: a MERGED candidate in the real plan is not counted as live work (criterion 5, production path)", () => {
  const plan = planOf([
    task({ id: "W1-T2581", files: [...SEVEN], status: "merged" }),
    task({ id: "W1-T2589", files: [...FOUR_SUBSET] }),
  ]);
  const v = lintPlan(plan).get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(v, [], "the corpus lintPlan derives itself must carry status, or history reads as live work");

  // The blocking control: the SAME plan with that one field flipped back to queued MUST report,
  // or the silence above is vacuous — a plan the check never looked at silently passes too.
  const live = planOf([
    task({ id: "W1-T2581", files: [...SEVEN], status: "queued" }),
    task({ id: "W1-T2589", files: [...FOUR_SUBSET] }),
  ]);
  const reported = lintPlan(live).get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(reported.length, 1, "one field is the whole difference between the two runs");
});

test("lintPlan alone: a task that is ITSELF merged reports nothing — it is not competing for a dispatch slot", () => {
  const plan = planOf([
    task({ id: "W1-T2581", files: [...SEVEN] }),
    task({ id: "W1-T2589", files: [...FOUR_SUBSET], status: "merged" }),
  ]);
  const v = lintPlan(plan).get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(v, [], "a shipped shard is history on its own side too, not only as a candidate");

  // ...and the live task on the OTHER side of that same plan still sees nothing, because its
  // only candidate is merged. Both directions of the one plan, so neither silence is assumed.
  const other = lintPlan(plan).get("W1-T2581")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(other, [], "the merged shard is not live work for its counterpart either");
});

test("CREDIT, not status:, is what says a shard already shipped — the case status: alone cannot see", () => {
  // `status:` is what the FILING wrote; nothing updates it on merge, and this repo has measured
  // shards reading `queued` on main while their build had already merged. Without a credit set,
  // that landed shard is still live work to this check and is still reported.
  const shippedButUnmarked = planOf([
    task({ id: "W1-T2581", files: [...SEVEN] }), // merged in fact; `status:` never updated
    task({ id: "W1-T2589", files: [...FOUR_SUBSET] }),
  ]);
  const withoutCredit = lintPlan(shippedButUnmarked).get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(withoutCredit.length, 1, "status: alone cannot see credit — this is the false positive");

  // Given the credit projection, the same plan reports nothing. One input is the whole difference.
  const withCredit = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
    mergedTaskIds: new Set(["W1-T2581"]),
  });
  assert.deepEqual(withCredit, [], "a candidate CREDITED as merged is history, whatever its shard still says");
});

test("a task CREDITED as merged reports nothing on its own side either", () => {
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), {
    openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }),
    mergedTaskIds: new Set(["W1-T2589"]),
  });
  assert.deepEqual(v, [], "a shipped shard is not competing for a dispatch slot, credited or marked");
});

test("the credit set only ever NARROWS — an empty one, or an id it does not name, changes nothing", () => {
  // A credit set is an exclusion list, never an admission one: it must not make the check fire on
  // something `status:` had already ruled out, and it must not silence an unrelated pair.
  const base = { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "queued" }) };
  const mine = task({ id: "W1-T2589", files: [...FOUR_SUBSET] });
  assert.equal(duplicateSurfaceViolations(mine, { ...base, mergedTaskIds: new Set() }).length, 1, "an empty credit set is the uncredited behaviour exactly");
  assert.equal(duplicateSurfaceViolations(mine, { ...base, mergedTaskIds: new Set(["W1-T9999"]) }).length, 1, "an unrelated id changes nothing");

  // And it never RESURRECTS a pair `status:` already excluded.
  const statusMerged = { openTaskSurfaces: corpus({ id: "W1-T2581", files: SEVEN, status: "merged" }) };
  assert.deepEqual(duplicateSurfaceViolations(mine, { ...statusMerged, mergedTaskIds: new Set() }), [], "status: merged stays excluded under an empty credit set");
});

test("the offline linter stays offline: lintPlan supplies no credit set, so its behaviour is unchanged and network-free", () => {
  // W1-T367 ruled `rmd lint-plan`'s whole-plan pass stays an OFFLINE, DETERMINISTIC linter, so
  // credit awareness must NOT leak into the default. `lintPlan` derives a corpus and no credit
  // set; the credit read lives only where `projectPlan` is already resolved (lintPlanCommand's
  // `--base` pass). This asserts that boundary rather than trusting it.
  const plan = planOf([task({ id: "W1-T2581", files: [...SEVEN] }), task({ id: "W1-T2589", files: [...FOUR_SUBSET] })]);
  const v = lintPlan(plan).get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(v.length, 1, "the network-free default still reports on status: alone — deterministic, no projection consulted");
});

// ── the production producer: what lintPlanCommand's --base pass actually supplies ──────────────
//
// Everything above hands `mergedTaskIds` in by hand. That proves the exclusion WORKS; it does not
// prove anything real ever supplies it — the exact gap that left this criterion unmet twice. The
// supplier is `lintPlanCommand`'s `--base` pass, which already resolves `projectPlan`'s batched
// projection for `postMergeAmendment.merged`. Both derivations are exported so they can be driven
// here directly rather than only from inside a CLI.

test("surfaceCorpusFrom derives the corpus from the plan every caller already holds", () => {
  const plan = planOf([task({ id: "W1-T2581", files: [...SEVEN] }), task({ id: "W1-T2589", files: [...FOUR_SUBSET], status: "merged" })]);
  assert.deepEqual(surfaceCorpusFrom(plan), [
    { id: "W1-T2581", files: SEVEN, status: "queued" },
    { id: "W1-T2589", files: FOUR_SUBSET, status: "merged" },
  ]);

  // ...and it feeds the real check: the corpus this produces reports the observed pair.
  const v = duplicateSurfaceViolations(task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), { openTaskSurfaces: surfaceCorpusFrom(plan) });
  assert.equal(v.length, 1, "the derived corpus is the one the check actually consumes");
});

test("creditedMergedIdsFrom reads projectPlan's projection — merged in, unmerged out", () => {
  const proj = (merged: boolean, indeterminate = false) => ({ merged, indeterminate }) as never;
  const ids = creditedMergedIdsFrom(
    new Map([
      ["W1-T2581", proj(true)],
      ["W1-T2589", proj(false)],
    ]),
  );
  assert.deepEqual([...ids!].sort(), ["W1-T2581"]);
});

test("an INDETERMINATE projection is not credited — a rate-limited read must not resurrect a landed shard as live work", () => {
  // The failure this excludes: a mid-batch auth/rate-limit failure reads as "not merged", the
  // landed shard re-enters the corpus, and the check reports it against live work. Same per-task
  // fail-open `postMergeAmendment` already applies to this projection.
  const proj = (merged: boolean, indeterminate = false) => ({ merged, indeterminate }) as never;
  const ids = creditedMergedIdsFrom(new Map([["W1-T2581", proj(true, true)]]));
  assert.deepEqual([...ids!], [], "merged but indeterminate is not credit");
});

test("no projection is not an empty projection — absent means `read status: alone`, and that is what keeps the offline pass offline", () => {
  assert.equal(creditedMergedIdsFrom(undefined), undefined, "undefined in, undefined out — never a silently-empty set");
  // The distinction is load-bearing: an empty SET would still be a credit answer, and collapsing
  // the two would make the network-free pass claim it had consulted a projection it never read.
  assert.deepEqual([...creditedMergedIdsFrom(new Map())!], [], "an empty map IS a resolved answer, and it is empty");
});

// ── the call site itself, executed ─────────────────────────────────────────────────────────────
//
// The two derivations above are exported and driven directly, which proves they COMPUTE the right
// thing. It does not prove `lintPlanCommand` passes them: deleting either from the opts literal
// reddened NOTHING in the tests above, which is precisely the "wired nowhere" shape that left this
// criterion unmet twice. Only executing the real `--base` pass can catch that, so these two do.
//
// The fixture is COMMITTED with one task and rewritten on disk to add a second whose files are a
// strict subset, giving `--base HEAD` a real changed-task diff; it is restored byte-for-byte in a
// `finally` no matter the outcome. `projectPlan` is injected, so no network is touched.

const DSC_FIXTURE = fileURLToPath(new URL("./fixtures/duplicate-surface-credit/tasks.yaml", import.meta.url));
const DSC_BASE_YAML = readFileSync(DSC_FIXTURE, "utf8");
const DSC_WITH_DUPLICATE =
  DSC_BASE_YAML +
  `- id: DSC-NEW
  title: fixture task whose surface is a strict subset of DSC-BASE (W1-T2676 producer coverage)
  repo: remudero
  type: implement
  origin: "test fixture (W1-T2676 coverage, not a real plan entry)"
  files: [src/lib/merge-hold.ts, src/run-task.ts, test/merge-hold.test.ts]
`;

async function runDscBase(baseMerged: boolean): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(String(m));
  console.error = (m: string) => logs.push(String(m));
  console.warn = () => {};
  writeFileSync(DSC_FIXTURE, DSC_WITH_DUPLICATE, "utf8");
  try {
    await lintPlanCommand(["--plan", DSC_FIXTURE, "--base", "HEAD"], {
      loadConfig: () => ({ root: "/tmp/rmd-dsc-unused" }) as never,
      resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
      ghGateway: () => ({}) as never,
      // DSC-BASE keeps `status: queued` in the fixture either way — CREDIT is the only thing
      // that differs between the two runs, which is exactly the signal under test.
      projectPlan: () =>
        new Map([["DSC-BASE", { taskId: "DSC-BASE", status: baseMerged ? "merged" : "queued", merged: baseMerged, source: "none" }]]) as never,
    });
    return logs.join("\n");
  } finally {
    writeFileSync(DSC_FIXTURE, DSC_BASE_YAML, "utf8");
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/** The summary's warning tally. `lint-plan` PRINTS only blocking violations per task and counts
 *  warnings in its summary line, so a `duplicate-surface` warning is observable here and nowhere
 *  else in the output. Keyed on the count deliberately: a first draft matched /duplicate-surface/
 *  over the whole log and PASSED against the fixture's own PATH
 *  (`fixtures/duplicate-surface-credit/tasks.yaml`) while the check itself never fired -- a
 *  recognizer matching something real, and the wrong real thing. */
function warningCount(out: string): number {
  const m = /— \d+ failing, (\d+) warning\(s\)/.exec(out);
  assert.ok(m, `no lint-plan summary line in output:\n${out}`);
  return Number(m![1]);
}

test("lintPlanCommand --base: the real call site supplies the corpus — the pair is warned about through the executed path", async () => {
  const out = await runDscBase(false);
  assert.match(out, /1 task\(s\) checked \(1 new\/changed vs HEAD\)/, "the --base pass really linted the added task, so this is not a vacuous run");
  assert.equal(warningCount(out), 2, "duplicate-surface is one of these; without the corpus the --base pass warns once");
});

test("lintPlanCommand --base: a CREDITED-merged shard is not reported, though its status: still reads queued", async () => {
  // The ONLY difference between this run and the one above is projectPlan's credit answer: the
  // fixture bytes, the plan, the diff and DSC-BASE's `status: queued` are all identical. One
  // warning disappears, and it is the duplicate-surface one.
  const credited = warningCount(await runDscBase(true));
  const uncredited = warningCount(await runDscBase(false));
  assert.equal(uncredited - credited, 1, "credit removes exactly one warning — the pair against a shard that already shipped");
  assert.equal(credited, 1, "and nothing else changed: the remaining warning is unrelated to credit");
});

test("lintPlan with merge credit: a queued candidate already credited as merged is not counted as live work", () => {
  const plan = planOf([
    task({ id: "W1-T2581", files: [...SEVEN] }), // yaml stays queued after merge
    task({ id: "W1-T2589", files: [...FOUR_SUBSET] }),
  ]);
  const v = lintPlan(plan, () => ({ mergedTaskIds: new Set(["W1-T2581"]) }))
    .get("W1-T2589")!
    .violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(v, [], "external merge credit must exclude history even when yaml still says queued");

  const reported = lintPlan(plan, () => ({ mergedTaskIds: new Set() }))
    .get("W1-T2589")!
    .violations.filter((x) => x.check === "duplicate-surface");
  assert.equal(reported.length, 1, "removing only the injected credit makes the same plan report");
});

test("lintPlan with merge credit: a queued task credited as merged reports nothing on its own side", () => {
  const plan = planOf([
    task({ id: "W1-T2581", files: [...SEVEN] }),
    task({ id: "W1-T2589", files: [...FOUR_SUBSET] }), // yaml stays queued after merge
  ]);
  const results = lintPlan(plan, () => ({ mergedTaskIds: new Set(["W1-T2589"]) }));
  const v = results.get("W1-T2589")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(v, [], "a credited task is history on its own side too");

  const other = results.get("W1-T2581")!.violations.filter((x) => x.check === "duplicate-surface");
  assert.deepEqual(other, [], "the credited shard is not live work for its counterpart either");
});
