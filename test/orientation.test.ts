import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { regenerateOrientation } from "../src/lib/orientation.js";
import { buildGather } from "../src/lib/retro.js";
import type { Task } from "../src/lib/plan.js";

// `regenerateOrientation` is the exact mechanism `rmd retro` calls after every
// Architect worker step (src/run-task.ts's retroCommand). Standing rule 13: "A
// doc that DESCRIBES a mechanism is never proof the mechanism EXISTS." — so this
// drives it against a REAL git worktree (not a mock) across TWO simulated retro
// passes with DIFFERENT gather/next-task state, and asserts the second commit's
// OWN `git show` diff — the exact observable artifact a live `rmd retro` run
// produces — names the refreshed state and next task, never the stale ones.

const MASTER_PLAN_V1 = `# MASTER-PLAN

## 12. Standing rules

1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.

## 12A. Documentation as a gated artifact, in tiers

irrelevant
`;

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "placeholder",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...overrides,
  };
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-orientation-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "MASTER-PLAN.md"), MASTER_PLAN_V1);
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  return dir;
}

const LEDGER_PASS_1 = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"R1","task_id":"W1-T1","step":"run.start","type":"implement"}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"R1","task_id":"W1-T1","step":"verdict","verdict":"merged","pr_url":"https://github.com/o/r/pull/1","cost_usd":1}`,
].join("\n");

const LEDGER_PASS_2 = [
  LEDGER_PASS_1,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"R2","task_id":"W1-T2","step":"run.start","type":"implement"}`,
  `{"ts":"2026-01-02T00:01:00.000Z","run_id":"R2","task_id":"W1-T2","step":"verdict","verdict":"merged","pr_url":"https://github.com/o/r/pull/2","cost_usd":2}`,
].join("\n");

test("regenerateOrientation: a REAL retro pass commits docs/ORIENTATION.md naming the CURRENT next task and shipped list", () => {
  const worktreePath = makeWorktree();
  const gather = buildGather({ ledgerNdjson: LEDGER_PASS_1, learningsMd: "# L\n" });
  const result = regenerateOrientation({
    worktreePath,
    generatedAt: "2026-01-01T12:00:00.000Z",
    gather,
    nextTask: fixtureTask({ id: "W1-T7", title: "Transient-vs-strike classifier" }),
  });

  assert.equal(result.committed, true);
  assert.ok(result.diff, "a committed regeneration must return its OWN observable diff");
  // The committed diff itself — not a description of it — names the file and the content.
  assert.match(result.diff!, /docs\/ORIENTATION\.md/);
  assert.match(result.diff!, /\*\*W1-T7\*\* — Transient-vs-strike classifier/);
  assert.match(result.diff!, /W1-T1 → https:\/\/github\.com\/o\/r\/pull\/1/);

  // And the commit is REAL, on-disk, git-verifiable independent of the returned diff string.
  const log = execFileSync("git", ["-C", worktreePath, "log", "--oneline", "-1"], { encoding: "utf8" });
  assert.match(log, /rmd retro: regenerate docs\/ORIENTATION\.md/);
  const onDisk = readFileSync(join(worktreePath, "docs", "ORIENTATION.md"), "utf8");
  assert.match(onDisk, /W1-T7/);
});

test("regenerateOrientation: the SECOND retro pass's diff refreshes the next task AND the shipped list — never re-shows stale state", () => {
  const worktreePath = makeWorktree();

  // Pass 1 (simulates the FIRST rmd retro run).
  const gather1 = buildGather({ ledgerNdjson: LEDGER_PASS_1, learningsMd: "# L\n" });
  const pass1 = regenerateOrientation({
    worktreePath,
    generatedAt: "2026-01-01T12:00:00.000Z",
    gather: gather1,
    nextTask: fixtureTask({ id: "W1-T7", title: "Transient-vs-strike classifier" }),
  });
  assert.equal(pass1.committed, true);

  // Pass 2 (simulates the NEXT rmd retro run, later: one more merge shipped, and
  // the next runnable task has moved on now that W1-T7 presumably merged too).
  const gather2 = buildGather({ ledgerNdjson: LEDGER_PASS_2, learningsMd: "# L\n" });
  const pass2 = regenerateOrientation({
    worktreePath,
    generatedAt: "2026-01-02T12:00:00.000Z",
    gather: gather2,
    nextTask: fixtureTask({ id: "W1-T8", title: "A different, unrelated later task" }),
  });

  assert.equal(pass2.committed, true, "the second pass must commit AGAIN — the doc keeps regenerating, never goes stale");
  assert.ok(pass2.diff);
  // THE FALSIFIER: pass 2's own commit diff shows the REFRESHED next task...
  assert.match(pass2.diff!, /\*\*W1-T8\*\* — A different, unrelated later task/);
  assert.match(pass2.diff!, /W1-T2 → https:\/\/github\.com\/o\/r\/pull\/2/);
  // ...and the diff's ADDED lines (`+`) never re-assert the now-stale W1-T7 pick —
  // a diff is a CHANGE, so the old value appears only on a removed (`-`) line, if at all.
  const addedLines = pass2.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  assert.ok(!addedLines.some((l) => l.includes("W1-T7")), "pass 2's diff must not ADD the stale pass-1 next-task pick");

  // Two real, distinct, chronologically-ordered commits — not one commit amended, not a no-op.
  const log = execFileSync("git", ["-C", worktreePath, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(log.length, 3); // seed + pass1 + pass2
  assert.equal(log.filter((l) => l.includes("rmd retro: regenerate")).length, 2);
});

test("regenerateOrientation: an UNCHANGED gather/next-task on the next pass commits NOTHING (no spurious churn)", () => {
  const worktreePath = makeWorktree();
  const gather = buildGather({ ledgerNdjson: LEDGER_PASS_1, learningsMd: "# L\n" });
  const nextTask = fixtureTask({ id: "W1-T7", title: "Transient-vs-strike classifier" });

  const first = regenerateOrientation({ worktreePath, generatedAt: "SAME", gather, nextTask });
  const second = regenerateOrientation({ worktreePath, generatedAt: "SAME", gather, nextTask });

  assert.equal(first.committed, true);
  assert.equal(second.committed, false);
  assert.equal(second.diff, undefined);
  const log = execFileSync("git", ["-C", worktreePath, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(log.length, 2); // seed + the ONE real regeneration commit, no duplicate
});
