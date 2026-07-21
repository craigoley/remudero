import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  buildPlanPrBody,
  buildPlanPrCommitMessage,
  ensureJudgeableBody,
  filingAcceptanceCriteria,
  regeneratePlanIndexAndCommit,
  regeneratePlanIndexFile,
  renderAcceptanceBlock,
} from "../src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";

// ── W1-T136: the shared plan-PR gate-contract module ────────────────────────────────────────
//
// Every assertion here that matters is proved against the REAL tools the gate actually runs:
// the real `commitlint` CLI (test/commit-message.test.ts's `lint()` pattern), the real
// `parseAcceptanceBlock` (the parser `remudero-review` uses), and the real
// `scripts/generate-plan-index.mjs` in a real temp git repo (test/orientation.test.ts's
// convention). #287/#387/#394 are the three already-merged incidents this module exists to
// make structurally impossible; each has a named falsifier below.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const COMMITLINT_CONFIG = join(REPO_ROOT, "commitlint.config.mjs");
const GENERATE_PLAN_INDEX_SCRIPT = join(REPO_ROOT, "scripts", "generate-plan-index.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", COMMITLINT_CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

// ── 1. Acceptance-block rendering ────────────────────────────────────────────────────────────

test("renderAcceptanceBlock: round-trips through the real parseAcceptanceBlock with matching count and content", () => {
  const criteria = [
    { claim: "alpha claim", proof: "unit test A" },
    { claim: "beta claim", proof: "unit test B" },
  ];
  const block = renderAcceptanceBlock(criteria);
  const body = `Some intro prose.\n\n${block}\n`;
  const parsed = parseAcceptanceBlock(body);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((c) => ({ claim: c.claim, proof: c.proof })),
    criteria,
  );
});

test("renderAcceptanceBlock: throws on an empty criteria list — an empty block is unjudgeable by construction", () => {
  assert.throws(() => renderAcceptanceBlock([]), /at least one criterion/);
});

// ── #394 falsifier: a non-bare header is invisible to the real parser ───────────────────────

test("#394 falsifier: a non-bare Acceptance header resolves ZERO criteria via the REAL parser — the danger is real", () => {
  const body = ["## Acceptance criteria and how each is proved", "", "- claim one | proof one"].join("\n");
  assert.equal(parseAcceptanceBlock(body).length, 0, "the #394 shape must be unrecognized — that IS the bug");
});

test("#394 falsifier: renderAcceptanceBlock's header is ALWAYS bare — never emits the shape that broke the parser", () => {
  const block = renderAcceptanceBlock([{ claim: "c", proof: "p" }]);
  const headerLine = block.split("\n")[0];
  assert.equal(headerLine, "Acceptance:");
  // And it actually parses, proving the renderer's own output is never the #394 shape.
  assert.equal(parseAcceptanceBlock(block).length, 1);
});

// ── #394 falsifier #2: an interruption after the header truncates the bullet run ─────────────

test("#394 falsifier #2: a blank line between bullets truncates the block via the REAL parser", () => {
  const body = ["Acceptance:", "- claim one | proof one", "", "- claim two | proof two"].join("\n");
  const parsed = parseAcceptanceBlock(body);
  assert.equal(parsed.length, 1, "parsing must stop at the blank line, dropping claim two");
});

test("#394 falsifier #2: renderAcceptanceBlock never interrupts its own bullets — every bullet survives parsing", () => {
  const criteria = [
    { claim: "one", proof: "p1" },
    { claim: "two", proof: "p2" },
    { claim: "three", proof: "p3" },
  ];
  const block = renderAcceptanceBlock(criteria);
  const lines = block.split("\n");
  assert.equal(lines[0], "Acceptance:");
  for (let i = 1; i < lines.length; i++) assert.match(lines[i], /^- /, `line ${i} is not a bullet: ${JSON.stringify(lines[i])}`);
  assert.equal(parseAcceptanceBlock(block).length, 3);
});

// ── 2. "Ensure judgeable" repair (the #394 backstop) ─────────────────────────────────────────

test("ensureJudgeableBody: a body with an already-judgeable Acceptance block is returned byte-identical (never clobbered)", () => {
  const body = "Some retro prose.\n\nAcceptance:\n- a real claim the worker wrote | a real proof\n";
  const out = ensureJudgeableBody(body, [{ claim: "fallback claim", proof: "fallback proof" }]);
  assert.equal(out, body);
});

test("ensureJudgeableBody: a body with NO Acceptance block gets a fallback appended and becomes judgeable", () => {
  const body = "Just prose, no acceptance block anywhere.";
  const out = ensureJudgeableBody(body, [{ claim: "fallback claim", proof: "fallback proof" }]);
  assert.notEqual(out, body);
  const parsed = parseAcceptanceBlock(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].claim, "fallback claim");
});

test("ensureJudgeableBody: the #394 shape (non-bare header) is NOT judgeable, so the fallback IS appended", () => {
  const body = "## Acceptance criteria and how each is proved\n\n- claim | proof";
  const out = ensureJudgeableBody(body, [{ claim: "fallback claim", proof: "fallback proof" }]);
  const parsed = parseAcceptanceBlock(out);
  assert.ok(
    parsed.some((c) => c.claim === "fallback claim"),
    "the repaired body must resolve the fallback criterion",
  );
});

// ── 3. Filing-PR Acceptance auto-authorship ──────────────────────────────────────────────────

test("filingAcceptanceCriteria: one criterion about the filing itself, naming the filed ids and files", () => {
  const criteria = filingAcceptanceCriteria(["W1-T900", "W1-T901"], ["plan/tasks.yaml", "MASTER-PLAN.md"]);
  assert.equal(criteria.length, 1);
  assert.match(criteria[0].claim, /W1-T900\/W1-T901/);
  assert.match(criteria[0].proof, /plan\/tasks\.yaml/);
  assert.match(criteria[0].proof, /MASTER-PLAN\.md/);
  // And it must actually be judgeable once rendered.
  assert.equal(parseAcceptanceBlock(renderAcceptanceBlock(criteria)).length, 1);
});

test("filingAcceptanceCriteria: throws with zero filed task ids", () => {
  assert.throws(() => filingAcceptanceCriteria([], ["plan/tasks.yaml"]));
});

// ── 4. Gate-compliant commit-message assembly — the #387 falsifier ──────────────────────────

// Verbatim (verified 673 chars) from `git show 39f7955` — PR #387's ratification commit, which
// spliced this single-paragraph stamp line RAW into the commit body and blew commitlint's
// body-max-line-length. Hardcoded here (rather than shelled out to `git show` at test time) so
// the falsifier survives a shallow checkout that lacks that historical commit.
const REAL_387_STAMP_LINE =
  "- P19 (plan -> WS-2 addendum) — RATIFIED 2026-07-20 -> W1-T170/W1-T171/W1-T172 (per-run isolated worker HOMES · the deterministic file-overlap pre-dispatch check, rung 1 · N parallel dispatch lanes bounded by the queue-governor WIP limit, N=2). TRIGGER FIRED: both prerequisites built — W1-T121 (#385, queue governor) and W1-T122 (#386, plan sharding). Rung 2 (Tree-sitter symbol-touch locks) stays BANKED until a rung-1 escape is observed in the ledger; W1-T172's `dispatch.concurrent_set` line is what makes that trigger answerable. HONESTY BOUND CARRIED: files: is advisory metadata a worker can exceed — the check reduces collision probability and is never a guarantee.";

test("#387 falsifier: the real 673-char stamp line is proven the right shape (single paragraph)", () => {
  assert.equal(REAL_387_STAMP_LINE.length, 673);
  assert.doesNotMatch(REAL_387_STAMP_LINE, /\n/);
});

test("#387 falsifier: the RAW, unwrapped splice (the pre-fix shape) is REJECTED by the real commitlint CLI", () => {
  const raw = ["chore(plan): ratify P19 via rmd approve", "", REAL_387_STAMP_LINE, "", "Remudero-Task: P19"].join("\n") + "\n";
  const result = lint(raw);
  assert.notEqual(result.status, 0, "the FALSIFIER: the raw unwrapped splice must be rejected by the real gate");
  assert.match(result.stdout + result.stderr, /body-max-line-length/);
});

test("#387 falsifier: buildPlanPrCommitMessage WRAPS the same stamp line — every line <=100 chars AND passes real commitlint", () => {
  const message = buildPlanPrCommitMessage({
    scope: "plan",
    subject: "ratify P19 via rmd approve",
    extraBody: REAL_387_STAMP_LINE,
  });
  for (const line of message.split("\n")) {
    assert.ok(line.length <= 100, `over-long line: ${JSON.stringify(line)}`);
  }
  const result = lint(message);
  assert.equal(result.status, 0, `shaped message must pass commitlint:\n${message}\n${result.stdout}${result.stderr}`);
});

test("buildPlanPrCommitMessage: omits the Remudero-Task trailer when no taskId is given (the filing-PR case)", () => {
  const msg = buildPlanPrCommitMessage({ scope: "plan", subject: "ratify P1 via rmd approve" });
  assert.doesNotMatch(msg, /Remudero-Task:/);
  assert.equal(lint(msg).status, 0);
});

test("buildPlanPrCommitMessage: includes a correctly-formatted trailer when a taskId IS given", () => {
  const msg = buildPlanPrCommitMessage({ scope: "plan", subject: "file a task", taskId: "W1-T900" });
  assert.match(msg, /^Remudero-Task: W1-T900$/m);
  assert.equal(lint(msg).status, 0);
});

// ── 5. PR-body assembly ──────────────────────────────────────────────────────────────────────

test("buildPlanPrBody: assembles a judgeable body with NO trailer when taskId is omitted (the filing case)", () => {
  const body = buildPlanPrBody({
    intro: "Some intro prose.",
    criteria: filingAcceptanceCriteria(["W1-T900"], ["plan/tasks.yaml", "MASTER-PLAN.md"]),
  });
  assert.equal(parseAcceptanceBlock(body).length, 1);
  assert.doesNotMatch(body, /Remudero-Task:/);
});

test("buildPlanPrBody: includes the trailer when taskId is given (the implementing-PR case)", () => {
  const body = buildPlanPrBody({
    intro: "intro",
    criteria: [{ claim: "c", proof: "p" }],
    taskId: "W1-T5",
  });
  assert.match(body, /^Remudero-Task: W1-T5$/m);
  assert.equal(parseAcceptanceBlock(body).length, 1);
});

// ── 6. Plan-index regeneration — the #287 falsifier ──────────────────────────────────────────

const MASTER_PLAN_V1 = "# MASTER-PLAN\n\n## Section One\n\nOriginal prose about section one.\n";
const MASTER_PLAN_V2 =
  "# MASTER-PLAN\n\n## Section One\n\nEDITED prose that no longer matches the committed index.\n\n## Section Two\n\nA brand new section.\n";

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
}

/** A real temp git repo seeded with MASTER-PLAN.md, a copy of the REAL generator script, and
 *  an empty `plan/` dir (no committed index — the "no prior index" starting state). */
function makeBareWorktree(masterPlanText: string): string {
  // realpathSync: on macOS, os.tmpdir() lives under a `/tmp` -> `/private/tmp` symlink.
  // generate-plan-index.mjs's `import.meta.url === pathToFileURL(process.argv[1]).href`
  // "run as main" guard compares a RESOLVED (real) URL against argv[1]'s literal path —
  // an unresolved `/tmp/...` script path never matches, so `main()` silently never runs
  // (exit 0, does nothing). Resolving here once, up front, is the fix.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-pr-emitter-")));
  const env = gitEnv();
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(GENERATE_PLAN_INDEX_SCRIPT, join(dir, "scripts", "generate-plan-index.mjs"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "MASTER-PLAN.md"), masterPlanText);
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  return dir;
}

/** A worktree with an INITIAL, correct plan/plan-index.json already committed (generated for
 *  real via the script) — the starting state for "edit MASTER-PLAN.md, then regenerate". */
function makeSeededWorktree(masterPlanText: string): string {
  const dir = makeBareWorktree(masterPlanText);
  const gen = spawnSync(process.execPath, [join(dir, "scripts", "generate-plan-index.mjs"), "--source", "MASTER-PLAN.md", "--out", "plan/plan-index.json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);
  const env = gitEnv();
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "seed plan-index"], { encoding: "utf8", env });
  return dir;
}

function freshCheck(dir: string) {
  return spawnSync(
    process.execPath,
    [join(dir, "scripts", "generate-plan-index.mjs"), "--source", "MASTER-PLAN.md", "--out", "plan/plan-index.json", "--check"],
    { cwd: dir, encoding: "utf8" },
  );
}

test("regeneratePlanIndexFile: after editing MASTER-PLAN.md, the regenerated index matches a fresh independent --check run", () => {
  const dir = makeSeededWorktree(MASTER_PLAN_V1);
  writeFileSync(join(dir, "MASTER-PLAN.md"), MASTER_PLAN_V2);

  const result = regeneratePlanIndexFile({ worktreePath: dir });
  assert.equal(result.changed, true);
  assert.equal(result.relPath, "plan/plan-index.json");

  const check = freshCheck(dir);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("#287 falsifier: SKIPPING the regen step after editing MASTER-PLAN.md leaves plan-index.json STALE", () => {
  const dir = makeSeededWorktree(MASTER_PLAN_V1);
  writeFileSync(join(dir, "MASTER-PLAN.md"), MASTER_PLAN_V2);
  // Deliberately never call regeneratePlanIndexFile — reproduces #287.
  const check = freshCheck(dir);
  assert.notEqual(check.status, 0, "the FALSIFIER: an un-regenerated index must fail --check");
  assert.match(check.stdout + check.stderr, /STALE/);
});

test("regeneratePlanIndexFile: content unchanged when MASTER-PLAN.md hasn't changed", () => {
  const dir = makeSeededWorktree(MASTER_PLAN_V1);
  const result = regeneratePlanIndexFile({ worktreePath: dir });
  assert.equal(result.changed, false);
});

// ── regenerate-and-commit-if-changed wrapper (mirrors test/orientation.test.ts) ──────────────

test("regeneratePlanIndexAndCommit: with no prior index, a pass regenerates AND commits it, with a commitlint-clean message", () => {
  const dir = makeBareWorktree(MASTER_PLAN_V1);
  const result = regeneratePlanIndexAndCommit({ worktreePath: dir });
  assert.equal(result.committed, true);
  assert.ok(result.diff);
  assert.match(result.diff!, /plan\/plan-index\.json/);

  const log = execFileSync("git", ["-C", dir, "log", "--oneline", "-1"], { encoding: "utf8" });
  assert.match(log, /chore\(plan\): regenerate plan\/plan-index\.json/);

  const message = execFileSync("git", ["-C", dir, "log", "-1", "--format=%B"], { encoding: "utf8" });
  const result2 = lint(message);
  assert.equal(result2.status, 0, `plan-index commit message must pass commitlint:\n${message}\n${result2.stdout}${result2.stderr}`);

  const check = freshCheck(dir);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("regeneratePlanIndexAndCommit: idempotent — a SECOND pass with no further MASTER-PLAN.md change commits NOTHING", () => {
  const dir = makeBareWorktree(MASTER_PLAN_V1);
  const first = regeneratePlanIndexAndCommit({ worktreePath: dir });
  assert.equal(first.committed, true);

  const second = regeneratePlanIndexAndCommit({ worktreePath: dir });
  assert.equal(second.committed, false);
  assert.equal(second.diff, undefined);

  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(log.filter((l) => l.includes("chore(plan): regenerate plan/plan-index.json")).length, 1, "no spurious second commit");
});

test("regeneratePlanIndexAndCommit: a real SECOND MASTER-PLAN.md edit commits AGAIN (two distinct commits)", () => {
  const dir = makeBareWorktree(MASTER_PLAN_V1);
  const first = regeneratePlanIndexAndCommit({ worktreePath: dir });
  assert.equal(first.committed, true);

  writeFileSync(join(dir, "MASTER-PLAN.md"), MASTER_PLAN_V2);
  const second = regeneratePlanIndexAndCommit({ worktreePath: dir });
  assert.equal(second.committed, true);

  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(log.filter((l) => l.includes("chore(plan): regenerate plan/plan-index.json")).length, 2);
});

// ── Light integration: the retro Acceptance-repair pass, logic only (no real `gh`) ───────────

test("integration: the #394-shaped fixture PR body becomes judgeable after ensureJudgeableBody, without touching gh", () => {
  // Mirrors what retroCommand's harness-side repair pass does: read the PR body (here, a
  // fixture standing in for `gh pr view --json body`), run it through parseAcceptanceBlock,
  // and repair it if unjudgeable — all pure logic, no `gh pr edit` call in this function.
  const fixtureBody = [
    "This retro cycle:",
    "",
    "## Acceptance criteria and how each is proved",
    "",
    "- SHIPPED log updated | see diff",
  ].join("\n");
  assert.equal(parseAcceptanceBlock(fixtureBody).length, 0, "fixture must reproduce the #394 shape");

  const repaired = ensureJudgeableBody(fixtureBody, [
    { claim: "the retro's plan-only sync PR is gate-compliant", proof: "SHIPPED-log/NET-STATE/calibration-table updates are in this diff" },
  ]);
  const parsed = parseAcceptanceBlock(repaired);
  assert.ok(parsed.length > 0, "the repaired body must be judgeable");
  // The original prose (including the worker's broken header) is preserved, never discarded.
  assert.match(repaired, /This retro cycle:/);
});
