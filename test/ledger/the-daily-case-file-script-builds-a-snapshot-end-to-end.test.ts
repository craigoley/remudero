import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ghShim } from "#test/helpers/gh-shim.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const run = promisify(execFile);
const task = "W1-T20001";
const runId = `${task}-1795000000000`;
const sha = "d".repeat(40);

// W1-T14602: the nightly script itself, run as the host runs it — a real ledger, a real plan, `gh` answered by a shim.
test("W1-T14602: the daily case-file script writes a snapshot and its carry for every called task", async (t) => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const ledger = writeLedger([
    { ts: at(30), task_id: task, run_id: runId, step: "run.start" },
    { ts: at(29), task_id: task, run_id: runId, step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "claude", model: "claude-opus-5-5" } } },
    { ts: at(20), task_id: task, run_id: runId, step: "pr.opened", pr_url: "https://github.com/craigoley/remudero/pull/41001" },
    // A called task with no ledger PR row is searched, and a failed search keeps GitHub's reason.
    { ts: at(10), task_id: "W1-T20002", run_id: "W1-T20002-1795000000001", step: "worker.assignment",
      worker_assignment: { id: "a2", selected: { provider: "claude", model: "claude-opus-5-5" } } },
  ], { scope: t });
  const repo = ownedFixtureDir(t, "case-script-repo").dir;
  mkdirSync(join(repo, "plan"), { recursive: true });
  const record = (id: string) => [`- id: ${id}`, `  title: "Task ${id}"`, "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: auto", "  risk: high", "  status: queued", "  attempts: 0"].join("\n");
  writeFileSync(join(repo, "plan", "tasks.yaml"), `${record(task)}\n${record("W1-T20002")}\n`);
  const shim = ghShim([
    { when: "pr view 41001", stdout: JSON.stringify({ number: 41001, url: "https://github.com/craigoley/remudero/pull/41001",
      state: "MERGED", headRefOid: sha, headRefName: `run-${task}-1`, body: `Remudero-Task: ${task}`,
      mergedAt: at(5), statusCheckRollup: [] }) },
    { when: "pr list", stderr: "HTTP 500: search unavailable", exit: 1 },
  ]);
  const out = join(ledger.dir, "field-trials", "case-files-latest.json");
  const env = { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, RMD_FIELD_TRIALS_REPO_ROOT: repo,
    RMD_FIELD_TRIALS_CORE_LEDGER: ledger.dir, RMD_FIELD_TRIALS_CASE_OUT: out,
    GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "" };
  const { stdout } = await run(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "private-field-trials-case-files.mjs")],
    { cwd: REPO_ROOT, env, timeout: 120_000 });
  const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assert.equal(summary.event, "field_trials.case_files");
  assert.equal(summary.candidates, 2);
  assert.equal(summary.selected, 1);
  assert.equal(summary.searchUnreadable, 1);
  assert.equal(summary.readFailures.length, 1);
  assert.equal(summary.readFailures[0].target, "W1-T20002");
  const files = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(files.map((file: { taskId: string }) => file.taskId), [task]);
  const carry = JSON.parse(readFileSync(join(ledger.dir, "field-trials", "case-files-carry.json"), "utf8"));
  assert.equal(carry.links[task], 41001);
  assert.equal(carry.finishedPrs["41001"].raw.state, "MERGED");
  assert.equal(existsSync(`${out}.tmp`), false);
  // The second night reads the carried, finished PR with no `gh pr view`.
  const before = shim.calls().filter((call) => call.includes("pr view")).length;
  await run(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "private-field-trials-case-files.mjs")],
    { cwd: REPO_ROOT, env, timeout: 120_000 });
  assert.equal(shim.calls().filter((call) => call.includes("pr view")).length, before);
});
