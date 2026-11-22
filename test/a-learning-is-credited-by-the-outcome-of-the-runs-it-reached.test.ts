/**
 * test/a-learning-is-credited-by-the-outcome-of-the-runs-it-reached.test.ts — W1-T4241, W1-T11115.
 *
 * `selectLearnings` already randomizes which equally-matched learnings survive the budget cut. The
 * run now ledgers each contested entry's propensity, and `foldLearningOutcomes` joins injected vs
 * dropped to the run's clean-merge outcome with inverse-propensity weights.
 *
 * W1-T11115: an edit keeps a learning's id, so the fold credits the exact content revision a run
 * exposed. The producer ledgers one `lc1:` digest per id either arm names, selected AND dropped, from
 * the draw's own snapshot; the fold groups by {id, revision} and counts every observation it cannot pin.
 * An id is not unique across layers: two matching copies of one id are counted per copy, so the id
 * keeps its share and its `ambiguous` marker, and the fold counts an id listed in both arms.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { learningsInjectedRow } from "#src/cli/commands/run-task-verb.js";
import { renderKnowledgeMeasured, renderLearningOutcomes, summarizeKnowledgeMeasured, summarizeLearningOutcomes } from "#src/lib/digest.js";
import { contestedPropensities, foldLearningOutcomes, OUTCOME_ARM_FLOOR, OUTCOME_PROPENSITY_TRIM } from "#src/lib/knowledge-outcome.js";
import { readLearningUsage, seedOf } from "#src/lib/knowledge-value.js";
import { appendLedger } from "#src/lib/ledger.js";
import { ledgerLivePath, readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import {
  AMBIGUOUS_LEARNING_CONTENT,
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  LEARNING_CONTENT_IDENTITY_RE,
  LEARNING_PROPENSITY_DRAWS,
  learningContentIdentities,
  learningContentIdentity,
  learningIdRecord,
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
  // W1-T11115: the record has no prototype, so an id such as `__proto__` stays a key.
  assert.deepEqual(contestedPropensities({ x: 0, y: 0.5, z: 1 }), { __proto__: null, y: 0.5 });
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

/** Ids that name `Object.prototype` members. The YAML loader accepts each as a learning id, so every
 *  id-keyed record on the producer and fold path must hold each one as an ordinary key. */
const PROTOTYPE_MEMBER_IDS = ["__proto__", "constructor", "toString", "hasOwnProperty"];

interface ProducerRun {
  /** The `learnings.injected` row the producer builds for the draw, written to and read back from a
   *  real ledger. */
  row: Row;
  /** The same row for a masked wipe-test arm B. */
  maskedRow: Row;
  /** The corpus the draw read, parsed again from the same shards, in the loader's layer order. */
  corpus: LearningEntry[];
  /** Per re-selection `k`: the `corpus` indexes of the COPIES the producer's draw chose under derived
   *  seed `k`, replayed with the real selector one seed at a time, outside the producer's counting. */
  chosenByDraw: ReadonlyArray<ReadonlySet<number>>;
}

/** How many of a producer run's re-selections chose each copy, aligned with its `corpus`. */
const copyWins = (run: ProducerRun): number[] => run.corpus.map((_, i) => run.chosenByDraw.filter((chosen) => chosen.has(i)).length);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The producer path of an implement dispatch (run-task-verb.ts's runTaskBody), over a real corpus on
 *  disk: the layered load, the real selector wrapped by `recordingSelectLearnings`, the production
 *  budget, draw count and run seed, then the producer's own `learningsInjectedRow`, appended with
 *  `appendLedger` and read back through the ledger union. 30 equal-strength ~430-char lines overflow
 *  the 8,148-char budget, so about 19 fit and the seeded draw decides which.
 *  `userLayerCopyOf` also writes a user-overall layer holding a second, different copy of that id,
 *  whose glob the task never matches, as a real cross-layer corpus can. `userLayerIds` writes
 *  user-overall entries that DO match, as equal-strength rivals. An id that is also a project id is a
 *  second, different copy that matches too: runTaskBody loads both homes, and both copies compete in
 *  every re-selection. `userLayerPinnedCopyOf` writes a matching user-overall copy of a project id
 *  whose symbol the task text also names: it outranks every project entry, so it is selected in
 *  every re-selection while the project copy stays contested. `oversized` adds a project entry of
 *  ~7,700 chars: it fits only when the draw ranks it first, so its propensity is a few 64ths.
 *  The usage store is written and read with the producer's own reader. It holds a no-history count,
 *  the same prior an absent id gets, for every fixture id. An absent `__proto__` or `constructor`
 *  would read an inherited member in knowledge-value.ts's `learningValue`, outside this task. */
async function producerRun(
  opts: { userLayerCopyOf?: string; userLayerIds?: readonly string[]; userLayerPinnedCopyOf?: string; oversized?: string; runId?: string } = {},
): Promise<ProducerRun> {
  const runId = opts.runId ?? PRODUCER_RUN_ID;
  const dir = mkdtempSync(join(tmpdir(), "rmd-lcr-corpus-"));
  const userDir = mkdtempSync(join(tmpdir(), "rmd-lcr-user-"));
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lcr-state-"));
  try {
    const line = (id: string, fact: string, glob: string) =>
      [`- id: ${JSON.stringify(id)}`, `  fact: "${fact}"`, '  src: "lcr-fixture"', `  files: ["${glob}"]`].join("\n");
    const project = Array.from({ length: 30 }, (_, i) => `lcr-${String(i).padStart(2, "0")}`);
    const projectLines = project.map((id) => line(id, `${RAW_FACT_SENTINEL}-${id} ${"x".repeat(380)}`, PRODUCER_TASK_FILE));
    if (opts.oversized !== undefined) {
      project.push(opts.oversized);
      projectLines.push(line(opts.oversized, `${RAW_FACT_SENTINEL}-${opts.oversized} ${"y".repeat(7700)}`, PRODUCER_TASK_FILE));
    }
    writeFileSync(join(dir, "revision.yaml"), projectLines.join("\n") + "\n");
    const userIds = [...(opts.userLayerIds ?? [])];
    const userLines = userIds.map((id) => line(id, `${RAW_FACT_SENTINEL}-user-${id} ${"x".repeat(380)}`, PRODUCER_TASK_FILE));
    if (opts.userLayerPinnedCopyOf !== undefined) {
      userIds.push(opts.userLayerPinnedCopyOf);
      userLines.push(`${line(opts.userLayerPinnedCopyOf, `${RAW_FACT_SENTINEL}-user-pinned ${"p".repeat(380)}`, PRODUCER_TASK_FILE)}\n  symbols: ["producer"]`);
    }
    if (opts.userLayerCopyOf !== undefined) {
      userIds.push(opts.userLayerCopyOf);
      userLines.push(line(opts.userLayerCopyOf, `${RAW_FACT_SENTINEL}-user-layer-revision`, "docs/never-in-this-task.md"));
    }
    const withUserLayer = userLines.length > 0;
    if (withUserLayer) writeFileSync(join(userDir, "revision.yaml"), userLines.join("\n") + "\n");
    const usagePath = join(stateDir, "learning-usage.json");
    writeFileSync(usagePath, JSON.stringify(learningIdRecord([...project, ...userIds].map((id) => [id, { offered: 0, used: 0 }] as const))));
    const usage = readLearningUsage(usagePath);
    const input = {
      homes: {
        projectDir: dir,
        userOverallDir: withUserLayer ? userDir : join(dir, "no-user-layer"),
        globalArtifactPath: join(dir, "no-global-layer", "artifact.yaml"),
      },
      taskFiles: [PRODUCER_TASK_FILE],
      selectionContext: { text: ["prove the producer names the exact learning revision it drew"], usage, seed: seedOf(runId), propensityDraws: LEARNING_PROPENSITY_DRAWS },
      budgetChars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    };
    for (const arm of ["A", "B"] as const) {
      const draw = recordingSelectLearnings();
      const result = await computeMatchedLearningsForArm(arm, input, { ...REAL_LEARNINGS_INJECTION_DEPS, selectLearnings: draw.selectLearnings });
      const fields = learningsInjectedRow(result, draw.lastDraw(), arm === "B", usage);
      appendLedger(ledgerLivePath(stateDir), { step: "learnings.injected", run_id: runId, task_id: "T-LEARN-REVISION", ts: ts(), ...fields });
    }
    const rows = readLedgerUnionRecordsSync(stateDir).rows.filter((r) => r.step === "learnings.injected");
    assert.equal(rows.length, 2, "both arms' rows come back from the ledger");
    const corpus = [...loadLearningsCorpus(dir), ...(withUserLayer ? loadLearningsCorpus(userDir) : [])];
    const chosenByDraw = Array.from({ length: LEARNING_PROPENSITY_DRAWS }, (_, k) => {
      const context = { ...input.selectionContext, seed: propensitySeed(input.selectionContext.seed, k), propensityDraws: 0 };
      return new Set(selectLearnings(corpus, input.taskFiles, input.budgetChars, context).selected.map((chosen) => corpus.indexOf(chosen)));
    });
    return { row: rows.find((r) => r.masked === false)!, maskedRow: rows.find((r) => r.masked === true)!, corpus, chosenByDraw };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** THE PRODUCER INVARIANT, checked on a real producer row against its replayed source draw. Every id
 *  either arm names has its own `content_ids` entry: the digest of its single source revision, or
 *  the `ambiguous` marker when the source holds it with different content. Every CONTESTED id, one
 *  with any copy chosen in some re-selections and not in others, has its own share, and that share is
 *  the fraction of re-selections in which any copy was chosen. */
function assertProducerInvariant(run: ProducerRun): void {
  const ids = run.row.content_ids as Record<string, string>;
  const p = (run.row.propensity ?? {}) as Record<string, number>;
  const arms = [...(run.row.matched_ids as string[]), ...(run.row.dropped as string[])];
  assert.ok(arms.length > 0, "the draw matched entries");
  for (const id of arms) {
    assert.ok(Object.hasOwn(ids, id), `${id}: an id either arm names has its own content_ids entry`);
    const revisions = new Set(run.corpus.filter((e) => e.id === id).map((e) => learningContentIdentity(e)));
    assert.equal(ids[id], revisions.size === 1 ? [...revisions][0] : AMBIGUOUS_LEARNING_CONTENT, `${id}: the source draw's own identity`);
  }
  const wins = copyWins(run);
  for (const id of new Set(run.corpus.map((e) => e.id))) {
    const slots = run.corpus.flatMap((e, i) => (e.id === id ? [i] : []));
    if (!slots.some((i) => wins[i]! > 0 && wins[i]! < LEARNING_PROPENSITY_DRAWS)) continue;
    assert.ok(Object.hasOwn(p, id), `${id}: a contested id has its own share`);
    const reached = run.chosenByDraw.filter((chosen) => slots.some((i) => chosen.has(i))).length;
    assert.equal(p[id], reached / LEARNING_PROPENSITY_DRAWS, `${id}: the share of re-selections that chose any copy`);
  }
}

/** THE REVIEWER'S CASE (round 4), through the real producer: a project copy and a user-overall copy
 *  of one id, with different content, BOTH matching the task, as runTaskBody loads its two homes. It
 *  returns the first seeded run in which each copy is contested, the id sits in both arms, and the
 *  copies' wins sum to at least the draw count. That per-id sum read the id at a share of 1 or more,
 *  so the row carried no share and no revision for it, and the fold counted nothing. */
let copySplit: { run: ProducerRun; id: string } | undefined;
async function copySplitRun(): Promise<{ run: ProducerRun; id: string }> {
  if (copySplit) return copySplit;
  const id = "lcr-07";
  for (let i = 0; i < 24; i++) {
    const run = await producerRun({ userLayerIds: [id], runId: `${PRODUCER_RUN_ID}-copy-split-${i}` });
    const wins = copyWins(run).filter((_, j) => run.corpus[j]!.id === id);
    const both = (run.row.matched_ids as string[]).includes(id) && (run.row.dropped as string[]).includes(id);
    const pooledAtLeastOne = wins.reduce((sum, n) => sum + n, 0) >= LEARNING_PROPENSITY_DRAWS;
    if (wins.length === 2 && wins.every((n) => n > 0 && n < LEARNING_PROPENSITY_DRAWS) && both && pooledAtLeastOne) return (copySplit = { run, id });
  }
  throw new Error("no seeded run split two contested copies of one id across both arms");
}

test("W1-T11115: learning outcome revision identifies both selected and dropped source content", async () => {
  // THE SELECTION SEAM: the W1-T4241 tied fixture — a, b, c, d are contested, `strong` is not.
  const tied = ["a", "b", "c", "d"].map((id) => entry(id));
  const strong = entry("strong", ["src/x.ts", "src/y.ts"], "s");
  const snapshot = [...tied, strong];
  const files = ["src/x.ts", "src/y.ts"];
  const drawn = selectLearnings(snapshot, files, 700, { usage: {}, seed: 42, propensityDraws: 64 });
  const contested = Object.keys(contestedPropensities(drawn.propensity, drawn.contestedIds)!).sort();
  assert.deepEqual(contested, ["a", "b", "c", "d"]);
  assert.deepEqual(drawn.contestedIds, contested, "the draw names the ids the budget cut decided");
  assert.deepEqual(Object.keys(drawn.contentIds!).sort(), [...contested, "strong"], "every matched entry, contested or not, carries a revision");
  assert.equal(drawn.contentIds!.strong, learningContentIdentity(strong));
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

  // DETERMINISTIC AND CANONICAL: equal canonical bytes give one identity. Reordering a glob, symbol or
  // error signature is not a revision, and neither is repeating a glob (a task file matches a glob
  // set once), usage metadata, or text that is never injected.
  const base = { ...entry("r", ["src/a.ts", "src/b.ts"], "the fact"), symbols: ["x", "y"], errorSignatures: ["boom", "bang"] } as LearningEntry;
  const id0 = learningContentIdentity(base);
  assert.equal(learningContentIdentity({ ...base }), id0);
  assert.equal(learningContentIdentity({ ...base, files: ["src/b.ts", "src/a.ts", "src/a.ts"], symbols: ["y", "x"], errorSignatures: ["bang", "boom"] }), id0);
  assert.equal(learningContentIdentity({ ...base, cited: "2026-11-01", citedCount: 9, evidence: "PR#1", src: "PR#2", subsystem: "other" }), id0);
  assert.equal(learningContentIdentity({ ...base, symbols: undefined }), learningContentIdentity({ ...base, symbols: [] }));
  // A REAL change to what the worker reads, or to what admits and ranks the entry, is a new revision.
  // A repeated symbol or error signature is one: the selector counts each copy as a hit.
  for (const changed of [
    { fact: "the fact, edited" },
    { files: ["src/a.ts"] },
    { symbols: ["x"] },
    { symbols: ["x", "y", "x"] },
    { errorSignatures: ["bang"] },
    { errorSignatures: ["boom", "bang", "boom"] },
    { layer: "global" as const },
  ]) {
    assert.notEqual(learningContentIdentity({ ...base, ...changed }), id0, `${Object.keys(changed)[0]} is part of the intervention`);
  }

  // A DUPLICATE ID IN ONE SNAPSHOT: identical copies resolve; conflicting copies are ambiguous, never
  // either one; an id the snapshot never held stays unresolved rather than invented.
  assert.deepEqual(learningContentIdentities([base, { ...base }], ["r"]), { __proto__: null, r: id0 });
  assert.deepEqual(learningContentIdentities([base, { ...base, fact: "another fact" }], ["r", "absent"]), { __proto__: null, r: AMBIGUOUS_LEARNING_CONTENT });

  // A SAME-ID COPY THE TASK NEVER MATCHED, through the real draw. The copy is not a candidate, so it
  // moves no propensity, but it is in the snapshot the draw read: the dropped entry's id has two
  // revisions there, so it reads ambiguous, never the matched copy's digest.
  const droppedId = droppedContested[0]!.id;
  const unmatchedCopy = entry(droppedId, ["docs/never-in-this-task.md"], "an unmatched revision of the same id");
  const withCopy = selectLearnings([...snapshot, unmatchedCopy], files, 700, { usage: {}, seed: 42, propensityDraws: 64 });
  assert.deepEqual(withCopy.propensity, drawn.propensity, "the unmatched copy is not a candidate");
  assert.deepEqual(withCopy.dropped.map((e) => e.id), drawn.dropped.map((e) => e.id));
  assert.equal(withCopy.contentIds![droppedId], AMBIGUOUS_LEARNING_CONTENT, `${droppedId}: one id, two revisions in the source draw`);
  for (const id of contested.filter((c) => c !== droppedId)) assert.equal(withCopy.contentIds![id], drawn.contentIds![id], `${id} is unaffected`);
  const selectedId = selectedContested[0]!.id;
  const selectedCopy = selectLearnings([...snapshot, entry(selectedId, ["docs/never-in-this-task.md"])], files, 700, { usage: {}, seed: 42, propensityDraws: 64 });
  assert.equal(selectedCopy.contentIds![selectedId], AMBIGUOUS_LEARNING_CONTENT, `${selectedId}: a selected entry is checked the same way`);

  // THE PRODUCER: the implement dispatch's row names the revision of every contested entry it drew.
  const producer = await producerRun();
  const { row, corpus } = producer;
  const p = row.propensity as Record<string, number>;
  const ids = row.content_ids as Record<string, string>;
  assert.ok(ids && typeof ids === "object", "the producer row carries content_ids");
  const producerContested = Object.keys(p).sort();
  assert.ok(producerContested.length > 0, "the fixture corpus overflows the budget, so the draw contests entries");
  const matched = new Set(row.matched_ids as string[]);
  const dropped = new Set(row.dropped as string[]);
  assert.deepEqual(Object.keys(ids).sort(), [...new Set([...matched, ...dropped])].sort(), "every id either arm names carries a revision");
  assertProducerInvariant(producer);
  assert.ok(producerContested.some((id) => matched.has(id)), "a selected contested entry carries a revision");
  assert.ok(producerContested.some((id) => dropped.has(id)), "a dropped contested entry carries a revision");
  for (const id of producerContested) {
    const source = corpus.filter((e) => e.id === id);
    assert.equal(source.length, 1);
    assert.equal(ids[id], learningContentIdentity(source[0]!), `${id}: the ledgered revision is the source entry's`);
  }

  // THE PRODUCER, with the user-overall layer holding a second copy of a dropped contested id that
  // the task never matches: the row ledgers that id ambiguous, and the fold credits it to no revision.
  const layeredId = producerContested.find((id) => dropped.has(id) && p[id]! >= OUTCOME_PROPENSITY_TRIM && p[id]! <= 1 - OUTCOME_PROPENSITY_TRIM)!;
  assert.ok(layeredId !== undefined, "a dropped contested entry inside the trim");
  const layered = await producerRun({ userLayerCopyOf: layeredId });
  assert.equal(layered.corpus.filter((e) => e.id === layeredId).length, 2, "the draw's source holds the id twice");
  assert.deepEqual(layered.row.propensity, row.propensity, "the unmatched copy is not a candidate");
  const layeredIds = layered.row.content_ids as Record<string, string>;
  assert.equal(layeredIds[layeredId], AMBIGUOUS_LEARNING_CONTENT, `${layeredId}: the producer names no single revision`);
  for (const id of producerContested.filter((c) => c !== layeredId)) assert.equal(layeredIds[id], ids[id], `${id} is unaffected`);
  const layeredFold = foldLearningOutcomes([layered.row, { step: "verdict", run_id: layered.row.run_id, ts: ts(), verdict: "merged" }]);
  assert.equal(layeredFold.excludedRevision.ambiguous, 1);
  assert.equal(layeredFold.learnings.some((l) => l.id === layeredId), false, `${layeredId} is credited to no revision`);
  assertProducerInvariant(layered);

  // TWO MATCHING COPIES OF ONE ID (the round-4 review). The draw is counted per COPY. Here the budget
  // fits `strong` and ONE copy of `d`, so every re-selection keeps one copy and drops the other. Each
  // copy is contested, and either copy reaches the prompt in every draw: a pooled share of exactly 1.
  // Counted per id, the copies' wins summed to that 1, and the id read as decided, with no share and
  // no revision, while it sat in both arms. Now it is contested at its pooled share, and ambiguous.
  const dCopies = [entry("d", files, "first copy " + "1".repeat(320)), entry("d", files, "second copy " + "2".repeat(320))];
  const split = selectLearnings([strong, ...dCopies], files, 400, { usage: {}, seed: 42, propensityDraws: 64 });
  assert.deepEqual([split.selected.map((e) => e.id), split.dropped.map((e) => e.id)], [["strong", "d"], ["d"]], "one copy is selected, the other dropped");
  const splitWins = dCopies.map((copy) => Array.from({ length: 64 }, (_, k) => k).filter((k) => selectLearnings([strong, ...dCopies], files, 400, { usage: {}, seed: propensitySeed(42, k) }).selected.includes(copy)).length);
  assert.ok(splitWins.every((n) => n > 0 && n < 64), `each copy is contested: ${splitWins.join(", ")} of 64`);
  assert.equal(splitWins[0]! + splitWins[1]!, 64, "the per-id sum of the copies' wins reads exactly 1");
  assert.equal(split.propensity!.d, 1, "a copy of d reaches the prompt in every re-selection");
  assert.deepEqual(split.contestedIds, ["d"], "d is contested at a pooled share of 1");
  assert.deepEqual(contestedPropensities(split.propensity, split.contestedIds), { __proto__: null, d: 1 }, "so it keeps its own share");
  assert.equal(split.contentIds!.d, AMBIGUOUS_LEARNING_CONTENT, "two matching revisions of one id");
  assert.equal(split.contentIds!.strong, learningContentIdentity(strong));

  // THE SAME CASE THROUGH THE PRODUCER: a project copy and a user-overall copy of one id, BOTH matching
  // the task, as runTaskBody loads its two homes, through the real loader, selector, producer row,
  // appendLedger and the ledger union read. Each copy is contested and the draw put one in each arm.
  const { run: splitRun, id: splitId } = await copySplitRun();
  const splitRunWins = copyWins(splitRun).filter((_, j) => splitRun.corpus[j]!.id === splitId);
  assert.ok(splitRunWins.reduce((sum, n) => sum + n, 0) >= LEARNING_PROPENSITY_DRAWS, `per id, ${splitRunWins.join(" + ")} of 64 reads a share of 1 or more`);
  assert.deepEqual([(splitRun.row.matched_ids as string[]).filter((m) => m === splitId), (splitRun.row.dropped as string[]).filter((d) => d === splitId)], [[splitId], [splitId]]);
  const splitP = splitRun.row.propensity as Record<string, number>;
  assert.ok(Object.hasOwn(splitP, splitId) && splitP[splitId]! > 0 && splitP[splitId]! <= 1, `${splitId} keeps its own share: ${splitP[splitId]}`);
  assert.equal((splitRun.row.content_ids as Record<string, string>)[splitId], AMBIGUOUS_LEARNING_CONTENT, `${splitId}: the row carries its ambiguity marker`);
  assertProducerInvariant(splitRun);
  const splitFold = foldLearningOutcomes([splitRun.row, { step: "verdict", run_id: splitRun.row.run_id, ts: ts(), verdict: "merged" }]);
  assert.equal(splitFold.excludedRevision.ambiguous, 1, `${splitId}'s exposure is counted as ambiguous`);
  assert.equal(splitFold.learnings.some((l) => l.id === splitId), false, `${splitId} is credited to no revision`);
  // AT A POOLED SHARE OF 1, THROUGH THE PRODUCER: the task text also names the user-overall copy's
  // symbol, so it is selected in every re-selection, while the project copy stays contested. The id
  // reaches the prompt every time, yet the budget cut decides a copy of it: the row keeps its share of 1.
  const pinned = await producerRun({ userLayerPinnedCopyOf: splitId, runId: `${PRODUCER_RUN_ID}-pinned` });
  const pinnedWins = copyWins(pinned).filter((_, j) => pinned.corpus[j]!.id === splitId);
  assert.equal(pinnedWins[1], LEARNING_PROPENSITY_DRAWS, "the pinned copy is selected in every re-selection");
  assert.ok(pinnedWins[0]! > 0 && pinnedWins[0]! < LEARNING_PROPENSITY_DRAWS, `the project copy is contested: ${pinnedWins[0]} of 64`);
  assert.equal((pinned.row.propensity as Record<string, number>)[splitId], 1, `${splitId} is ledgered at its pooled share of 1`);
  assert.equal((pinned.row.content_ids as Record<string, string>)[splitId], AMBIGUOUS_LEARNING_CONTENT);
  assertProducerInvariant(pinned);
  const pinnedFold = foldLearningOutcomes([pinned.row, { step: "verdict", run_id: pinned.row.run_id, ts: ts(), verdict: "merged" }]);
  assert.equal(pinnedFold.excludedRevision.ambiguous, 1, `${splitId}'s exposure is counted as ambiguous, never trimmed or dropped`);

  // IDS THAT NAME Object.prototype MEMBERS. A learning id is free corpus text, and the YAML loader
  // accepts `__proto__`. On an ordinary object, `contentIds["__proto__"] = digest` called the inherited
  // setter and dropped the digest, so the row carried the id's propensity and arm but no revision.
  // Every id-keyed record the seam and the draw produce has no prototype.
  const memberSnapshot = PROTOTYPE_MEMBER_IDS.map((pid) => entry(pid));
  const memberIdentities = learningContentIdentities(memberSnapshot, PROTOTYPE_MEMBER_IDS);
  assert.equal(Object.getPrototypeOf(memberIdentities), null);
  assert.deepEqual(Object.keys(memberIdentities), PROTOTYPE_MEMBER_IDS);
  for (const e of memberSnapshot) assert.equal(memberIdentities[e.id], learningContentIdentity(e), `${e.id}: an own key holding its digest`);
  assert.equal(Object.getPrototypeOf(drawn.propensity), null, "the draw's propensities have no prototype");
  assert.equal(Object.getPrototypeOf(drawn.contentIds), null, "nor do its content identities");

  // THROUGH THE PRODUCER AND A REAL LEDGER. The user-overall layer holds the four ids as equal-strength
  // rivals. Across runs the draw contests each one on both arms. After `appendLedger` and the union
  // read, every contested entry of every row still names its source revision as an own key.
  const memberRuns: ProducerRun[] = [];
  for (let i = 0; i < 8; i++) memberRuns.push(await producerRun({ userLayerIds: PROTOTYPE_MEMBER_IDS, runId: `${PRODUCER_RUN_ID}-member-${i}` }));
  const memberArms = new Map<string, Set<string>>(PROTOTYPE_MEMBER_IDS.map((pid) => [pid, new Set<string>()]));
  for (const memberRun of memberRuns) assertProducerInvariant(memberRun);
  for (const { row: memberRow, corpus: memberCorpus } of memberRuns) {
    const memberP = memberRow.propensity as Record<string, number>;
    const memberIds = memberRow.content_ids as Record<string, string>;
    const memberArmIds = [...(memberRow.matched_ids as string[]), ...(memberRow.dropped as string[])];
    assert.deepEqual(Object.keys(memberIds).sort(), [...new Set(memberArmIds)].sort(), "every id either arm names carries a revision");
    for (const pid of PROTOTYPE_MEMBER_IDS) {
      if (!Object.hasOwn(memberP, pid)) continue;
      assert.ok(Object.hasOwn(memberIds, pid), `${pid}: the revision survives the ledger as an own key`);
      assert.equal(memberIds[pid], learningContentIdentity(memberCorpus.find((e) => e.id === pid)!), `${pid}: the source entry's revision`);
      memberArms.get(pid)!.add((memberRow.matched_ids as string[]).includes(pid) ? "selected" : "dropped");
    }
  }
  for (const pid of PROTOTYPE_MEMBER_IDS) assert.deepEqual([...memberArms.get(pid)!].sort(), ["dropped", "selected"], `${pid} is contested on both arms`);
  // The fold credits each to its own revision on both arms: never `malformed`, never `unresolved`.
  const memberFold = foldLearningOutcomes(memberRuns.flatMap(({ row: r }) => [r, { step: "verdict", run_id: r.run_id, ts: ts(), verdict: "merged" }]));
  assert.deepEqual(memberFold.excludedRevision, { legacy: 0, malformed: 0, ambiguous: 0, conflicting: 0, unresolved: 0 });
  for (const pid of PROTOTYPE_MEMBER_IDS) {
    const cohorts = memberFold.learnings.filter((l) => l.id === pid);
    assert.equal(cohorts.length, 1, `${pid}: one cohort`);
    assert.equal(cohorts[0]!.contentId, learningContentIdentity(memberRuns[0]!.corpus.find((e) => e.id === pid)!));
    assert.ok(cohorts[0]!.injected > 0 && cohorts[0]!.dropped > 0, `${pid}: both arms are credited`);
  }

  // THE DIGEST looks usage up by id too. Each id hurts while workers claim to use it, so each is a
  // disagreement that names its revision, and folding its `learnings.used` rows writes nothing onto
  // Object.prototype or any other inherited member.
  const memberDigestRows: Row[] = PROTOTYPE_MEMBER_IDS.flatMap((pid) => [
    ...Array.from({ length: 20 }, (_, i) => run(`${pid}-digest-${i}`, 0.5, i < 10, i < 10 ? "blocked_ci" : "merged", 0, pid, learningContentIdentity(entry(pid)))).flat(),
    ...Array.from({ length: 12 }, (_, i) => ({ step: "learnings.used", run_id: `${pid}-used-${i}`, injected_ids: [pid], used_ids: [pid] })),
  ]);
  const memberSummary = summarizeLearningOutcomes(memberDigestRows)!;
  assert.equal(Object.hasOwn(Object.prototype, "offered"), false, "no usage count lands on Object.prototype");
  assert.deepEqual(
    memberSummary.disagreements.map((d) => [d.id, d.contentId, d.verdict, d.usedMean.toFixed(2)]),
    [...PROTOTYPE_MEMBER_IDS].sort().map((pid) => [pid, learningContentIdentity(entry(pid)), "hurts", "0.93"]),
  );
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

  // A REPEATED TRIGGER, through the real draw. The task text names `alpha`; the edit lists it twice.
  // The selector counts each copy as a hit, so the edit ranks L higher and moves its propensity. The
  // draw's own identity must move with it, or the two revisions share one cohort.
  const triggerSnapshot = (l: Partial<LearningEntry>): LearningEntry[] => [
    { ...entry("h", ["src/x.ts"], "h".repeat(650)), symbols: ["alpha", "beta"] },
    { ...entry("s1", ["src/x.ts"], "s".repeat(150)), symbols: ["alpha", "beta"] },
    { ...entry("s2", ["src/x.ts"], "t".repeat(150)), symbols: ["alpha", "beta"] },
    { ...entry("L", ["src/x.ts"], "l".repeat(450)), symbols: ["alpha"], ...l },
    { ...entry("c", ["src/x.ts"], "c".repeat(450)), symbols: ["alpha"] },
  ];
  const triggerDraw = (l: Partial<LearningEntry>) =>
    selectLearnings(triggerSnapshot(l), ["src/x.ts"], 1000, { text: "touches alpha and beta", usage: {}, seed: 11, propensityDraws: 64 });
  const once = triggerDraw({});
  const twice = triggerDraw({ symbols: ["alpha", "alpha"] });
  const pOnce = once.propensity!.L!;
  const pTwice = twice.propensity!.L!;
  assert.ok(pOnce > 0 && pOnce < 1 && pTwice > 0 && pTwice < 1, `both draws contest L (${pOnce}, ${pTwice})`);
  assert.notEqual(pOnce, pTwice, "the repeated trigger changes the selector's propensity for L");
  const revOnce = once.contentIds!.L!;
  const revTwice = twice.contentIds!.L!;
  assert.match(revOnce, LEARNING_CONTENT_IDENTITY_RE);
  assert.match(revTwice, LEARNING_CONTENT_IDENTITY_RE);
  assert.notEqual(revTwice, revOnce, "a change that moves the propensity is a new revision");
  // A repeated GLOB moves nothing, so it is the same revision: stable bytes, stable identity.
  const globTwice = triggerDraw({ files: ["src/x.ts", "src/x.ts"] });
  assert.equal(globTwice.propensity!.L, pOnce);
  assert.equal(globTwice.contentIds!.L, revOnce);
  // Opposite synthetic effects at the draws' own propensities and identities stay two cohorts: the
  // predecessor helps, the edit hurts, and neither verdict reaches the other.
  const triggerRows = [
    ...stratum("trigger-once", 20, pOnce, 10, (inj) => (inj ? "merged" : "blocked_ci"), revOnce),
    ...stratum("trigger-twice", 20, pTwice, 10, (inj) => (inj ? "blocked_ci" : "merged"), revTwice),
  ];
  const triggerReport = foldLearningOutcomes(triggerRows);
  assert.equal(triggerReport.learnings.length, 2, "one cohort per revision");
  const byTrigger = Object.fromEntries(triggerReport.learnings.map((l) => [l.contentId, l]));
  assert.deepEqual({ ...byTrigger[revOnce]!, se: undefined }, { id: "L", contentId: revOnce, injected: 10, dropped: 10, effect: 1, se: undefined, verdict: "helps" });
  assert.deepEqual({ ...byTrigger[revTwice]!, se: undefined }, { id: "L", contentId: revTwice, injected: 10, dropped: 10, effect: -1, se: undefined, verdict: "hurts" });

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
});

test("W1-T11115: learning outcome revision reports unresolved exposure identities as unmeasurable", async () => {
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
    // UNRESOLVED: no identity for the contested entry, or no single arm for it.
    injectedRow("no-identity", { content_ids: {} }), verdict("no-identity"),
    injectedRow("no-arm", { matched_ids: [], dropped: [] }), verdict("no-arm"),
    injectedRow("both-arms", { matched_ids: ["L"], dropped: ["L"] }), verdict("both-arms"),
    // Three well-formed runs: the only observations REV may count.
    ...stratum("current", 3, 0.5, 2, (inj) => (inj ? "merged" : "blocked_ci")),
  ];
  const report = foldLearningOutcomes(rows);
  assert.deepEqual(report.excludedRevision, { legacy: 20, malformed: 2, ambiguous: 1, conflicting: 2, unresolved: 3 });
  assert.equal(report.runs, 20 + 8 + 3, "an excluded revision still counts its row's run; only the observation is withheld");
  assert.deepEqual(report.learnings, [{ id: "L", contentId: REV, injected: 2, dropped: 1, verdict: "unmeasurable" }], "legacy rows never inherit the current revision");

  // THE DIGEST counts them by reason, beside the trimmed and verdict-less exclusions.
  const line = renderLearningOutcomes(summarizeLearningOutcomes(rows)!);
  assert.ok(line.includes("28 without a single revision (legacy 20, malformed 2, ambiguous 1, conflicting 2, unresolved 3)"), line);
  assert.ok(line.includes("0 measured, 1 unmeasurable"), line);
  const clean = renderLearningOutcomes(summarizeLearningOutcomes(stratum("only", 3, 0.5, 2, () => "merged"))!);
  assert.ok(!clean.includes("without a single revision"), clean);

  // A CONFLICT ACROSS THE TRIM. One run's two draws name different valid revisions, the second at a
  // propensity (1/64) the trim drops. The conflict is checked over EVERY row of the run before any
  // observation is trimmed, so neither is credited, and both count as conflicting.
  const zero = { legacy: 0, malformed: 0, ambiguous: 0, conflicting: 0, unresolved: 0 };
  const across = foldLearningOutcomes([
    injectedRow("across", {}),
    injectedRow("across", { matched_ids: [], dropped: ["L"], propensity: { L: 1 / 64 }, content_ids: { L: other } }),
    verdict("across"),
  ]);
  assert.deepEqual(across.excludedRevision, { ...zero, conflicting: 2 });
  assert.equal(across.excludedTrimmed, 0, "a conflicting exposure is counted as conflicting, never as trimmed");
  assert.deepEqual(across.learnings, [], "the row inside the trim is not credited to REV");
  // Two rows that AGREE across the trim are no conflict: the trim applies, and the other row counts.
  const agree = foldLearningOutcomes([
    injectedRow("agree", {}),
    injectedRow("agree", { matched_ids: [], dropped: ["L"], propensity: { L: 1 / 64 } }),
    verdict("agree"),
  ]);
  assert.deepEqual(agree.excludedRevision, zero);
  assert.equal(agree.excludedTrimmed, 1);
  assert.deepEqual(agree.learnings, [{ id: "L", contentId: REV, injected: 1, dropped: 0, verdict: "unmeasurable" }]);
  // A revision beside a row of the same run that names none (ambiguous, legacy, malformed, absent) is
  // not a single revision either, inside the trim or outside it: the run cannot be pinned to REV.
  const beside = foldLearningOutcomes(
    [{ content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } }, { content_ids: undefined }, { content_ids: { L: "lc1:short" } }, { content_ids: {} }].flatMap((sibling, i) => [
      injectedRow(`beside-${i}`, {}),
      injectedRow(`beside-${i}`, { propensity: { L: i % 2 === 0 ? 1 / 64 : 0.5 }, ...sibling }),
      verdict(`beside-${i}`),
    ]),
  );
  assert.deepEqual(beside.excludedRevision, { ...zero, conflicting: 8 });
  assert.equal(beside.excludedTrimmed, 0);
  assert.deepEqual(beside.learnings, []);
  // Two rows of one run that both name no revision do not conflict: each keeps its own reason.
  const neither = foldLearningOutcomes([injectedRow("neither", { content_ids: undefined }), injectedRow("neither", { content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } }), verdict("neither")]);
  assert.deepEqual(neither.excludedRevision, { ...zero, legacy: 1, ambiguous: 1 });

  // IDENTITY BEFORE THE TRIM. Each observation lands in ONE counter, the first that applies (the rule
  // is foldLearningOutcomes's). An unresolved identity is counted under its reason even outside the
  // trim, so `ambiguous: 0` cannot hide an emitted ambiguous identity. Only a resolved one is trimmed.
  const outsideTrim = 1 / 64;
  const identityFirst = foldLearningOutcomes(
    [
      { propensity: { L: outsideTrim }, content_ids: undefined },
      { propensity: { L: outsideTrim }, content_ids: { L: "lc1:short" } },
      { propensity: { L: outsideTrim }, content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } },
      { propensity: { L: 1 - outsideTrim }, content_ids: {} },
      { propensity: { L: outsideTrim }, matched_ids: [], dropped: [] },
      { propensity: { L: outsideTrim } },
    ].flatMap((over, i) => [injectedRow(`identity-first-${i}`, over), verdict(`identity-first-${i}`)]),
  );
  assert.deepEqual(identityFirst.excludedRevision, { ...zero, legacy: 1, malformed: 1, ambiguous: 1, unresolved: 2 });
  assert.equal(identityFirst.excludedTrimmed, 1, "only the observation whose revision and arm resolve is trimmed");
  assert.deepEqual(identityFirst.learnings, []);

  // THE PRODUCER at a trimmed propensity. An oversized project entry fits only when the draw ranks it
  // first, and the user-overall layer holds a different copy that the task never matches. The real row
  // ledgers that id ambiguous at a few 64ths, and the fold counts it as ambiguous, not as trimmed.
  const oversized = "lcr-oversized";
  let trimmedDraw: Row | undefined;
  for (let i = 0; i < 16 && trimmedDraw === undefined; i++) {
    const { row: candidate } = await producerRun({ oversized, userLayerCopyOf: oversized, runId: `${PRODUCER_RUN_ID}-trim-${i}` });
    const candidateP = candidate.propensity as Record<string, number> | undefined;
    if (candidateP && Object.hasOwn(candidateP, oversized) && candidateP[oversized]! < OUTCOME_PROPENSITY_TRIM) trimmedDraw = candidate;
  }
  assert.ok(trimmedDraw !== undefined, "a seeded draw contests the oversized entry below the trim");
  assert.equal((trimmedDraw.content_ids as Record<string, string>)[oversized], AMBIGUOUS_LEARNING_CONTENT, "the producer names no single revision");
  const trimmedRows = [trimmedDraw, verdict(String(trimmedDraw.run_id))];
  const trimmedFold = foldLearningOutcomes(trimmedRows);
  assert.equal(trimmedFold.excludedRevision.ambiguous, 1, "the emitted ambiguous identity is counted");
  assert.equal(trimmedFold.excludedTrimmed, 0, "and never only as trimmed");
  const trimmedLine = renderLearningOutcomes(summarizeLearningOutcomes(trimmedRows)!);
  assert.ok(trimmedLine.includes("0 trimmed, 1 without a single revision (ambiguous 1)"), trimmedLine);

  // AN OWN KEY ONLY. A ledgered row without the digest of an id that names an Object.prototype member
  // names no revision for it: `unresolved`, never `malformed` from reading the inherited member.
  const missingMember = foldLearningOutcomes(
    PROTOTYPE_MEMBER_IDS.flatMap((pid) => [
      JSON.parse(JSON.stringify(injectedRow(`missing-${pid}`, { matched_ids: [pid], propensity: { [pid]: 0.5 }, content_ids: {} }))) as Row,
      verdict(`missing-${pid}`),
    ]),
  );
  assert.deepEqual(missingMember.excludedRevision, { ...zero, unresolved: 4 });

  // AN ID IN BOTH ARMS (the round-4 review). Two copies of one id that split a draw put the id in both
  // arms. The fold never credits it, and never drops it silently: it is an exposure, with or without
  // a ledgered share, and lands in ONE counter by the same order. Row 0 is the shape the per-id
  // producer wrote for the reviewer's draw: both arms, no share and no revision for L, beside M's own.
  const splitRow = (over: Row): Row => ({ matched_ids: ["L", "M"], dropped: ["L"], propensity: { M: 0.5 }, content_ids: { M: other }, ...over });
  const splitRows: Row[] = [
    {},
    { content_ids: { M: other, L: AMBIGUOUS_LEARNING_CONTENT } },
    { content_ids: undefined },
    { propensity: undefined, content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } },
    { propensity: { L: 1, M: 0.5 }, content_ids: { M: other, L: AMBIGUOUS_LEARNING_CONTENT } },
    { propensity: { L: 1, M: 0.5 }, content_ids: { M: other, L: REV } },
    // A copy-split id the draw contests at a pooled share of 1, with BOTH copies selected this time.
    { matched_ids: ["L", "L", "M"], dropped: [], propensity: { L: 1, M: 0.5 }, content_ids: { M: other, L: AMBIGUOUS_LEARNING_CONTENT } },
    { matched_ids: ["L", "M"], dropped: [], propensity: { L: 1, M: 0.5 }, content_ids: { M: other, L: REV } },
  ].flatMap((over, i) => [injectedRow(`split-${i}`, splitRow(over)), verdict(`split-${i}`)]);
  const splitFold = foldLearningOutcomes(splitRows);
  // L: 0 unresolved (no identity), 1 ambiguous, 2 legacy, 3 ambiguous with no share record at all,
  // 4 ambiguous at a share of 1 (identity before the trim), 5 one revision but both arms: unresolved,
  // 6 ambiguous at a share of 1 in one arm, 7 one revision at a share of 1 in one arm: trimmed.
  // M: legacy in row 2, and credited to its own revision in the other six rows that ledger its share.
  assert.deepEqual(splitFold.excludedRevision, { ...zero, legacy: 2, ambiguous: 4, unresolved: 2 });
  assert.equal(splitFold.excludedTrimmed, 1, "only the single revision in a single arm reaches the trim");
  assert.equal(splitFold.runs, 8, "a row whose only exposure is a both-arms id still counts its run");
  assert.deepEqual(splitFold.learnings, [{ id: "M", contentId: other, injected: 6, dropped: 0, verdict: "unmeasurable" }]);
  // A both-arms id is in the run's census too: beside a row of the same run that pins it, it conflicts.
  const splitConflictRows = [
    injectedRow("split-conflict", { matched_ids: ["L"], dropped: ["L"], propensity: undefined, content_ids: { L: AMBIGUOUS_LEARNING_CONTENT } }),
    injectedRow("split-conflict", {}),
    verdict("split-conflict"),
  ];
  const splitConflict = foldLearningOutcomes(splitConflictRows);
  assert.deepEqual(splitConflict.excludedRevision, { ...zero, conflicting: 2 });
  assert.deepEqual(splitConflict.learnings, []);
  // THE PRODUCER'S OWN ROW for the reviewer's draw (two matching copies, project and user-overall):
  // the split id is counted as ambiguous, never dropped and never credited.
  const { run: splitRun, id: splitId } = await copySplitRun();
  const producerSplitRows = [splitRun.row, verdict(String(splitRun.row.run_id))];
  const producerSplit = foldLearningOutcomes(producerSplitRows);
  assert.equal(producerSplit.excludedRevision.ambiguous, 1, `${splitId} is counted as ambiguous`);
  assert.equal(producerSplit.learnings.some((l) => l.id === splitId), false);

  // THE FOLD-SIDE INVARIANT, stated apart from the fold: every exposure of an unmasked run with a
  // verdict (an entry with a ledgered share in (0, 1], or an id in both arms) lands in exactly one
  // place: one exclusion counter, the trim, or one cohort observation. None is ever dropped silently.
  const exposures = (all: Row[]): number => {
    const verdicts = new Set(all.filter((r) => r.step === "verdict").map((r) => r.run_id));
    return all
      .filter((r) => r.step === "learnings.injected" && r.masked !== true && verdicts.has(r.run_id))
      .reduce((n, r) => {
        const shares = Object.entries((r.propensity ?? {}) as Record<string, unknown>).filter(([, sp]) => typeof sp === "number" && sp > 0 && sp <= 1);
        const droppedIds = new Set((r.dropped ?? []) as string[]);
        const both = ((r.matched_ids ?? []) as string[]).filter((m) => droppedIds.has(m));
        return n + new Set([...shares.map(([sid]) => sid), ...both]).size;
      }, 0);
  };
  const placed = (all: Row[]): number => {
    const folded = foldLearningOutcomes(all);
    const excluded = Object.values(folded.excludedRevision).reduce((sum, n) => sum + n, 0);
    return excluded + folded.excludedTrimmed + folded.learnings.reduce((sum, l) => sum + l.injected + l.dropped, 0);
  };
  for (const fixture of [rows, splitRows, splitConflictRows, producerSplitRows, trimmedRows, [...rows, ...splitRows, ...producerSplitRows]]) {
    assert.ok(exposures(fixture) > 0);
    assert.equal(placed(fixture), exposures(fixture), "every exposure is placed exactly once");
  }

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

test("W1-T11115: learning outcome revision preserves randomized exposure bounds and privacy", async () => {
  // PRIVACY: an identity is a fixed-width digest, whatever the fact says.
  const id = learningContentIdentity(entry("L", ["src/x.ts"], `${RAW_FACT_SENTINEL} the raw fact text`));
  assert.match(id, /^lc1:[0-9a-f]{16}$/);

  // THE PRODUCER ROW: digests only, beside the unchanged propensity and masking fields.
  const { row, maskedRow } = await producerRun();
  assert.ok(!JSON.stringify(row).includes(RAW_FACT_SENTINEL), "no raw learning content enters the ledger");
  // Nor on the copy-split path: two matching copies of one id ledger a marker, never either fact.
  const { run: splitRun, id: splitId } = await copySplitRun();
  assert.ok(!JSON.stringify(splitRun.row).includes(RAW_FACT_SENTINEL), "no raw learning content enters the ledger");
  assert.equal((splitRun.row.content_ids as Record<string, string>)[splitId], AMBIGUOUS_LEARNING_CONTENT);
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
