import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backfillRecommendations,
  buildRecommendationPrompt,
  checkRecommendation,
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

  // A keep decision from a writer that obeys its prompt, scripted the same on both attempts: the prompt asks for
  // the text the checker requires, so the first answer is written and no row says refused.
  const kept = { ...changed, summary: `${changed.summary} It stays parked.` };
  const asked: string[] = [];
  assert.deepEqual(await pumpOnce(stateDir, kept, obedientWriter("keep", asked)), ["inbox.recommendation_written"]);
  assert.equal(asked.length, 1, "no repair attempt");
  const stored = readRecommendationStore(recommendationStorePath(stateDir))[proposal.id];
  assert.deepEqual([stored?.action, stored?.text], ["keep", "The exact keep input."]);
});

/** The production writer over a model that obeys its prompt: it answers `action`, with "text" only when the prompt
 *  says that action posts text. */
function obedientWriter(action: string, prompts: string[]) {
  return realRecommendationWriter({
    mount: { model: "haiku", effort: "low", maxTurns: 400 } as never, cwd: "/nonexistent", settingsFile: "settings.json",
    spawn: (async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      const posts = new RegExp(`\\b${action} posts (?:a reason|feedback|a question)\\b`).test(args.prompt);
      const answer = {
        action, ...(posts ? { text: `The exact ${action} input.` } : {}),
        why: "Its proof passed on main.", evidence: ["W1-T5418"], obsolete: false,
      };
      return { subtype: "success", isError: false, text: JSON.stringify(answer) };
    }) as never,
  });
}

test("W1-T10229: every action the prompt offers, answered as the prompt says, passes the checker in every lane", async () => {
  const resolves: Pick<RecommendationEvidence, "resolve"> = { resolve: async () => "pr" };
  const seen = new Set<string>();
  for (const id of ["machine-judge:W1-T5418", "ruling:p0", "unowned"]) {
    for (const lane of ["ready", "drafting", "notReady", "declined"] as const) {
      const prompt = buildRecommendationPrompt({ proposal: { id, summary: "A parked decision." }, lane, history: [] });
      const offered = /"action" is one of: ([a-z, ]+)\./.exec(prompt)![1]!.split(", ");
      for (const action of offered) {
        const answer = await obedientWriter(action, [])({ context: prompt });
        assert.deepEqual(await checkRecommendation(answer, { id, lane, ifNothingHappens: "It stays parked." }, resolves),
          { ok: true, problems: [] }, `${action} on ${id} in ${lane}`);
        seen.add(action);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["approve", "decline", "keep", "reframe", "reply"]);
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

/** A clock the test moves: the writer's deferrals are timed by it. */
function fakeClock(start = Date.parse("2026-11-26T14:00:00.000Z")) {
  let at = start;
  return { advance: (ms: number) => { at += ms; }, now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
}

/** The production writer over a model that answers per item: `reply(id)` scripts each spawn; the ids asked are kept. */
function itemWriter(reply: (id: string) => { text: string; isError?: boolean; subtype?: string; notStarted?: "admission-abandoned" }, asked: string[]) {
  return realRecommendationWriter({
    mount: { model: "haiku", effort: "low", maxTurns: 400 } as never, cwd: "/nonexistent", settingsFile: "settings.json",
    spawn: (async (args: { prompt: string }) => {
      const id = /^Item: (\S+)/m.exec(args.prompt)?.[1] ?? "";
      asked.push(id);
      return { subtype: "success", isError: false, ...reply(id) };
    }) as never,
  });
}

const A = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
const B = { id: "machine-judge:W1-T6088", summary: "A merge-queue guard is parked for a risk decision." };
const MINUTE = 60_000;
const tooLong = { text: "Prompt is too long", isError: true, subtype: "error_during_execution" };

test("W1-T10229: a spawn that keeps failing on one item never blocks the next one", async (t) => {
  const stateDir = stateDirFor(t);
  const asked: string[] = [];
  const clock = fakeClock();
  let a = A;
  const deps = {
    stateDir, evidence, clock, readProposals: () => [a, B], readLanes: () => ({ [A.id]: "ready" as const, [B.id]: "ready" as const }),
    summarize: itemWriter((id) => (id === A.id ? tooLong : { text: fencedWithNote("Its proof passed on main.") }), asked),
  };
  // The reviewer's case: a deterministic error on A, max=1, one tick per 60 s poll.
  const ticks = [];
  for (let i = 0; i < 5; i += 1) {
    ticks.push(await backfillRecommendations(deps, 1));
    clock.advance(MINUTE);
  }
  assert.deepEqual(asked, [A.id, B.id], "A failed once and is deferred, not respawned on each tick; B was asked in the same tick");
  assert.deepEqual(ticks.map((k) => [k.written, k.failed, k.refused]), [[1, 1, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(ticks[0]!.failures.map((f) => ({ id: f.proposalId, strikes: f.strikes, parked: f.parked })), [{ id: A.id, strikes: 1, parked: false }]);
  assert.match(ticks[0]!.failures[0]!.error, /Prompt is too long/, "the failure carries the spawn's error");
  assert.ok(readRecommendationStore(recommendationStorePath(stateDir))[B.id], "B's recommendation is written");

  // Bounded: the backoff doubles, and the third failure parks A until its fingerprint changes.
  clock.advance(5 * MINUTE);
  assert.deepEqual((await backfillRecommendations(deps, 1)).failures.map((f) => [f.strikes, f.parked]), [[2, false]]);
  clock.advance(5 * MINUTE);
  assert.equal((await backfillRecommendations(deps, 1)).failed, 0, "still inside the doubled backoff");
  clock.advance(5 * MINUTE);
  assert.deepEqual((await backfillRecommendations(deps, 1)).failures.map((f) => [f.strikes, f.parked]), [[3, true]]);
  clock.advance(24 * 60 * MINUTE);
  assert.equal((await backfillRecommendations(deps, 1)).failed, 0, "a parked fingerprint is not asked again");
  assert.equal(asked.filter((id) => id === A.id).length, 3);
  a = { ...A, summary: `${A.summary} It was re-filed.` };
  assert.deepEqual((await backfillRecommendations(deps, 1)).failures.map((f) => [f.strikes, f.parked]), [[1, false]], "a changed fingerprint starts over");
  assert.throws(() => readFileSync(join(stateDir, "inbox-recommendation-refusals.json"), "utf8"), /ENOENT/, "no failure is ever recorded as a refusal");
});

test("W1-T10229: a spawn that never started is deferred without a strike", async (t) => {
  const stateDir = stateDirFor(t);
  const asked: string[] = [];
  const clock = fakeClock();
  const deps = {
    stateDir, evidence, clock, readProposals: () => [A], readLanes: () => ({ [A.id]: "ready" as const }),
    summarize: itemWriter(() => ({ text: "", notStarted: "admission-abandoned" }), asked),
  };
  const first = await backfillRecommendations(deps, 1);
  assert.deepEqual(first.failures.map((f) => [f.strikes, f.parked, f.unattempted]), [[0, false, true]]);
  clock.advance(MINUTE);
  assert.equal((await backfillRecommendations(deps, 1)).failed, 0, "deferred, so no hot loop");
  for (let i = 0; i < 4; i += 1) {
    clock.advance(5 * MINUTE);
    assert.deepEqual((await backfillRecommendations(deps, 1)).failures.map((f) => [f.strikes, f.parked]), [[0, false]], "never parked");
  }
  assert.equal(asked.length, 5);
});

test("W1-T10229: a writer spawn that never answered is a failed row, not a refused answer", async (t) => {
  const stateDir = stateDirFor(t);
  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  const prompts: string[] = [];
  const clock = fakeClock();
  const writer = scriptedWriter([
    { text: "Claude AI usage limit reached", isError: true, subtype: "error_during_execution" },
    { text: fencedWithNote("Its proof passed on main.") },
  ], prompts);

  // The usage refusal is no model answer: it is logged as failed with its error, and does not park the fingerprint.
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pump = (log: typeof rows) => startRecommendationBackfill({
    stateDir, evidence, clock, readProposals: () => [proposal], readLanes: () => ({ [proposal.id]: "ready" }), summarize: writer,
  }, 60_000, (step, extra) => log.push({ step, extra }));
  let p = pump(rows);
  await p.settled();
  p.stop();
  assert.deepEqual(rows.map((r) => r.step), ["inbox.recommendation_failed"]);
  assert.equal(rows[0]!.extra?.proposal_id, proposal.id);
  assert.match(String(rows[0]!.extra?.error), /usage limit reached/);
  assert.deepEqual([rows[0]!.extra?.strikes, rows[0]!.extra?.parked, rows[0]!.extra?.unattempted], [1, false, false]);
  assert.throws(() => readFileSync(join(stateDir, "inbox-recommendation-refusals.json"), "utf8"), /ENOENT/);
  // After its deferral the next tick asks again and writes the answer.
  clock.advance(5 * MINUTE);
  const later: typeof rows = [];
  p = pump(later);
  await p.settled();
  p.stop();
  assert.deepEqual(later.map((r) => r.step), ["inbox.recommendation_written"]);
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
