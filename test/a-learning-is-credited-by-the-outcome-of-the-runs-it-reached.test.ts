/**
 * test/a-learning-is-credited-by-the-outcome-of-the-runs-it-reached.test.ts — W1-T4241, W1-T11115.
 *
 * `selectLearnings` already randomizes which equally-matched learnings survive the budget cut. The
 * run now ledgers each contested entry's propensity, and `foldLearningOutcomes` joins injected vs
 * dropped to the run's clean-merge outcome with inverse-propensity weights.
 *
 * W1-T11115: an edit keeps a learning's id, so the fold credits the exact content revision a run
 * exposed. The producer ledgers one `lc1:` digest per contested entry, selected AND dropped, from the
 * draw's own snapshot; the fold groups by {id, revision} and counts every observation it cannot pin.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { learningsInjectedRow } from "#src/cli/commands/run-task-verb.js";
import { renderKnowledgeMeasured, renderLearningOutcomes, summarizeKnowledgeMeasured, summarizeLearningOutcomes } from "#src/lib/digest.js";
import { contestedPropensities, foldLearningOutcomes, OUTCOME_ARM_FLOOR } from "#src/lib/knowledge-outcome.js";
import { seedOf } from "#src/lib/knowledge-value.js";
import {
  AMBIGUOUS_LEARNING_CONTENT,
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  LEARNING_CONTENT_IDENTITY_RE,
  LEARNING_PROPENSITY_DRAWS,
  learningContentIdentities,
  learningContentIdentity,
  loadLearningsCorpus,
  propensitySeed,
  recordingSelectLearnings,
  selectLearnings,
  type LearningEntry,
} from "#src/lib/learnings.js";
import { computeMatchedLearningsForArm, REAL_LEARNINGS_INJECTION_DEPS } from "#src/lib/wipe-test.js";

const entry = (id: string, files: string[] = ["src/x.ts"], fact = "f".repeat(300)): LearningEntry =>
  ({ id, subsystem: "t", lifecycle: "active", files, fact, src: "t" }) as LearningEntry;

/** The revision every W1-T4241 fixture row exposes: one fixed `L`. */
const REV = learningContentIdentity(entry("L"));

type Row = Record<string, unknown>;
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 8, 1) + clock++ * 60_000).toISOString();

/** One run: its injected row (id -> propensity, injected or dropped), then its verdict unless omitted.
 *  `contentId: null` writes a pre-W1-T11115 (legacy) row, which carries no `content_ids` at all. */
function run(runId: string, p: number, injected: boolean, verdict: string | undefined, fixes = 0, id = "L", contentId: string | null = REV): Row[] {
  const rows: Row[] = [
    {
      step: "learnings.injected",
      run_id: runId,
      ts: ts(),
      matched_ids: injected ? [id] : [],
      dropped: injected ? [] : [id],
      propensity: { [id]: p },
      ...(contentId === null ? {} : { content_ids: { [id]: contentId } }),
    },
  ];
  for (let i = 0; i < fixes; i++) rows.push({ step: "fix.dispatch", run_id: runId, ts: ts() });
  if (verdict !== undefined) rows.push({ step: "verdict", run_id: runId, ts: ts(), verdict });
  return rows;
}

/** `n` runs at propensity `p`, `injectedCount` of them injected, each with the given outcome. */
function stratum(tag: string, n: number, p: number, injectedCount: number, outcome: (injected: boolean) => string, contentId: string | null = REV): Row[] {
  return Array.from({ length: n }, (_, i) => run(`${tag}-${i}`, p, i < injectedCount, outcome(i < injectedCount), 0, "L", contentId)).flat();
}

test("W1-T4241: contested entries carry a propensity and selection is unchanged", () => {
  // Four equal-strength ~330-char entries against a 700-char budget beside a tiny stronger one: two of
  // the four fit, and the draw decides which.
  const tied = ["a", "b", "c", "d"].map((id) => entry(id));
  const strong = entry("strong", ["src/x.ts", "src/y.ts"], "s");
  const files = ["src/x.ts", "src/y.ts"];
  const context = { usage: {}, seed: 42 };
  const plain = selectLearnings([...tied, strong], files, 700, context);
  const withP = selectLearnings([...tied, strong], files, 700, { ...context, propensityDraws: 64 });

  // Asking for propensities never changes what this run selects.
  assert.deepEqual(withP.selected.map((e) => e.id), plain.selected.map((e) => e.id));
  assert.deepEqual(withP.dropped.map((e) => e.id), plain.dropped.map((e) => e.id));
  assert.equal(plain.propensity, undefined);

  const p = withP.propensity!;
  assert.equal(p.strong, 1, "a higher match count is deterministic, not contested");
  for (const id of ["a", "b", "c", "d"]) assert.ok(p[id]! > 0 && p[id]! < 1, `${id} is contested: ${p[id]}`);
  // `strong` (~27 chars) leaves room for exactly two ~330-char tied entries in every re-selection,
  // so the tied propensities sum to 2 — each draw keeps two of the four.
  assert.equal(["a", "b", "c", "d"].reduce((sum, id) => sum + p[id]!, 0), 2);
  assert.equal(plain.selected.length, 3);
  // Reproducible from the run seed alone, and the derived seeds are the documented stride.
  assert.deepEqual(selectLearnings([...tied, strong], files, 700, { ...context, propensityDraws: 64 }).propensity, p);
  assert.notEqual(propensitySeed(42, 0), propensitySeed(42, 1));

  // No usage history means no draw: nothing is randomized, so nothing is contested.
  const noUsage = selectLearnings([...tied, strong], files, 700, { seed: 42, propensityDraws: 64 }).propensity!;
  assert.ok(Object.values(noUsage).every((v) => v === 0 || v === 1));
  assert.equal(contestedPropensities(noUsage), undefined);
  assert.deepEqual(contestedPropensities({ x: 0, y: 0.5, z: 1 }), { y: 0.5 });
});

test("W1-T4241: outcomes are weighted by inverse propensity with a per-arm floor", () => {
  // CONFOUNDED, NO TRUE EFFECT: runs at p=0.8 merge clean whether or not L is injected; runs at
  // p=0.2 never do. Injection follows p, so the NAIVE injected-vs-dropped rate reads +0.6.
  const confounded = [
    ...stratum("hi", 20, 0.8, 16, () => "merged"),
    ...stratum("lo", 20, 0.2, 4, () => "blocked_ci"),
  ];
  const naive = (() => {
    const inj = [16, 4];
    return 16 / (inj[0]! + inj[1]!) - 4 / (4 + 16);
  })();
  assert.ok(Math.abs(naive - 0.6) < 1e-9, "the fixture is confounded as intended");
  const none = foldLearningOutcomes(confounded).learnings[0]!;
  assert.equal(none.verdict, "no-detectable-effect");
  assert.ok(Math.abs(none.effect!) < 1e-9, `IPW removes the confounding: ${none.effect}`);

  // A REAL EFFECT: injected runs merge clean, dropped runs do not, at the same propensities.
  const real = [...stratum("hi", 20, 0.8, 16, (inj) => (inj ? "merged" : "blocked_ci")), ...stratum("lo", 20, 0.2, 4, (inj) => (inj ? "merged" : "blocked_ci"))];
  const helps = foldLearningOutcomes(real).learnings[0]!;
  assert.equal(helps.verdict, "helps");
  assert.equal(helps.effect, 1);
  const hurts = foldLearningOutcomes([...stratum("hi", 20, 0.5, 10, (inj) => (inj ? "blocked_ci" : "merged"))]).learnings[0]!;
  assert.equal(hurts.verdict, "hurts");

  // Below the floor in either arm: unmeasurable, with its counts — never a favourable reading.
  const few = foldLearningOutcomes(stratum("few", 3, 0.5, 2, () => "merged")).learnings[0]!;
  assert.deepEqual(few, { id: "L", contentId: REV, injected: 2, dropped: 1, verdict: "unmeasurable" });
  assert.equal(OUTCOME_ARM_FLOOR, 10);

  // Propensities outside the trim are excluded and counted.
  const trimmed = foldLearningOutcomes([...run("t1", 0.02, true, "merged"), ...run("t2", 0.97, false, "merged")]);
  assert.equal(trimmed.excludedTrimmed, 2);
  assert.deepEqual(trimmed.learnings, []);
});

test("W1-T4241: a run with no terminal verdict is excluded and counted", () => {
  const rows = [
    ...run("done", 0.5, true, "merged"),
    ...run("inflight", 0.5, false, undefined),
    ...run("fixed", 0.5, false, "merged", 1),
    { step: "learnings.injected", run_id: "masked", ts: ts(), masked: true, matched_ids: [], propensity: { L: 0.5 } },
    { step: "learnings.injected", run_id: "no-p", ts: ts(), matched_ids: ["L"] },
  ];
  const r = foldLearningOutcomes(rows, { floor: 1 });
  assert.equal(r.excludedNoVerdict, 1);
  assert.equal(r.excludedMasked, 1);
  assert.equal(r.runs, 2, "the verdict-less, masked and propensity-less runs contribute nothing");
  // `fixed` merged only after a fix rung: not clean, so the dropped arm reads 0 and the injected 1.
  assert.deepEqual({ ...r.learnings[0]!, se: undefined }, { id: "L", contentId: REV, injected: 1, dropped: 1, effect: 1, se: undefined, verdict: "helps" });
  assert.ok(r.window && r.window.from < r.window.to);
});

test("W1-T4241: the digest names measured effects and disagreements with LEARNINGS_USED", () => {
  const rows: Row[] = [
    ...stratum("hi", 20, 0.5, 10, (inj) => (inj ? "blocked_ci" : "merged")),
    // Workers claim to use L almost every time it is offered.
    ...Array.from({ length: 12 }, (_, i) => ({ step: "learnings.used", run_id: `u${i}`, injected_ids: ["L"], used_ids: ["L"] })),
  ];
  const s = summarizeLearningOutcomes(rows)!;
  assert.deepEqual(s.disagreements.map((d) => [d.id, d.verdict]), [["L", "hurts"]]);
  const line = renderLearningOutcomes(s);
  assert.match(line, /learning outcomes \(20 contested run\(s\)/);
  assert.match(line, /L -1\.00 ±0\.00 \(n 10\/10\)/);
  assert.match(line, /disagrees with LEARNINGS_USED: L hurts but used-mean 0\.93/);
  assert.equal(summarizeLearningOutcomes([{ step: "learnings.injected", run_id: "x", matched_ids: [] }]), undefined);
  assert.match(renderLearningOutcomes(summarizeLearningOutcomes(stratum("q", 3, 0.5, 1, () => "merged"))!), /no detectable effect; 0 measured, 1 unmeasurable/);
});

// ── W1-T11115: the exact content revision ───────────────────────────────────────────────────

/** The fixture task's one file; every producer corpus entry matches it with equal strength. */
const PRODUCER_TASK_FILE = "src/lib/daemon.ts";
const PRODUCER_RUN_ID = "T-LEARN-REVISION-1785100000000";
/** Written into every producer fact; it must never appear in a ledger row. */
const RAW_FACT_SENTINEL = "RAW-FACT-SENTINEL";

interface ProducerRun {
  /** The `learnings.injected` row the producer builds for the draw, after a ledger JSON round trip. */
  row: Row;
  /** The same row for a masked wipe-test arm B. */
  maskedRow: Row;
  /** The corpus the draw read, parsed again from the same shard. */
  corpus: LearningEntry[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The producer path of an implement dispatch (run-task-verb.ts's runTaskBody), over a real corpus on
 *  disk: the layered load, the real selector wrapped by `recordingSelectLearnings`, the production
 *  budget, draw count and run seed, then the producer's own `learningsInjectedRow`. 30 equal-strength
 *  ~430-char lines overflow the 8,148-char budget, so about 19 fit and the seeded draw decides which. */
function producerRun(duplicateIds: string[] = []): ProducerRun {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lcr-corpus-"));
  try {
    writeFileSync(
      join(dir, "revision.yaml"),
      Array.from({ length: 30 }, (_, i) => {
        const id = `lcr-${String(i).padStart(2, "0")}`;
        return [`- id: ${id}`, `  fact: "${RAW_FACT_SENTINEL}-${id} ${"x".repeat(380)}"`, '  src: "lcr-fixture"', `  files: ["${PRODUCER_TASK_FILE}"]`].join("\n");
      }).join("\n") + "\n",
    );
    const userOverallDir = join(dir, "user-layer");
    if (duplicateIds.length > 0) {
      mkdirSync(userOverallDir);
      writeFileSync(join(userOverallDir, "duplicates.yaml"), duplicateIds.map((id) =>
        `- id: ${id}\n  fact: "${RAW_FACT_SENTINEL} conflicting copy"\n  src: "lcr-fixture"\n  files: ["unrelated.ts"]\n`,
      ).join(""));
    }
    const usage = {};
    const input = {
      homes: { projectDir: dir, userOverallDir, globalArtifactPath: join(dir, "no-global-layer", "artifact.yaml") },
      taskFiles: [PRODUCER_TASK_FILE],
      selectionContext: { text: ["prove the producer names the exact learning revision it drew"], usage, seed: seedOf(PRODUCER_RUN_ID), propensityDraws: LEARNING_PROPENSITY_DRAWS },
      budgetChars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    };
    const rowForArm = (arm: "A" | "B"): Row => {
      const draw = recordingSelectLearnings();
      const result = computeMatchedLearningsForArm(arm, input, { ...REAL_LEARNINGS_INJECTION_DEPS, selectLearnings: draw.selectLearnings });
      const fields = learningsInjectedRow(result, draw.contentIds(), arm === "B", usage);
      return JSON.parse(JSON.stringify({ step: "learnings.injected", run_id: PRODUCER_RUN_ID, ts: ts(), ...fields })) as Row;
    };
    return { row: rowForArm("A"), maskedRow: rowForArm("B"), corpus: loadLearningsCorpus(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T11115: learning outcome revision identifies both selected and dropped source content", () => {
  // THE SELECTION SEAM: the W1-T4241 tied fixture — a, b, c, d are contested, `strong` is not.
  const tied = ["a", "b", "c", "d"].map((id) => entry(id));
  const strong = entry("strong", ["src/x.ts", "src/y.ts"], "s");
  const snapshot = [...tied, strong];
  const files = ["src/x.ts", "src/y.ts"];
  const drawn = selectLearnings(snapshot, files, 700, { usage: {}, seed: 42, propensityDraws: 64 });
  const contested = Object.keys(contestedPropensities(drawn.propensity)!).sort();
  assert.deepEqual(contested, ["a", "b", "c", "d"]);
  assert.deepEqual(Object.keys(drawn.contentIds!).sort(), contested, "every contested entry, and only those, carries a revision");
  const selectedContested = drawn.selected.filter((e) => contested.includes(e.id));
  const droppedContested = drawn.dropped.filter((e) => contested.includes(e.id));
  assert.ok(selectedContested.length > 0 && droppedContested.length > 0, "the draw selected some contested entries and dropped others");
  for (const e of [...selectedContested, ...droppedContested]) {
    assert.equal(drawn.contentIds![e.id], learningContentIdentity(e), `${e.id}: the identity is the snapshot entry's own`);
    assert.equal(LEARNING_CONTENT_IDENTITY_RE.test(drawn.contentIds![e.id]!), true);
  }
  // The validator the fold uses refuses anything but a versioned fixed-width digest.
  for (const bad of ["sha256:0123456789abcdef", "lc1:0123", "lc2:0123456789abcdef", AMBIGUOUS_LEARNING_CONTENT]) {
    assert.equal(LEARNING_CONTENT_IDENTITY_RE.test(bad), false, bad);
  }
  assert.equal(selectLearnings(snapshot, files, 700, { usage: {}, seed: 42 }).contentIds, undefined, "no draw, no contest, no revision");

  // Reordering triggers and repeating a glob preserve canonical bytes, as does changing metadata.
  const base = { ...entry("r", ["src/a.ts", "src/b.ts"], "the fact"), symbols: ["x", "y"], errorSignatures: ["boom"] } as LearningEntry;
  const id0 = learningContentIdentity(base);
  assert.equal(learningContentIdentity({ ...base }), id0);
  assert.equal(learningContentIdentity({ ...base, files: ["src/b.ts", "src/a.ts", "src/a.ts"], symbols: ["y", "x"] }), id0);
  assert.equal(learningContentIdentity({ ...base, cited: "2026-11-01", citedCount: 9, evidence: "PR#1", src: "PR#2", subsystem: "other" }), id0);
  assert.equal(learningContentIdentity({ ...base, symbols: undefined }), learningContentIdentity({ ...base, symbols: [] }));
  // A REAL change to what the worker reads, or to what admits the entry, is a new revision.
  for (const changed of [{ fact: "the fact, edited" }, { files: ["src/a.ts"] }, { symbols: ["x"] }, { errorSignatures: ["bang"] }, { layer: "global" as const }]) {
    assert.notEqual(learningContentIdentity({ ...base, ...changed }), id0, `${Object.keys(changed)[0]} is part of the intervention`);
  }

  // A DUPLICATE ID IN ONE SNAPSHOT: identical copies resolve; conflicting copies are ambiguous, never
  // either one; an id the snapshot never held stays unresolved rather than invented.
  assert.deepEqual(learningContentIdentities([base, { ...base }], ["r"]), { r: id0 });
  assert.deepEqual(learningContentIdentities([base, { ...base, fact: "another fact" }], ["r", "absent"]), { r: AMBIGUOUS_LEARNING_CONTENT });

  // THE PRODUCER: the implement dispatch's row names the revision of every contested entry it drew.
  const { row, corpus } = producerRun();
  const p = row.propensity as Record<string, number>;
  const ids = row.content_ids as Record<string, string>;
  assert.ok(ids && typeof ids === "object", "the producer row carries content_ids");
  const producerContested = Object.keys(p).sort();
  assert.ok(producerContested.length > 0, "the fixture corpus overflows the budget, so the draw contests entries");
  assert.deepEqual(Object.keys(ids).sort(), producerContested);
  const matched = new Set(row.matched_ids as string[]);
  const dropped = new Set(row.dropped as string[]);
  assert.ok(producerContested.some((id) => matched.has(id)), "a selected contested entry carries a revision");
  assert.ok(producerContested.some((id) => dropped.has(id)), "a dropped contested entry carries a revision");
  for (const id of producerContested) {
    const source = corpus.filter((e) => e.id === id);
    assert.equal(source.length, 1);
    assert.equal(ids[id], learningContentIdentity(source[0]!), `${id}: the ledgered revision is the source entry's`);
  }
  const selectedId = producerContested.find((id) => matched.has(id))!;
  const droppedId = producerContested.find((id) => dropped.has(id))!;
  const { row: ambiguous } = producerRun([selectedId, droppedId]);
  assert.deepEqual(ambiguous.matched_ids, row.matched_ids);
  assert.deepEqual(ambiguous.dropped, row.dropped);
  assert.deepEqual(ambiguous.propensity, p);
  assert.deepEqual(ambiguous.content_ids, { ...ids, [selectedId]: AMBIGUOUS_LEARNING_CONTENT, [droppedId]: AMBIGUOUS_LEARNING_CONTENT },
    "both contested IDs are ambiguous even when the conflicting copies did not match the task");
  assert.ok(!JSON.stringify(ambiguous).includes(RAW_FACT_SENTINEL));
});

test("W1-T11115: learning outcome revision separates opposite effects under one learning id", () => {
  // Two revisions of one id: the first helps, the edit hurts. Pooled, they cancel to zero.
  const first = learningContentIdentity(entry("L", ["src/x.ts"], "revision one"));
  const edit = learningContentIdentity(entry("L", ["src/x.ts"], "revision two"));
  assert.notEqual(first, edit);
  const helpsThenHurts = (contentFirst: string | null, contentEdit: string | null) => [
    ...stratum("first", 20, 0.5, 10, (inj) => (inj ? "merged" : "blocked_ci"), contentFirst),
    ...stratum("edit", 20, 0.5, 10, (inj) => (inj ? "blocked_ci" : "merged"), contentEdit),
  ];
  const rows = helpsThenHurts(first, edit);
  const report = foldLearningOutcomes(rows);
  const byRevision = Object.fromEntries(report.learnings.map((l) => [l.contentId, l]));
  assert.equal(report.learnings.length, 2, "one cohort per revision, never one per id");
  assert.deepEqual({ ...byRevision[first]!, se: undefined }, { id: "L", contentId: first, injected: 10, dropped: 10, effect: 1, se: undefined, verdict: "helps" });
  assert.deepEqual({ ...byRevision[edit]!, se: undefined }, { id: "L", contentId: edit, injected: 10, dropped: 10, effect: -1, se: undefined, verdict: "hurts" });
  // What pooling the two revisions under one id reads — the verdict this task removes.
  const pooled = foldLearningOutcomes(helpsThenHurts(REV, REV)).learnings;
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0]!.verdict, "no-detectable-effect");

  // A FRESH EDIT INHERITS NOTHING: three runs of a third revision read unmeasurable beside a helps.
  const third = learningContentIdentity(entry("L", ["src/x.ts"], "revision three"));
  const young = foldLearningOutcomes([...stratum("first", 20, 0.5, 10, (inj) => (inj ? "merged" : "blocked_ci"), first), ...stratum("third", 3, 0.5, 2, () => "merged", third)]);
  assert.deepEqual(young.learnings.find((l) => l.contentId === third), { id: "L", contentId: third, injected: 2, dropped: 1, verdict: "unmeasurable" });
  assert.equal(young.learnings.find((l) => l.contentId === first)!.verdict, "helps");

  // THE DIGEST labels each cohort, and a disagreement names the revision it is about.
  const used = Array.from({ length: 12 }, (_, i) => ({ step: "learnings.used", run_id: `u${i}`, injected_ids: ["L"], used_ids: ["L"] }));
  const s = summarizeLearningOutcomes([...rows, ...used])!;
  assert.deepEqual(s.disagreements.map((d) => [d.id, d.contentId, d.verdict]), [["L", edit, "hurts"]]);
  const line = renderLearningOutcomes(s);
  assert.ok(line.includes(`L +1.00 ±0.00 (n 10/10) [${first}]`), line);
  assert.ok(line.includes(`L -1.00 ±0.00 (n 10/10) [${edit}]`), line);
  assert.ok(line.includes(`disagrees with LEARNINGS_USED: L hurts but used-mean 0.93 [${edit}]`), line);
  const measuredRow = { step: "knowledge.measured", ts: ts(), status: "measured", window_days: 30, gaps: { runs: 40, excludedNoVerdict: 0, excludedMasked: 0, unmapped: 0, areas: [] }, outcomes: report };
  const knowledge = renderKnowledgeMeasured(summarizeKnowledgeMeasured([measuredRow])!);
  assert.ok(knowledge.includes(`L helps +1.00 [${first}]`), knowledge);
  assert.ok(knowledge.includes(`L hurts -1.00 [${edit}]`), knowledge);

  // Repeating a trigger can move L into the stronger tie. Differing peer costs keep both draws contested.
  for (const field of ["symbols", "errorSignatures"] as const) {
    const trigger = ["DrawTrigger"];
    const repeated = [...trigger, ...trigger];
    const peers = [entry("large", [], "x".repeat(480)), entry("small", [], "x".repeat(250))]
      .map((peer) => ({ ...peer, [field]: repeated }));
    const draw = (triggers: string[]) => selectLearnings(
      [{ ...entry("L", [], "x".repeat(200)), [field]: triggers }, ...peers], [], 700,
      { text: trigger, usage: {}, seed: 42, propensityDraws: LEARNING_PROPENSITY_DRAWS },
    );
    const before = draw(trigger);
    const after = draw(repeated);
    const pBefore = contestedPropensities(before.propensity)!.L!;
    const pAfter = contestedPropensities(after.propensity)!.L!;
    assert.ok(pBefore > 0 && pAfter < 1 && pAfter > pBefore, `${field}: the edit changes the contested propensity`);
    const beforeId = before.contentIds!.L!;
    const afterId = after.contentIds!.L!;
    const helps = (contentId: string) => stratum("trigger-first", 80, pBefore, 40, (inj) => inj ? "merged" : "blocked_ci", contentId);
    const hurts = stratum("trigger-edit", 20, pAfter, 10, (inj) => inj ? "blocked_ci" : "merged", afterId);
    assert.equal(foldLearningOutcomes([...helps(afterId), ...hurts]).learnings[0]!.verdict, "helps", `${field}: pooling hides the harm`);
    const effects = foldLearningOutcomes([...helps(beforeId), ...hurts]).learnings;
    assert.equal(effects.length, 2, `${field}: the real draws identify separate cohorts`);
    assert.equal(effects.find((l) => l.contentId === beforeId)?.effect, 1);
    assert.equal(effects.find((l) => l.contentId === afterId)?.effect, -1);
  }
});

test("W1-T11115: learning outcome revision reports unresolved exposure identities as unmeasurable", () => {
  const other = learningContentIdentity(entry("L", ["src/x.ts"], "another revision"));
  const injectedRow = (runId: string, over: Row): Row => ({ step: "learnings.injected", run_id: runId, ts: ts(), matched_ids: ["L"], dropped: [], propensity: { L: 0.5 }, content_ids: { L: REV }, ...over });
  const verdict = (runId: string): Row => ({ step: "verdict", run_id: runId, ts: ts(), verdict: "merged" });
  const rows: Row[] = [
    // LEGACY: twenty pre-W1-T11115 runs that, backfilled with today's bytes, would make REV measurable.
    ...stratum("legacy", 20, 0.5, 10, (inj) => (inj ? "merged" : "blocked_ci"), null),
    // MALFORMED: a map that is not an object, and a value that is not an `lc1:` identity.
    injectedRow("bad-map", { content_ids: REV }), verdict("bad-map"),
    injectedRow("bad-value", { content_ids: { L: "sha256:not-an-identity" } }), verdict("bad-value"),
    // AMBIGUOUS: the draw's snapshot held two different L's.
    injectedRow("ambiguous", { content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } }), verdict("ambiguous"),
    // CONFLICTING: one run ledgered two different revisions for the same exposure.
    injectedRow("conflict", {}), injectedRow("conflict", { content_ids: { L: other } }), verdict("conflict"),
    injectedRow("trimmed-low-conflict", {}), injectedRow("trimmed-low-conflict", { propensity: { L: 1 / 64 }, content_ids: { L: other } }), verdict("trimmed-low-conflict"),
    injectedRow("trimmed-high-conflict", { propensity: { L: 63 / 64 }, content_ids: { L: other } }), injectedRow("trimmed-high-conflict", {}), verdict("trimmed-high-conflict"),
    // UNRESOLVED: no identity for the contested entry, or no single arm for it.
    injectedRow("no-identity", { content_ids: {} }), verdict("no-identity"),
    injectedRow("no-arm", { matched_ids: [], dropped: [] }), verdict("no-arm"),
    injectedRow("both-arms", { matched_ids: ["L"], dropped: ["L"] }), verdict("both-arms"),
    // Three well-formed runs: the only observations REV may count.
    ...stratum("current", 3, 0.5, 2, (inj) => (inj ? "merged" : "blocked_ci")),
  ];
  const report = foldLearningOutcomes(rows);
  assert.deepEqual(report.excludedRevision, { legacy: 20, malformed: 2, ambiguous: 1, conflicting: 4, unresolved: 3 });
  assert.equal(report.excludedTrimmed, 2, "both tail observations still count as trimmed");
  assert.equal(report.runs, 20 + 12 + 3, "an excluded revision still counts its row's run; only the observation is withheld");
  assert.deepEqual(report.learnings, [{ id: "L", contentId: REV, injected: 2, dropped: 1, verdict: "unmeasurable" }], "legacy rows never inherit the current revision");

  // THE DIGEST counts them by reason, beside the trimmed and verdict-less exclusions.
  const line = renderLearningOutcomes(summarizeLearningOutcomes(rows)!);
  assert.ok(line.includes("30 without a single revision (legacy 20, malformed 2, ambiguous 1, conflicting 4, unresolved 3)"), line);
  assert.ok(line.includes("0 measured, 1 unmeasurable"), line);
  const clean = renderLearningOutcomes(summarizeLearningOutcomes(stratum("only", 3, 0.5, 2, () => "merged"))!);
  assert.ok(!clean.includes("without a single revision"), clean);

  // A HISTORICAL knowledge.measured row (pooled by id, before revisions) is labelled legacy, never
  // shown as if it measured today's content.
  const historical = {
    step: "knowledge.measured",
    ts: ts(),
    status: "measured",
    window_days: 30,
    gaps: { runs: 20, excludedNoVerdict: 0, excludedMasked: 0, unmapped: 0, areas: [] },
    outcomes: { runs: 20, excludedNoVerdict: 0, excludedMasked: 0, excludedTrimmed: 0, learnings: [{ id: "L", injected: 10, dropped: 10, effect: -0.5, se: 0.1, verdict: "hurts" }] },
  };
  const old = renderKnowledgeMeasured(summarizeKnowledgeMeasured([historical])!);
  assert.ok(old.includes("L hurts -0.50 [legacy: revision unknown]"), old);
});

test("W1-T11115: learning outcome revision preserves randomized exposure bounds and privacy", () => {
  // PRIVACY: an identity is a fixed-width digest, whatever the fact says.
  const id = learningContentIdentity(entry("L", ["src/x.ts"], `${RAW_FACT_SENTINEL} the raw fact text`));
  assert.match(id, /^lc1:[0-9a-f]{16}$/);

  // THE PRODUCER ROW: digests only, beside the unchanged propensity and masking fields.
  const { row, maskedRow } = producerRun();
  assert.ok(!JSON.stringify(row).includes(RAW_FACT_SENTINEL), "no raw learning content enters the ledger");
  assert.equal(row.masked, false);
  assert.match(String(row.usage_sha), /^[0-9a-f]{16}$/);
  const ids = row.content_ids as Record<string, string>;
  for (const [entryId, p] of Object.entries(row.propensity as Record<string, number>)) {
    assert.ok(p > 0 && p < 1, `${entryId}: only contested propensities are ledgered`);
    assert.match(ids[entryId]!, LEARNING_CONTENT_IDENTITY_RE);
  }
  // The producer's own row folds into revision cohorts; one run is below every arm floor.
  const folded = foldLearningOutcomes([row, { step: "verdict", run_id: row.run_id, ts: ts(), verdict: "merged" }]);
  assert.ok(folded.learnings.length > 0);
  for (const l of folded.learnings) {
    assert.equal(l.contentId, ids[l.id]);
    assert.equal(l.verdict, "unmeasurable");
  }

  // BOUNDS: the trim and the per-arm floor still apply to a well-formed revision, and a trimmed
  // observation is counted as trimmed, not as a revision problem.
  const trimmed = foldLearningOutcomes([...run("t1", 0.02, true, "merged"), ...run("t2", 0.97, false, "merged")]);
  assert.equal(trimmed.excludedTrimmed, 2);
  assert.deepEqual(trimmed.excludedRevision, { legacy: 0, malformed: 0, ambiguous: 0, conflicting: 0, unresolved: 0 });
  const floor = foldLearningOutcomes(stratum("floor", 18, 0.5, 9, (inj) => (inj ? "merged" : "blocked_ci")));
  assert.deepEqual(floor.learnings, [{ id: "L", contentId: REV, injected: 9, dropped: 9, verdict: "unmeasurable" }]);
  // MASKING: the producer's arm B draws nothing, so it ledgers no propensity and no revision; a masked
  // row is excluded as masked, never read for its revision.
  assert.equal(maskedRow.masked, true);
  assert.deepEqual(maskedRow.matched_ids, []);
  assert.equal("propensity" in maskedRow, false);
  assert.equal("content_ids" in maskedRow, false);
  const [contestedRow, maskedVerdict] = run("m", 0.5, true, "merged");
  const masked = foldLearningOutcomes([{ ...contestedRow!, masked: true }, maskedVerdict!]);
  assert.equal(masked.excludedMasked, 1);
  assert.deepEqual(masked.excludedRevision, { legacy: 0, malformed: 0, ambiguous: 0, conflicting: 0, unresolved: 0 });
  assert.deepEqual(masked.learnings, []);

  // OBSERVATIONAL ONLY: naming revisions never changes what a run selects, and the fold never
  // writes to the rows it reads.
  const tied = ["a", "b", "c", "d"].map((tid) => entry(tid));
  const plain = selectLearnings(tied, ["src/x.ts"], 700, { usage: {}, seed: 7 });
  const drawn = selectLearnings(tied, ["src/x.ts"], 700, { usage: {}, seed: 7, propensityDraws: 64 });
  assert.deepEqual(drawn.selected, plain.selected);
  assert.deepEqual(drawn.dropped, plain.dropped);
  const frozen = deepFreeze(stratum("frozen", 20, 0.5, 10, () => "merged"));
  assert.equal(foldLearningOutcomes(frozen).learnings.length, 1);
});
