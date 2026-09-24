// test/one-lane-s-github-failure-does-not-end-the-pass.test.ts — W1-T4466.
//
// THE DEFECT: over 30 hours the daemon container ended 6 of 26 passes on an "error" a single lane
// caused. Four were a REST PR create's 422 for a branch whose PR another lane already opened
// (W1-T4384, W1-T4425, W1-T4022, W1-T4093 — each already had its PR on the same run branch, so the
// create was a pointless duplicate). Two were a failed check-runs READ (W1-T4351, W1-T4436) —
// `gh api repos/.../commits/<sha>/check-runs?per_page=100` — a lane reading CI state, not writing
// anything. Every one of the six reached the daemon's `fatalError` and ended the whole pass, which
// restarts the entrypoint and resets every in-process backoff/cadence, even though no sibling
// lane's work was lost.
//
// THE FIX, two independent surfaces:
//  (i)  `runGhPrCreate` (src/run-task.ts) now detects the "a pull request already exists for this
//       head" 422 and ADOPTS the existing open PR instead of rethrowing — ledgered
//       `pr_create.adopted_existing`, carrying the original 422 alongside the adopted PR's own
//       number/url so the double create stays visible (design ii). Any OTHER 422 still throws.
//  (iii) the daemon's lane classifier (src/lib/daemon.ts) now recognises a failed GitHub READ off
//       the known check-runs/combined-status endpoints and ends ONLY that lane — logged under
//       `daemon.gh_read_failed` — while the pass continues; a WRITE failure keeps today's fatal
//       behaviour unchanged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runGhPrCreate } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { MergedSet } from "../src/lib/drain.js";

const NONE_MERGED: MergedSet = () => false;

/** The exact shape `gh api --method POST repos/{owner}/{repo}/pulls` fails with when a PR for the
 *  head branch already exists — a real 422 `Validation Failed` naming the `PullRequest` resource. */
function alreadyExistsRejection(owner: string, repo: string, branch: string): Error {
  return Object.assign(new Error(`Command failed: gh api --method POST repos/${owner}/${repo}/pulls`), {
    stderr:
      `gh: Validation Failed (HTTP 422)\n` +
      `{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","field":"head",` +
      `"message":"A pull request already exists for ${owner}:${branch}."}],` +
      `"documentation_url":"https://docs.github.com/rest/pulls/pulls#create-a-pull-request"}\n`,
  });
}

// ── acceptance 1: a duplicate create ADOPTS the branch's existing open PR ──────────────────────

test("W1-T4466: a create for a branch whose pull request already exists adopts that pull request", () => {
  const built = {
    command: "gh" as const,
    args: [
      "api",
      "--method",
      "POST",
      "repos/craigoley/remudero/pulls",
      "-f",
      "title=feat(x): a title",
      "-f",
      "body=a body",
      "-f",
      "head=run-W1-T4384-1",
      "-f",
      "base=main",
    ],
    options: { cwd: "/tmp", encoding: "utf8" as const },
  };
  const rejection = alreadyExistsRejection("craigoley", "remudero", "run-W1-T4384-1");
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = (command: string, args: string[]): string => {
    calls.push({ command, args });
    if (calls.length === 1) throw rejection; // the duplicate create itself
    // the head lookup this task adds: the branch's own already-open PR comes back
    return JSON.stringify([{ html_url: "https://github.com/craigoley/remudero/pull/6931", number: 6931 }]);
  };
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const result = runGhPrCreate(
    built,
    "run-W1-T4384-1",
    (step, extra) => logged.push({ step, extra }),
    (msg) => said.push(msg),
    exec,
  );

  assert.equal(result.prUrl, "https://github.com/craigoley/remudero/pull/6931", "adopts the EXISTING pull request's url");
  assert.equal(result.prNumber, 6931);
  assert.equal(calls.length, 2, "the duplicate create, then exactly one head lookup — no retry loop");
  assert.equal(calls[1].command, "gh");
  assert.match(calls[1].args.join(" "), /pulls\?head=craigoley(?:%3A|:)run-W1-T4384-1&state=open/, "the lookup names this exact head, open only");

  const adopted = logged.find((l) => l.step === "pr_create.adopted_existing");
  assert.ok(adopted, "the adoption is ledgered under its own named step — design (ii), never silently absorbed");
  assert.equal(adopted?.extra?.branch, "run-W1-T4384-1");
  assert.equal(adopted?.extra?.prNumber, 6931);
  assert.match(String(adopted?.extra?.error ?? ""), /422/, "the ORIGINAL 422 rides along with the adoption, visible rather than absorbed");
  assert.match(said.join("\n"), /already has an open pull request/i);
});

test("W1-T4466 FALSIFIER: any OTHER 422 (unrelated to an existing PR) still throws, unadopted", () => {
  const built = {
    command: "gh" as const,
    args: ["api", "--method", "POST", "repos/craigoley/remudero/pulls"],
    options: { cwd: "/tmp", encoding: "utf8" as const },
  };
  const otherValidationFailure = Object.assign(new Error("Command failed: gh api --method POST repos/craigoley/remudero/pulls"), {
    stderr: 'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"field":"base","code":"invalid"}]}\n',
  });
  let lookupCalled = false;
  const exec = (): string => {
    lookupCalled = true;
    return "[]";
  };
  assert.throws(
    () => runGhPrCreate(built, "run-x", () => {}, () => {}, () => { throw otherValidationFailure; }),
    (err: unknown) => err === otherValidationFailure,
  );
  assert.equal(lookupCalled, false, "no head lookup is even attempted for a 422 that does not name an existing PR");
});

// ── acceptance 2: a failed check-runs READ ends its lane, never the whole pass ──────────────────

function twoTaskPlan() {
  return loadPlanFromYaml(
    `
- id: W1-T4351-fixture
  title: the lane whose check-runs read fails
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [a.txt]
- id: W1-T4436-fixture
  title: a sibling lane that succeeds in the same tick
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [b.txt]
`,
    "one-lane-github-failure.fixture.yaml",
  );
}

/** The exact shape observed on the fleet host: a synchronous check-runs read's `gh` child exits
 *  non-zero and this is what execFileSync throws — no rate-limit/auth/network text, just a dead
 *  read. */
function checkRunsReadFailure(sha: string): Error {
  return Object.assign(new Error(`Command failed: gh api repos/craigoley/remudero/commits/${sha}/check-runs?per_page=100`), {
    status: 1,
    stderr: "gh: Not Found (HTTP 404)",
  });
}

test("W1-T4466: a failed check-runs read ends its lane and not the daemon pass", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const s = await runDaemon(
    twoTaskPlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        calls.push(id);
        if (id === "W1-T4351-fixture") throw checkRunsReadFailure("deadbeef");
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );

  assert.notEqual(s.stopReason, "error", "the check-runs read's own failure must not end the pass");
  assert.deepEqual(calls.sort(), ["W1-T4351-fixture", "W1-T4436-fixture"], "the sibling lane still ran in the SAME tick");

  const readFailed = rows.find((r) => r.step === "daemon.gh_read_failed");
  assert.ok(readFailed, "the read failure is named on its own step, not folded into a generic error");
  assert.equal(readFailed?.extra.task, "W1-T4351-fixture");
  assert.match(String(readFailed?.extra.error ?? ""), /check-runs/);

  assert.ok(
    rows.every((r) => r.step !== "daemon.summary" || r.extra.stopReason !== "error"),
    "no summary row ever reports this tick as a daemon error",
  );
});

test("W1-T4466: a WRITE failure (not a read) still ends the pass — unchanged fatal behaviour (design iii)", async () => {
  const writeFailure = Object.assign(new Error("Command failed: gh api --method POST repos/craigoley/remudero/pulls"), {
    stderr: "gh: Bad credentials (HTTP 401)",
  });
  const s = await runDaemon(
    twoTaskPlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw writeFailure;
      },
      sleep: async () => {},
    },
    { max: 1, pollIntervalMs: 1 },
  );
  assert.equal(s.stopReason, "error", "a mutating gh call's own failure is still a genuine, unclassified crash");
});
