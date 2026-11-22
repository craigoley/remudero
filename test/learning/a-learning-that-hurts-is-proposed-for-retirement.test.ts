/**
 * test/learning/a-learning-that-hurts-is-proposed-for-retirement.test.ts — W1-T14141.
 *
 * knowledge-outcome.ts estimates each contested learning's effect on a clean merge from the
 * randomized budget draw, per content revision (W1-T11115), and the measurement cadence ledgers it as
 * `knowledge.measured`. Only the digest read it, so a learning measured to hurt kept being injected.
 * The knowledge gardener now reads the newest measurement and proposes one `retire` for each active
 * learning whose CURRENT revision reads `hurts`, through the same cap, pins, declines and reviewed PR
 * every other retirement takes.
 *
 * INVARIANT only-measured-harm-acts: helps, no-detectable-effect and unmeasurable never act, and
 * neither does a hurts verdict on an earlier revision of the text.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GardenerDeps } from "#src/lib/gardener.js";
import {
  currentLearningRevisions,
  initialGardenerState,
  knowledgeGardenSpec,
  measuredHarmRetirements,
  planGardenPass,
  readMeasuredLearningOutcomes,
  type GardenAction,
  type GardenWorkspace,
} from "#src/lib/knowledge-gardener.js";
import { KNOWLEDGE_MEASURED_STEP } from "#src/lib/knowledge-gaps.js";
import { buildKnowledgeInventory } from "#src/lib/knowledge-inventory.js";
import { foldLearningOutcomes, measuredHarm, newestMeasuredLearningOutcomes, type LearningOutcome } from "#src/lib/knowledge-outcome.js";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { appendLedger } from "#src/lib/ledger.js";
import { ledgerLivePath, readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { learningContentIdentities, loadLayeredLearningsForTaskFiles } from "#src/lib/learnings.js";
import { buildKnowledgeMeasuredRow } from "#src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TASK_FILE = "src/x.ts";

type Row = Record<string, unknown>;

/** A temp repo whose project learnings hold `ids`, each active unless named in `retired`. */
function corpus(ids: readonly string[], opts: { retired?: readonly string[]; facts?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14141-`));
  mkdirSync(join(root, "learnings"), { recursive: true });
  const yaml = ids
    .map((id) => [
      `- id: ${id}`,
      "  subsystem: t",
      `  lifecycle: ${opts.retired?.includes(id) ? "superseded" : "active"}`,
      `  files: [${TASK_FILE}]`,
      "  fact: >-",
      `    ${opts.facts?.[id] ?? `The ${id} learning says one thing about ${TASK_FILE} and says it plainly.`}`,
      "  src: t",
      "",
    ].join("\n"))
    .join("\n");
  writeFileSync(join(root, "learnings", "core.yaml"), yaml);
  return root;
}

/** The revision the PRODUCER ledgers for each id: its own loader and identity over the draw's snapshot. */
function producerRevisions(root: string, ids: readonly string[]): Record<string, string> {
  const homes = { projectDir: join(root, "learnings"), userOverallDir: join(root, "no-user-layer"), globalArtifactPath: join(root, "no-global", "a.yaml") };
  return learningContentIdentities(loadLayeredLearningsForTaskFiles(homes, [TASK_FILE]).entries, ids);
}

let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 1) + clock++ * 60_000).toISOString();

/** `n` injected and `n` dropped runs of `id` at revision `contentId`, propensity 0.5, with the given
 *  clean-merge counts per arm: the ledger rows `foldLearningOutcomes` reads. */
function trial(id: string, contentId: string, n: number, cleanInjected: number, cleanDropped: number): Row[] {
  const rows: Row[] = [];
  for (const injected of [true, false]) {
    for (let i = 0; i < n; i++) {
      const runId = `${id}-${contentId}-${injected ? "in" : "out"}-${i}`;
      rows.push({
        step: "learnings.injected",
        run_id: runId,
        ts: ts(),
        matched_ids: injected ? [id] : [],
        dropped: injected ? [] : [id],
        propensity: { [id]: 0.5 },
        content_ids: { [id]: contentId },
      });
      const clean = i < (injected ? cleanInjected : cleanDropped);
      rows.push({ step: "verdict", run_id: runId, ts: ts(), verdict: clean ? "merged" : "failed" });
    }
  }
  return rows;
}

/** The cadence's own `knowledge.measured` row over `rows`, as `runKnowledgeMeasurement` writes it. */
function measuredRow(rows: Row[], at: string): Row {
  return {
    ...buildKnowledgeMeasuredRow({ status: "measured", window: { from: at, to: at }, archiveCount: 0, unread: 0, outcomes: foldLearningOutcomes(rows) }),
    ts: at,
  };
}

function stateWith(rows: Row[]): string {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14141-state-`));
  for (const row of rows) appendLedger(ledgerLivePath(stateDir), row as Parameters<typeof appendLedger>[1]);
  return stateDir;
}

function specFor(root: string, stateDir: string, logged: Array<[string, Record<string, unknown> | undefined]> = []) {
  const deps = {
    stateDir,
    repoRoot: root,
    log: (step: string, extra?: Record<string, unknown>) => logged.push([step, extra]),
    openWorkspace: (() => {
      throw new Error("this test opens no workspace");
    }) as unknown as GardenerDeps<GardenWorkspace>["openWorkspace"],
  } satisfies GardenerDeps<GardenWorkspace>;
  return knowledgeGardenSpec(deps);
}

const retires = (actions: readonly GardenAction[]) => actions.filter((a) => a.class === "retire");

/** A hand-built cohort, for the rules the fold itself never produces (disagreeing numbers, legacy ids). */
const cohort = (id: string, contentId: string, verdict: LearningOutcome["verdict"], effect?: number, se?: number): LearningOutcome => ({
  id,
  contentId,
  injected: 20,
  dropped: 20,
  verdict,
  ...(effect === undefined ? {} : { effect }),
  ...(se === undefined ? {} : { se }),
});

function retirePlan(
  ids: readonly string[],
  outcomes: readonly LearningOutcome[],
  revisions: Record<string, string>,
  extra: Partial<Parameters<typeof planGardenPass>[0]> = {},
  retired: readonly string[] = [],
) {
  const root = corpus(ids, { retired });
  try {
    return planGardenPass({
      items: buildKnowledgeInventory(root),
      usage: {},
      state: initialGardenerState(),
      rng: () => 0.99,
      switchedOff: (c) => c !== "retire",
      measuredOutcomes: outcomes,
      currentRevisions: revisions,
      ...extra,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T14141 criterion 1: a learning whose newest measured verdict is hurts becomes one retire candidate naming its effect, standard error and arm counts", async () => {
  const root = corpus(["hurtful", "harmless"]);
  const rev = producerRevisions(root, ["hurtful", "harmless"]);
  // 20 runs a side: 4 of 20 clean with it, 16 of 20 clean without it.
  const rows = [...trial("hurtful", rev.hurtful!, 20, 4, 16), ...trial("harmless", rev.harmless!, 20, 10, 10)];
  const stateDir = stateWith([measuredRow(rows, "2026-11-20T00:00:00.000Z")]);
  try {
    const spec = specFor(root, stateDir);
    const inv = spec.inventory();
    // The gardener names the same revision the producer ledgered, or no match could ever be made.
    assert.equal(inv.currentRevisions.hurtful, rev.hurtful);
    const measured = inv.measuredOutcomes.find((o) => o.id === "hurtful")!;
    assert.equal(measured.verdict, "hurts");
    const candidates = retires(spec.candidates(inv, seededRandom(1), []));
    assert.deepEqual(candidates.map((a) => a.target), ["hurtful"], "exactly one retire, for the learning measured to hurt");
    const reason = candidates[0]!.reason;
    assert.ok(reason.includes(measured.effect!.toFixed(2)), `the reason names the effect: ${reason}`);
    assert.ok(reason.includes(`standard error ${measured.se!.toFixed(2)}`), `the reason names its standard error: ${reason}`);
    assert.ok(reason.includes("20 run(s) that injected it and 20 that dropped it"), `the reason names the arm counts: ${reason}`);
    assert.ok(reason.includes(rev.hurtful!), "the reason names the revision it measured");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T14141 criterion 1: only the newest measurement is read, so a later one withdraws an earlier hurts and a refusal acts on nothing", () => {
  const root = corpus(["swings"]);
  const rev = producerRevisions(root, ["swings"]).swings!;
  const hurts = measuredRow(trial("swings", rev, 20, 4, 16), "2026-11-10T00:00:00.000Z");
  const recovered = measuredRow(trial("swings", rev, 20, 10, 10), "2026-11-20T00:00:00.000Z");
  const refused = { ...buildKnowledgeMeasuredRow({ status: "refused", refusedReason: "archive unreadable", window: { from: "a", to: "b" }, archiveCount: 0, unread: 1 }), ts: "2026-11-21T00:00:00.000Z" };
  try {
    assert.deepEqual(newestMeasuredLearningOutcomes([recovered, hurts]).map((o) => o.verdict), ["no-detectable-effect"], "the newest row wins whatever order the union returns");
    assert.deepEqual(newestMeasuredLearningOutcomes([hurts, recovered, refused]), [], "a newest row that was refused acts on nothing, never on an older row");
    for (const [label, rows] of [["recovered", [hurts, recovered]], ["refused", [hurts, refused]]] as const) {
      const stateDir = stateWith([...rows]);
      try {
        const spec = specFor(root, stateDir);
        const inv = spec.inventory();
        assert.deepEqual(retires(spec.candidates(inv, seededRandom(1), [])), [], `${label}: the older hurts proposes nothing`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
    // POSITIVE CONTROL: the older row alone does propose it.
    const stateDir = stateWith([hurts]);
    try {
      const spec = specFor(root, stateDir);
      assert.deepEqual(retires(spec.candidates(spec.inventory(), seededRandom(1), [])).map((a) => a.target), ["swings"]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14141 criterion 2: helps, no-detectable-effect and unmeasurable verdicts produce no action", () => {
  const ids = ["helps-id", "flat-id", "unmeasured-id", "hurts-id"];
  const root = corpus(ids);
  const rev = producerRevisions(root, ids);
  rmSync(root, { recursive: true, force: true });
  const helps = cohort("helps-id", rev["helps-id"]!, "helps", 0.5, 0.1);
  const flat = cohort("flat-id", rev["flat-id"]!, "no-detectable-effect", -0.1, 0.1);
  const unmeasured = { ...cohort("unmeasured-id", rev["unmeasured-id"]!, "unmeasurable"), injected: 3, dropped: 2 };
  assert.deepEqual(retires(retirePlan(ids, [helps, flat, unmeasured], rev).actions), [], "no verdict but hurts acts");
  // POSITIVE CONTROL, same corpus and revisions: a hurts cohort beside them does act.
  const hurts = cohort("hurts-id", rev["hurts-id"]!, "hurts", -0.6, 0.13);
  assert.deepEqual(retires(retirePlan(ids, [helps, flat, unmeasured, hurts], rev).actions).map((a) => a.target), ["hurts-id"]);
});

test("W1-T14141 criterion 2: a hurts verdict on another revision, an inactive learning or disagreeing numbers produces no action", () => {
  const ids = ["edited", "retired", "odd", "legacy"];
  const root = corpus(ids, { retired: ["retired"] });
  const rev = producerRevisions(root, ids);
  rmSync(root, { recursive: true, force: true });
  const edited = cohort("edited", "lc1:0000000000000000", "hurts", -0.6, 0.13);
  const retired = cohort("retired", rev.retired ?? "lc1:1111111111111111", "hurts", -0.6, 0.13);
  const odd = cohort("odd", rev.odd!, "hurts", -0.1, 0.13);
  const legacy = cohort("legacy", "[legacy: revision unknown]", "hurts", -0.6, 0.13);
  const outcomes = [edited, retired, odd, legacy];
  assert.equal(measuredHarm(odd), false, "a hurts label whose effect is inside two standard errors is not harm");
  assert.deepEqual(measuredHarmRetirements(outcomes, rev, ["edited", "odd", "legacy"]), [], "only the exact current revision of an active learning can act");
  assert.deepEqual(retires(retirePlan(ids, outcomes, rev, {}, ["retired"]).actions), [], "through the pass, the same four propose nothing");
  // POSITIVE CONTROL: the edited learning's CURRENT revision measured to hurt does act.
  assert.deepEqual(retires(retirePlan(ids, [{ ...edited, contentId: rev.edited! }], rev, {}, ["retired"]).actions).map((a) => a.target), ["edited"]);
});

test("W1-T14141 criterion 3: the per-pass cap, test pins and declined filter apply to these candidates as to every other retire", () => {
  const ids = ["h1", "h2", "h3", "h4", "pinned", "declined"];
  const root = corpus(ids);
  const rev = producerRevisions(root, ids);
  rmSync(root, { recursive: true, force: true });
  // Certainty is |effect| / se: h1 is the most certain, h4 the least.
  const outcomes = [
    cohort("h1", rev.h1!, "hurts", -0.9, 0.1),
    cohort("h2", rev.h2!, "hurts", -0.8, 0.1),
    cohort("h3", rev.h3!, "hurts", -0.7, 0.1),
    cohort("h4", rev.h4!, "hurts", -0.3, 0.1),
    cohort("pinned", rev.pinned!, "hurts", -0.95, 0.1),
    cohort("declined", rev.declined!, "hurts", -0.99, 0.1),
  ];
  const state = { ...initialGardenerState(), declinedTargets: [{ class: "retire" as const, target: "declined", prNumber: 7, declinedAt: "2026-11-01T00:00:00.000Z" }] };
  const plan = retirePlan(ids, outcomes, rev, { state, testPins: { pinned: "test/pins.test.ts" } });
  assert.deepEqual(retires(plan.actions).map((a) => a.target).sort(), ["h1", "h2", "h3"], "the cap keeps the three most certain; the pinned and declined never take a slot");
  // POSITIVE CONTROL: without the pin and the decline, those two outrank all four.
  const open = retirePlan(ids, outcomes, rev);
  assert.deepEqual(retires(open.actions).map((a) => a.target).sort(), ["declined", "h1", "pinned"]);
});

test("W1-T14141 criterion 3: a learning both retire rules name is one retire, with both reasons and the stronger certainty", () => {
  const ids = ["unused", "used-a", "used-b"];
  const root = corpus(ids);
  const stateDir = stateWith([]);
  try {
    const rev = producerRevisions(root, ids);
    const spec = specFor(root, stateDir);
    const usage = { unused: { offered: 60, used: 0 }, "used-a": { offered: 60, used: 55 }, "used-b": { offered: 60, used: 50 } };
    const inv = { ...spec.inventory(), usage };
    const usageOnly = retires(spec.candidates(inv, seededRandom(3), []));
    assert.deepEqual(usageOnly.map((a) => a.target), ["unused"], "the usage rule alone names it");
    const harm = cohort("unused", rev.unused!, "hurts", -0.6, 0.13);
    const named = retires(spec.candidates({ ...inv, measuredOutcomes: [harm], currentRevisions: rev }, seededRandom(3), []));
    assert.deepEqual(named.map((a) => a.target), ["unused"], "one retire per target");
    assert.match(named[0]!.reason, /rarely used it/);
    assert.match(named[0]!.reason, /Measured to hurt/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14141: an unreadable measurement or corpus is logged and proposes no measured retirement", () => {
  const root = corpus(["hurtful"]);
  const rev = producerRevisions(root, ["hurtful"]);
  const row = measuredRow(trial("hurtful", rev.hurtful!, 20, 4, 16), "2026-11-20T00:00:00.000Z");
  const stateDir = stateWith([row]);
  try {
    // A rotation that cannot be read leaves the union incomplete.
    writeFileSync(join(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz"), "not gzip");
    const incomplete = readMeasuredLearningOutcomes(stateDir);
    assert.ok("unreadable" in incomplete && incomplete.unreadable.startsWith("incomplete ledger union"), JSON.stringify(incomplete));
    const logged: Array<[string, Record<string, unknown> | undefined]> = [];
    const spec = specFor(root, stateDir, logged);
    assert.deepEqual(retires(spec.candidates(spec.inventory(), seededRandom(1), [])), []);
    assert.ok(logged.some(([step, extra]) => step === "knowledge.gardener_failed" && extra?.phase === "measured-outcomes"));
    const thrown = readMeasuredLearningOutcomes(stateDir, (() => {
      throw new Error("disk gone");
    }) as unknown as typeof readLedgerUnionRecordsSync);
    assert.deepEqual(thrown, { unreadable: "Error: disk gone" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14141: the current revision is the producer's own, and a corpus that does not load fails as the inventory's own read does", () => {
  const root = corpus(["a", "b"], { facts: { b: "A second learning about src/x.ts, worded differently from the first one." } });
  try {
    const rev = currentLearningRevisions(root, ["a", "b", "absent"]);
    assert.deepEqual({ ...rev }, { ...producerRevisions(root, ["a", "b", "absent"]) });
    assert.equal(Object.hasOwn(rev, "absent"), false, "an id the corpus does not hold is given no invented revision");
    writeFileSync(join(root, "learnings", "core.yaml"), "- id: a\n  fact: [unclosed\n");
    assert.throws(() => currentLearningRevisions(root, ["a"]));
    assert.throws(() => buildKnowledgeInventory(root), "the inventory's own read refuses the same corpus");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14141: a measured row's entries are read field by field, and one without the outcome shape is left out", () => {
  const good = cohort("kept", "lc1:2222222222222222", "hurts", -0.6, 0.13);
  const row = {
    step: KNOWLEDGE_MEASURED_STEP,
    ts: "2026-11-20T00:00:00.000Z",
    status: "measured",
    outcomes: { learnings: [good, null, "text", { ...good, injected: -1 }, { ...good, verdict: "worse" }, { ...good, effect: "big" }] },
  };
  assert.deepEqual(newestMeasuredLearningOutcomes([row, { step: "verdict", ts: "2026-11-21T00:00:00.000Z" }]), [good]);
  assert.deepEqual(newestMeasuredLearningOutcomes([{ ...row, outcomes: { learnings: "none" } }]), []);
  assert.deepEqual(newestMeasuredLearningOutcomes([{ ...row, ts: 5 }]), []);
  // A cohort measured with no spread at all still acts, ranked above every finite certainty.
  const certain = measuredHarmRetirements([cohort("sure", "lc1:3333333333333333", "hurts", -1, 0)], { sure: "lc1:3333333333333333" }, ["sure"]);
  assert.equal(certain[0]!.certainty, Number.MAX_VALUE);
});
