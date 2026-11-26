import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import {
  backfillRecommendations,
  gitRecommendationEvidence,
  readRecommendationStore,
  realRecommendationWriter,
  recommendationStorePath,
  startRecommendationBackfill,
  type ParkedRecommendation,
  type RecommendationEvidence,
} from "#src/lib/inbox-recommendation.js";
import { gitRepo } from "../helpers/git-repo.js";

function parkedAt(stateDir: string): Record<string, ParkedRecommendation> {
  return JSON.parse(readFileSync(join(stateDir, "inbox-recommendation-parked.json"), "utf8")) as Record<string, ParkedRecommendation>;
}

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
async function pumpOnce(stateDir: string, proposals: { id: string; summary: string } | Array<{ id: string; summary: string }>,
  summarize: (input: { context: string }) => Promise<unknown>, clock?: Clock): Promise<string[]> {
  const rows: string[] = [];
  const all = [proposals].flat();
  const pump = startRecommendationBackfill({
    stateDir, evidence, readProposals: () => all, readLanes: () => Object.fromEntries(all.map((p) => [p.id, "ready" as const])), summarize,
    ...(clock ? { clock } : {}),
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

  // The first item's spawn errors: it is parked with its reason, and the second item is still processed.
  const errorDir = stateDirFor(t);
  const first = { id: "machine-judge:W1-T1", summary: "The first parked decision needs review." };
  const second = { id: "machine-judge:W1-T2", summary: "The second parked decision needs review." };
  const asked: string[] = [];
  const erroring = scriptedWriter([
    { text: "API Error: prompt is too long", isError: true, subtype: "error_during_execution" },
    { text: fencedWithNote("The second proof passed on main.") },
  ], asked);
  const clock = fixedClock(Date.parse("2026-11-26T00:00:00.000Z"));
  assert.deepEqual(await pumpOnce(errorDir, [first, second], erroring, clock), ["inbox.recommendation_failed"]);
  assert.match(parkedAt(errorDir)[first.id]!.reason, /error_during_execution.*prompt is too long/);
  assert.deepEqual(await pumpOnce(errorDir, [first, second], erroring, clock), ["inbox.recommendation_written"]);
  assert.match(asked[1]!, /Item: machine-judge:W1-T2 /);
  assert.deepEqual(Object.keys(readRecommendationStore(recommendationStorePath(errorDir))), [second.id]);
  // The parked item is not respawned on the next tick.
  assert.deepEqual(await pumpOnce(errorDir, [first, second], erroring, clock), []);
  assert.equal(asked.length, 2);
  assert.throws(() => readFileSync(join(errorDir, "inbox-recommendation-refusals.json"), "utf8"), /ENOENT/);
});

test("W1-T10229: a parked item is retried on a doubling wait, capped at a day, and a changed source is asked at once", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T1", summary: "A parked decision needs review." };
  let asks = 0;
  // A spawn that throws (no result envelope at all) is the same class as an error result.
  const writer = realRecommendationWriter({
    mount: { model: "haiku", effort: "low", maxTurns: 400 } as never, cwd: "/nonexistent", settingsFile: "settings.json",
    spawn: (async () => {
      asks += 1;
      throw new Error("spawn E2BIG");
    }) as never,
  });
  let now = Date.parse("2026-11-26T00:00:00.000Z");
  const minute = 60_000;
  const waits = [15, 30, 60, 120, 240, 480, 960, 1440, 1440];
  for (const [index, wait] of waits.entries()) {
    assert.deepEqual(await pumpOnce(stateDir, proposal, writer, fixedClock(now)), ["inbox.recommendation_failed"]);
    const entry = parkedAt(stateDir)[proposal.id]!;
    assert.equal(entry.attempts, index + 1);
    assert.equal(Date.parse(entry.retryAt) - now, wait * minute);
    assert.match(entry.reason, /spawn E2BIG/);
    assert.deepEqual(await pumpOnce(stateDir, proposal, writer, fixedClock(now + wait * minute - 1)), [], "still parked");
    now += wait * minute;
  }
  assert.equal(asks, waits.length);
  const changed = { ...proposal, summary: `${proposal.summary} It was re-filed.` };
  assert.deepEqual(await pumpOnce(stateDir, changed, writer, fixedClock(now - minute)), ["inbox.recommendation_failed"]);
  assert.equal(parkedAt(stateDir)[proposal.id]!.attempts, 1, "a new fingerprint starts over");
});

test("W1-T10229: an item due for retry waits behind items that never errored", async (t) => {
  const stateDir = stateDirFor(t);
  const first = { id: "machine-judge:W1-T1", summary: "The first parked decision needs review." };
  const second = { id: "machine-judge:W1-T2", summary: "The second parked decision needs review." };
  const asked: string[] = [];
  const writer = scriptedWriter([
    { text: "API Error", isError: true, subtype: "error_during_execution" },
    { text: fencedWithNote("The second proof passed on main.") },
  ], asked);
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  await pumpOnce(stateDir, [first, second], writer, fixedClock(start));
  assert.deepEqual(await pumpOnce(stateDir, [first, second], writer, fixedClock(start + 60 * 60_000)), ["inbox.recommendation_written"]);
  assert.match(asked[1]!, /Item: machine-judge:W1-T2 /);
});

test("W1-T10229: a legacy task's prompt carries its own record, not the plan monolith", async (t) => {
  const repo = gitRepo({ kind: "inbox-recommendation-refused" });
  t.after(() => repo.cleanup());
  repo.git("config", "remote.origin.url", "https://github.com/acme/target.git");
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "- id: W1-T204\n  title: Its own record\n- id: W1-T205\n  title: Another task record\n");
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "test: add the plan monolith");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  const proposal = { id: "machine-judge:W1-T204", summary: "A legacy-plan task is parked." };
  const prompts: string[] = [];
  await backfillRecommendations({
    stateDir: stateDirFor(t), readProposals: () => [proposal], readLanes: () => ({ [proposal.id]: "ready" }),
    evidence: gitRecommendationEvidence(async (args) => repo.git(...args), { planDir: "plan", planMonolith: "plan/tasks.yaml" },
      { repository: "acme/target", checkoutRoot: repo.dir }),
    summarize: async ({ context }) => {
      prompts.push(context);
      return null;
    },
  }, 1);
  assert.match(prompts[0]!, /The task record on main:\n- id: W1-T204\n {2}title: Its own record/);
  assert.doesNotMatch(prompts[0]!, /W1-T205|Another task record/);
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
  const start = Date.parse("2026-11-26T00:00:00.000Z");

  // The usage refusal is no model answer: it is not counted as refused and does not refuse the fingerprint.
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer, fixedClock(start)), ["inbox.recommendation_failed"]);
  assert.throws(() => readFileSync(join(stateDir, "inbox-recommendation-refusals.json"), "utf8"), /ENOENT/);
  // So the item is asked again once its park ends, and the answer is written.
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer, fixedClock(start + 15 * 60_000)), ["inbox.recommendation_written"]);
  assert.equal(prompts.length, 2);
});

test("W1-T10229: abandoned admission fails the tick and parks nothing", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  const writer = realRecommendationWriter({
    mount: { model: "haiku", effort: "low", maxTurns: 400 } as never, cwd: "/nonexistent", settingsFile: "settings.json",
    spawn: (async () => ({ notStarted: "admission-abandoned", subtype: "admission_abandoned", isError: false, text: "" })) as never,
  });
  assert.deepEqual(await pumpOnce(stateDir, proposal, writer), ["inbox.recommendation_failed"]);
  assert.throws(() => readFileSync(join(stateDir, "inbox-recommendation-parked.json"), "utf8"), /ENOENT/);
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
