/**
 * The implement contract orders a SCOPE-TIME CHECK before the first edit.
 *
 * THE GAP. A dispatched worker is told "YOUR TASK'S OWN RECORD IS AT ... READ IT FIRST" and is
 * offered two REACTIVE exits (`ALREADY_SATISFIED:` and `REFUSED:` `[premise-rotted|...]`), but
 * nothing told it, up front, to re-verify the record's cited file:line references at HEAD and to
 * check whether each acceptance proof already passes on origin/main BEFORE editing. That check lived
 * only in hand-written briefs; the cost of its absence is in the repo (run-task.ts: "10 dispatches /
 * $23.34, both already shipped"; W1-T272's five manufactured no-op PRs).
 *
 * WHERE IT LIVES. The FIRST bullet of `outputContractLines`, the one body BOTH the turn-0 prompt and
 * the compaction anchor splice verbatim, so the two cannot drift. It names the SPECIFIC failure
 * (drifted line numbers, a symbol that no longer exists, an already-green proof) rather than "be
 * careful". It needs only Read and Grep, which the Claude bound AND the shell-less cash bound both
 * carry, so no variant is gated; the third test fails the day that stops being true.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { IMPLEMENT_REFUSAL_REPORT_CONTRACT, renderImplementPrompt } from "../src/run-task.js";
import { IMPLEMENT_CASH_TOOLS, IMPLEMENT_CLAUDE_TOOLS } from "../src/lib/worker.js";
import type { Task } from "../src/lib/plan.js";

const task: Task = {
  id: "W1-T9999",
  title: "scope-time check fixture",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  risk: "low",
  verify: "auto",
  status: "queued",
  attempts: 0,
  prompt: "do ${TASK_ID} on ${RUN_ID}",
  acceptance: [{ claim: "it is done", proof: "unit test: it is done" }],
};

/** The scope-time bullet: from its first line up to the next top-level bullet, whitespace-collapsed
 *  so a regex reads across the contract's line wraps. */
function scopeTimeBullet(lines: string[]): string {
  const start = lines.findIndex((l) => l.startsWith("- BEFORE EDITING"));
  assert.notEqual(start, -1, "the contract carries a `- BEFORE EDITING` scope-time bullet");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("- "));
  return [lines[start], ...rest.slice(0, end === -1 ? rest.length : end)].join(" ").replace(/\s+/g, " ");
}

test("the implement contract tells the worker to re-verify cited lines before editing", () => {
  const bullet = scopeTimeBullet(outputContractLines(task.id));
  assert.match(bullet, /Read and Grep at this HEAD/);
  assert.match(bullet, /re-verify every file:line/);
  assert.match(bullet, /cited lines drift/);
  assert.match(bullet, /a symbol that no longer exists/);
  assert.match(bullet, /whether each acceptance proof already passes on origin\/main/);
  // It names the exits that really exist, so a worker is not told to emit a class nothing parses.
  assert.match(bullet, /ALREADY_SATISFIED/);
  assert.match(bullet, /premise-rotted/);
  assert.match(outputContractLines(task.id).join("\n"), /`ALREADY_SATISFIED: <the PR number or url/);
  assert.match(IMPLEMENT_REFUSAL_REPORT_CONTRACT, /premise-rotted/);
});

test("the scope-time paragraph is the first bullet of the contract and stays short", () => {
  const lines = outputContractLines(task.id);
  assert.equal(lines[0], "# OUTPUT CONTRACT");
  assert.ok(lines[1].startsWith("- BEFORE EDITING"), "the scope-time bullet comes before every other contract bullet");
  assert.equal(lines[2].startsWith("  "), true, "the bullet wraps as indented continuation lines");
  const bullet = scopeTimeBullet(lines);
  assert.ok(bullet.length <= 650, `the scope-time bullet is ${bullet.length} chars; keep it near 600`);
  assert.ok(lines[lines.length - 1].startsWith("- End with a REPORT"), "the report line is still the contract's tail");
});

test("the scope-time paragraph rides both contract variants because both tool bounds carry Read and Grep", () => {
  for (const bound of [IMPLEMENT_CLAUDE_TOOLS, IMPLEMENT_CASH_TOOLS]) {
    assert.ok(bound.includes("Read") && bound.includes("Grep"), `${bound.join(",")} carries Read and Grep`);
  }
  for (const harnessCommits of [false, true]) {
    const lines = outputContractLines(task.id, harnessCommits);
    assert.ok(lines[1].startsWith("- BEFORE EDITING"), `harnessCommits=${harnessCommits} carries the scope-time bullet`);
    // The shell-less variant must not be told to run a shell to do it.
    const bullet = scopeTimeBullet(lines);
    assert.doesNotMatch(bullet, /\bgit\b|\bBash\b|\bnpm\b/);
  }
  assert.equal(
    scopeTimeBullet(outputContractLines(task.id, false)),
    scopeTimeBullet(outputContractLines(task.id, true)),
    "one paragraph, byte-identical in both variants",
  );
});

test("the compaction anchor still matches the turn-zero contract", () => {
  for (const harnessCommits of [false, true]) {
    const contract = outputContractLines(task.id, harnessCommits).join("\n");
    const turnZero = renderImplementPrompt(task, "", "RUN-1", "", "", "", "", harnessCommits);
    const anchor = renderAnchorBlock(task, "RUN-1", "", harnessCommits);
    assert.ok(contract.includes("- BEFORE EDITING"));
    assert.equal(turnZero.slice(turnZero.length - contract.length), contract);
    assert.equal(anchor.slice(anchor.length - contract.length), contract);
  }
});
