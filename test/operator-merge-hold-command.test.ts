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

// ── W1-T1000002 COVERAGE: the three refusal arms the first cut never reached ──────────────────
// `diff-coverage` BLOCKED this PR on operator-merge-hold.ts:31, :57 and :119-120 — the invalid
// action arm, the --task-without--pr arm, and the read-back verification throw. Each is reached
// here for real, through the module's own seams.

test("parseOperatorMergeHoldArgs refuses an action that is neither engage nor release", () => {
  assert.match(parseError(["bogus", "--by", "craig", "--reason", "x"]), /must be `engage` or `release`/);
  // The arm fires on the FIRST argument specifically, not on any stray token: an empty argv and a
  // flag-shaped first argument take the same refusal, so a caller who omits the verb is named
  // rather than silently parsed as a fleet engage.
  assert.match(parseError([]), /must be `engage` or `release`/);
  assert.match(parseError(["--pr", "7", "--by", "craig", "--reason", "x"]), /must be `engage` or `release`/);
  // CONTROL: the two legal verbs are NOT refused by this arm, so the assertions above are the
  // action check talking and not a fixture that fails for some unrelated reason.
  assert.equal(parseOperatorMergeHoldArgs(["engage", "--by", "c", "--reason", "r"]).ok, true);
  assert.equal(parseOperatorMergeHoldArgs(["release", "--by", "c", "--reason", "r"]).ok, true);
});

test("parseOperatorMergeHoldArgs refuses --task on a fleet-wide hold, which has no PR to scope it to", () => {
  assert.match(
    parseError(["engage", "--task", "W1-T2564", "--by", "craig", "--reason", "no pr scope"]),
    /--task is valid only with a PR-scoped hold/,
  );
  // CONTROL: the SAME argv with --pr added parses, so this refusal is about the missing scope and
  // not about --task itself being rejected outright.
  assert.equal(
    parseOperatorMergeHoldArgs([
      "engage", "--pr", "3511", "--task", "W1-T2564", "--by", "craig", "--reason", "no pr scope",
    ]).ok,
    true,
  );
});

test("applyOperatorMergeHold THROWS when the appended decision does not read back as current", () => {
  const { dir, ledgerPath } = fixture();
  try {
    // A reader that never observes the append — the shape of a write that silently did not land.
    // The verification exists so that failure is LOUD rather than reported as a successful hold.
    const appended: unknown[] = [];
    assert.throws(
      () =>
        applyOperatorMergeHold(
          ledgerPath,
          { action: "engage", prNumber: 3511, by: "craig", reason: "write is dropped" },
          {
            readLedger: () => [],
            appendLedger: (_path, line) => void appended.push(line),
            now: () => 1,
          },
        ),
      /merge-hold write did not become the current decision for PR #3511/,
    );
    assert.equal(appended.length, 1, "the append was attempted — the throw is about the READ-BACK, not a refusal to write");

    // CONTROL, and the anti-vacuity half: the SAME call with a reader that really reflects the
    // append does NOT throw. Without this the assertion above would pass against a function that
    // threw unconditionally.
    const rows: Array<Record<string, unknown>> = [];
    const result = applyOperatorMergeHold(
      ledgerPath,
      { action: "engage", prNumber: 3511, by: "craig", reason: "write lands" },
      {
        readLedger: () => rows,
        appendLedger: (_path, line) => void rows.push(line as Record<string, unknown>),
        now: () => 1,
      },
    );
    assert.equal(result.written, true);
    assert.deepEqual(result.current, { by: "craig", reason: "write lands" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeHoldCommand reports a parse refusal on stderr with exit 2, and writes no ledger row", () => {
  const { dir, ledgerPath } = fixture();
  const errs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errs.push(args.join(" "));
  try {
    const exit = mergeHoldCommand(["engage", "--pr", "3511", "--reason", "no author"], { ledgerPath, now: () => 44 });
    assert.equal(exit, 2, "a refusal exits 2 — distinct from 0 (applied) and from 1");
    assert.match(errs.join("\n"), /rmd merge-hold: /);
    assert.match(errs.join("\n"), /--by/, "the refusal names the missing flag, not a bare usage dump");
    assert.equal(
      automergeHoldFromLedger(readLedgerLines(ledgerPath), 3511),
      undefined,
      "and NOTHING was written — a refused command must not leave a durable decision behind",
    );
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeHoldCommand releasing an already-clear scope exits 0 and says so, rather than writing a misleading row", () => {
  const { dir, ledgerPath } = fixture();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => void output.push(args.join(" "));
  try {
    const exit = mergeHoldCommand(["release", "--pr", "3511", "--by", "craig", "--reason", "nothing held"], {
      ledgerPath,
      now: () => 44,
    });
    assert.equal(exit, 0, "an idempotent no-op is success, not a refusal");
    assert.match(output.join("\n"), /already released; no ledger row written/);
    assert.equal(readLedgerLines(ledgerPath).length, 0, "the ledger is untouched — that is the whole point of the arm");

    // CONTROL: the same release AFTER a real engage does write, so the assertions above are the
    // already-clear arm talking and not a release that never works at all.
    assert.equal(mergeHoldCommand(["engage", "--pr", "3511", "--by", "craig", "--reason", "hold"], { ledgerPath, now: () => 45 }), 0);
    assert.equal(mergeHoldCommand(["release", "--pr", "3511", "--by", "craig", "--reason", "cleared"], { ledgerPath, now: () => 46 }), 0);
    assert.equal(readLedgerLines(ledgerPath).length, 2, "engage + release both landed");
    assert.equal(automergeHoldFromLedger(readLedgerLines(ledgerPath), 3511), undefined, "and the scope reads clear again");
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
