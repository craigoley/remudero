import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanPlanCoherence, type PlanCoherenceShardEntry } from "../src/lib/plan-coherence.js";
import { loadPlan } from "../src/lib/plan.js";
import {
  buildGather,
  planCoherenceRung,
  planCoherenceSectionFor,
  renderGather,
  renderPlanCoherence,
  type PlanCoherenceShardListing,
} from "../src/lib/retro.js";

// W1-T2642 — THE MONOLITH-VS-SHARD QUESTION, MEASURED. `loadPlan`'s merged view is coherent by
// construction (duplicate ids and unresolved `depends_on` both throw `PlanError`), but the two
// registries beside it are unchecked until this module: a shard's FILENAME id (shardSlugFromPath)
// vs. the record id actually inside it, and the one-task-per-file filing convention
// `monolithFilingViolations`' own message asserts and nothing verifies. Every fixture below is
// hand-authored, never the live plan — the suite must not go red just because the plan changed.

const MONOLITH_PATH = "plan/tasks.yaml";

/** A minimal well-formed task entry — the smallest shape `parseTasksFromYaml` accepts (mirrors
 *  test/main-plan-load-guard.test.ts's own `task` helper). */
const task = (id: string, extra = ""): string =>
  [`- id: ${id}`, `  title: ${id.toLowerCase()}`, "  repo: remudero", "  type: implement", extra]
    .filter(Boolean)
    .join("\n");

const taskList = (...ids: string[]): string => (ids.length === 0 ? "[]" : ids.map((id) => task(id)).join("\n"));

const shard = (path: string, text: string): PlanCoherenceShardEntry => ({ path, text });

/** Write a plan tree (monolith + shards) to a fresh temp dir; return the tasks.yaml path — for
 *  the ONE test that must exercise the real {@link loadPlan}, not merely a fixture text blob. */
function planTree(monolithText: string, shards: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-coherence-"));
  const monolithPath = join(dir, "tasks.yaml");
  writeFileSync(monolithPath, monolithText + "\n");
  const names = Object.keys(shards);
  if (names.length > 0) {
    mkdirSync(join(dir, "tasks.d"), { recursive: true });
    for (const name of names) writeFileSync(join(dir, "tasks.d", name), shards[name] + "\n");
  }
  return monolithPath;
}

// ── ACCEPTANCE #1 ────────────────────────────────────────────────────────────────────────
// "a shard whose FILENAME id differs from the record id inside it is NAMED with both ids and
// its path — the disagreement shardSlugFromPath structurally cannot see, because it parses the
// path and never opens the file"

test("ACCEPTANCE #1: a shard's filename id disagreeing with its record id is named with both ids and the path", () => {
  const scan = scanPlanCoherence(
    { path: MONOLITH_PATH, text: taskList("W1-T900") },
    [shard("plan/tasks.d/W1-T1-some-slug.yaml", task("W1-T2"))],
  );
  assert.equal(scan.findings.length, 1);
  const [finding] = scan.findings;
  assert.equal(finding.kind, "filename-id-mismatch");
  if (finding.kind !== "filename-id-mismatch") return;
  assert.equal(finding.path, "plan/tasks.d/W1-T1-some-slug.yaml");
  assert.equal(finding.filenameId, "W1-T1");
  assert.equal(finding.recordId, "W1-T2");

  const report = planCoherenceRung({ path: MONOLITH_PATH, text: taskList("W1-T900") }, {
    ok: true,
    entries: [shard("plan/tasks.d/W1-T1-some-slug.yaml", task("W1-T2"))],
  });
  assert.equal(report.kind, "findings");
  const rendered = renderPlanCoherence(report);
  assert.match(rendered, /W1-T1/);
  assert.match(rendered, /W1-T2/);
  assert.match(rendered, /plan\/tasks\.d\/W1-T1-some-slug\.yaml/);
});

test("a shard whose filename id AGREES with its record id is silent", () => {
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: taskList() }, [
    shard("plan/tasks.d/W1-T1-some-slug.yaml", task("W1-T1")),
  ]);
  assert.deepEqual(scan.findings, []);
});

// ── ACCEPTANCE #2 ────────────────────────────────────────────────────────────────────────
// "a shard holding two task records, and a shard holding none, are each NAMED — the
// one-task-per-file convention monolithFilingViolations' own message asserts and no check
// verifies"

test("ACCEPTANCE #2: a shard holding TWO task records is named with its record count and ids", () => {
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: taskList() }, [
    shard("plan/tasks.d/W1-T1-some-slug.yaml", taskList("W1-T1", "W1-T2")),
  ]);
  assert.equal(scan.findings.length, 1);
  const [finding] = scan.findings;
  assert.equal(finding.kind, "filing-count");
  if (finding.kind !== "filing-count") return;
  assert.equal(finding.path, "plan/tasks.d/W1-T1-some-slug.yaml");
  assert.equal(finding.recordCount, 2);
  assert.deepEqual(finding.recordIds, ["W1-T1", "W1-T2"]);
});

test("ACCEPTANCE #2: a shard holding ZERO task records is named with recordCount 0", () => {
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: taskList() }, [
    shard("plan/tasks.d/W1-T1-some-slug.yaml", "[]"),
  ]);
  assert.equal(scan.findings.length, 1);
  const [finding] = scan.findings;
  assert.equal(finding.kind, "filing-count");
  if (finding.kind !== "filing-count") return;
  assert.equal(finding.recordCount, 0);
  assert.deepEqual(finding.recordIds, []);

  const rendered = renderPlanCoherence(
    planCoherenceRung({ path: MONOLITH_PATH, text: taskList() }, {
      ok: true,
      entries: [shard("plan/tasks.d/W1-T1-some-slug.yaml", "[]")],
    }),
  );
  assert.match(rendered, /0 task record/);
});

test("a two-record shard does NOT also fire filename-id-mismatch — filing-count is the whole story there", () => {
  // filenameId W1-T1 matches neither W1-T2 nor W1-T3, but with 2 records "the record id" is not
  // a single well-defined thing to compare against, so only filing-count fires.
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: taskList() }, [
    shard("plan/tasks.d/W1-T1-some-slug.yaml", taskList("W1-T2", "W1-T3")),
  ]);
  assert.deepEqual(
    scan.findings.map((f) => f.kind),
    ["filing-count"],
  );
});

// ── unparseable-path (design's third finding class, structural sibling of the two above) ──

test("a shard path that shardSlugFromPath cannot parse is named as unparseable, not silently skipped", () => {
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: taskList() }, [
    shard("plan/tasks.d/not-a-task-shape.yaml", task("W1-T1")),
  ]);
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0].kind, "unparseable-path");
  if (scan.findings[0].kind !== "unparseable-path") return;
  assert.equal(scan.findings[0].path, "plan/tasks.d/not-a-task-shape.yaml");
});

// ── ACCEPTANCE #3 ────────────────────────────────────────────────────────────────────────
// "an id held by BOTH the monolith and a shard is reported as a finding, and the report's
// verdict AGREES with loadPlan on the identical fixture — never a second opinion about what
// the plan contains"

test("ACCEPTANCE #3: an id held by both the monolith and a shard is reported, agreeing with loadPlan on the SAME fixture", () => {
  const monolithText = taskList("W1-T1");
  const shardText = task("W1-T1");

  // The rung's verdict:
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: monolithText }, [
    shard("plan/tasks.d/W1-T1-some-slug.yaml", shardText),
  ]);
  const dup = scan.findings.find((f) => f.kind === "cross-file-duplicate");
  assert.ok(dup, "expected a cross-file-duplicate finding");
  if (dup?.kind !== "cross-file-duplicate") return;
  assert.equal(dup.id, "W1-T1");
  assert.equal(dup.firstPath, MONOLITH_PATH);
  assert.equal(dup.secondPath, "plan/tasks.d/W1-T1-some-slug.yaml");

  // loadPlan's verdict, over literally the SAME bytes written to disk — must also refuse,
  // naming the same id.
  const planPath = planTree(monolithText, { "W1-T1-some-slug.yaml": shardText });
  assert.throws(() => loadPlan(planPath), /duplicate task id 'W1-T1'/);
});

test("no cross-file-duplicate finding, and loadPlan agrees, when every id is unique", () => {
  const monolithText = taskList("W1-T1");
  const shardText = task("W1-T2");
  const scan = scanPlanCoherence({ path: MONOLITH_PATH, text: monolithText }, [
    shard("plan/tasks.d/W1-T2-some-slug.yaml", shardText),
  ]);
  assert.deepEqual(scan.findings, []);

  const planPath = planTree(monolithText, { "W1-T2-some-slug.yaml": shardText });
  assert.doesNotThrow(() => loadPlan(planPath));
});

// ── ACCEPTANCE #4 ────────────────────────────────────────────────────────────────────────
// "a clean corpus renders the counts it examined (shards read, monolith records read,
// disagreements zero) and never a bare zero, so a check that did not run is distinguishable
// from a check that passed"

test("ACCEPTANCE #4: a clean corpus renders the counts examined, never a bare zero", () => {
  const shards: PlanCoherenceShardListing = {
    ok: true,
    entries: [
      shard("plan/tasks.d/W1-T1-alpha.yaml", task("W1-T1")),
      shard("plan/tasks.d/W1-T2-beta.yaml", task("W1-T2")),
    ],
  };
  const report = planCoherenceRung({ path: MONOLITH_PATH, text: taskList("W1-T900", "W1-T901") }, shards);
  assert.equal(report.kind, "clean");
  if (report.kind !== "clean") return;
  assert.equal(report.shardsExamined, 2);
  assert.equal(report.monolithRecordsExamined, 2);

  const rendered = renderPlanCoherence(report);
  assert.doesNotMatch(rendered, /^\s*0\s*$/m); // never a bare, unexplained zero
  assert.match(rendered, /2 shard\(s\)/);
  assert.match(rendered, /2 monolith record\(s\)/);
  assert.match(rendered, /zero/i);
});

// ── ACCEPTANCE #5 ────────────────────────────────────────────────────────────────────────
// "an unreadable plan directory renders `unexamined` with its stated reason, never a silent
// clean; and the module makes no network or gateway call, so it has no `unavailable` state to
// degrade into"

test("ACCEPTANCE #5: an unreadable plan directory renders UNEXAMINED with its stated reason, never a silent clean", () => {
  const shards: PlanCoherenceShardListing = { ok: false, reason: "EACCES: permission denied, scandir 'plan/tasks.d'" };
  const report = planCoherenceRung({ path: MONOLITH_PATH, text: taskList("W1-T1") }, shards);
  assert.equal(report.kind, "unexamined");
  if (report.kind !== "unexamined") return;
  assert.match(report.reason, /EACCES/);

  const rendered = renderPlanCoherence(report);
  assert.match(rendered, /UNEXAMINED/);
  assert.doesNotMatch(rendered, /No disagreements/);
});

test("ACCEPTANCE #5: there is no unavailable state to construct — the type only carries unexamined/clean/findings", () => {
  // Compile-time proof lives in the PlanCoherenceReport union itself (retro.ts); this is the
  // runtime companion — every reachable `kind` for a report this rung can actually produce.
  const clean = planCoherenceRung({ path: MONOLITH_PATH, text: taskList() }, { ok: true, entries: [] });
  const unexamined = planCoherenceRung({ path: MONOLITH_PATH, text: taskList() }, { ok: false, reason: "boom" });
  const findings = planCoherenceRung({ path: MONOLITH_PATH, text: taskList() }, {
    ok: true,
    entries: [shard("plan/tasks.d/not-a-task-shape.yaml", task("W1-T1"))],
  });
  for (const report of [clean, unexamined, findings]) {
    assert.ok(["clean", "unexamined", "findings"].includes(report.kind));
  }
});

// ── the retro-facing composition, and a full multi-finding integration pass ────────────────

test("planCoherenceSectionFor composes the rung and the render into one call, for a multi-finding corpus", () => {
  const shards: PlanCoherenceShardListing = {
    ok: true,
    entries: [
      shard("plan/tasks.d/W1-T1-alpha.yaml", task("W1-T9")), // filename/record mismatch
      shard("plan/tasks.d/W1-T2-beta.yaml", taskList("W1-T2", "W1-T3")), // filing-count
      shard("plan/tasks.d/broken-name.yaml", task("W1-T4")), // unparseable path
      shard("plan/tasks.d/W1-T500-gamma.yaml", task("W1-T500")), // cross-file duplicate w/ monolith
    ],
  };
  const section = planCoherenceSectionFor({ path: MONOLITH_PATH, text: taskList("W1-T500") }, shards);
  assert.match(section, /## Plan-coherence rung/);
  assert.match(section, /W1-T9/);
  assert.match(section, /W1-T2, W1-T3/);
  assert.match(section, /broken-name\.yaml/);
  assert.match(section, /W1-T500/);
  assert.match(section, /4 disagreement\(s\)/);
});

// ── ACCEPTANCE #6 ────────────────────────────────────────────────────────────────────────
// "the rung has a LIVE CALL SITE in the retro — the fourteen-cycle question is answered every
// cycle by measurement rather than re-asked in prose, and this module is not a signal read by
// nothing"
//
// `buildGather` is called UNCONDITIONALLY every `rmd retro` cycle (retroCommand, run-task.ts)
// and its result is fed straight into `renderGather`, which produces the actual retro report
// text (both --dry-run and the real automated run). `planCoherenceRung(` is called FROM INSIDE
// `buildGather` UNCONDITIONALLY TOO — never gated behind whether the caller supplied
// `opts.planCoherence` — so `RetroGather.planCoherence` is NEVER omitted: absent real plan
// bytes it reports (and `renderGather` prints) `unexamined` with a stated reason, a genuine
// every-cycle answer rather than silence. This is the whole difference between "this rung is
// read by nothing" and "this rung answers the fourteen-cycle question every cycle the retro
// already runs" — even before `retroCommand` is wired to supply real bytes.

const MINIMAL_LEDGER = "";
const MINIMAL_LEARNINGS = "# L\n";

test("ACCEPTANCE #6: buildGather still COMPUTES planCoherence (never omits it), rendering UNEXAMINED, when the caller supplies nothing", () => {
  const g = buildGather({ ledgerNdjson: MINIMAL_LEDGER, learningsMd: MINIMAL_LEARNINGS });
  assert.notEqual(g.planCoherence, undefined, "planCoherenceRung must be called even when opts.planCoherence is omitted");
  assert.equal(g.planCoherence.kind, "unexamined");
  const rendered = renderGather(g);
  assert.match(rendered, /## Plan-coherence rung/);
  assert.match(rendered, /UNEXAMINED/);
  assert.match(rendered, /opts\.planCoherence/);
});

test("ACCEPTANCE #6: buildGather COMPUTES planCoherenceRung, and renderGather prints the clean section, when the caller wires plan/tasks.yaml + shards in", () => {
  const g = buildGather({
    ledgerNdjson: MINIMAL_LEDGER,
    learningsMd: MINIMAL_LEARNINGS,
    planCoherence: {
      monolith: { path: MONOLITH_PATH, text: taskList("W1-T1") },
      shards: { ok: true, entries: [shard("plan/tasks.d/W1-T2-beta.yaml", task("W1-T2"))] },
    },
  });
  assert.ok(g.planCoherence, "buildGather must have run the census, not left it undefined");
  assert.equal(g.planCoherence?.kind, "clean");
  const rendered = renderGather(g);
  assert.match(rendered, /## Plan-coherence rung/);
  assert.match(rendered, /No disagreements/);
});

test("ACCEPTANCE #6: a real disagreement supplied through buildGather surfaces in renderGather's report, naming the offender", () => {
  const g = buildGather({
    ledgerNdjson: MINIMAL_LEDGER,
    learningsMd: MINIMAL_LEARNINGS,
    planCoherence: {
      monolith: { path: MONOLITH_PATH, text: taskList() },
      shards: { ok: true, entries: [shard("plan/tasks.d/W1-T1-alpha.yaml", task("W1-T9"))] },
    },
  });
  assert.equal(g.planCoherence?.kind, "findings");
  const rendered = renderGather(g);
  assert.match(rendered, /## Plan-coherence rung/);
  assert.match(rendered, /W1-T1/);
  assert.match(rendered, /W1-T9/);
});

test("ACCEPTANCE #6: an unlistable plan/tasks.d/ wired through buildGather renders UNEXAMINED in the retro report, never a silent clean", () => {
  const g = buildGather({
    ledgerNdjson: MINIMAL_LEDGER,
    learningsMd: MINIMAL_LEARNINGS,
    planCoherence: {
      monolith: { path: MONOLITH_PATH, text: taskList("W1-T1") },
      shards: { ok: false, reason: "EACCES: permission denied, scandir 'plan/tasks.d'" },
    },
  });
  assert.equal(g.planCoherence?.kind, "unexamined");
  const rendered = renderGather(g);
  assert.match(rendered, /UNEXAMINED/);
  assert.doesNotMatch(rendered, /No disagreements/);
});
