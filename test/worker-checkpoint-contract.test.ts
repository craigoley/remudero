import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { commitMessageContractLines, outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { renderImplementPrompt, renderReconPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

// W1-T502: a run's only copy of hours of work is dirty files in a reapable worktree until the
// terminal commit. This suite drives the REAL render functions (never a re-typed copy of their
// text) and asserts: (1) the implement contract now teaches an event-based `wip:` checkpoint
// cadence with a structured `[remudero-context]` body, (2) the commit-message guidance states the
// title-only truth ci.yml enforces rather than the stale "every commit" claim, (3) a multi-commit
// run branch is told to pass an explicit conventional PR title instead of letting `--fill` derive
// one, and (4) recon — which never touches this diff — stays asymmetric: it renders neither.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T999",
    title: "a task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "low",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

// ── acceptance 1: event-based checkpoint cadence with a structured context body ──

test("the implement output contract instructs event-based checkpoint commits", () => {
  const contract = outputContractLines("W1-T999").join("\n");
  assert.match(
    contract,
    /after each meaningful unit of work/i,
    "the contract must tie checkpoints to EVENTS (a green test, a decision, an abandoned approach), not a fixed cadence",
  );
  assert.match(contract, /`wip: <what>`/, "the contract must name the exact checkpoint subject prefix");
  assert.match(
    contract,
    /\[remudero-context\]/,
    "the contract must name the structured checkpoint body marker",
  );
  assert.match(
    contract,
    /reapable/i,
    "the contract must state WHY checkpoints matter: the worktree holding the only copy of the work is reapable",
  );
  assert.match(
    contract,
    /survive a worktree wipe/i,
    "the contract must state the mechanism: checkpoint commits land where a wipe cannot reach them",
  );
});

test("the checkpoint cadence is taught in BOTH the turn-0 implement prompt and the post-compaction anchor — never re-derived", () => {
  const t = task();
  const runId = "RUN-502";
  const original = renderImplementPrompt(t, "", runId, "");
  const anchor = renderAnchorBlock(t, runId);
  for (const [name, prompt] of [
    ["turn-0 implement prompt", original],
    ["post-compaction anchor", anchor],
  ] as const) {
    assert.match(prompt, /CHECKPOINT AS YOU GO/, `${name} must carry the checkpoint cadence instruction`);
    assert.match(prompt, /\[remudero-context\]/, `${name} must carry the structured body marker`);
  }
});

// ── acceptance 4: the structured checkpoint body marker is taught in the contract source ──

test("grep: remudero-context in src/lib/compaction.ts", () => {
  // Redundant, executable companion to the PR-body grep proof: read the real file rather than
  // re-asserting the in-memory string, so a future refactor that moves the literal out of this
  // module (and out of outputContractLines' rendered text) fails this test too.
  const src = readFileSync(fileURLToPath(new URL("../src/lib/compaction.ts", import.meta.url)), "utf8");
  assert.match(src, /remudero-context/);
});

// ── acceptance 2: the commitlint guidance states the title-only truth, not the stale claim ──

test("the commit message contract states the title-only commitlint scope", () => {
  const text = commitMessageContractLines().join("\n");
  assert.match(text, /lints ONLY the PR TITLE/, "must state the corrected, narrower scope");
  assert.doesNotMatch(
    text,
    /lints EVERY commit on the PR/,
    "must NOT carry the stale claim that made checkpoint commits look merge-blocking",
  );
  assert.match(text, /squash-merges\s+every PR/i, "must state WHY: squash-merge means branch commits never reach main");
  assert.match(text, /`wip:` checkpoint commits/, "must name checkpoint commits explicitly by their subject prefix");
  assert.match(
    text,
    /never block a merge/i,
    "must connect the corrected scope back to checkpoint commits: they never block a merge",
  );
});

test("the commit message contract's rules still apply — now to the PR title and the run's final commit", () => {
  // The type/case/length rules themselves are NOT being weakened, only re-scoped: this is the
  // regression guard that the correction didn't silently drop the substance alongside the claim.
  const text = commitMessageContractLines().join("\n");
  assert.match(text, /Conventional Commits/);
  assert.match(text, /100 CHARACTERS/);
  assert.match(text, /LOWER-CASE/);
  assert.match(text, /FINAL/, "must scope the surviving rules to the run's final commit");
});

// ── acceptance 3: an explicit conventional PR title, not one derived from a multi-commit branch ──

test("a multi-commit run branch is told to pass an explicit conventional PR title", () => {
  const contract = outputContractLines("W1-T999").join("\n");
  assert.match(contract, /multi-commit/i, "must name the multi-commit-branch scenario checkpointing creates");
  assert.match(
    contract,
    /gh pr create --fill` derives a multi-commit PR's title from the BRANCH/,
    "must state WHY --fill alone is wrong once checkpoints exist: it derives the title from the branch name",
  );
  assert.match(
    contract,
    /--title/,
    "must instruct the worker to pass an explicit --title",
  );
  assert.doesNotMatch(
    contract,
    /open a PR with `gh pr create --fill\s+--base main`/,
    "must not still instruct the bare --fill-only invocation that derives the title from the branch",
  );
});

// ── acceptance-adjacent falsifier: recon is untouched — the asymmetry the design requires ──

test("FALSIFIER: renderReconPrompt renders neither the checkpoint cadence nor the [remudero-context] marker — recon stays read-only and out of scope", () => {
  const recon = renderReconPrompt("");
  assert.doesNotMatch(recon, /CHECKPOINT AS YOU GO/);
  assert.doesNotMatch(recon, /\[remudero-context\]/);
  assert.doesNotMatch(recon, /wip: <what>/);
});
