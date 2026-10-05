import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { depReviewCommand, type DepReviewDeps } from "../src/run-task.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { decideDepReview, reconcileDepReviewHold } from "../src/lib/dep-review.js";
import { escalationClasses, escalationDecisions } from "../src/lib/now-decisions.js";
import type { BoardRow } from "../src/lib/board.js";

const ageMs = 24 * 60 * 60 * 1000;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  let head = "a".repeat(40);
  let red = true;
  let createFails = false;
  let closeFails = false;
  let listFails = false;
  let sourceDiff = false;
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const opened: Array<{ url: string; title: string; body: string; labels: string[] }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const statuses: string[] = [];
  const arms: string[] = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      if (createFails) throw new Error("create unavailable");
      const url = `https://github.com/craigoley/remudero/issues/${9000 + opened.length}`;
      opened.push({ url, title, body, labels });
      return url;
    },
    listOpen() {
      if (listFails) throw new Error("list unavailable");
      return opened.filter((i) => !closed.some((c) => c.url === i.url))
        .map((i, index) => ({ ...i, number: 9000 + index }));
    },
    closeWithComment(url, comment) {
      if (closeFails) throw new Error("close unavailable");
      closed.push({ url, comment });
    },
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    now: () => now,
    gh: () => ({
      number: 5022, url: "https://github.com/craigoley/remudero/pull/5022",
      title: "build(deps): bump example from 1.0.0 to 1.0.1", body: "",
      headRefOid: head, author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "ci-gate", conclusion: red ? "FAILURE" : "SUCCESS" }],
    }),
    prDiff: () => sourceDiff
      ? "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n"
      : "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async (args) => {
      statuses.push(args.state);
      return { posted: true };
    }) as DepReviewDeps["postStatus"],
    arm: () => { arms.push(head); return "armed"; },
    issues,
  };
  return {
    run: () => depReviewCommand("5022", ["--repo", "remudero"], { ...deps }),
    advance: (ms: number) => { now += ms; },
    changeHead: () => { head = "b".repeat(40); },
    recover: () => { red = false; },
    failChecks: () => { red = true; },
    failCreate: (value: boolean) => { createFails = value; },
    failClose: (value: boolean) => { closeFails = value; },
    failList: (value: boolean) => { listFails = value; },
    removeClose: () => { delete issues.closeWithComment; },
    changeDiff: () => { sourceDiff = true; },
    forgetLedger: () => rmSync(ledgerPath, { force: true }),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    opened, closed, statuses, arms,
  };
}

test("W1-T5022: aged dependency hold escalates once per head", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 1);
  f.advance(ageMs - 1);
  assert.equal(await f.run(), 1);
  assert.equal(f.opened.length, 0);
  f.advance(1);
  assert.equal(await f.run(), 1);
  assert.equal(f.opened.length, 1);
  assert.match(f.opened[0].body, /ci-gate/);
  assert.match(f.opened[0].body, /repository operator/i);
  assert.match(f.opened[0].body, /rerun/i);
  assert.match(f.opened[0].body, /repair/i);
  assert.match(f.opened[0].body, /\*\*Head:\*\* a{40}/);
  assert.ok(f.opened[0].labels.includes("needs-human"));
  const decisions = escalationDecisions("core", [{
    taskId: "PR-5022", title: "dependency review", needsHuman: true,
    escalationTitle: f.opened[0].title, escalationIssueUrl: f.opened[0].url,
  } as BoardRow], escalationClasses(f.ledger()));
  assert.equal(decisions.length, 1, "the existing human-gate decision source sees the ask");
  assert.equal(decisions[0].kind, "escalation", "a CI repair ask must not become manual approval");
  assert.equal(decisions[0].answer.path, "/v1/escalation/mark-handled");
  f.forgetLedger();
  await f.run();
  f.advance(ageMs);
  await f.run();
  assert.equal(f.opened.length, 1);
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.arms, []);
});

test("W1-T5022: recovered dependency hold retires its escalation", async (t) => {
  for (const recovery of ["checks", "head"] as const) {
    const f = fixture(t);
    await f.run();
    f.advance(ageMs);
    await f.run();
    assert.equal(f.opened.length, 1);
    if (recovery === "checks") f.recover();
    else f.changeHead();
    assert.equal(await f.run(), recovery === "checks" ? 0 : 1);
    assert.equal(f.closed.length, 1);
    assert.equal(f.closed[0].url, f.opened[0].url);
    assert.match(f.closed[0].comment, recovery === "checks" ? /recover/i : /head.*chang/i);
    await f.run();
    assert.equal(f.closed.length, 1);
    if (recovery === "checks") {
      assert.deepEqual(f.statuses, ["success", "success"]);
      assert.equal(f.arms.length, 2);
      f.failChecks();
      await f.run();
      f.advance(ageMs);
      await f.run();
      assert.equal(f.opened.length, 1, "a recovered head must never open a second ask");
    } else {
      assert.equal(f.opened.length, 1, "a new head starts a fresh age window");
      f.advance(ageMs);
      await f.run();
      assert.equal(f.opened.length, 2);
      assert.match(f.opened[1].body, /\*\*Head:\*\* b{40}/);
    }
  }
});

test("dependency hold retries failed delivery and retirement without approving red checks", async (t) => {
  const f = fixture(t);
  await f.run();
  f.advance(ageMs);
  f.failList(true);
  assert.equal(await f.run(), 1);
  assert.equal(f.opened.length, 0);
  assert.match(f.ledger().at(-1).error, /not delivered/);
  f.failList(false);
  f.failCreate(true);
  assert.equal(await f.run(), 1);
  assert.equal(f.opened.length, 0);
  assert.match(f.ledger().at(-1).error, /create unavailable/);
  f.failCreate(false);
  await f.run();
  assert.equal(f.opened.length, 1);
  f.recover();
  f.failClose(true);
  assert.equal(await f.run(), 1);
  assert.equal(f.closed.length, 0);
  assert.match(f.ledger().at(-1).error, /close unavailable/);
  const incomplete = f.ledger().filter((row) => row.step === "dep-review.decided").at(-1);
  assert.equal(incomplete.decision, "hold", "the sweep must retry incomplete retirement");
  assert.equal(incomplete.review_decision, "arm", "preserve the recovered review verdict");
  assert.match(incomplete.reason, /close unavailable/);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.arms, []);
  f.failClose(false);
  assert.equal(await f.run(), 0);
  assert.equal(f.closed.length, 1);
});

test("short lived dependency hold recovery resets the age on the same head", async (t) => {
  const f = fixture(t);
  await f.run();
  f.advance(ageMs - 1);
  f.recover();
  assert.equal(await f.run(), 0);
  f.failChecks();
  await f.run();
  f.advance(1);
  await f.run();
  assert.equal(f.opened.length, 0);
  f.advance(ageMs - 1);
  await f.run();
  assert.equal(f.opened.length, 1);
});

test("dependency hold refuses a missing close transport and retires a no-longer-eligible proposal", async (t) => {
  const missing = fixture(t);
  await missing.run();
  missing.advance(ageMs);
  await missing.run();
  missing.recover();
  missing.removeClose();
  assert.equal(await missing.run(), 1);
  assert.match(missing.ledger().at(-1).error, /cannot retire/);
  assert.deepEqual(missing.statuses, []);

  const refused = fixture(t);
  await refused.run();
  refused.advance(ageMs);
  await refused.run();
  refused.changeDiff();
  assert.equal(await refused.run(), 2);
  assert.equal(refused.closed.length, 1);
  assert.match(refused.closed[0].comment, /no longer holds this head \(refuse\)/);
  assert.deepEqual(refused.statuses, []);
  assert.deepEqual(refused.arms, []);
});

test("dependency hold corrupt state cannot erase the delivered-head history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-held-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "hold.json");
  const result = decideDepReview({
    author: { login: "app/dependabot" },
    title: "bump example from 1.0.0 to 1.0.1", body: "", diff: "",
    checks: [{ name: "ci-gate", conclusion: "FAILURE" }],
  });
  const reconcile = () => reconcileDepReviewHold({
    statePath, prUrl: "https://github.com/craigoley/remudero/pull/5022", prNumber: 5022,
    title: "example", body: "", headSha: "a".repeat(40), result, nowMs: Date.now(),
    escalationDeps: () => { throw new Error("must not deliver with corrupt state"); },
    log: () => assert.fail("must not record a successful reconciliation"),
  });
  for (const state of [
    null,
    "invalid",
    { headSha: 1, heldSinceMs: null, asks: [] },
    { headSha: "a", heldSinceMs: "yesterday", asks: [] },
    { headSha: "a", heldSinceMs: null, asks: {} },
    { headSha: "a", heldSinceMs: null, asks: [null] },
    { headSha: "a", heldSinceMs: null, asks: [{ headSha: 1, issueUrl: "url", retired: false }] },
    { headSha: "a", heldSinceMs: null, asks: [{ headSha: "a", issueUrl: 1, retired: false }] },
    { headSha: "a", heldSinceMs: null, asks: [{ headSha: "a", issueUrl: "url", retired: "yes" }] },
  ]) {
    writeFileSync(statePath, JSON.stringify(state));
    assert.throws(reconcile, /invalid dependency hold state/);
  }
  writeFileSync(statePath, "{");
  assert.throws(reconcile, SyntaxError);
});
