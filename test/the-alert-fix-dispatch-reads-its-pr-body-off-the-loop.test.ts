// W1-T9698: the alert-fix dispatch read the opened PR's body with the synchronous `gh` (ghJson), twice per open:
// once in checkAlertFixAcceptance and once in readAlertFixPrBody. Both now read over an awaited reader, and one
// dispatch reads the body once for the acceptance check and the inert-proof count.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceAuthorTimeCheck } from "../src/lib/review.js";
import { alertFixBodyDeps, checkAlertFixAcceptance, dispatchAlertFixRun, readAlertFixPrBody, type AlertFixDispatchDeps } from "../src/run-task.js";
import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/96981";
const ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "9698",
  severity: "medium",
  state: "open",
  createdAt: "2026-10-15T00:00:00Z",
  summary: "W1-T9698 fixture alert",
  url: "https://github.com/craigoley/remudero/security/code-scanning/9698",
  path: "src/lib/some-file.ts",
};
const HEALTHY_BODY = "Acceptance:\n- the guard is wired | grep: readFileIfExists( in src/lib/fs-safe.ts\n\nRemudero-Task: alert-code-scanning-9698\n";
const PROSE_BODY = "Acceptance:\n- the guard is wired | the reviewer reads the diff\n\nRemudero-Task: alert-code-scanning-9698\n";

/** An awaited gh reader: the body arrives on a later tick, so a caller that does not await it reads nothing. */
function asyncReader(body: string, calls: string[][] = []): (args: string[]) => Promise<unknown> {
  return async (args) => {
    calls.push(args);
    await new Promise((resolve) => setImmediate(resolve));
    return { body };
  };
}

test("W1-T9698: the alert-fix acceptance check awaits an async body read", async () => {
  const calls: string[][] = [];
  const pending = checkAlertFixAcceptance(PR_URL, asyncReader(HEALTHY_BODY, calls));
  assert.ok(pending instanceof Promise, "the check returns a promise over the awaited read");
  const verdict = await pending;
  assert.equal(verdict.ok, true, "the verdict is over the body the async read resolved, not an empty one");
  assert.deepEqual(calls, [["pr", "view", PR_URL, "--json", "body"]]);
  assert.equal(await readAlertFixPrBody(PR_URL, asyncReader(HEALTHY_BODY)), HEALTHY_BODY);
  assert.equal(await readAlertFixPrBody(PR_URL, async () => ({})), "", "an absent body field reads as an empty body");

  // Handed the body the dispatch already read, the real check never calls its reader.
  const never = alertFixBodyDeps(() => {
    throw new Error("the reader must not be called when the body is handed over");
  });
  assert.deepEqual(await never.checkAcceptance(PR_URL, "no header, no trailer"), acceptanceAuthorTimeCheck("no header, no trailer"));
  // Handed none, it reads the body itself, awaited.
  const own: string[][] = [];
  assert.equal((await alertFixBodyDeps(asyncReader(HEALTHY_BODY, own)).checkAcceptance(PR_URL)).ok, true);
  assert.equal(own.length, 1);
});

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "s-w1t9698",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as unknown as WorkerResult;
}

async function dispatchRows(deps: AlertFixDispatchDeps): Promise<Array<Record<string, unknown>>> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t9698-"));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, ALERT, ledgerPath, "ALERT-FIX-W1T9698", deps);
    return readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeDeps(bodySeams: Pick<AlertFixDispatchDeps, "checkAcceptance" | "readPrBody">): AlertFixDispatchDeps {
  const mount: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };
  return {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => mount,
    spawn: async () => workerResult(`REPORT\nPR_URL: ${PR_URL}\n`),
    ensureTaskTrailer: () => {},
    ...bodySeams,
  };
}

test("W1-T9698: one open reads the pr body once", async () => {
  const calls: string[][] = [];
  const rows = await dispatchRows(fakeDeps(alertFixBodyDeps(asyncReader(PROSE_BODY, calls))));
  assert.ok(rows.some((r) => r.step === "alert-fix.pr_opened"), "positive control: the dispatch reached the opened PR");
  assert.deepEqual(calls, [["pr", "view", PR_URL, "--json", "body"]], "one body read serves the check and the inert-proof count");
  const inert = rows.filter((r) => r.step === "alert-fix.acceptance_defect" && r.defect === "inert-proofs");
  assert.equal(inert.length, 1, "the inert-proof count ran over the awaited body");
  assert.equal(inert[0]!.inert_count, 1);
  assert.equal(rows.filter((r) => r.step === "alert-fix.acceptance_check_error").length, 0);

  // The check judges that same body: a body with no header is refused through it, still on one read.
  const refusedCalls: string[][] = [];
  const refused = await dispatchRows(fakeDeps(alertFixBodyDeps(asyncReader("just prose, no header, no trailer", refusedCalls))));
  assert.equal(refusedCalls.length, 1);
  assert.deepEqual(
    refused.filter((r) => r.step === "alert-fix.acceptance_defect").map((r) => r.defect),
    ["no-header"],
  );

  // A failed read is a named check error for the inert-proof count; the check, handed no body, reads for itself.
  let failedReads = 0;
  const failing = await dispatchRows(
    fakeDeps(
      alertFixBodyDeps(async () => {
        failedReads++;
        throw new Error("gh: could not resolve to a PullRequest");
      }),
    ),
  );
  const errors = failing.filter((r) => r.step === "alert-fix.acceptance_check_error");
  assert.deepEqual(errors.map((r) => r.check ?? "acceptance"), ["acceptance", "inert-proofs"]);
  assert.equal(failedReads, 2);
});
