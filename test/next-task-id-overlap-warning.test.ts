import assert from "node:assert/strict";
import test from "node:test";
import { candidateFilesFromArgs, overlapAdvisoryLines, overlapWarningLinesFor, rareOverlapWarningLines } from "../src/run-task.js";
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

test("W1-T2606: an unreadable open pull request list degrades to ONE NAMED OUTAGE LINE, never silence", () => {
  // SUPERSEDES the old "degrades to silence" contract (W1-T917's original assertion here): silence
  // is indistinguishable from a genuine clean read, which is the defect W1-T2606 fixes. The
  // successor contract is zero OVERLAP lines plus one named outage line — never a bare [], and
  // never any output at all being accepted. Each seam is failed INDEPENDENTLY, so a passing result
  // cannot come from the other one short-circuiting, and neither arm throws.
  const scopeThrow = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      throw new Error("API rate limit already exceeded");
    },
  });
  assert.equal(scopeThrow.length, 1, "an unreadable open-PR list must say so, not go silent");
  assert.match(scopeThrow[0]!, /could not be read/);
  assert.match(scopeThrow[0]!, /API rate limit already exceeded/, "names the underlying reason verbatim");

  const planThrow = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => {
      throw new Error("ENOENT: plan/tasks.yaml");
    },
    scopes: () => [{ id: "#1", files: ["src/lib/plan.ts"] }],
  });
  assert.equal(planThrow.length, 1, "an unreadable plan must say so, not go silent");
  assert.match(planThrow[0]!, /could not be read/);
  assert.match(planThrow[0]!, /ENOENT: plan\/tasks\.yaml/);
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

test("W1-T917: the files flag parses into candidate paths", () => {
  assert.deepEqual(candidateFilesFromArgs(["--files", "src/lib/plan.ts, test/plan-sharding.test.ts"]), [
    "src/lib/plan.ts",
    "test/plan-sharding.test.ts",
  ]);
  assert.deepEqual(candidateFilesFromArgs([]), [], "absent flag ⇒ no candidate, so no open-PR read");
  assert.deepEqual(candidateFilesFromArgs(["--files", " , ,"]), [], "blank entries are dropped, not passed through");
});

test("W1-T917/W1-T2606: the offline flag suppresses the READ but announces the suppression", () => {
  const scopes = [{ id: "#1873", files: ["src/lib/plan.ts"] }];
  let swept = 0;
  const deps = { plan: () => planFixture(), scopes: () => { swept++; return scopes; } };
  const offlineLines = overlapAdvisoryLines(["--files", "src/lib/plan.ts"], true, "o", "r", PLAN_PATH, deps);
  // W1-T2606: --offline still spends nothing (unchanged), but it may no longer read as a clean
  // check — it must say plainly that the surface was not consulted, matching the id line's own
  // "(--offline: ... floor, not a guarantee)" wording one screen above it.
  assert.equal(offlineLines.length, 1, "--offline with a requested check must say it did not check, not go silent");
  assert.match(offlineLines[0]!, /--offline/);
  assert.match(offlineLines[0]!, /NOT read/);
  assert.equal(swept, 0, "and must still not spend a single REST call");
  assert.equal(
    overlapAdvisoryLines(["--files", "src/lib/plan.ts"], false, "o", "r", PLAN_PATH, deps).length,
    1,
    "while the same call online does warn — the falsifier for the suppression",
  );
  // And when there is nothing to check in the first place (no --files), --offline still prints
  // nothing — it has nothing to announce not-having-read, exactly like the online arm's own
  // empty-candidate short circuit above.
  assert.deepEqual(
    overlapAdvisoryLines([], true, "o", "r", PLAN_PATH, deps),
    [],
    "no --files ⇒ nothing was ever going to be checked, offline or not",
  );
});
