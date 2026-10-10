/**
 * #10500 resumed a build that stopped on a `wip:` checkpoint exactly once. The first stop still always
 * resumes; whether a later stop resumes again is now the W1-T7096 progress judge's call, which sees each
 * stop's remaining work. With no judge wired (test fixtures) the stand-in keeps the former resume-once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as checkpoint from "../src/lib/unfinished-checkpoint.js";

type Stop = { round: number; subject: string; remaining?: string };
type Decide = (stops: Stop[], head: string, judge?: (input: unknown) => Promise<unknown>) => Promise<{ resume: boolean; by: string; reason: string }>;

function decide(): Decide {
  const fn = (checkpoint as Record<string, unknown>).decideCheckpointResume;
  assert.equal(typeof fn, "function", "decideCheckpointResume is exported");
  return fn as Decide;
}

const first: Stop = { round: 1, subject: "chore(wip): bind the reason", remaining: "final ratchets" };
const second: Stop = { round: 2, subject: "chore(wip): bind the reason", remaining: "final ratchets" };

test("a second checkpoint stop resumes again when the progress judge says continue", async () => {
  const seen: unknown[] = [];
  const result = await decide()([first, second], "abc123", async (input) => {
    seen.push(input);
    return { verdict: "continue", reason: "the remaining work is still being worked" };
  });
  assert.equal(result.resume, true);
  assert.equal(result.by, "judge");
  const input = seen[0] as { rounds: unknown[]; signals: { identicalRedSets: number }; currentRed: string[] };
  assert.equal(input.rounds.length, 1, "the judge sees the earlier stop as a round");
  assert.equal(input.signals.identicalRedSets, 1, "an unchanged remaining line is the judge's loop signal");
  assert.match(input.currentRed[0]!, /final ratchets/);
});

test("a repeated checkpoint stop opens the PR when the progress judge escalates", async () => {
  const result = await decide()([first, second], "abc123", async () => ({
    verdict: "escalate", loop: "same remaining work", reason: "two stops added nothing",
  }));
  assert.equal(result.resume, false);
  assert.equal(result.by, "judge");
  assert.match(result.reason, /same remaining work/);
});

test("with no judge wired a second checkpoint stop keeps the former resume-once stand-in", async () => {
  const result = await decide()([first, second], "abc123");
  assert.equal(result.resume, false);
  assert.equal(result.by, "stand-in");
});

test("the first checkpoint stop always resumes", async () => {
  const result = await decide()([first], "abc123");
  assert.equal(result.resume, true);
  assert.equal(result.by, "first-stop");
});

type JudgeStop = (stops: Stop[], seams: { readHead: () => string; makeJudge: () => ((input: unknown) => Promise<unknown>) | undefined }) => Promise<{ resume: boolean; by: string; reason: string }>;

function judgeStop(): JudgeStop {
  const fn = (checkpoint as Record<string, unknown>).judgeCheckpointStop;
  assert.equal(typeof fn, "function", "judgeCheckpointStop is exported");
  return fn as JudgeStop;
}

test("the harness builds the checkpoint judge only for a later stop and names an unreadable head", async () => {
  let built = 0;
  const heads: string[] = [];
  const makeJudge = () => {
    built++;
    return async (input: unknown) => {
      heads.push((input as { headSha: string }).headSha);
      return { verdict: "continue", reason: "keep going" };
    };
  };
  const firstOnly = await judgeStop()([first], { readHead: () => "aaa111\n", makeJudge });
  assert.equal(firstOnly.resume, true);
  assert.equal(built, 0, "the first stop never builds a judge");
  const later = await judgeStop()([first, second], { readHead: () => { throw new Error("no git"); }, makeJudge });
  assert.equal(later.resume, true);
  assert.equal(built, 1);
  assert.match(heads[0]!, /^unreadable: Error: no git/);
});

test("a checkpoint judge that throws or gives no verdict opens the PR, and a runaway is bounded", async () => {
  const thrown = await decide()([first, second], "h", async () => { throw new Error("judge down"); });
  assert.equal(thrown.resume, false);
  assert.match(thrown.reason, /checkpoint judgment failed: Error: judge down/);
  const absent = await decide()([first, second], "h", async () => undefined);
  assert.equal(absent.resume, false);
  assert.match(absent.reason, /absent checkpoint verdict/);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...first, round: i + 1 }));
  const bounded = await decide()(many, "h", async () => ({ verdict: "continue", reason: "forever" }));
  assert.equal(bounded.resume, false);
  assert.equal(bounded.by, "backstop");
});
