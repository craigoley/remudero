/**
 * W1-T5856 — THE POST-FIX RE-VERIFICATION READS A LARGE CI LOG.
 *
 * W1-T5836 streamed the job log for the sweep's and the fix rung's CI reads; the re-verification's
 * default reader still called the buffered synchronous `fetchCiFailures`, whose 4 MiB buffer dies
 * ENOBUFS on a coverage-shard log. Every read here goes through the shared PATH-shimmed `gh`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CI_GATE_TIMEOUT_FIX_CLASS, type OpenPrView } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fetchCiFailures, sweepPostFixReverification } from "./helpers/run-task-test.js";
import { ghShim } from "./helpers/gh-shim.js";

const JOB = "8001";
const PR_URL = "https://github.com/o/r/pull/5856";
const ROLLUP = [{ name: "ci-gate", conclusion: "TIMED_OUT", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${JOB}` }];
const NEEDLE = "ci-gate: timed out waiting for required check(s) to complete: mutation-ratchet";

function bigLog(): string {
  const lines: string[] = [];
  let bytes = 0;
  for (let n = 1; bytes < 6 * 1024 * 1024; n += 1) {
    const line = `2026-10-05T08:17:00.0000000Z ok ${n} - coverage shard filler test ${n} passes`;
    lines.push(line);
    bytes += line.length + 1;
  }
  lines.push(`2026-10-05T08:19:00.0000000Z ${NEEDLE}`, "2026-10-05T08:20:00.0000000Z ##[error]Process completed with exit code 1.");
  return lines.join("\n");
}

function pendingPr(): OpenPrView {
  return {
    prNumber: 5856,
    prUrl: PR_URL,
    taskId: "W1-TX",
    reviewState: "success",
    checksState: "pending",
    ciFailures: undefined,
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
    headSha: "aaaa111",
    autoMergeArmed: false,
    headRefName: "run-W1-T5856-1",
  } as OpenPrView;
}

test("unit test: test/the-post-fix-reverification-reads-a-large-ci-log.test.ts", async () => {
  const log = bigLog();
  assert.ok(Buffer.byteLength(log) > 6 * 1024 * 1024, "the fixture is past the 4 MiB buffer");
  const shim = ghShim(
    [
      { when: `check-runs/${JOB}/annotations`, stdout: "[]" },
      { when: `actions/jobs/${JOB}/logs`, stdout: log },
      { when: `pr view ${PR_URL} --json statusCheckRollup`, stdout: JSON.stringify({ statusCheckRollup: ROLLUP }) },
    ],
    { kind: "t5856-gh" },
  );
  const ledgerDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5856-ledger-`));
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const pushes: string[] = [];
    const summary = await sweepPostFixReverification("o", "r", [pendingPr()], join(ledgerDir, "ledger.ndjson"), "SWEEP-T5856", () => {}, {
      isMergedByNumber: (n) => n === CI_GATE_TIMEOUT_FIX_CLASS.fixPrNumber,
      pushEmptyCommit: (_root, branch) => {
        pushes.push(branch);
        return "newsha";
      },
    });
    assert.equal(summary.results[0]?.outcome, "redriven", "the default reader returned the failing region of the 6 MiB log");
    assert.equal(summary.results[0]?.fixClassId, CI_GATE_TIMEOUT_FIX_CLASS.id);
    assert.deepEqual(pushes, ["run-W1-T5856-1"]);

    const [buffered] = fetchCiFailures("o", "r", ROLLUP);
    assert.equal(buffered?.logUnavailable?.kind, "fetch-failed");
    assert.match(String((buffered?.logUnavailable as { detail?: string } | undefined)?.detail), /ENOBUFS/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
