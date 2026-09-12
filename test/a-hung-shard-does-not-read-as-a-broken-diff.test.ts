import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { makeTempDir } from "../src/lib/tmp.js";
import { ghStubPath, pathWith } from "./helpers/gh-stub.js";

// W1-T3345: a job killed at its wall-clock ceiling lands in GitHub as `cancelled`, the same
// conclusion as a benign superseded run. The collapse jobs already distinguish those causes by
// current PR head; this suite proves the unchanged-head path now names the last started test from
// the shard log instead of leaving the operator to hunt manually.

const CI_YML = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const SHA = "a".repeat(40);

interface Gate {
  jobName: string;
  run: string;
}

function gates(): Gate[] {
  const doc = parseYaml(readFileSync(CI_YML, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, unknown> }> }>;
  };
  const found: Gate[] = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.env && Object.prototype.hasOwnProperty.call(step.env, "SHARD_RESULT") && step.run) {
        found.push({ jobName, run: step.run });
      }
    }
  }
  return found;
}

function ghWithRunLog(logText: string): string {
  return ghStubPath(`#!/bin/sh
if [ "$1" = "api" ]; then
  echo ${SHA}
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  cat <<'LOG'
${logText}
LOG
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`);
}

function runGate(script: string, logText: string): { code: number; out: string } {
  const scriptPath = join(makeTempDir("w1-t3345-hang-gate-"), "gate.sh");
  writeFileSync(scriptPath, script);
  try {
    const out = execFileSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: pathWith(ghWithRunLog(logText)),
        SHARD_RESULT: "cancelled",
        RUN_HEAD_SHA: SHA,
        PR_NUMBER: "1",
        GH_REPO_SLUG: "o/r",
        GITHUB_RUN_ID: "9001",
      },
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("W1-T3345: unchanged-head cancelled shards name the last started unfinished test", () => {
  const logText = [
    "ci-shard (4/4)\tTest\t2026-09-10T17:04:38.000Z TAP version 13",
    "ci-shard (4/4)\tTest\t2026-09-10T17:04:39.000Z # Subtest: test/healthy.test.ts > finishes",
    "ci-shard (4/4)\tTest\t2026-09-10T17:04:40.000Z ok 1 - test/healthy.test.ts > finishes",
    "ci-shard (4/4)\tTest\t2026-09-10T17:04:41.000Z # Subtest: test/hung-shard.test.ts > waits forever",
  ].join("\n");

  for (const g of gates()) {
    const r = runGate(g.run, logText);
    assert.equal(r.code, 1, `${g.jobName} must still block an unchanged-head cancellation:\n${r.out}`);
    assert.match(r.out, /SHARD HANG/, `${g.jobName} must report the cancellation as a hang`);
    assert.match(
      r.out,
      /Last started unfinished test: test\/hung-shard\.test\.ts > waits forever \(ci-shard \(4\/4\)\)\./,
      `${g.jobName} must name the started-without-finished test from the shard log:\n${r.out}`,
    );
    assert.doesNotMatch(r.out, /find the test that started/, `${g.jobName} must not leave naming to manual log inspection`);
  }
});

test("W1-T3345: coverage shards emit TAP starts in the log while preserving spec stdout and lcov", () => {
  const text = readFileSync(CI_YML, "utf8");
  const coverageStart = text.indexOf("coverage-ratchet:");
  assert.notEqual(coverageStart, -1, "coverage-ratchet job must exist");
  const nextJob = text.indexOf("\n  mutation-ratchet:", coverageStart);
  assert.notEqual(nextJob, -1, "coverage-ratchet job body must be bounded");
  const body = text.slice(coverageStart, nextJob);

  assert.match(body, /--test-reporter=spec --test-reporter-destination=stdout/, "spec output remains visible");
  assert.match(body, /--test-reporter=tap --test-reporter-destination=stderr/, "TAP start lines must reach the log");
  assert.match(body, /--test-reporter=lcov --test-reporter-destination=coverage\/lcov\.info/, "lcov output remains unchanged");
});
