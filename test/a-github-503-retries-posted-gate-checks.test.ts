import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

test("a transient GitHub 503 does not leave posted gate checks incomplete", () => {
  const workflow = parseYaml(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: { commitlint: { steps: Array<{ env?: Record<string, string>; run?: string }> } };
  };
  const reporter = workflow.jobs.commitlint.steps.find((step) => step.run?.includes("report()"));
  assert.ok(reporter?.run && reporter.env);
  const root = mkdtempSync(join(tmpdir(), "rmd-gate-report-retry-"));
  try {
    const stub = `gh() {
printf '%s\\n' "$*" >> "$GH_LOG_FILE"
case "$*" in
  *name=jscpd-gate*)
    if [ "$GH_FAIL_KIND" = permanent ]; then
      echo 'gh: denied (HTTP 403)' >&2
      exit 1
    fi
    if [ ! -e "$GH_RETRIED" ]; then
      : > "$GH_RETRIED"
      echo 'gh: unavailable (HTTP 503)' >&2
      exit 1
    fi
    ;;
esac
}
sleep() { :; }
`;
    const env = {
      ...process.env,
      ...Object.fromEntries(Object.keys(reporter.env).filter((key) => key.startsWith("OUTCOME_")).map((key) => [key, "success"])),
      GITHUB_REPOSITORY: "owner/repo",
      HEAD_SHA: "abc123",
      POSTING_JOB_ID: "12345",
      GH_LOG_FILE: join(root, "calls"),
      GH_RETRIED: join(root, "retried"),
      GH_FAIL_KIND: "transient",
    };
    const transient = spawnSync("bash", ["-c", stub + reporter.run], { env, encoding: "utf8" });
    assert.equal(transient.status, 0, transient.stderr);
    assert.match(transient.stdout, /reported baseline-monotonic = success/);
    const calls = readFileSync(env.GH_LOG_FILE, "utf8").trim().split("\n");
    assert.equal(calls.filter((line) => line.includes("name=jscpd-gate")).length, 2);
    assert.ok(calls.some((line) => line.includes("name=baseline-monotonic")));
    assert.ok(calls.every((line) => line.includes("external_id=job:12345")));

    writeFileSync(env.GH_LOG_FILE, "");
    const permanent = spawnSync("bash", ["-c", stub + reporter.run], {
      env: { ...env, GH_FAIL_KIND: "permanent" }, encoding: "utf8",
    });
    assert.equal(permanent.status, 1);
    assert.match(permanent.stderr, /check-run post failed for jscpd-gate after 1 attempt.*HTTP 403/);
    assert.doesNotMatch(permanent.stdout, /reported baseline-monotonic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
