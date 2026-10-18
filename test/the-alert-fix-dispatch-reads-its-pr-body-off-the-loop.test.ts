// W1-T9698: the alert-fix dispatch read the opened PR's body with the synchronous `gh` (ghJson), twice per open:
// once in checkAlertFixAcceptance and once in readAlertFixPrBody. Both now read over an awaited reader, and the
// dispatch's body step (judgeOpenedAlertFixBody, which dispatchAlertFixRun awaits) reads the body once for the
// acceptance check and the inert-proof count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceAuthorTimeCheck } from "#src/lib/review.js";

/** Loaded inside each test, so at a base without the module the test itself fails rather than the file. */
const bodyModule = () => import("#src/lib/alert-fix-body.js");

const PR_URL = "https://github.com/craigoley/remudero/pull/96981";
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
  const { alertFixBodyDeps, checkAlertFixAcceptance, readAlertFixPrBody } = await bodyModule();
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

async function judgedRows(read: (args: string[]) => unknown): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const { alertFixBodyDeps, judgeOpenedAlertFixBody } = await bodyModule();
  const seams = alertFixBodyDeps(read);
  await judgeOpenedAlertFixBody(PR_URL, seams.checkAcceptance, seams.readPrBody, (step, extra = {}) => rows.push({ step, ...extra }));
  return rows;
}

test("W1-T9698: one open reads the pr body once", async () => {
  const calls: string[][] = [];
  const rows = await judgedRows(asyncReader(PROSE_BODY, calls));
  assert.deepEqual(calls, [["pr", "view", PR_URL, "--json", "body"]], "one body read serves the check and the inert-proof count");
  const inert = rows.filter((r) => r.step === "alert-fix.acceptance_defect" && r.defect === "inert-proofs");
  assert.equal(inert.length, 1, "the inert-proof count ran over the awaited body");
  assert.equal(inert[0]!.inert_count, 1);
  assert.equal(rows.filter((r) => r.step === "alert-fix.acceptance_check_error").length, 0);

  // The check judges that same body: a body with no header is refused through it, still on one read.
  const refusedCalls: string[][] = [];
  const refused = await judgedRows(asyncReader("just prose, no header, no trailer", refusedCalls));
  assert.equal(refusedCalls.length, 1);
  assert.deepEqual(refused.filter((r) => r.step === "alert-fix.acceptance_defect").map((r) => r.defect), ["no-header"]);

  // A failed read is a named check error for the inert-proof count; the check, handed no body, reads for itself.
  let failedReads = 0;
  const failing = await judgedRows(async () => {
    failedReads++;
    throw new Error("gh: could not resolve to a PullRequest");
  });
  assert.deepEqual(failing.map((r) => `${r.step}:${r.check ?? "acceptance"}`), [
    "alert-fix.acceptance_check_error:acceptance",
    "alert-fix.acceptance_check_error:inert-proofs",
  ]);
  assert.equal(failedReads, 2);

  // Without a body reader (the fakes that predate W1-T8625), only the check runs.
  const checkOnly: Array<Record<string, unknown>> = [];
  const { judgeOpenedAlertFixBody } = await bodyModule();
  await judgeOpenedAlertFixBody(PR_URL, () => acceptanceAuthorTimeCheck("no header"), undefined, (step, extra = {}) => checkOnly.push({ step, ...extra }));
  assert.deepEqual(checkOnly.map((r) => r.defect), ["no-header"]);
});
