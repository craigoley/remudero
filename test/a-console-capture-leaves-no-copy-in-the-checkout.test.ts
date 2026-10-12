/**
 * W1-T5628 — A CONSOLE CAPTURE LEAVES NO COPY IN THE CHECKOUT.
 *
 * Since W1-T5525 (#9049) POST /v1/feedback, /v1/skills/run and /v1/escalation/reply `captureFeedback` under
 * their root and `queueFeedbackRecord` staged a COPY for the daemon's landing sweep. The sweep removes landed
 * copies only under the daemon's own checkout, so serve's checkout (or the escalation route's state root) kept
 * an untracked file that a later fast-forward refuses. Staging now MOVES the record; the readers that relied on
 * the copy read the queue instead: the inbox lists a queue-only entry `landing: "queued"`, a repeated
 * `submissionKey` returns it, a reply sees a queued grill and a queued answer, and serve logs an unreadable
 * queue whether or not a projection worker runs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as feedback from "../src/lib/feedback.js";
import * as landing from "../src/lib/feedback-landing.js";
import { appendThreadMessage } from "../src/lib/inbox-thread.js";
import * as panelActions from "../src/lib/panel-actions.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import * as skillRun from "../src/lib/panel-skill-run.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService, type Route } from "../src/lib/service.js";
import { skillsDir } from "../src/lib/skill.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const QUEUE_DIR = join("state", "feedback-landing-pending");

type Entry = { id: string; status: string; reply_to?: unknown; submission_key?: unknown; landing?: unknown; landingUnknown?: unknown };

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5628-${label}-`));
}

const rel = (id: string) => `plan/feedback/${id}.yaml`;
const queuedPath = (stateRoot: string, id: string) => join(stateRoot, QUEUE_DIR, rel(id));

/** A plain checkout-shaped root, a separate state root, and the console's panel deps wired to land. */
function consoleFixture(label: string) {
  const root = tmpDir(`${label}-root`);
  const stateRoot = tmpDir(`${label}-state`);
  const logged: Array<[string, Record<string, unknown>]> = [];
  const refuse = () => {
    throw new Error("a console capture never lands on the request path");
  };
  const deps = {
    root,
    inboxRoot: stateRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath: join(tmpDir(`${label}-ledger`), "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    logProjection: (step: string, extra: Record<string, unknown>) => logged.push([step, extra]),
    feedbackLand: { git: refuse, gh: refuse },
  };
  mkdirSync(dirname(deps.planPath), { recursive: true });
  writeFileSync(deps.planPath, "[]\n");
  return { root, stateRoot, deps, logged };
}

/** A file where the queue's feedback directory belongs: listing it fails, so the queue is unreadable. */
function breakQueue(stateRoot: string): void {
  mkdirSync(join(stateRoot, QUEUE_DIR, "plan"), { recursive: true });
  writeFileSync(join(stateRoot, QUEUE_DIR, "plan", "feedback"), "not a directory\n");
}

async function withServer<T>(routes: Route[], run: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "r-token", write: "w-token" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer w-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Record<string, unknown> };
}

async function get(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: "Bearer r-token" } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function listed(base: string): Promise<Map<string, Entry>> {
  const res = await fetch(`${base}/v1/feedback`, { headers: { authorization: "Bearer r-token" } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return new Map((JSON.parse(text) as { entries: Entry[] }).entries.map((e) => [e.id, e]));
}

function feedbackRoutes(deps: ReturnType<typeof consoleFixture>["deps"]): Route[] {
  return [panelGraph.buildFeedbackInboxRoute(deps), panelGraph.buildSubmitFeedbackRoute(deps), panelGraph.buildPreviewFeedbackRoute(deps), panelGraph.buildTraceRoute(deps)];
}

test("POST /v1/feedback moves its capture into the queue: no copy under root, listed queued, a repeated submissionKey returns it", async () => {
  const fx = consoleFixture("submit");
  await withServer(feedbackRoutes(fx.deps), async (base) => {
    const first = await post(base, "/v1/feedback", { text: "the board is slow", submissionKey: "key-1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const entry = first.body.entry as feedback.FeedbackEntry;
    assert.equal(first.body.landing, "queued");
    assert.equal(existsSync(join(fx.root, rel(entry.id))), false, "no untracked copy is left under serve's checkout");
    assert.match(readFileSync(queuedPath(fx.stateRoot, entry.id), "utf8"), /^submission_key: key-1$/m);

    const entries = await listed(base);
    assert.equal(entries.get(entry.id)?.landing, "queued", "a queue-only capture still lists, marked queued");
    assert.equal(entries.get(entry.id)?.status, "new");
    assert.equal((await get(base, `/v1/trace?id=${entry.id}`)).status, 200, "the trace resolves a queue-only capture");
    assert.equal((await get(base, "/v1/trace?id=fb-nowhere")).status, 404, "an id in neither place is still unknown");

    const repeat = await post(base, "/v1/feedback", { text: "the board is slow", submissionKey: "key-1" });
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    assert.equal((repeat.body.entry as feedback.FeedbackEntry).id, entry.id, "the repeat answers the queued entry");
    assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [rel(entry.id)], "and files nothing new");
  });
});

test("POST /v1/skills/run leaves no copy of its grill under root, and a reply to that queue-only grill stages the answer and the flip", async () => {
  const fx = consoleFixture("skill");
  mkdirSync(skillsDir(fx.root), { recursive: true });
  writeFileSync(join(skillsDir(fx.root), "plan.yaml"), "tools:\n  - Read\npermission_profile: implement\noutput_contract: a PR\ngrounding_sources:\n  - plan/tasks.yaml\ngate: ci\ntier: G-17\n");
  const task = { id: "W9-T1", title: "Example task", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [{ claim: "does it", proof: "unit test: does it" }] };
  mkdirSync(dirname(fx.deps.planPath), { recursive: true });
  writeFileSync(fx.deps.planPath, JSON.stringify([task]));
  await withServer([...skillRun.buildPanelSkillRunRoutes(fx.deps), ...feedbackRoutes(fx.deps)], async (base) => {
    const ran = await post(base, "/v1/skills/run", { skill: "plan", mode: "clarify", taskId: "W9-T1" });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const grill = ran.body.feedback as feedback.FeedbackEntry;
    assert.equal(existsSync(join(fx.root, rel(grill.id))), false, "the grill is moved, not copied");
    assert.equal((await listed(base)).get(grill.id)?.status, "grilling");

    const answer = await post(base, "/v1/feedback", { text: "split it in two", replyTo: grill.id });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const answerId = (answer.body.entry as feedback.FeedbackEntry).id;
    assert.equal(existsSync(join(fx.root, rel(answerId))), false);
    assert.match(readFileSync(queuedPath(fx.stateRoot, grill.id), "utf8"), new RegExp(`^answered_by: ${answerId}$`, "m"), "the flip builds on the queued grill");
  });
});

test("POST /v1/escalation/reply leaves no copy under its state root", async () => {
  const stateRoot = tmpDir("escalation");
  const threadStorePath = join(stateRoot, "state", "inbox-threads.jsonl");
  appendThreadMessage({ taskId: "W9-T2", class: "BLOCKED" }, "escalation", "the retry still failed CI", { threadStorePath });
  const deps = { root: stateRoot, ledgerPath: join(stateRoot, "ledger.ndjson"), issues: { close: () => undefined }, threadStorePath };
  await withServer([panelActions.buildEscalationReplyRoute(deps)], async (base) => {
    const replied = await post(base, "/v1/escalation/reply", { taskId: "W9-T2", class: "BLOCKED", text: "retry once more" });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    const entry = replied.body.feedback as feedback.FeedbackEntry;
    assert.equal(replied.body.landing, "queued");
    assert.equal(existsSync(join(stateRoot, rel(entry.id))), false, "the state root keeps only the queued record");
    assert.ok(existsSync(queuedPath(stateRoot, entry.id)));
  });
});

test("a second reply to a grill whose first answer is only queued is refused", async () => {
  const fx = consoleFixture("answered");
  const grill = feedback.captureFeedback(fx.root, { raw: "which board?", origin: "ui" });
  feedback.setFeedbackStatus(fx.root, grill.id, "grilling");
  await withServer(feedbackRoutes(fx.deps), async (base) => {
    assert.equal((await post(base, "/v1/feedback", { text: "the plan board", replyTo: grill.id })).status, 200);
    const again = await post(base, "/v1/feedback", { text: "the plan board, again", replyTo: grill.id });
    assert.equal(again.status, 400, JSON.stringify(again.body));
    assert.match(String(again.body.detail), /already holds feedback#fb-.* answering it/);
    const preview = await post(base, "/v1/feedback/preview", { text: "and once more", replyTo: grill.id });
    assert.equal(preview.status, 400, "the preview refuses the same reply the submit would");
  });
});

test("a reply or a keyed repeat over an unreadable queue is refused rather than filed blind", async () => {
  const fx = consoleFixture("unreadable");
  const grill = feedback.captureFeedback(fx.root, { raw: "which board?", origin: "ui" });
  feedback.setFeedbackStatus(fx.root, grill.id, "grilling");
  breakQueue(fx.stateRoot);
  await withServer(feedbackRoutes(fx.deps), async (base) => {
    const keyed = await post(base, "/v1/feedback", { text: "the board is slow", submissionKey: "key-2" });
    assert.equal(keyed.status, 503, JSON.stringify(keyed.body));
    assert.equal(keyed.body.error, "landing_queue_unreadable");
    const reply = await post(base, "/v1/feedback", { text: "the plan board", replyTo: grill.id });
    assert.equal(reply.status, 503, JSON.stringify(reply.body));
    const preview = await post(base, "/v1/feedback/preview", { text: "the plan board", replyTo: grill.id });
    assert.equal(preview.status, 503, JSON.stringify(preview.body));
    assert.equal((await get(base, "/v1/trace?id=fb-nowhere")).status, 503, "a trace never calls an id unknown it could not look up");
  });
  assert.deepEqual(feedback.listFeedback(fx.root).map((e) => e.id), [grill.id], "nothing was filed blind");
  const routes = fx.logged.filter(([step]) => step === "serve.feedback_landing_queue_unreadable").map(([, extra]) => extra.route);
  assert.deepEqual(routes, ["/v1/feedback", "/v1/feedback", "/v1/feedback/preview", "/v1/trace"]);
});

test("serve logs an unreadable landing queue on GET /v1/feedback with no projection worker", async () => {
  const root = tmpDir("serve");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  feedback.captureFeedback(root, { raw: "already in the checkout", origin: "ui" });
  breakQueue(root);
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} }, feedbackLand: {} },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: "r-token", write: "w-token" }, githubEventWake: { repository: "owner/repo" },
    log: (step, extra) => logged.push([step, extra]),
  };
  const route = buildServeRoutes(deps).find((r) => r.method === "GET" && r.path === "/v1/feedback");
  assert.ok(route, "serve mounts the feedback inbox");
  await withServer([route], async (base) => {
    for (const e of (await listed(base)).values()) assert.equal(e.landingUnknown, true);
  });
  assert.equal(logged.filter(([step]) => step === "serve.feedback_landing_queue_unreadable").length, 1, "the log is wired without a worker");
});

test("queueFeedbackRecord keeps the copy when staging fails, and names a copy it staged but could not remove", () => {
  const root = tmpDir("unit-root");
  const entry = feedback.captureFeedback(root, { raw: "stage me", origin: "ui" });
  const blocked = join(tmpDir("unit-blocked"), "a-file");
  writeFileSync(blocked, "not a directory\n");
  const failed = landing.queueFeedbackRecord(root, rel(entry.id), blocked);
  assert.equal(failed.queued, undefined);
  assert.ok(existsSync(join(root, rel(entry.id))), "a failed stage keeps the only copy");

  const stateRoot = tmpDir("unit-state");
  const stuck = landing.queueFeedbackRecord(root, rel(entry.id), stateRoot, () => {
    throw new Error("EACCES: read-only checkout");
  });
  assert.deepEqual(stuck.queued, [rel(entry.id)], "the record is queued");
  assert.match(stuck.error ?? "", /queued, but removing its copy under .* failed: EACCES/);
  assert.ok(existsSync(join(root, rel(entry.id))));
});
