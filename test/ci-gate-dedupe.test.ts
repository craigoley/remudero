import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T123: ci-gate dedupes check-runs BY NAME, evaluates only the LATEST attempt ──────────
//
// ci-gate aggregates commits/<sha>/check-runs and used to fail on ANY entry whose conclusion was
// a failure, with NO grouping by name. A SHA accumulates one check-run PER ATTEMPT, so once a
// job failed once on a SHA, re-running it to green could never clear the gate -- the stale
// failure stayed in the list and was unretractable (observed live on #242: `refactor-campaign`
// failed at 19:37:44, then succeeded at 19:52:17 on the same head, and ci-gate still held merge
// naming the stale failure).
//
// The fix groups the check-run list by `name` and evaluates only the attempt with the latest
// `started_at`. This suite drives the REAL bash+jq script embedded in ci-gate.yml's one step
// (extracted from the file on disk, never re-typed here) as a subprocess, with a stub `gh`
// binary on PATH standing in for the GitHub API. This proves the shipped script's actual
// behavior, not a reimplementation of it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CheckRun = {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  started_at: string;
};

async function loadAggregateScript(): Promise<string> {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  const steps = doc.jobs["ci-gate"].steps as Array<{ name: string; run: string }>;
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  assert.ok(step, "expected ci-gate.yml's ci-gate job to have a step whose run script defines runs_json()");
  return step!.run;
}

// A fake `gh` that answers `gh api .../check-runs?... --paginate --slurp` with exactly one
// "page" (an object with a `check_runs` array) -- the same shape `gh api --slurp` itself would
// have produced by wrapping the real API's single-page response in an array.
async function writeFakeGh(dir: string, checkRuns: CheckRun[]): Promise<void> {
  const page = JSON.stringify([{ check_runs: checkRuns }]);
  const body = `#!/usr/bin/env bash\ncat <<'FIXTURE_EOF'\n${page}\nFIXTURE_EOF\n`;
  await writeFile(join(dir, "gh"), body, { mode: 0o755 });
}

async function runAggregateScript(
  script: string,
  required: string[],
  ignore: string[],
  checkRuns: CheckRun[],
  timeoutMs = 20_000,
) {
  const dir = await mkdtemp(join(tmpdir(), "ci-gate-dedupe-"));
  try {
    await writeFakeGh(dir, checkRuns);
    return spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fake-token",
        REPO: "example/example",
        SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        REQUIRED: JSON.stringify(required),
        IGNORE: JSON.stringify(ignore),
        // W1-T261 added a bounded grace-window re-read before ci-gate concludes FAILURE
        // (test/ci-gate-reaggregate.test.ts exercises it directly). Zero it here so this
        // suite's dedupe-only fixtures keep their original immediate-conclusion timing.
        GRACE_WINDOW_SECONDS: "0",
        GRACE_POLL_INTERVAL_SECONDS: "1",
      },
      encoding: "utf8",
      timeout: timeoutMs,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ci-gate-dedupe: a SHA carrying a failed then a later successful run of the SAME required check name reads as SUCCESS (the #242 fixture)", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["refactor-campaign"], [], [
    { name: "refactor-campaign", status: "completed", conclusion: "failure", started_at: "2026-07-19T19:37:44Z" },
    { name: "refactor-campaign", status: "completed", conclusion: "success", started_at: "2026-07-19T19:52:17Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /ci-gate: every REQUIRED check is terminal and no check failed — merge may proceed\./);
  assert.doesNotMatch(out, /FAILED/);
});

test("ci-gate-dedupe: a SHA whose LATEST attempt for a name is a failure still FAILS the gate (dedupe did not weaken real reds)", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["refactor-campaign"], [], [
    { name: "refactor-campaign", status: "completed", conclusion: "success", started_at: "2026-07-19T19:37:44Z" },
    { name: "refactor-campaign", status: "completed", conclusion: "failure", started_at: "2026-07-19T19:52:17Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: check\(s\) FAILED — holding merge/);
  assert.match(out, /- refactor-campaign/);
});

test("ci-gate-dedupe: an IGNORE-listed name with the latest attempt failing does not block, even amid other completed required checks", async () => {
  const script = await loadAggregateScript();
  const result = await runAggregateScript(script, ["refactor-campaign"], ["ci-gate"], [
    { name: "refactor-campaign", status: "completed", conclusion: "success", started_at: "2026-07-19T19:37:44Z" },
    { name: "ci-gate", status: "completed", conclusion: "failure", started_at: "2026-07-19T19:52:17Z" },
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /merge may proceed\./);
});

test("ci-gate-dedupe: a required check absent from the deduped list is still waited on (never silently passed) — the pre-existing fail-on-absent contract is untouched", async () => {
  const script = await loadAggregateScript();
  // Only "present-check" ever registers a check-run; "missing-check" never does. The real script
  // waits up to 15 minutes (a hardcoded deadline) for a required name to appear -- this test does
  // not wait that long. Instead it gives the subprocess a short window, then asserts it is still
  // in the "waiting" loop (never reached a pass/fail verdict) and has named the correct missing
  // check, which is the fail-closed behavior the absent-check contract depends on.
  const result = await runAggregateScript(
    script,
    ["present-check", "missing-check"],
    [],
    [{ name: "present-check", status: "completed", conclusion: "success", started_at: "2026-07-19T19:37:44Z" }],
    3_000,
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(out, /waiting for required check\(s\) to complete:/);
  assert.match(out, /- missing-check/);
  assert.doesNotMatch(out, /merge may proceed\./);
  assert.doesNotMatch(out, /check\(s\) FAILED — holding merge/);
});
