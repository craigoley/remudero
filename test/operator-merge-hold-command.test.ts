import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOperatorMergeHold,
  parseOperatorMergeHoldArgs,
} from "../src/lib/operator-merge-hold.js";
import { automergeHoldFromLedger } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { mergeHoldCommand } from "../src/run-task.js";

function fixture(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-operator-merge-hold-"));
  return { dir, ledgerPath: join(dir, "ledger.ndjson") };
}

function parseError(args: string[]): string {
  const parsed = parseOperatorMergeHoldArgs(args);
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("expected merge-hold argument parsing to fail");
  return parsed.error;
}

test("parseOperatorMergeHoldArgs accepts an attributable PR-scoped engage", () => {
  assert.deepEqual(
    parseOperatorMergeHoldArgs([
      "engage",
      "--pr",
      "3511",
      "--task",
      "W1-T2564",
      "--by",
      "craig",
      "--reason",
      "manual review before squash",
    ]),
    {
      ok: true,
      input: {
        action: "engage",
        prNumber: 3511,
        taskId: "W1-T2564",
        by: "craig",
        reason: "manual review before squash",
      },
    },
  );
});

test("parseOperatorMergeHoldArgs accepts a fleet release and refuses unattributed or ambiguous input", () => {
  assert.deepEqual(parseOperatorMergeHoldArgs(["release", "--by", "craig", "--reason", "incident cleared"]), {
    ok: true,
    input: { action: "release", by: "craig", reason: "incident cleared" },
  });
  assert.match(parseError(["engage", "--reason", "missing author"]), /--by/);
  assert.match(parseError(["release", "--by", "craig"]), /--reason/);
  assert.match(
    parseError(["engage", "--pr", "0", "--by", "craig", "--reason", "bad scope"]),
    /positive integer/,
  );
  assert.match(
    parseError(["engage", "--pr", "3", "--task", "not-a-task", "--by", "craig", "--reason", "bad task"]),
    /W1-T<n>/,
  );
  assert.match(
    parseError(["engage", "--by", "craig", "--reason", "x", "--surprise"]),
    /unexpected argument/,
  );
});

test("applyOperatorMergeHold writes a PR hold that the production reader immediately observes", () => {
  const { dir, ledgerPath } = fixture();
  try {
    const result = applyOperatorMergeHold(
      ledgerPath,
      {
        action: "engage",
        prNumber: 3511,
        taskId: "W1-T2564",
        by: "craig",
        reason: "manual review before squash",
      },
      { now: () => 1234 },
    );

    assert.equal(result.written, true);
    const lines = readLedgerLines(ledgerPath);
    assert.deepEqual(automergeHoldFromLedger(lines, 3511), {
      by: "craig",
      reason: "manual review before squash",
    });
    assert.equal(lines[0]?.step, "automerge.hold_engaged");
    assert.equal(lines[0]?.run_id, "OPERATOR-MERGE-HOLD-1234");
    assert.equal(lines[0]?.task_id, "W1-T2564");
    assert.equal(lines[0]?.pr_number, 3511);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fleet hold applies to every PR, then an explicit PR release carves out only that PR", () => {
  const { dir, ledgerPath } = fixture();
  try {
    applyOperatorMergeHold(
      ledgerPath,
      { action: "engage", by: "craig", reason: "freeze unattended merges" },
      { now: () => 1 },
    );
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledgerPath), 1), {
      by: "craig",
      reason: "freeze unattended merges",
    });
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledgerPath), 2), {
      by: "craig",
      reason: "freeze unattended merges",
    });

    applyOperatorMergeHold(
      ledgerPath,
      { action: "release", prNumber: 1, by: "craig", reason: "PR 1 manually cleared" },
      { now: () => 2 },
    );
    const lines = readLedgerLines(ledgerPath);
    assert.equal(automergeHoldFromLedger(lines, 1), undefined);
    assert.deepEqual(automergeHoldFromLedger(lines, 2), {
      by: "craig",
      reason: "freeze unattended merges",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releasing an already-clear scope is idempotent and appends no misleading release row", () => {
  const { dir, ledgerPath } = fixture();
  try {
    const result = applyOperatorMergeHold(
      ledgerPath,
      { action: "release", prNumber: 3511, by: "craig", reason: "already done" },
      { now: () => 9 },
    );
    assert.equal(result.written, false);
    assert.deepEqual(readLedgerLines(ledgerPath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeHoldCommand routes parsed CLI input to the durable writer and reports read-back", () => {
  const { dir, ledgerPath } = fixture();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    const exit = mergeHoldCommand(
      ["engage", "--pr", "3511", "--by", "craig", "--reason", "manual squash override"],
      { ledgerPath, now: () => 44 },
    );
    assert.equal(exit, 0);
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledgerPath), 3511), {
      by: "craig",
      reason: "manual squash override",
    });
    assert.match(output.join("\n"), /ENGAGED for PR #3511/);
    assert.match(output.join("\n"), /read back through the production hold reader/);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
