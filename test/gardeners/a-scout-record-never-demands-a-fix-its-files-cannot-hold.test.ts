import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { GardenCheckout } from "#src/lib/gardener.js";
import { machineShardLintRefusal } from "#src/lib/machine-filing.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import { SCOUT_WINDOW_MS, isScoutInvestigation, scoutGardenSpec, scoutShard, scoutSurvival, type ScoutSources } from "#src/lib/scout-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 24 * 3_600_000;
const FIX_CLAIM = (step: string): string => `${step} stops recurring: its cause is fixed rather than its rows hidden`;
const INVESTIGATION_CLAIM = (step: string): string => `the code that writes ${step} is located and named`;
const isTest = (path: string): boolean => /^test\//.test(path);
/** A claim that asks for the cause to be fixed, as the scout words one. */
const demandsFix = (claim: string): boolean => /stops recurring|\bfix(?:ed)?\b/i.test(claim.replace(/^invariant:.*/, ""));

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Task id → the shard a fixture draft was written to; its filename slug matches its test, as a filed shard's does. */
const SHARDS = new Map<string, string>();

/** A queued test-only fix draft as the scout filed it before W1-T10261: no design, one fix claim, one test file. */
function legacyDraft(id: string, step: string, risk = "low"): { path: string; text: string; test: string } {
  const slug = step.replace(/[._]/g, "-");
  const test = `test/scout-${slug}.test.ts`;
  const text = [
    `- id: ${id}`,
    `  title: "THE SCOUT'S UNCOVERED RECURRING SYMPTOM — ${step} landed 2 ledger rows across the trailing window and no task cites it"`,
    "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", `  risk: ${risk}`, "  priority: 3.86",
    "  status: queued", "  attempts: 0", "  author_class: machine", `  origin: "scout:${step}"`,
    "  files:", `    - ${test}`,
    "  acceptance:",
    `    - claim: ${JSON.stringify(FIX_CLAIM(step))}`,
    `      proof: ${JSON.stringify(`grep: test("${id}: ${step} no longer recurs" in ${test}`)}`,
    "  rationale: |",
    `    The ledger step ${step} carries a failure shape and landed rows in both halves of the trailing 7 days.`,
    "    The rows name no file of their own: locate the code that writes this step first, then fix its cause.",
    "",
  ].join("\n");
  const path = `plan/tasks.d/${id}-scout-${slug}.yaml`;
  SHARDS.set(id, path);
  return { path, text, test };
}

interface Fixture { drafts: Task[]; all?: Task[]; merged?: Record<string, number>; ledger?: Record<string, unknown>[]; active?: string[]; rows?: Array<{ step: string; fields: Record<string, unknown> }> }
function spec(root: string, f: Fixture, extra: Partial<ScoutSources> = {}) {
  const rows = f.rows ?? [];
  return scoutGardenSpec({ repoRoot: root, stateDir: root, clock: fixedClock(NOW), log: (step, fields = {}) => rows.push({ step, fields }),
    openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => { throw new Error("a re-derived draft keeps its id"); },
    plan: () => ({ all: f.all ?? f.drafts, open: f.drafts.filter((t) => t.status === "queued"), shards: new Map(f.drafts.map((t) => [t.id, SHARDS.get(t.id)!])) }),
    ledger: () => f.ledger ?? [], mergedTasks: () => new Map(Object.entries(f.merged ?? {})), mergedLastDay: () => 5,
    pricedSteps: () => new Set(), openRunTasks: () => new Set(f.active ?? []), ...extra,
  });
}
const ws = (root: string): GardenCheckout => ({ root, branch: "scout-t13208" } as GardenCheckout);
const act = (s: ReturnType<typeof spec>) => { const inv = s.inventory(); return { inv, plan: { actions: s.candidates(inv, () => 0), acting: ["file-uncovered-symptom" as const] } }; };
const read = (root: string, path: string): Task => loadPlanFromYaml(readFileSync(join(root, path), "utf8"), path).tasks[0]!;

test("W1-T13208 criterion 1: a symptom whose writer the scout cannot locate is filed as an investigation with no fix claim", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c1" });
  const step = "shadow_judge.unavailable";
  const shard = scoutShard({ step, older: 1, newer: 1, total: 2, files: [] }, "W1-T99100", [2], repo.dir);
  assert.equal(shard.refused, undefined);
  const task = loadPlanFromYaml(shard.text, "inv.yaml").tasks[0]!;
  assert.equal(task.acceptance![0]!.claim, INVESTIGATION_CLAIM(step));
  assert.equal(isScoutInvestigation(task), true);
  assert.match(task.title, /INVESTIGATION/);
  assert.match(task.rationale ?? "", /INVESTIGATION/);
  assert.equal(task.files!.length, 1, "an investigation declares its own test and nothing else");
  assert.ok(isTest(task.files![0]!));
  for (const c of task.acceptance!) assert.equal(demandsFix(c.claim), false, c.claim);
  assert.ok(task.acceptance!.some((c) => c.claim.startsWith("invariant:symptom-still-recorded")), "the symptom-still-recorded invariant stays");
});

test("W1-T13208 criterion 2: a symptom whose writer is located is filed as a fix with the writer declared ahead of the test", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c2" });
  const step = "inbox.draft_error";
  put(repo.dir, "src/lib/inbox.ts", `log(${JSON.stringify(step)});`);
  repo.git("add", "src");
  for (const files of [[], ["src/named.ts"]]) {
    const shard = scoutShard({ step, older: 2, newer: 3, total: 5, files }, "W1-T99101", [5], repo.dir);
    assert.equal(shard.refused, undefined);
    const task = loadPlanFromYaml(shard.text, "fix.yaml").tasks[0]!;
    assert.equal(task.acceptance![0]!.claim, FIX_CLAIM(step));
    assert.equal(isScoutInvestigation(task), false);
    assert.deepEqual(task.files!.slice(0, -1), files.length > 0 ? files : ["src/lib/inbox.ts"]);
    assert.ok(isTest(task.files!.at(-1)!), "the scout test comes last");
  }
});

test("W1-T13208 criterion 3: a queued test-only fix draft is rewritten at the next pass, with its writers or as an investigation", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c3" });
  put(repo.dir, "src/lib/shadow-judge.ts", 'log("shadow_judge.unavailable");');
  repo.git("add", "src");
  const located = legacyDraft("W1-T99110", "shadow_judge.unavailable");
  const lost = legacyDraft("W1-T99111", "nothing.writes_failed");
  for (const d of [located, lost]) put(repo.dir, d.path, d.text);
  const drafts = [located, lost].map((d) => loadPlanFromYaml(d.text, d.path).tasks[0]!);
  assert.match(machineShardLintRefusal(located.text, located.path) ?? "", /design-invariant-proof/,
    "CONTROL: the draft as filed is refused by the lint the plan pull request ran, which is why no rewrite ever landed");
  const rows: NonNullable<Fixture["rows"]> = [];
  const s = spec(repo.dir, { drafts, rows });
  const { plan } = act(s);
  assert.equal(plan.actions.length, 2);
  const landed = s.apply(ws(repo.dir), plan, {});
  assert.deepEqual(landed!.paths.sort(), [located.path, lost.path].sort(), `both rewrites reach the plan: ${JSON.stringify(rows)}`);
  const fix = read(repo.dir, located.path);
  assert.deepEqual(fix.files, ["src/lib/shadow-judge.ts", located.test]);
  assert.equal(fix.acceptance![0]!.claim, FIX_CLAIM("shadow_judge.unavailable"));
  assert.equal(machineShardLintRefusal(readFileSync(join(repo.dir, located.path), "utf8"), located.path), undefined);
  const inv = read(repo.dir, lost.path);
  assert.deepEqual(inv.files, [lost.test]);
  assert.equal(inv.acceptance![0]!.claim, INVESTIGATION_CLAIM("nothing.writes_failed"));
  assert.match(inv.title, /INVESTIGATION/);
  assert.equal(machineShardLintRefusal(readFileSync(join(repo.dir, lost.path), "utf8"), lost.path), undefined);
  assert.equal(inv.verify, "human");
  // The investigation is no fix demand: the next pass leaves it alone.
  const next = spec(repo.dir, { drafts: [located, lost].map((d) => read(repo.dir, d.path)) });
  assert.deepEqual(act(next).plan.actions, []);
});

test("W1-T13208 criterion 4: a merged investigation's named writer makes the next record a fix, and the investigation is not debited", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c4" });
  const step = "widget.sync_failed";
  put(repo.dir, "src/lib/widget.ts", "export const sync = () => 1;\n");
  repo.git("add", "src");
  const shard = scoutShard({ step, older: 2, newer: 3, total: 5, files: [] }, "W1-T99120", [5], repo.dir);
  const investigation = loadPlanFromYaml(shard.text, "inv.yaml").tasks[0]!;
  investigation.status = "merged";
  put(repo.dir, investigation.files![0]!, `// scout-writer: src/lib/widget.ts\n// scout-writer: src/lib/ghost.ts\n`);
  const mergedAt = NOW - 10 * DAY;
  const ts = (f: number): string => new Date(NOW - SCOUT_WINDOW_MS * f).toISOString();
  const ledger = [0.9, 0.85, 0.2, 0.15].map((f) => ({ ts: ts(f), step }));
  const s = spec(repo.dir, { drafts: [], all: [investigation], merged: { [investigation.id]: mergedAt }, ledger }, { mintTaskId: () => "W1-T99121" });
  const inv = s.inventory();
  assert.deepEqual(inv.selected.map((x) => [x.step, x.files, x.investigated]), [[step, ["src/lib/widget.ts"], true]], "a ghost path the investigation named is dropped");
  const landed = s.apply(ws(repo.dir), { actions: s.candidates(inv, () => 0), acting: ["file-uncovered-symptom"] }, {}, ["W1-T99121"]);
  const fix = read(repo.dir, landed!.paths[0]!);
  assert.equal(fix.acceptance![0]!.claim, FIX_CLAIM(step));
  assert.deepEqual(fix.files!.slice(0, -1), ["src/lib/widget.ts"], "the fix declares the writer the investigation named");
  // Not debited: the rows continued after the merge, and the investigation still scores nothing.
  const rowsAfter = [...Array(6)].map((_, i) => ({ ts: new Date(mergedAt + (i + 1) * DAY).toISOString(), step }));
  const early = NOW - 40 * DAY;
  const plan = { open: [], all: [investigation], shards: new Map() };
  const scored = scoutSurvival(plan, new Map([[investigation.id, early]]), rowsAfter.map((r) => ({ ...r, ts: new Date(early + DAY).toISOString() })), NOW);
  assert.deepEqual(scored.outcome, { trials: 0, successes: 0 });
  assert.equal(scored.tracked[0]!.verdict, "investigation");
  const control = { ...investigation, acceptance: [{ claim: FIX_CLAIM(step), proof: "grep: x in y" }] };
  const debited = scoutSurvival({ ...plan, all: [control] }, new Map([[control.id, early]]), rowsAfter.map((r) => ({ ...r, ts: new Date(early + DAY).toISOString() })), NOW);
  assert.equal(debited.tracked[0]!.verdict, "debit", "CONTROL: a fix task with continuing rows is debited");
});

test("W1-T13208 criterion 5: the scorecard counts the queued fix drafts that declare only a test, by the reason each was left alone", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c5" });
  const step = "verify_human.release_escalated";
  for (const f of ["verify-human-judge", "verify-human-release"]) put(repo.dir, `src/lib/${f}.ts`, `log(${JSON.stringify(step)});`);
  put(repo.dir, "src/lib/widget.ts", 'log("widget.sync_failed");');
  repo.git("add", "src");
  const refused = legacyDraft("W1-T99130", step);
  const rewritable = legacyDraft("W1-T99131", "widget.sync_failed");
  const open = legacyDraft("W1-T99132", "widget.sync_failed");
  const ruled = legacyDraft("W1-T99133", "widget.sync_failed");
  const unreadable = legacyDraft("W1-T99134", "widget.sync_failed");
  const noShard = legacyDraft("W1-T99135", "widget.sync_failed");
  const ruling = `  risk_ruling:\n    verdict: operator\n    action: proceed\n    confidence: 1\n    reasons: ["ruled"]\n    judged_at: "2026-10-01T00:00:00Z"\n    pin: "${"a".repeat(64)}"\n`;
  for (const d of [refused, rewritable, open, unreadable, noShard]) put(repo.dir, d.path, d.text);
  put(repo.dir, ruled.path, ruled.text + ruling);
  const load = (d: { text: string; path: string }) => loadPlanFromYaml(d.text + (d === ruled ? ruling : ""), d.path).tasks[0]!;
  const tasks = [refused, rewritable, open, ruled, unreadable, noShard].map(load);
  const paths = new Map(tasks.map((x) => [x.id, SHARDS.get(x.id)!]));
  paths.set("W1-T99134", "plan/tasks.d/missing.yaml");
  paths.delete("W1-T99135");
  const s = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(NOW), log: () => {}, openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => { throw new Error("unused"); },
    plan: () => ({ all: tasks, open: tasks, shards: paths }),
    ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0, openRunTasks: () => new Set(["W1-T99132"]),
  });
  const inv = s.inventory();
  const card = s.scorecard(inv, { actions: s.candidates(inv, () => 0), acting: ["file-uncovered-symptom"] }) as { test_only_fix_drafts?: unknown };
  assert.deepEqual(card.test_only_fix_drafts, {
    total: 6, operator_ruled: 1, no_shard: 1, open_run: 1, rewritable: 1,
    rewrite_refused: { sizing: 1, "unreadable: Error": 1 },
  });
  // A plan with no such draft keeps the scorecard it always had.
  const empty = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(NOW), log: () => {}, openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => "W1-T1", plan: () => ({ all: [], open: [], shards: new Map() }), ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0,
  });
  const none = empty.inventory();
  assert.equal("test_only_fix_drafts" in empty.scorecard(none, { actions: [], acting: [] }), false);
});

test("W1-T13208 criterion 6: no record the scout writes or rewrites declares only a test file while a claim demands a fix", (t) => {
  const repo = gitRepo({ scope: t, kind: "t13208-c6" });
  put(repo.dir, "src/lib/shadow-judge.ts", 'log("shadow_judge.unavailable");');
  repo.git("add", "src");
  const located = legacyDraft("W1-T99140", "shadow_judge.unavailable");
  const lost = legacyDraft("W1-T99141", "nothing.writes_failed");
  const open = legacyDraft("W1-T99142", "shadow_judge.unavailable");
  const ruled = legacyDraft("W1-T99143", "shadow_judge.unavailable");
  const ruling = `  risk_ruling:\n    verdict: operator\n    action: proceed\n    confidence: 1\n    reasons: ["ruled"]\n    judged_at: "2026-10-01T00:00:00Z"\n    pin: "${"b".repeat(64)}"\n`;
  for (const d of [located, lost, open]) put(repo.dir, d.path, d.text);
  put(repo.dir, ruled.path, ruled.text + ruling);
  const drafts = [located, lost, open, ruled].map((d) => loadPlanFromYaml(d.text + (d === ruled ? ruling : ""), d.path).tasks[0]!);
  const s = spec(repo.dir, { drafts, active: ["W1-T99142"] });
  const { plan } = act(s);
  assert.deepEqual(plan.actions.map((a) => a.draft!.id).sort(), ["W1-T99140", "W1-T99141"], "the operator-ruled draft and the one with an open run are not candidates");
  s.apply(ws(repo.dir), plan, {});
  assert.equal(readFileSync(join(repo.dir, ruled.path), "utf8"), ruled.text + ruling, "the operator-ruled draft is untouched");
  assert.equal(readFileSync(join(repo.dir, open.path), "utf8"), open.text, "the draft with an open run is untouched");
  const written = [
    ...[located, lost].map((d) => read(repo.dir, d.path)),
    ...[{ step: "shadow_judge.unavailable", files: [] }, { step: "nothing.writes_failed", files: [] }, { step: "x.run_failed", files: ["src/x.ts"] }]
      .map((x) => loadPlanFromYaml(scoutShard({ ...x, older: 1, newer: 1, total: 2 }, "W1-T99144", [2], repo.dir).text, "w.yaml").tasks[0]!),
  ];
  assert.equal(written.length, 5);
  for (const task of written) {
    const hasSource = task.files!.some((f) => !isTest(f));
    const asksFix = task.acceptance!.some((c) => demandsFix(c.claim));
    assert.ok(hasSource || !asksFix, `${task.id}: declares only a test (${task.files!.join(", ")}) and demands a fix`);
    assert.ok(hasSource || isScoutInvestigation(task), `${task.id}: a test-only record must be an investigation`);
  }
});
