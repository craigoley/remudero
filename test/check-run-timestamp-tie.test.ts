import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { rollupFromRest } from "../src/lib/open-prs-rest.js";
import { checksStateFromRollup, dedupeRollupByLatestAttempt } from "../src/lib/sweep.js";

const NAME = "acceptance-author-gate";
const STARTED = "2026-09-28T21:25:45Z";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Run = { id: number; name: string; status: string; conclusion: string; started_at: string };
const run = (id: number, conclusion: string): Run => ({ id, name: NAME, status: "completed", conclusion, started_at: STARTED });

function runShippedGate(runs: Run[]): { status: number | null; output: string } {
  const yaml = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci-gate.yml"), "utf8")) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  const script = yaml.jobs["ci-gate"]?.steps.find((step) => step.run?.includes("runs_json"))?.run;
  assert.ok(script, "the shipped gate must expose its real aggregation step");
  const dir = mkdtempSync(join(tmpdir(), "check-run-timestamp-tie-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify([{ check_runs: runs }])}\nJSON\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fixture",
        REPO: "example/remudero",
        SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        REQUIRED: JSON.stringify([NAME]),
        IGNORE: "[]",
        ADVISORY: "[]",
        GRACE_WINDOW_SECONDS: "0",
        GRACE_POLL_INTERVAL_SECONDS: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T4729: same-second REST check runs choose the later numeric id", () => {
  // The API can return newest first. Its older failure must not win by array position.
  const successLast = rollupFromRest([run(109142982739, "success"), run(109142977824, "failure")], []);
  assert.deepEqual(successLast.map((entry) => entry.checkRunId), [109142982739, 109142977824]);
  assert.equal(dedupeRollupByLatestAttempt(successLast)[0]?.checkRunId, 109142982739);
  assert.equal(checksStateFromRollup(successLast, [NAME]), "green");
  const ascending = rollupFromRest([run(109142977824, "failure"), run(109142982739, "success")], []);
  assert.equal(dedupeRollupByLatestAttempt(ascending)[0]?.checkRunId, 109142982739);
  assert.equal(checksStateFromRollup(ascending, [NAME]), "green");

  // A newer failure must still veto merge; this is an ordering rule, not a success preference.
  const failureLast = rollupFromRest([run(109142982740, "failure"), run(109142982739, "success")], []);
  assert.equal(dedupeRollupByLatestAttempt(failureLast)[0]?.checkRunId, 109142982740);
  assert.equal(checksStateFromRollup(failureLast, [NAME]), "red");
});

test("W1-T4729: ci-gate tie chooses the later check run id", () => {
  const recovered = runShippedGate([run(109142982739, "success"), run(109142977824, "failure")]);
  assert.equal(recovered.status, 0, recovered.output);
  assert.match(recovered.output, /all required checks terminal, no failures/);
  const ascending = runShippedGate([run(109142977824, "failure"), run(109142982739, "success")]);
  assert.equal(ascending.status, 0, ascending.output);

  const regressed = runShippedGate([run(109142982740, "failure"), run(109142982739, "success")]);
  assert.notEqual(regressed.status, 0, regressed.output);
  assert.match(regressed.output, /required check\(s\) FAILED/);
});
