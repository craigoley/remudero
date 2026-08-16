import assert from "node:assert/strict";
import test from "node:test";
import { overlapWarningLinesFor, rareOverlapWarningLines } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { OpenPrFileScope } from "../src/lib/dispatch-overlap.js";

/**
 * W1-T917 — the READER for `rareOverlapWarnings`, which shipped with W1-T533/#1968 and had ZERO
 * callers outside its own module. W1-T533 owns the scoring and is untouched here; this drives the
 * CALL SITE. The threshold is `rareDeclarationRatioCeiling: 0.05`, so the fixture below straddles
 * it deliberately: a 2/100 path (2%) is rare, a 37/100 path (37%) is a hub.
 */

function task(id: string, files: string[]): Task {
  return { id, files } as unknown as Task;
}

/** 100 shards: `src/run-task.ts` in 37 of them (the 37% hub), `src/lib/plan.ts` in 2 (0.7% -> 2%). */
function planFixture(): Plan {
  const tasks: Task[] = [];
  for (let i = 0; i < 37; i++) tasks.push(task(`W1-H${i}`, ["src/run-task.ts"]));
  tasks.push(task("W1-R1", ["src/lib/plan.ts", "test/plan-sharding.test.ts"]));
  tasks.push(task("W1-R2", ["src/lib/plan.ts"]));
  for (let i = 0; i < 61; i++) tasks.push(task(`W1-F${i}`, [`src/lib/filler-${i}.ts`]));
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const PLAN_PATH = "plan/tasks.yaml";

test("W1-T917: the mint path warns on a rare path shared with an open pull request", () => {
  // THE #1873/#1874 PAIR, driven through the real caller: both declared src/lib/plan.ts and
  // test/plan-sharding.test.ts, were created 74 seconds apart, and BOTH WERE TRAILERLESS WITH NO
  // SHARD — which is why the open-PR side is fed from a DIFF, not from declared `files:`.
  const scopes: OpenPrFileScope[] = [{ id: "#1873", files: ["src/lib/plan.ts", "test/plan-sharding.test.ts"] }];
  const lines = overlapWarningLinesFor(
    ["src/lib/plan.ts", "test/plan-sharding.test.ts"],
    "craigoley",
    "remudero",
    PLAN_PATH,
    { plan: () => planFixture(), scopes: () => scopes },
  );
  assert.equal(lines.length, 1, `expected one warning, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /#1873/, "the warning must name the open pull request");
  // It names the RAREST shared path, not merely a shared one: test/plan-sharding.test.ts is in 1
  // shard here against src/lib/plan.ts's 2, so the rarest-selection is asserted rather than assumed.
  assert.match(lines[0], /test\/plan-sharding\.test\.ts/, "and the RAREST shared path");
  assert.match(lines[0], /1 of 100/, "with the ratio that makes it judgeable");
});

test("W1-T917: the mint path stays silent on a hub path alone", () => {
  // THE WHOLE DESIGN. src/run-task.ts is declared by 37 of 100 shards; a detector that reports this
  // fires on a third of the plan and is the proxy rarity weighting exists to replace.
  const scopes: OpenPrFileScope[] = [{ id: "#9999", files: ["src/run-task.ts"] }];
  const lines = overlapWarningLinesFor(["src/run-task.ts"], "craigoley", "remudero", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => scopes,
  });
  assert.deepEqual(lines, [], "a hub-only overlap must never warn");
});

test("W1-T917: the overlap warning never changes the minted id", () => {
  // ADVISORY, NEVER A GATE (W1-T533 design iii): the reader returns LINES. It has no way to refuse a
  // mint, alter an id or set an exit code — it returns string[] and nothing else.
  const scopes: OpenPrFileScope[] = [{ id: "#1873", files: ["src/lib/plan.ts"] }];
  const lines = overlapWarningLinesFor(["src/lib/plan.ts"], "craigoley", "remudero", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => scopes,
  });
  assert.ok(Array.isArray(lines) && lines.every((l) => typeof l === "string"));
  // And an empty candidate — the ordinary `rmd next-task-id` with no --files — reads nothing at all.
  let swept = 0;
  const none = overlapWarningLinesFor([], "craigoley", "remudero", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      swept++;
      return scopes;
    },
  });
  assert.deepEqual(none, []);
  assert.equal(swept, 0, "no candidate paths ⇒ not a single open-PR read is spent");
});

test("W1-T917: an unreadable open pull request list degrades to silence", () => {
  // An advisory that can break the verb it advises is worse than none. Each seam is failed
  // INDEPENDENTLY, so a passing result cannot come from the other one short-circuiting.
  const scopeThrow = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      throw new Error("API rate limit already exceeded");
    },
  });
  assert.deepEqual(scopeThrow, [], "an unreadable open-PR list must print nothing, not throw");

  const planThrow = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => {
      throw new Error("ENOENT: plan/tasks.yaml");
    },
    scopes: () => [{ id: "#1", files: ["src/lib/plan.ts"] }],
  });
  assert.deepEqual(planThrow, [], "an unreadable plan must print nothing, not throw");
});

test("W1-T917: the warning line names the pull request and the rare path", () => {
  const lines = rareOverlapWarningLines([
    { withPr: "#1874", rarestPath: "src/lib/plan.ts", declaredByCount: 2, totalShardCount: 277 },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /#1874/);
  assert.match(lines[0], /src\/lib\/plan\.ts/);
  assert.match(lines[0], /2 of 277/, "the rarity is shown as the ratio a filer can judge");
});
