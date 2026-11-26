import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readRecommendationStore,
  realRecommendationWriter,
  recommendationStorePath,
  startRecommendationBackfill,
  type RecommendationEvidence,
} from "#src/lib/inbox-recommendation.js";

function stateDirFor(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-scout-recommendation-refused-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

const evidence: RecommendationEvidence = {
  shards: async () => new Map(),
  shardText: async () => undefined,
  taskHistory: async () => [],
  resolve: async (entry) => (/^W1-T\d+$/.test(entry) ? "task" : undefined),
};

/** One timer tick of the daemon's pump: the rows it logged. */
async function pumpOnce(stateDir: string, proposal: { id: string; summary: string }, summarize: (input: { context: string }) => Promise<unknown>): Promise<string[]> {
  const rows: string[] = [];
  const pump = startRecommendationBackfill({
    stateDir, evidence, readProposals: () => [proposal], readLanes: () => ({ [proposal.id]: "ready" }), summarize,
  }, 60_000, (step) => rows.push(step));
  try {
    await pump.settled();
  } finally {
    pump.stop();
  }
  return rows;
}

/** The production writer over a model whose replies are scripted, one per spawn; the prompts it was sent are kept. */
function scriptedWriter(replies: Array<{ text: string; isError?: boolean; subtype?: string }>, prompts: string[]) {
  return realRecommendationWriter({
    mount: { model: "haiku", effort: "low", maxTurns: 400 } as never, cwd: "/nonexistent", settingsFile: "settings.json",
    spawn: (async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      const reply = replies.shift();
      assert.ok(reply, "no more scripted replies than spawns");
      return { subtype: "success", isError: false, ...reply };
    }) as never,
  });
}

// The answers the writer threw away as unparseable: a valid recommendation the model fenced and followed with a
// note that holds a brace. The greedy /\{[\s\S]*\}/ read spanned from the object's first brace to the note's last,
// so JSON.parse failed, the writer returned null, and two such answers emitted inbox.recommendation_refused.
const fencedWithNote = (why: string) => [
  "```json",
  JSON.stringify({ action: "approve", why, evidence: ["W1-T5418"], obsolete: false }),
  "```",
  "Note: the record's {status} field still reads queued.",
].join("\n");

test("W1-T10229: inbox.recommendation_refused no longer recurs", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  const prompts: string[] = [];
  const writer = scriptedWriter([
    { text: fencedWithNote("Its proof passed on main.") },
    // The changed fingerprint: the first reply holds no object at all, the repair attempt is fenced with a note.
    { text: "I recommend approving this item because its proof passed." },
    { text: fencedWithNote("Its re-filed proof passed on main.") },
  ], prompts);

  // A new fingerprint: the production writer reads the model's fenced answer, so the item is written, not refused.
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer), ["inbox.recommendation_written"]);
  assert.equal(prompts.length, 1, "one answer, no repair attempt");
  assert.equal(readRecommendationStore(recommendationStorePath(stateDir))[proposal.id]?.why, "Its proof passed on main.");

  // A changed fingerprint: the summary moved. A reply with no object is retried with a prompt that names the real
  // problem, and the repair answer is written. No row says refused.
  const changed = { ...proposal, summary: `${proposal.summary} It was re-filed.` };
  assert.deepEqual(await pumpOnce(stateDir, changed, writer), ["inbox.recommendation_written"]);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2]!, /Your last answer was refused for: the answer was not one JSON object/);
  assert.equal(readRecommendationStore(recommendationStorePath(stateDir))[proposal.id]?.why, "Its re-filed proof passed on main.");
});

test("W1-T10229: the writer reads the answer object out of prose, fences and stray braces", async () => {
  const answer = { action: "approve", why: 'Its proof "passed" on main {twice}.', evidence: ["W1-T5418"], obsolete: false };
  const prompts: string[] = [];
  const writer = scriptedWriter([
    { text: `Unclosed {aside. ${JSON.stringify(answer)} Then {not json}.` },
    { text: 'A sketch {"why": "first"} then {"why": "second"}, but no action.' },
    { text: "{not: json}" },
  ], prompts);
  assert.deepEqual(await writer({ context: "p" }), answer, "a quoted brace and an unclosed one around the object");
  assert.deepEqual(await writer({ context: "p" }), { why: "first" }, "no object names an action: the first object, for the checker to refuse");
  assert.equal(await writer({ context: "p" }), null, "an unparseable object is still no answer");
});

test("W1-T10229: a writer spawn that never answered is a failed tick, not a refused answer", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  const prompts: string[] = [];
  const writer = scriptedWriter([
    { text: "Claude AI usage limit reached", isError: true, subtype: "error_during_execution" },
    { text: fencedWithNote("Its proof passed on main.") },
  ], prompts);

  // The usage refusal is no model answer: it is not counted as refused and does not park the fingerprint.
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer), ["inbox.recommendation_failed"]);
  assert.throws(() => readFileSync(join(stateDir, "inbox-recommendation-refusals.json"), "utf8"), /ENOENT/);
  // So the next tick asks again and writes the answer.
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer), ["inbox.recommendation_written"]);
  assert.equal(prompts.length, 2);
});

test("W1-T10229: an answer the checker still refuses is recorded once per fingerprint", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  let asks = 0;
  const events: string[] = [];
  const worker = startRecommendationBackfill({
    stateDir,
    evidence,
    readProposals: () => [proposal],
    readLanes: () => ({ [proposal.id]: "ready" }),
    summarize: async () => {
      asks += 1;
      return null; // The two checked answers are invalid; that exact source is refused once.
    },
  }, 5, (step) => events.push(step));

  try {
    // Let several timer ticks run. A stable refusal must be recorded once, then suppressed by
    // its proposal fingerprint instead of emitting a ledger row on every tick.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.settled();
  } finally {
    worker.stop();
  }

  assert.equal(asks, 2, "one initial answer and one repair attempt for the unchanged proposal");
  assert.deepEqual(events, ["inbox.recommendation_refused"]);
});
