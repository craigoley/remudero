/**
 * W1-T5525 — EVERY CONSOLE FEEDBACK WRITE LANDS THROUGH THE DAEMON QUEUE.
 *
 * #8891 and #8928 let POST /v1/feedback, POST /v1/skills/run and POST /v1/escalation/reply land on the request
 * path through `requestPathLand`, which skipped the W1-T5348 filer preflight. W1-T5460 (#8929) built the queue
 * for POST /v1/feedback/decision. These routes now stage their records there too and answer `landing: "queued"`;
 * the daemon's `sweepFeedbackLanding` lands them with the preflight, and nothing lands without it.
 *
 * Route fixtures are plain directories with fake `git`/`gh` seams that record every call: a request path that
 * still landed would reach them. The one real landing below uses test/helpers/git-repo.ts and a fake `gh`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as feedback from "../src/lib/feedback.js";
import * as landing from "../src/lib/feedback-landing.js";
import { appendThreadMessage } from "../src/lib/inbox-thread.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as panelActions from "../src/lib/panel-actions.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import * as skillRun from "../src/lib/panel-skill-run.js";
import { createService, type Route } from "../src/lib/service.js";
import { skillsDir } from "../src/lib/skill.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const QUEUE_DIR = join("state", "feedback-landing-pending");

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5525-${label}-`));
}

/** Landing seams that record every call and refuse it: the request path must reach none of them. */
function recordingLand() {
  const calls: string[] = [];
  const refuse = (kind: string) => (args: string[]): string => {
    calls.push(`${kind} ${args.join(" ")}`);
    throw new Error(`the request path reached ${kind}`);
  };
  const feedbackLand = {
    git: refuse("git"),
    gh: refuse("gh"),
    planPrPreflight: () => (calls.push("preflight"), { ok: true, failures: [], unreadable: [] }),
  };
  return { calls, feedbackLand };
}

/** A checkout-shaped root (not a git repo), a separate state root, and the console's panel deps. */
function panelFixture(label: string, stateRoot = tmpDir(`${label}-state`)) {
  const root = tmpDir(`${label}-root`);
  const ledgerPath = join(tmpDir(`${label}-ledger`), "ledger.ndjson");
  const { calls, feedbackLand } = recordingLand();
  const deps = {
    root,
    inboxRoot: stateRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    feedbackLand,
  };
  return { root, stateRoot, ledgerPath, calls, deps };
}

async function post(routes: Route[], path: string, body: unknown): Promise<Record<string, unknown>> {
  const server = createService({ tokens: { read: "r-token", write: "w-token" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer w-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

const rel = (id: string) => `plan/feedback/${id}.yaml`;
const queuedBytes = (stateRoot: string, id: string) => readFileSync(join(stateRoot, QUEUE_DIR, rel(id)), "utf8");
// ledger-read-intent: live
const ledgerRow = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).find((r) => r.step === step);

test("POST /v1/feedback stages its capture for the daemon sweep and answers landing: queued, with no git, gh or preflight", async () => {
  const fx = panelFixture("submit");
  const body = await post([panelGraph.buildSubmitFeedbackRoute(fx.deps)], "/v1/feedback", { text: "the board is slow" });
  const entry = body.entry as feedback.FeedbackEntry;
  assert.equal(body.landing, "queued");
  assert.deepEqual(fx.calls, [], "the request path never lands, so it never reaches git, gh or the preflight");
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [rel(entry.id)]);
  assert.equal(queuedBytes(fx.stateRoot, entry.id), readFileSync(join(fx.root, rel(entry.id)), "utf8"), "the capture's own bytes are staged");
  assert.equal(ledgerRow(fx.ledgerPath, "panel.feedback_submitted")?.landing, "queued");
});

test("POST /v1/feedback with replyTo stages both the answer and the target's answered flip, leaving the checkout copy untouched", async () => {
  const fx = panelFixture("reply");
  const target = feedback.captureFeedback(fx.root, { raw: "which board?", origin: "ui", land: { stateRoot: tmpDir("reply-unused") } });
  feedback.setFeedbackStatus(fx.root, target.id, "grilling");
  const body = await post([panelGraph.buildSubmitFeedbackRoute(fx.deps)], "/v1/feedback", { text: "the plan board", replyTo: target.id });
  const answer = body.entry as feedback.FeedbackEntry;
  assert.equal(body.landing, "queued");
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [rel(answer.id), rel(target.id)].sort());
  assert.match(queuedBytes(fx.stateRoot, target.id), /^status: answered$/m);
  assert.match(queuedBytes(fx.stateRoot, target.id), new RegExp(`^answered_by: ${answer.id}$`, "m"));
  assert.equal(feedback.readFeedbackEntry(fx.root, target.id).status, "grilling", "the tracked entry's flip rides the queue, never a raw write");
});

test("POST /v1/feedback names a failed staging in its ledger row and never answers landing: queued", async () => {
  const blocked = join(tmpDir("blocked"), "a-file");
  writeFileSync(blocked, "not a directory\n");
  const fx = panelFixture("blocked", blocked);
  const body = await post([panelGraph.buildSubmitFeedbackRoute(fx.deps)], "/v1/feedback", { text: "nowhere to queue" });
  assert.equal(body.landing, undefined);
  assert.deepEqual(fx.calls, [], "a failed staging still never falls back to landing on the request path");
  assert.match(String(ledgerRow(fx.ledgerPath, "panel.feedback_submitted")?.landing_error), /queueing plan\/feedback\/.* failed/);
});

test("POST /v1/skills/run stages the Refine grill at grilling for the daemon sweep and answers landing: queued", async () => {
  const fx = panelFixture("skill");
  mkdirSync(skillsDir(fx.root), { recursive: true });
  writeFileSync(join(skillsDir(fx.root), "plan.yaml"), "tools:\n  - Read\npermission_profile: implement\noutput_contract: a PR\ngrounding_sources:\n  - plan/tasks.yaml\ngate: ci\ntier: G-17\n");
  const task = { id: "W9-T1", title: "Example task", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [{ claim: "does it", proof: "unit test: does it" }] };
  mkdirSync(dirname(fx.deps.planPath), { recursive: true });
  writeFileSync(fx.deps.planPath, JSON.stringify([task]));
  const body = await post(skillRun.buildPanelSkillRunRoutes(fx.deps), "/v1/skills/run", { skill: "plan", mode: "clarify", taskId: "W9-T1" });
  const grill = body.feedback as feedback.FeedbackEntry;
  assert.equal(body.landing, "queued");
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [rel(grill.id)]);
  assert.match(queuedBytes(fx.stateRoot, grill.id), /^status: grilling$/m, "the queue holds the grill after its flip, not the bare capture");
  assert.equal(ledgerRow(fx.ledgerPath, "panel.skill_invoked")?.landing, "queued");
});

test("POST /v1/escalation/reply stages its capture under the route's state root and answers landing: queued", async () => {
  const stateRoot = tmpDir("reply-route");
  const threadStorePath = join(stateRoot, "state", "inbox-threads.jsonl");
  appendThreadMessage({ taskId: "W9-T2", class: "BLOCKED" }, "escalation", "the retry still failed CI", { threadStorePath });
  const ledgerPath = join(stateRoot, "ledger.ndjson");
  const deps = { root: stateRoot, ledgerPath, issues: { close: () => undefined }, threadStorePath };
  const body = await post([panelActions.buildEscalationReplyRoute(deps)], "/v1/escalation/reply", { taskId: "W9-T2", class: "BLOCKED", text: "retry once more" });
  const entry = body.feedback as feedback.FeedbackEntry;
  assert.equal(body.landing, "queued");
  assert.deepEqual(landing.queuedFeedbackLandings(stateRoot), [rel(entry.id)]);
  assert.match(queuedBytes(stateRoot, entry.id), /^thread_id: /m);
  assert.equal(ledgerRow(ledgerPath, "panel.escalation_replied")?.landing, "queued");
  assert.equal(ledgerRow(ledgerPath, "plan_pr.preflight_skipped"), undefined, "no route ledgers a skipped preflight any more");
});

test("no code path lands feedback without the filer preflight: requestPathLand is gone and a landing always runs it", () => {
  assert.equal("requestPathLand" in panelActions, false, "the request-path wrapper is deleted");

  const seed = gitRepo({ kind: "w5525-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  const origin = gitRepo({ bare: true, kind: "w5525-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w5525-clone" });
  mkdirSync(join(clone.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(clone.dir, rel("fb-direct")), "id: fb-direct\nstatus: new\nraw: direct\n");
  const gh = (args: string[]): string => (args[1] === "create" ? "https://github.com/o/r/pull/77\n" : "[]");
  let preflights = 0;
  const legacyOpts = { gh, planPrPreflight: () => (preflights++, { ok: true, failures: [], unreadable: [] }), preflight: "skip-request-path" };
  const r = withLiveWritesAllowed(() => landing.landFeedback(clone.dir, legacyOpts as landing.LandFeedbackOpts));
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.equal(preflights, 1, "the old skip option is ignored: the preflight runs");
});

test("a request-path landFeedback with stateRoot touches no git, and queueFeedbackRecord names an unreadable source", () => {
  const { calls, feedbackLand } = recordingLand();
  const stateRoot = tmpDir("direct-state");
  const r = landing.landFeedback(tmpDir("direct-root"), { ...feedbackLand, stateRoot });
  assert.deepEqual(r, { landed: false, files: [], queued: [] });
  assert.deepEqual(calls, []);

  const missing = landing.queueFeedbackRecord(tmpDir("missing-root"), rel("fb-gone"), stateRoot);
  assert.equal(missing.queued, undefined);
  assert.match(missing.error ?? "", /reading plan\/feedback\/fb-gone\.yaml under .* to queue it failed/);
  assert.deepEqual(landing.queuedFeedbackLandings(stateRoot), []);
});
