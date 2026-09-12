import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import {
  computeRunContext,
  mergeBaseRelativeStepNames,
  runTreeAdvisoryLine,
  type CiParityStepResult,
  type PreflightSummary,
} from "../src/lib/ci-parity.js";
import { preflightCommand } from "../src/run-task.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function ciParitySpawn(behind: { kind: "count"; value: number } | { kind: "unknown"; reason: string }): PreflightSpawn {
  return (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(test): fixture\n", stderr: "" };
    if (key.includes("rev-list")) {
      return behind.kind === "count"
        ? { status: 0, stdout: `${behind.value}\n`, stderr: "" }
        : { status: 128, stdout: "", stderr: `${behind.reason}\n` };
    }
    if (key.includes("reflog show")) {
      return { status: 0, stdout: "origin/main@{2026-09-09T12:00:00+00:00}\n", stderr: "" };
    }
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
    if (file === "git" && args[0] === "diff" && args.includes("--name-only")) {
      return { status: 0, stdout: "src/lib/ci-parity.ts\n", stderr: "" };
    }
    if (file === "git" && args[0] === "diff") {
      return { status: 0, stdout: "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts\n+changed\n", stderr: "" };
    }
    if (key.includes("mutation-ratchet.mjs --changed-files")) {
      return { status: 0, stdout: "mutation-ratchet: skip -- no relevant path touched\n", stderr: "" };
    }
    if (key.includes("containment-diff-trigger.ts")) {
      return { status: 0, stdout: "containment-probe: not required for this diff\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

async function runCiParityPreflight(
  behind: { kind: "count"; value: number } | { kind: "unknown"; reason: string },
): Promise<{ code: number; lines: string[]; summary: PreflightSummary }> {
  const out = join(mkdtempSync(join(tmpdir(), "rmd-tree-read-")), "summary.json");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (m?: unknown) => lines.push(String(m));
  let code: number;
  try {
    code = await preflightCommand(["--ci-parity", "--summary-file", out], {
      spawn: ciParitySpawn(behind),
      loadavg: () => [0.5, 0.5, 0.5],
      cpuCount: 4,
    });
  } finally {
    console.log = originalLog;
  }
  return { code, lines, summary: JSON.parse(readFileSync(out, "utf8")) as PreflightSummary };
}

test("preflight --ci-parity summary states how many commits this tree is behind origin/main", async () => {
  const { code, lines, summary } = await runCiParityPreflight({ kind: "count", value: 7 });

  assert.equal(code, 0, "this fixture stays green; the tree distance is a report, not a refusal");
  assert.equal(summary.runContext?.behindCount, 7);
  assert.ok(lines.some((line) => line.includes("context: sha=") && line.includes("behind=7")));
});

test("a non-zero behind-count names the merge-base-relative entries in this run", () => {
  const steps: CiParityStepResult[] = [
    { name: "comment-load-ratchet", ok: true, detail: "comment-load-ratchet: PASS" },
    { name: "source-size", ok: true, detail: "source-size: PASS" },
    { name: "coverage-ratchet:diff-coverage", ok: true, detail: "coverage-ratchet:diff-coverage: PASS" },
    { name: "leak-grep", ok: true, detail: "leak-grep: PASS" },
  ];
  const ctx = computeRunContext({
    headSha: "abc123",
    behindText: "3\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });

  assert.deepEqual(mergeBaseRelativeStepNames(steps), [
    "comment-load-ratchet",
    "coverage-ratchet:diff-coverage",
    "source-size",
  ]);
  const line = runTreeAdvisoryLine(ctx, steps);
  assert.match(line ?? "", /behind=3/);
  assert.match(line ?? "", /comment-load-ratchet/);
  assert.match(line ?? "", /coverage-ratchet:diff-coverage/);
  assert.match(line ?? "", /source-size/);
  assert.doesNotMatch(line ?? "", /leak-grep/, "the warning must name only the merge-base-relative entries");
});

test("an unresolvable behind-count prints UNKNOWN with its reason and never prints zero", async () => {
  const { code, lines, summary } = await runCiParityPreflight({
    kind: "unknown",
    reason: "fatal: ambiguous argument 'HEAD..origin/main'",
  });

  assert.equal(code, 0, "unknown tree distance is advisory, not blocking");
  assert.equal(summary.runContext?.behindCount, undefined);
  assert.match(summary.runContext?.behindUnknownReason ?? "", /fatal: ambiguous argument/);
  const advisory = lines.find((line) => line.includes("tree advisory"));
  assert.ok(advisory, "an unknown distance must still print the affected entries");
  assert.match(advisory, /behind=UNKNOWN \(fatal: ambiguous argument/);
  assert.doesNotMatch(advisory, /behind=0/);
});

test("a behind tree is reported and never refused, so drift does not change the exit code", async () => {
  const current = await runCiParityPreflight({ kind: "count", value: 0 });
  const behind = await runCiParityPreflight({ kind: "count", value: 5 });

  assert.equal(current.code, 0);
  assert.equal(behind.code, current.code, "a non-zero behind-count must not make the run red");
  assert.equal(current.lines.some((line) => line.includes("tree advisory")), false);
  assert.ok(behind.lines.some((line) => line.includes("tree advisory") && line.includes("behind=5")));
});
