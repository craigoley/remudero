import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { INBOX_TERMINAL_VERDICT_HEADER } from "#src/lib/inbox-cli-serve.js";
import { hashToken } from "#src/lib/last-seen.js";
import { buildPanelGraphRoutes, classifyAllProposalsMemo, peekClassifiedInbox, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { loadPlan } from "#src/lib/plan.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const writeToken = "inbox-fresh-classification-write";
const proposalId = "verify-human:W9-T1";
const observedState = "not-ready:deps=0:cited=0";
const decline = { proposalId, reason: "set aside for now" };
const declined = { status: 200, body: { ok: true, proposalId, declined: true } };

function fixture(t: TestContext, { useSnapshot = false, initiallyDeclined = false } = {}) {
  const { dir: root, git } = gitRepo({ scope: t, seedCommit: false, kind: "inbox-write-memo" });
  const stateDir = join(root, "state");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml");
  fs.writeFileSync(planPath, "[]\n");
  git("add", "plan/tasks.yaml");
  git("commit", "-qm", "commit the plan");
  let plan = loadPlan(planPath);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const startedAt = Date.now();
  let now = startedAt;
  t.mock.method(systemClock, "now", () => now);
  const recordDecline = (state?: string) => fs.appendFileSync(ledgerPath, JSON.stringify({
    step: "panel.proposal_declined", task_id: proposalId, reason: "earlier decision", ts: fixedClock(startedAt).iso(),
    observed_state: state,
  }) + "\n");
  fs.writeFileSync(ledgerPath, "");
  if (initiallyDeclined) recordDecline();
  const registry = (state = observedState) => fs.writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [
    { id: proposalId, summary: `Judge provenance observed_state=${state}.`, evidenceAnchors: [] },
    { id: "P2", summary: "another proposal", evidenceAnchors: [] },
  ] }));
  registry();

  const calls = { snapshot: 0, project: 0, ledger: 0, stat: 0 };
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === ledgerPath) calls.ledger++;
    return readFile(...args);
  });
  const reframes: Array<[string, string]> = [];
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub({ listMergedHeadBranches: () => { calls.project++; return []; } }),
    ratify: { approve: () => assert.fail("the undrafted proposal cannot be approved"), reframe: (id, feedback) => { reframes.push([id, feedback]); } },
    inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => { calls.snapshot++; return plan; },
    inboxStatFile: (path) => {
      calls.stat++;
      const stat = fs.statSync(path, { throwIfNoEntry: false });
      return stat && `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    },
    inboxClock: fixedClock(startedAt),
  };
  const routes = buildPanelGraphRoutes(deps, useSnapshot ? deps.readPlanSnapshot : undefined);
  async function request(method: "GET" | "POST", url: string, body?: object, headers?: Record<string, string>) {
    const route = routes.find(route => route.method === method && route.path === url);
    assert.ok(route);
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url, headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", ...headers },
    });
    let status = 0;
    let text = "";
    const res = { writeHead(code: number) { status = code; return this; }, end(chunk: string) { text = chunk; } };
    await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, { params: {} });
    return { status, body: JSON.parse(text) as Record<string, unknown> };
  }
  return {
    calls, deps, startedAt, registry, recordDecline, reframes,
    age: (ms: number) => { now = startedAt + ms; },
    replaceSnapshot: () => { plan = loadPlan(planPath); },
    warm: async () => {
      assert.equal((await request("GET", "/v1/inbox")).status, 200);
      assert.ok(peekClassifiedInbox(deps)?.classifications.some(row => row.proposalId === proposalId));
      Object.assign(calls, { snapshot: 0, project: 0, ledger: 0, stat: 0 });
    },
    post: (verb: string, body: object, headers?: Record<string, string>) => request("POST", `/v1/inbox/${verb}`, body, headers),
    ledgerRows: () => readFile(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

test("W1-T13239 criterion 1: decline uses a fresh Inbox read and appends the same verdict row", async t => {
  const inbox = fixture(t);
  await inbox.warm();
  inbox.age(29_999);
  assert.deepEqual(await inbox.post("decline", decline), declined);
  assert.equal(inbox.calls.snapshot, 0);
  assert.equal(inbox.calls.project, 0);
  assert.equal(inbox.calls.ledger, 0);
  const now = inbox.startedAt + 29_999;
  const [row, ...others] = inbox.ledgerRows();
  assert.ok(row);
  assert.deepEqual(others, []);
  const { host, actor_pid, actor, gardener_origin, ...verdict } = row;
  assert.deepEqual(verdict, { ts: fixedClock(now).iso(), run_id: `PANEL-${now}`, step: "panel.proposal_declined",
    task_id: proposalId, origin: hashToken(writeToken), reason: decline.reason, observed_state: observedState });
});

test("the read classification also serves restore, keep and reframe", async t => {
  for (const variant of [
    { verb: "restore", input: { reason: "resume" }, output: { restored: true }, step: "panel.proposal_restored" },
    { verb: "keep", input: {}, output: { kept: true }, step: "inbox.kept" },
    { verb: "reframe", input: { feedback: "narrow the scope" }, output: { started: true }, step: "panel.proposal_reframe_requested" },
  ]) {
    await t.test(variant.verb, async t => {
      const inbox = fixture(t, { initiallyDeclined: variant.verb === "restore", useSnapshot: true });
      await inbox.warm();
      const stamp = variant.verb === "keep" ? { keptAt: fixedClock(inbox.startedAt).iso() } : {};
      assert.deepEqual(await inbox.post(variant.verb, { proposalId, ...variant.input }),
        { status: 200, body: { ok: true, proposalId, ...variant.output, ...stamp } });
      assert.equal(inbox.calls.project, 0);
      assert.equal(inbox.calls.ledger, 0);
      const row = inbox.ledgerRows().at(-1);
      assert.equal(row?.task_id, proposalId);
      assert.equal(row?.step, variant.step);
      if (variant.verb === "reframe") assert.deepEqual(inbox.reframes, [[proposalId, "narrow the scope"]]);
    });
  }
});

test("W1-T13239 criterion 2: cold, expired, changed and missing memo entries use the single-proposal read", async t => {
  for (const variant of ["cold", "expired", "registry rewritten", "missing proposal", "ledger changed", "plan changed"]) {
    await t.test(variant, async t => {
      const inbox = fixture(t, { useSnapshot: variant === "plan changed" });
      if (variant !== "cold") await inbox.warm();
      if (variant === "expired") inbox.age(30_000);
      const revisedState = "a-different-observation:deps=1:cited=0";
      if (variant === "registry rewritten") inbox.registry(revisedState);
      if (variant === "ledger changed") inbox.recordDecline();
      if (variant === "plan changed") inbox.replaceSnapshot();
      const missing = "P999";
      const answer = await inbox.post("decline", variant === "missing proposal" ? { ...decline, proposalId: missing } : decline);
      if (variant === "missing proposal") {
        assert.deepEqual(answer, { status: 404, body: { error: "not_found", detail: `no active proposal "${missing}"` } });
      } else if (variant === "ledger changed") {
        assert.deepEqual(answer, { status: 409, body: { error: "already_declined", detail: `${proposalId} was already declined (earlier decision)` } });
        assert.equal(inbox.ledgerRows().length, 1);
      } else {
        assert.deepEqual(answer, declined);
        assert.equal(inbox.ledgerRows()[0]?.observed_state, variant === "registry rewritten" ? revisedState : observedState);
      }
      assert.ok(inbox.calls.snapshot > 0, "the write acquired its plan");
      assert.equal(inbox.calls.project, 1);
      assert.ok(inbox.calls.ledger > 0);
    });
  }
});

test("a terminal restore still uses the recorded decline when the read shows a reopened proposal", async t => {
  const inbox = fixture(t, { useSnapshot: true });
  fs.writeFileSync(inbox.deps.planPath, JSON.stringify([{
    id: "W9-T1", title: "An operator decision", repo: "remudero", depends_on: [], type: "implement",
    verify: "human", risk: "high", status: "queued", attempts: 0, files: ["src/example.ts"],
    acceptance: [{ claim: "Show the operator decision", proof: "unit test: show the operator decision" }],
  }]));
  inbox.replaceSnapshot();
  inbox.recordDecline(observedState);
  await inbox.warm();
  assert.notEqual(peekClassifiedInbox(inbox.deps)?.classifications.find(row => row.proposalId === proposalId)?.state, "declined");
  const answer = await inbox.post("restore", { proposalId, reason: "resume" }, { [INBOX_TERMINAL_VERDICT_HEADER]: "1" });
  assert.deepEqual(answer, { status: 200, body: { ok: true, proposalId, restored: true } });
  assert.equal(inbox.ledgerRows().at(-1)?.step, "panel.proposal_restored");
});

test("W1-T13239 criterion 3: approve bypasses a warm memo and reads the committed plan", async t => {
  const inbox = fixture(t);
  fs.writeFileSync(inbox.deps.planPath, "uncommitted: this is not a plan\n");
  const memo = classifyAllProposalsMemo(inbox.deps, inbox.deps.readPlanSnapshot);
  assert.ok(memo.classifications.some(row => row.proposalId === "P2"));
  Object.assign(inbox.calls, { snapshot: 0, project: 0, ledger: 0, stat: 0 });
  const answer = await inbox.post("approve", { proposalId: "P2" });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error, "not_ready");
  assert.equal(inbox.calls.snapshot, 0);
  assert.equal(inbox.calls.stat, 0);
  assert.equal(inbox.calls.project, 1);
  assert.ok(inbox.calls.ledger > 0);
});
