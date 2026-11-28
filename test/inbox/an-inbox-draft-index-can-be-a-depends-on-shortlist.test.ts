import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigShapeError, validateConfigShape } from "#src/lib/config-schema.js";
import {
  candidateTokens,
  DEFAULT_DEPENDS_ON_SHORTLIST_K,
  dependsOnShortlist,
  pathsInText,
  scoreDependsOnCandidates,
  type DependsOnCandidateQuery,
  type DependsOnCandidateRow,
} from "#src/lib/depends-on-candidates.js";
import { draftPlanIndex, inboxDraftPrompt, planProjectionForDependsOn, runDraftRung, type Proposal } from "#src/lib/inbox.js";
import type { WorkerResult } from "#src/lib/worker.js";

// MEASURED 2026-11-27 at b446ded: after W1-T14296 the draft index still carries 1,027 open public tasks in 265,777
// chars of a 272,446-char prompt. `inboxDraftIndex: "topk"` sends a per-proposal shortlist instead; "full" (the
// default) must keep the prompt byte for byte.

const row = (id: string, title: string, files: string[] = [], planRefs: string[] = [], body?: string): DependsOnCandidateRow =>
  ({ id, title, files, planRefs, ...(body === undefined ? {} : { body }) });
const query = (text: string, extra: Partial<DependsOnCandidateQuery> = {}): DependsOnCandidateQuery =>
  ({ text, files: [], planRefs: [], namedIds: new Set(), ...extra });

/** A plan whose rows share files, directories, plan_refs and title words with SHORTLIST_PROPOSAL to different degrees. */
const SHORTLIST_PLAN = [
  "- id: W1-T1",
  '  title: "a landed task the proposal names"',
  "  status: merged",
  "  type: implement",
  "- id: W1-T2",
  '  title: "an unrelated queued task about billing"',
  "  status: queued",
  "  type: implement",
  "  files: [scripts/billing.mjs]",
  "- id: W1-T3",
  '  title: "the inbox draft index lists every open task"',
  "  status: queued",
  "  type: implement",
  "  files: [src/lib/inbox.ts]",
  "  depends_on: []",
  "- id: W1-T4",
  '  title: "a queued task the proposal names by id and shares nothing with"',
  "  status: blocked",
  "  type: diagnose",
  "- id: W1-T5",
  '  title: "a task sharing a plan ref"',
  "  status: queued",
  "  type: docs",
  "  plan_refs: [docs/forensics/inbox.md]",
  "- id: W1-T6",
  '  title: "a second unrelated task about deploys"',
  "  status: queued",
  "  type: implement",
  "  files: [deploy/entrypoint.sh]",
  "",
].join("\n");

const SHORTLIST_PROPOSAL = {
  id: "P-short",
  summary: "Shortlist the inbox draft index in src/lib/inbox.ts; follow up W1-T1 and W1-T4, see docs/forensics/inbox.md.",
  evidenceAnchors: [],
} as unknown as Proposal;

const projectedIds = (index: string): string[] => [...index.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]!);
const INDEX_HEADER = "=== plan/tasks.yaml INDEX (id, title, status, type, depends_on — for depends_on grounding) ===\n";
const SHORTLIST_LINE = "This is a shortlist; Grep plan/tasks.yaml and plan/tasks.d/ for any other dependency.";

function worker(): WorkerResult {
  return {
    sessionId: "S-short", costUsd: 0, numTurns: 1, text: "no markers", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "gpt-6-luna", routedModel: "gpt-6-luna", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

async function rungPrompt(proposal: Proposal, plan: string, indexMode?: "full" | "topk", escalate = false): Promise<{ prompt: string; logs: Record<string, unknown>[] }> {
  let prompt: string | undefined;
  const logs: Record<string, unknown>[] = [];
  await runDraftRung([proposal], plan, {
    ...(indexMode === undefined ? {} : { indexMode }),
    ...(escalate ? { escalate: async () => worker() } : {}),
    spawn: async (_proposal, p) => { prompt ??= p; return worker(); },
    log: (step, extra) => { logs.push({ step, ...extra }); },
  }, "run-short");
  assert.ok(prompt !== undefined, "control: the proposal must reach the spawn");
  return { prompt, logs };
}

test("the depends_on score ranks a shared file over a shared directory over nothing, and a rare path over a common one", () => {
  const rows = [
    row("A", "alpha", ["src/lib/inbox.ts"]),
    row("B", "beta", ["src/lib/other.ts"]),
    row("C", "gamma", ["deploy/entrypoint.sh"]),
    row("D", "delta", ["src/run-task.ts"]),
    row("E", "epsilon", ["src/run-task.ts"]),
    row("F", "zeta", ["src/run-task.ts"]),
  ];
  const [a, b, c] = scoreDependsOnCandidates(rows, query("", { files: ["src/lib/inbox.ts"] }));
  assert.ok(a! > b! && b! > 0, `an exact file (${a}) must outrank a shared parent directory (${b}), which still scores`);
  assert.equal(c, 0, "a row sharing no path scores zero");
  const both = scoreDependsOnCandidates(rows, query("", { files: ["src/lib/inbox.ts", "src/run-task.ts"] }));
  assert.ok(both[0]! > both[3]!, `the rare path (${both[0]}) must outweigh the path three rows share (${both[3]})`);
});

test("the depends_on score reads title words by BM25 and counts shared plan_refs, including an id the proposal names", () => {
  const rows = [
    row("A", "the inbox draft index lists every open task"),
    row("B", "an unrelated billing change", [], [], "nothing about the subject"),
    row("C", "a task citing a ref", [], ["docs/forensics/inbox.md"]),
    row("D", "a task citing a named id", [], ["W1-T9"]),
  ];
  const scores = scoreDependsOnCandidates(rows, query("shortlist the inbox draft index", { planRefs: ["docs/forensics/inbox.md"], namedIds: new Set(["W1-T9"]) }));
  assert.ok(scores[0]! > 0, "a title sharing query words scores");
  assert.equal(scores[1], 0, "a row sharing no word, path or ref scores zero");
  assert.ok(scores[2]! > 0, "a shared plan_ref scores");
  assert.ok(scores[3]! > 0, "a plan_ref naming an id the proposal names scores");
  assert.deepEqual(candidateTokens("The W1-T14296 index, and 2026 of it"), ["t14296", "index"], "stopwords, tokens under three characters and bare numbers drop");
  assert.deepEqual(scoreDependsOnCandidates([], query("anything")), [], "an empty plan scores nothing");
});

test("the depends_on shortlist always keeps a named id, even one that scores zero, and even at K 0", () => {
  const rows = [row("A", "inbox draft index"), row("N", "shares nothing at all"), row("B", "inbox only")];
  const q = query("inbox draft index", { namedIds: new Set(["N"]) });
  assert.equal(scoreDependsOnCandidates(rows, q)[1], 0, "control: the named row must score zero");
  assert.deepEqual(dependsOnShortlist(rows, q, 0), ["N"], "K 0 keeps the named row alone");
  assert.deepEqual(dependsOnShortlist(rows, q, 1), ["A", "N"], "K 1 adds the best scorer beside it");
});

test("the depends_on shortlist returns ids in plan order, not score order", () => {
  const rows = [row("LOW", "inbox"), row("NONE", "billing"), row("HIGH", "inbox draft index shortlist")];
  const q = query("inbox draft index shortlist");
  const scores = scoreDependsOnCandidates(rows, q);
  assert.ok(scores[2]! > scores[0]! && scores[0]! > 0, "control: HIGH must outscore LOW, and LOW must score");
  assert.deepEqual(dependsOnShortlist(rows, q), ["LOW", "HIGH"], "plan order, the zero scorer left out");
  assert.deepEqual(dependsOnShortlist(rows, q, 1), ["HIGH"], "K 1 keeps the higher scorer");
});

test("the depends_on shortlist holds at most K scored rows plus the named ones, and never pads with a zero scorer", () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(`R${i}`, i % 2 === 0 ? `inbox variant ${i}` : `billing variant ${i}`));
  const q = query("inbox", { namedIds: new Set(["R1", "R3"]) });
  const kept = dependsOnShortlist(rows, q, 80);
  assert.equal(kept.length, 80 + 2, "80 scored rows plus the two named ones");
  assert.ok(kept.includes("R1") && kept.includes("R3"), "both named rows are kept");
  assert.deepEqual(kept.filter((id) => Number(id.slice(1)) % 2 === 1), ["R1", "R3"], "no other zero-scoring row is kept");
  assert.equal(dependsOnShortlist(rows, q, 10).length, 12, "a smaller K bounds the scored rows to it");
  assert.equal(dependsOnShortlist(rows, q, 1000).length, 100 + 2, "a K above the scorers keeps every scorer and no zero row");
  assert.equal(dependsOnShortlist(rows, q).length, Math.min(DEFAULT_DEPENDS_ON_SHORTLIST_K, 100) + 2, "the default K bounds it the same way");
});

test("the depends_on shortlist reads repo paths from the proposal text, never a URL", () => {
  assert.deepEqual(pathsInText("see `.github/workflows/ci.yml`, `src/lib/foo.ts:12`, " +
    "src/lib/bar.ts#L13-L14, ./test/inbox/x.test.ts, ../plan/tasks.yaml and https://example.com/a/b."),
  [".github/workflows/ci.yml", "src/lib/foo.ts", "src/lib/bar.ts", "test/inbox/x.test.ts", "plan/tasks.yaml"]);
  // A citation that ends a sentence keeps its file path: punctuation comes off before the location suffix.
  for (const cited of ["src/lib/rare.ts:12.", "src/lib/rare.ts:12:", "src/lib/rare.ts:12:5.", "src/lib/rare.ts#L12.", "src/lib/rare.ts#L12-L14:"]) {
    assert.deepEqual(pathsInText(`Read ${cited}`), ["src/lib/rare.ts"], cited);
  }
});

test("proposal text paths rank exact dot-directory files over a shared directory, and rare line-cited paths over common ones", () => {
  const dotPathProposal = { ...SHORTLIST_PROPOSAL,
    summary: "Review `.github/workflows/ci.yml` before changing the workflow." } as Proposal;
  const dotPathPlan = [
    "- id: W1-T10", '  title: "the exact workflow file"', "  status: queued", "  type: implement",
    "  files: [.github/workflows/ci.yml]",
    "- id: W1-T11", '  title: "a sibling workflow file"', "  status: queued", "  type: implement",
    "  files: [.github/workflows/release.yml]",
    "- id: W1-T12", '  title: "an unrelated billing file"', "  status: queued", "  type: implement",
    "  files: [scripts/billing.mjs]", "",
  ].join("\n");
  assert.deepEqual(projectedIds(draftPlanIndex(dotPathProposal, dotPathPlan, "topk", 2).text), ["W1-T10", "W1-T11"],
    "proposal text keeps the exact .github file and its directory neighbor, not an unrelated row");

  const citedPathProposal = { ...SHORTLIST_PROPOSAL,
    summary: "See src/lib/rare.ts:12 and src/run-task.ts#L20 for context." } as Proposal;
  const citedPathPlan = [
    "- id: W1-T20", '  title: "the rare file with a line citation"', "  status: queued", "  type: implement",
    "  files: [src/lib/rare.ts]",
    ...[21, 22, 23].flatMap((id) => [`- id: W1-T${id}`, '  title: "a common runner file"', "  status: queued", "  type: implement",
      "  files: [src/run-task.ts]"]),
    "",
  ].join("\n");
  assert.deepEqual(projectedIds(draftPlanIndex(citedPathProposal, citedPathPlan, "topk", 1).text), ["W1-T20"],
    "the :line and #L citations normalize to file paths, and the rare exact path outranks the common one");
  // Titles share no word with the text, so only the cited path can keep the row (before the fix the index came back empty).
  const pathOnlyPlan = ["- id: W1-T30", '  title: "the guard"', "  status: queued", "  type: implement", "  files: [src/lib/rare.ts]",
    ...[31, 32, 33].flatMap((id) => [`- id: W1-T${id}`, '  title: "a runner"', "  status: queued", "  type: implement",
      "  files: [src/run-task.ts]"]), ""].join("\n");
  for (const summary of ["Fix src/lib/rare.ts:12.", "Fix src/lib/rare.ts:12: now", "Fix src/lib/rare.ts#L12."]) {
    assert.deepEqual(projectedIds(draftPlanIndex({ id: "P-cite", summary, evidenceAnchors: [] } as unknown as Proposal, pathOnlyPlan, "topk", 1).text),
      ["W1-T30"], `a sentence-final citation still keeps the row that declares the file: ${summary}`);
  }
});

test("invariant: with inboxDraftIndex full, or absent, the draft prompt is byte-identical to the current function's output", async () => {
  for (const proposal of [SHORTLIST_PROPOSAL, { ...SHORTLIST_PROPOSAL, id: "P-plain", summary: "names nothing" } as unknown as Proposal]) {
    const today = inboxDraftPrompt(proposal, SHORTLIST_PLAN, "run-short");
    assert.equal(inboxDraftPrompt(proposal, SHORTLIST_PLAN, "run-short", draftPlanIndex(proposal, SHORTLIST_PLAN, "full")), today);
    assert.equal(inboxDraftPrompt(proposal, SHORTLIST_PLAN, "run-short", draftPlanIndex(proposal, SHORTLIST_PLAN)), today, "the mode defaults to full");
    assert.equal((await rungPrompt(proposal, SHORTLIST_PLAN, "full")).prompt, today, "the rung under full sends today's prompt");
    assert.equal((await rungPrompt(proposal, SHORTLIST_PLAN)).prompt, today, "the rung with no mode sends today's prompt");
    assert.ok(!today.includes(SHORTLIST_LINE), "and the prompt carries no shortlist line");
  }
  const { logs } = await rungPrompt(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "full");
  const synthesized = logs.filter((r) => r["step"] === "inbox.draft_synthesized");
  assert.ok(synthesized.length > 0, "control: the rung must log its synthesized row");
  for (const r of synthesized) assert.ok(!("plan_index_mode" in r), "the full index adds no ledger field");
});

test("with inboxDraftIndex topk the index carries the shortlist line and only the candidate rows, in plan order", async () => {
  const full = projectedIds(planProjectionForDependsOn(SHORTLIST_PLAN, new Set(["W1-T1", "W1-T4"])));
  assert.deepEqual(full, ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6"], "control: the full index holds every open row and the named landed one");

  const index = draftPlanIndex(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "topk");
  assert.equal(index.shortlist, true);
  assert.deepEqual(projectedIds(index.text), ["W1-T1", "W1-T3", "W1-T4", "W1-T5"],
    "the named landed and open rows, the row sharing the file and title words, the row sharing a plan ref; never the unrelated ones");
  const fullRows = planProjectionForDependsOn(SHORTLIST_PLAN, new Set(["W1-T1", "W1-T4"])).split(/\n(?=- id: )/);
  assert.deepEqual(index.text.split(/\n(?=- id: )/), fullRows.filter((text) => /^- id: W1-T[1345]\n/.test(text)), "each kept row is the full index's own text");
  assert.deepEqual(projectedIds(draftPlanIndex(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "topk", 0).text), ["W1-T1", "W1-T4"], "K 0 keeps only the named rows");

  const { prompt, logs } = await rungPrompt(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "topk");
  assert.ok(prompt.includes(`${INDEX_HEADER}${SHORTLIST_LINE}\n${index.text}\n\n=== TASK IDS`), "the header gains the shortlist line above the rows");
  assert.equal(prompt, inboxDraftPrompt(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "run-short", index), "the rung sends the topk index");
  const synthesized = logs.filter((r) => r["step"] === "inbox.draft_synthesized");
  assert.ok(synthesized.length > 0, "control: the rung must log its synthesized row");
  for (const r of synthesized) {
    assert.equal(r["plan_index_mode"], "topk");
    assert.equal(r["plan_index_chars"], index.text.length);
  }
  const escalated = (await rungPrompt(SHORTLIST_PROPOSAL, SHORTLIST_PLAN, "topk", true)).logs;
  assert.ok(escalated.some((r) => r["step"] === "inbox.draft_escalated"), "control: the rung must escalate");
  const rescued = escalated.filter((r) => r["step"] === "inbox.draft_synthesized");
  assert.ok(rescued.length >= 2, "control: the escalation logs its own synthesized row");
  for (const r of rescued) assert.equal(r["plan_index_mode"], "topk", "the escalated draft's row names the topk index too");
});

test("config.json inboxDraftIndex accepts only full or topk", () => {
  for (const mode of ["full", "topk"]) {
    assert.doesNotThrow(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxDraftIndex: mode }, "config.json"));
  }
  for (const bad of ["top-k", true, 80]) {
    assert.throws(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxDraftIndex: bad }, "config.json"), ConfigShapeError);
  }
});
