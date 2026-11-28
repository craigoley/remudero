/**
 * W1-T14906: a field-trials case-file pass renews its installation token, re-mints once after a 401, and stops on a
 * 401 after that re-mint instead of failing every read for hours. Rate-limit refusals keep the doubling wait.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildFieldTrialsCaseFiles, CaseFileTokenRefused, type CaseFilePacing, type ListPrsPage,
  type ViewPr } from "#src/lib/field-trials-case-files.js";
import type { FlowRow } from "#src/lib/field-trials-flow.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const now = "2026-11-28T17:00:00.000Z";
const task = "W1-T30001";
const row = (step: string, extra: Partial<FlowRow> = {}) => ({ fingerprint: step, ts: "2026-11-28T16:00:00.000Z", step,
  host: null, actor: null, taskId: task, runId: `run-${task}`, assignmentId: null, requestedModel: null, selectedModel: null,
  servedModel: null, prRepo: null, prNumber: null, ...extra }) as FlowRow;
const source = { rows: [row("worker.assignment"), row("pr.opened", { prRepo: "craigoley/remudero", prNumber: 41001 })],
  planIds: new Set([task]), carry: undefined };
const emptyListing: ListPrsPage = async () => [];
const unauthorized = () => Object.assign(new Error("gh: Bad credentials (HTTP 401)"), { stderr: "HTTP 401: Bad credentials" });
const merged = { number: 41001, state: "MERGED", body: `Remudero-Task: ${task}` };

function pass(viewPr: ViewPr, remint?: () => Promise<unknown>) {
  const sleeps: number[] = [];
  const built: number[] = [];
  const pacing: CaseFilePacing = { nowIso: () => now, sleep: async (ms) => { sleeps.push(ms); }, remint };
  const run = buildFieldTrialsCaseFiles(source, emptyListing, viewPr, pacing, async (plan) => {
    built.push(plan.selected.length);
    return [] as TaskCaseFile[];
  }, 1_000);
  return { run, sleeps, built };
}

test("W1-T14906 criterion 2 a repeated 401 after a re-mint stops the pass", async () => {
  // A 401 re-mints once and retries the same read; a read answered after the re-mint builds as before.
  let reads = 0;
  let remints = 0;
  const recovered = pass(async () => { reads += 1; if (reads === 1) throw unauthorized(); return merged; },
    async () => { remints += 1; });
  const result = await recovered.run;
  assert.equal(remints, 1, "one re-mint");
  assert.equal(reads, 2, "the refused read is retried once");
  assert.equal(result.summary.prReadsFailed, 0);
  assert.deepEqual(recovered.built, [1]);

  // Still refused after the re-mint: the pass stops with a reason that names the 401, and builds nothing.
  reads = 0;
  remints = 0;
  const refused = pass(async () => { reads += 1; throw unauthorized(); }, async () => { remints += 1; });
  await assert.rejects(refused.run, (error: unknown) => error instanceof CaseFileTokenRefused
    && /HTTP 401/.test(error.message) && /after the token re-mint/.test(error.message));
  assert.equal(remints, 1, "never a second re-mint");
  assert.equal(reads, 2, "no read after the second 401");
  assert.deepEqual(refused.built, [], "no case files are built from a refused pass");
  assert.deepEqual(refused.sleeps, [], "a 401 is not paced like a rate limit");
});

test("W1-T14906 criterion 3 a rate-limit refusal still retries", async () => {
  // invariant:rate-limit-retry-unchanged — the doubling wait, retried until answered, with no re-mint.
  let reads = 0;
  let remints = 0;
  const limited = pass(async () => {
    reads += 1;
    if (reads <= 3) throw Object.assign(new Error("gh: API rate limit exceeded"), { stderr: "HTTP 403: API rate limit exceeded" });
    return merged;
  }, async () => { remints += 1; });
  const result = await limited.run;
  assert.deepEqual(limited.sleeps, [1_000, 2_000, 4_000]);
  assert.equal(result.summary.rateLimitWaits, 3);
  assert.equal(result.summary.prReadsFailed, 0);
  assert.equal(remints, 0);
  assert.deepEqual(limited.built, [1]);
});

test("W1-T14906: the nightly script stops on a 401 it cannot re-mint and keeps the last good snapshot", async (t) => {
  // The production entry path with no GitHub App configured: there is no token to renew, so the first 401 ends the
  // pass, the script exits non-zero (the wrapper's flock is released) and the previous snapshot is left in place.
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const ledger = writeLedger([
    { ts: at, task_id: task, run_id: `${task}-1795000000000`, step: "worker.assignment",
      worker_assignment: { id: "a1", selected: { provider: "claude", model: "claude-opus-5-5" } } },
    { ts: at, task_id: task, run_id: `${task}-1795000000000`, step: "pr.opened",
      pr_url: "https://github.com/craigoley/remudero/pull/41001" },
  ], { scope: t });
  const repo = ownedFixtureDir(t, "case-script-401-repo").dir;
  mkdirSync(join(repo, "plan"), { recursive: true });
  writeFileSync(join(repo, "plan", "tasks.yaml"), [`- id: ${task}`, `  title: "Task ${task}"`, "  repo: remudero",
    "  depends_on: []", "  type: implement", "  verify: auto", "  risk: high", "  status: queued", "  attempts: 0", ""].join("\n"));
  const shim = ghShim([
    { when: "pulls?state=all", stdout: "[]" },
    { when: "pr view 41001", stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)", exit: 1 },
  ]);
  const out = join(ledger.dir, "field-trials", "case-files-latest.json");
  mkdirSync(join(ledger.dir, "field-trials"), { recursive: true });
  writeFileSync(out, "[\"last good\"]");
  const env = { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, RMD_FIELD_TRIALS_REPO_ROOT: repo,
    RMD_FIELD_TRIALS_CORE_LEDGER: ledger.dir, RMD_FIELD_TRIALS_CASE_OUT: out,
    GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "" };
  const script = join(REPO_ROOT, "scripts", "private-field-trials-case-files.mjs");
  const failure = await promisify(execFile)(process.execPath, ["--import", "tsx", script], { cwd: REPO_ROOT, env, timeout: 120_000 })
    .then(() => undefined, (error: { code?: number; stderr?: string }) => error);
  assert.ok(failure, "the script exits non-zero");
  assert.equal(failure.code, 1);
  assert.match(String(failure.stderr), /stopped: GitHub refused PR #41001 with HTTP 401/);
  assert.equal(readFileSync(out, "utf8"), "[\"last good\"]", "the last good snapshot is not overwritten");
  assert.equal(shim.calls().filter((call) => call.includes("pr view 41001")).length, 1, "the refused read is not repeated");
});
