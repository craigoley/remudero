import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_SCHEMA, ConfigShapeError, validateConfigShape } from "#src/lib/config-schema.js";
import {
  DEFAULT_DEPENDS_ON_SHORTLIST_K,
  dependsOnShortlist,
  dependsOnShortlistWithDependencies,
  SHORTLIST_RECALL_MISSED_CAP,
  shortlistRecall,
  withOneHopDependencies,
  type DependsOnCandidateQuery,
  type DependsOnCandidateRow,
} from "#src/lib/depends-on-candidates.js";
import { draftPlanIndex, inboxDraftExampleFragmentYaml, lintDraftedFragment, runDraftRung, type DraftRungDeps, type Proposal } from "#src/lib/inbox.js";
import type { WorkerResult } from "#src/lib/worker.js";

// MEASURED 2026-11-27 on main's plan (1,027 open tasks, a 266K-char full index), 150 recent architect tasks as proxy
// proposals with their W1-T ids stripped: the top k alone kept 0.739 of each task's real open depends_on at k=200;
// the top k plus one hop kept 0.851 at k=80 and 0.910 at k=200. inbox.draft_shortlist_recall is the live version
// of that measurement, logged for every lint-clean draft in both index modes.

const row = (id: string, title: string, dependsOn?: string[]): DependsOnCandidateRow =>
  ({ id, title, files: [], planRefs: [], ...(dependsOn === undefined ? {} : { dependsOn }) });
const query = (text: string, extra: Partial<DependsOnCandidateQuery> = {}): DependsOnCandidateQuery =>
  ({ text, files: [], planRefs: [], namedIds: new Set(), ...extra });

const STAMP = "- P-recall (a proposal) — RATIFIED 2026-01-01 -> NEW-1.";
const projectedIds = (index: string): string[] => [...index.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]!);

/** W1-T2 matches the proposal and depends on W1-T3 (open) and W1-T1 (landed); W1-T4 and W1-T5 share nothing. */
const RECALL_PLAN = [
  "- id: W1-T1", '  title: "a landed task"', "  status: merged", "  type: implement",
  "- id: W1-T2", '  title: "shortlist recall evidence widget"', "  status: queued", "  type: implement", "  depends_on: [W1-T3, W1-T1]",
  "- id: W1-T3", '  title: "an unrelated billing task"', "  status: queued", "  type: implement",
  "- id: W1-T4", '  title: "an unrelated deploy task"', "  status: queued", "  type: implement",
  "- id: W1-T5", '  title: "another unrelated task"', "  status: blocked", "  type: diagnose",
  "",
].join("\n");
const RECALL_PROPOSAL = { id: "P-recall", summary: "shortlist recall evidence", evidenceAnchors: [] } as unknown as Proposal;

function fragmentCiting(deps: string[]): string {
  return inboxDraftExampleFragmentYaml().replace("depends_on: []", `depends_on: [${deps.join(", ")}]`);
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "S-recall", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "gpt-6-luna", routedModel: "gpt-6-luna", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

async function rung(plan: string, text: string, extra: Partial<DraftRungDeps> = {}, proposal: Proposal = RECALL_PROPOSAL):
  Promise<{ prompt: string; logs: Record<string, unknown>[]; ok: boolean }> {
  let prompt: string | undefined;
  const logs: Record<string, unknown>[] = [];
  const [outcome] = await runDraftRung([proposal], plan, {
    ...extra,
    spawn: async (_proposal, p) => { prompt ??= p; return worker(text); },
    log: (step, fields) => { logs.push({ step, ...fields }); },
  }, "run-recall");
  assert.ok(prompt !== undefined, "control: the proposal must reach the spawn");
  return { prompt, logs, ok: outcome!.ok };
}

const draftText = (fragment: string): string => `=== FRAGMENT START ===\n${fragment}\n=== FRAGMENT END ===\nSTAMP: ${STAMP}`;
const recallRows = (logs: Record<string, unknown>[]) => logs.filter((r) => r["step"] === "inbox.draft_shortlist_recall");

test("the one-hop expansion adds every row a kept row depends on, in plan order, and never a second hop or an absent id", () => {
  const rows = [
    row("A", "a", ["C", "LANDED", "GHOST"]),
    row("B", "b"),
    row("C", "c", ["D"]),
    row("D", "d"),
    row("E", "e", ["A"]),
  ];
  assert.deepEqual(withOneHopDependencies(rows, ["A"]), ["A", "C"], "A's open dependency joins; one not among the rows never does");
  assert.deepEqual(withOneHopDependencies(rows, ["E"]), ["A", "E"], "plan order, not kept-then-joined order, and A's own deps are not followed");
  assert.deepEqual(withOneHopDependencies(rows, ["A", "C"]), ["A", "C", "D"], "each kept row contributes its own hop");
  assert.deepEqual(withOneHopDependencies(rows, ["B", "MISSING"]), ["B"], "a row with no depends_on adds nothing, and an absent kept id drops");
  assert.deepEqual(withOneHopDependencies(rows, []), [], "nothing kept, nothing joined");

  const scored = [row("HIT", "inbox draft shortlist", ["DEP"]), row("DEP", "billing"), row("OTHER", "deploys")];
  const q = query("inbox draft shortlist");
  assert.deepEqual(dependsOnShortlist(scored, q, 1), ["HIT"], "control: the top k alone misses the dependency, which shares no word");
  assert.deepEqual(dependsOnShortlistWithDependencies(scored, q, 1), ["HIT", "DEP"], "the hop recovers it");
  assert.deepEqual(dependsOnShortlistWithDependencies(scored, query("billing", { namedIds: new Set(["OTHER"]) }), 0), ["OTHER"],
    "a named row is kept at K 0 and, with no depends_on, adds nothing");
});

test("the topk index follows one hop to an open dependency, never to a landed one the proposal does not name", () => {
  const index = draftPlanIndex(RECALL_PROPOSAL, RECALL_PLAN, "topk", 1);
  assert.deepEqual(projectedIds(index.text), ["W1-T2", "W1-T3"], "W1-T2 scores, its open dependency W1-T3 joins, its landed W1-T1 does not");
  const named = { ...RECALL_PROPOSAL, summary: "shortlist recall evidence, after W1-T1" } as unknown as Proposal;
  assert.deepEqual(projectedIds(draftPlanIndex(named, RECALL_PLAN, "topk", 1).text), ["W1-T1", "W1-T2", "W1-T3"], "a named landed row is still kept");
});

test("config inboxDraftTopK changes the shortlist size, in the index and through the rung", async () => {
  const plan = [1, 2, 3, 4, 5].map((n) => [`- id: W1-T${n}`, `  title: "inbox ${"draft ".repeat(n)}index"`, "  status: queued", "  type: implement"].join("\n")).join("\n") + "\n";
  const proposal = { id: "P-size", summary: "inbox draft index", evidenceAnchors: [] } as unknown as Proposal;
  const sizes = [1, 3, 5].map((k) => projectedIds(draftPlanIndex(proposal, plan, "topk", k).text).length);
  assert.deepEqual(sizes, [1, 3, 5], "k bounds the scored rows");

  for (const topK of [1, 3]) {
    const { prompt, logs } = await rung(plan, "no markers", { indexMode: "topk", topK }, proposal);
    const index = draftPlanIndex(proposal, plan, "topk", topK);
    assert.equal(projectedIds(index.text).length, topK);
    assert.ok(prompt.includes(index.text), `the rung sends the k=${topK} shortlist`);
    assert.equal(logs.find((r) => r["step"] === "inbox.draft_synthesized")?.["plan_index_chars"], index.text.length);
  }

  for (const good of [1, 200]) assert.doesNotThrow(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxDraftTopK: good }, "config.json"));
  for (const bad of [0, -5, 1.5, "200", null]) {
    assert.throws(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxDraftTopK: bad }, "config.json"), ConfigShapeError, `refuses ${String(bad)}`);
  }
});

test("a clean draft under inboxDraftIndex full logs inbox.draft_shortlist_recall with its cited, in_shortlist and missed ids", async () => {
  const fragment = fragmentCiting(["W1-T2", "W1-T3", "W1-T4", "W1-T1", "W1-T99", "NEW-1", "W1-T4"]);
  assert.deepEqual(lintDraftedFragment(fragment, "P-recall", STAMP), [], "control: the fixture fragment must lint clean");

  const { prompt, logs, ok } = await rung(RECALL_PLAN, draftText(fragment), { indexMode: "full", topK: 1 });
  assert.equal(ok, true);
  assert.ok(prompt.includes("- id: W1-T5"), "control: the full index still lists every open row");
  assert.deepEqual(recallRows(logs), [{
    step: "inbox.draft_shortlist_recall", proposal_id: "P-recall", mode: "full", k: 1,
    cited: 3, in_shortlist: 2, missed: ["W1-T4"],
  }], "the open cites W1-T2 (scored) and W1-T3 (one hop) are held, W1-T4 is missed; the landed, unknown, placeholder and repeated ids never count");
  const order = logs.map((r) => r["step"]);
  assert.ok(order.indexOf("inbox.draft_shortlist_recall") < order.indexOf("inbox.drafted"), "logged at the point the rung caches");

  const topk = await rung(RECALL_PLAN, draftText(fragment), { indexMode: "topk", topK: 1 });
  assert.equal(recallRows(topk.logs)[0]?.["mode"], "topk", "under topk the same row names the mode");
  assert.deepEqual(recallRows(topk.logs)[0]?.["missed"], ["W1-T4"], "a miss there is a dependency the drafter found by its own search");

  const many = Array.from({ length: 30 }, (_, i) => `- id: W1-T${100 + i}\n  title: "filler ${i}"\n  status: queued\n  type: implement`).join("\n");
  const wide = await rung(`${RECALL_PLAN}${many}\n`, draftText(fragmentCiting(Array.from({ length: 30 }, (_, i) => `W1-T${100 + i}`))), { topK: 1 });
  const [capped] = recallRows(wide.logs);
  assert.equal(capped?.["cited"], 30);
  assert.equal(capped?.["in_shortlist"], 0);
  assert.equal((capped?.["missed"] as string[]).length, SHORTLIST_RECALL_MISSED_CAP, "missed is capped at 20 ids; cited minus in_shortlist still counts them all");
  assert.deepEqual(shortlistRecall(["A", "B", "A"], new Set(["A"])), { cited: 2, in_shortlist: 1, missed: ["B"] });
});

test("a draft that is not lint-clean, or whose recall cannot be computed, logs no recall row and is still handled", async () => {
  const none = await rung(RECALL_PLAN, "no markers");
  assert.deepEqual(recallRows(none.logs), [], "no parsed draft, no row");
  assert.ok(none.logs.some((r) => r["step"] === "inbox.draft_error"), "control: the rung saw the unparsed draft");

  const dirty = await rung(RECALL_PLAN, draftText("- id: NEW-1\n  title: \"x\"\n  acceptance: not a list"));
  assert.deepEqual(recallRows(dirty.logs), [], "a draft still dirty after its retries logs no row");
  assert.equal(dirty.logs.find((r) => r["step"] === "inbox.drafted")?.["lint_clean"], false, "control: the dirty draft was cached as dirty");

  // A k the score cannot floor makes the computation throw; under "full" nothing else reads k, so only the recall does.
  const broken = await rung(RECALL_PLAN, draftText(fragmentCiting(["W1-T2"])), { topK: Symbol("unflooring") as unknown as number });
  assert.equal(broken.ok, true, "the throw never reaches the rung");
  assert.deepEqual(recallRows(broken.logs), [], "and it logs nothing");
  assert.equal(broken.logs.find((r) => r["step"] === "inbox.drafted")?.["lint_clean"], true, "the draft is cached as before");
});

test("the default depends_on shortlist k is 200, in the code, the config schema and the recall row", async () => {
  assert.equal(DEFAULT_DEPENDS_ON_SHORTLIST_K, 200);
  const field = CONFIG_SCHEMA.find((f) => f.name === "inboxDraftTopK");
  assert.equal(field?.default, 200);
  assert.equal(CONFIG_SCHEMA.find((f) => f.name === "inboxDraftIndex")?.default, "full", "the index itself stays full by default");
  const rows = Array.from({ length: 250 }, (_, i) => row(`R${i}`, `inbox variant ${i}`));
  assert.equal(dependsOnShortlistWithDependencies(rows, query("inbox")).length, 200, "absent k keeps 200 scored rows");
  const { logs } = await rung(RECALL_PLAN, draftText(fragmentCiting(["W1-T2"])));
  assert.deepEqual(recallRows(logs).map((r) => [r["mode"], r["k"], r["cited"], r["in_shortlist"]]), [["full", 200, 1, 1]],
    "with no config the row reads mode full at k 200");
});
