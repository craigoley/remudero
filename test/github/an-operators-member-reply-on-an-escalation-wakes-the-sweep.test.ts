/**
 * W1-T15280: the operator's reply on a needs-human escalation wakes the sweep early.
 * OBSERVED 2026-11-28: craigoley is a GitHub organization, so its admin cao825 comments with author_association
 * MEMBER, never OWNER. isOwnerEscalationReply accepted only OWNER, so the operator's reply never woke the sweep; the
 * polling reader (escalation-answers.ts) did accept it through config.operatorGithubLogins, so only the wake was lost.
 * The wake now uses the reader's rule: a configured login list wins, matched case-insensitively; without one, OWNER.
 * Both webhook surfaces carry the list: serve's own route and the supervisor's hook listener (W1-T14986).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isGithubHookConfig, type GithubHookConfig } from "#src/lib/github-delivery-accept.js";
import {
  consumeSweepWakeMarker,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  githubDeliveryChecks,
  githubDeliveryDedupPath,
  isOwnerEscalationReply,
  sweepWakeMarkerPath,
} from "#src/lib/github-event-wake.js";
import { createGithubHookServer } from "#src/lib/github-hook-listener.js";
import { githubHookConfigOf } from "#src/lib/serve.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SECRET = "w1-teventwake-secret";
const REPOSITORY = "craigoley/remudero";
const OPERATORS = ["cao825"] as const;

interface Reply { association?: string; login?: string; type?: string; labels?: string[]; action?: string }

function reply(r: Reply = {}): Record<string, unknown> {
  return {
    action: r.action ?? "created",
    repository: { full_name: REPOSITORY },
    issue: { number: 7573, labels: (r.labels ?? ["needs-human", "needs-question"]).map((name) => ({ name })) },
    comment: { author_association: r.association ?? "MEMBER", user: { login: r.login ?? "Cao825", type: r.type ?? "User" }, body: "revise-spec" },
  };
}

function headers(body: string, id: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": id,
    "x-github-event": "issue_comment",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
  };
}

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}eventwake-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

/** Serve's own POST /v1/hooks/github route, on an ephemeral port. */
async function serveRoute(t: TestContext, root: string, operatorGithubLogins?: readonly string[]) {
  const route = createGitHubEventWakeHandler({
    secret: SECRET, repository: REPOSITORY, markerPath: sweepWakeMarkerPath(root), dedup: createDeliveryDedupStore(50), log: () => {},
    ...(operatorGithubLogins ? { operatorGithubLogins } : {}),
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`;
}

/** The supervisor's hook listener (github-hook-listener.ts), built in this thread, with `config` pushed to it. */
async function hookListener(t: TestContext, root: string) {
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, `${SECRET}\n`);
  const hook = createGithubHookServer({ secretFile, post: () => {} });
  await new Promise<void>((resolve) => hook.server.listen(0, "127.0.0.1", resolve));
  t.after(() => hook.stop());
  const config: GithubHookConfig = {
    repository: REPOSITORY, markerPaths: { [REPOSITORY]: sweepWakeMarkerPath(root) }, dedupPath: githubDeliveryDedupPath(root),
    dedupCapacity: 50, semanticCheckMode: "shadow", aggregateCheckNames: ["ci-gate"],
  };
  return { url: `http://127.0.0.1:${(hook.server.address() as AddressInfo).port}/v1/hooks/github`, configure: hook.configure, config };
}

async function post(url: string, payload: Record<string, unknown>, id: string): Promise<unknown> {
  const body = JSON.stringify(payload);
  const res = await fetch(url, { method: "POST", headers: headers(body, id), body });
  return res.json();
}

/** Posts one delivery and says whether it armed the wake marker (consuming it, so each case starts clear). */
async function wakes(url: string, root: string, payload: Record<string, unknown>, id: string): Promise<boolean> {
  const answer = await post(url, payload, id);
  const marker = consumeSweepWakeMarker(sweepWakeMarkerPath(root));
  assert.equal(marker !== undefined, JSON.stringify(answer) === JSON.stringify({ accepted: true }), `${id}: the answer and the marker agree`);
  return marker?.deliveryId === id;
}

test("W1-T15280 criterion 1: a MEMBER reply by a configured operator login on a needs-human issue wakes", async (t) => {
  assert.equal(isOwnerEscalationReply("issue_comment", "created", reply(), OPERATORS), true,
    "the organization admin's MEMBER reply, its login matched case-insensitively");
  assert.equal(githubDeliveryChecks(undefined, undefined, OPERATORS).wakes("issue_comment", "created", reply()), true,
    "the checks both webhook surfaces share carry the list");

  const routeRoot = scratch(t);
  const route = await serveRoute(t, routeRoot, OPERATORS);
  assert.equal(await wakes(route, routeRoot, reply(), "route-operator-reply"), true, "serve's own route wakes the sweep");

  const hookRoot = scratch(t);
  const hook = await hookListener(t, hookRoot);
  const pushed = { ...hook.config, operatorGithubLogins: [...OPERATORS] };
  assert.equal(isGithubHookConfig(pushed), true, "a pushed config carrying the list is taken");
  hook.configure(pushed);
  assert.equal(await wakes(hook.url, hookRoot, reply(), "hook-operator-reply"), true, "the supervisor's hook listener wakes the sweep");
  hook.configure({ ...hook.config, operatorGithubLogins: [...OPERATORS] });
  assert.equal(await wakes(hook.url, hookRoot, reply(), "hook-same-list"), true, "a re-push of the same list keeps the operator's wake");

  const pushedByServe = githubHookConfigOf({
    fleetControlRoot: hookRoot, questionsRoot: hookRoot, instances: { registryPath: join(hookRoot, "absent.yaml") },
    githubEventWake: { repository: REPOSITORY, operatorGithubLogins: OPERATORS },
  });
  assert.deepEqual(pushedByServe?.operatorGithubLogins, [...OPERATORS], "serve pushes config.json's list to the listener");
});

test("W1-T15280 criterion 2: no other comment wakes, and without a configured list only OWNER does", async (t) => {
  const refused: Array<[string, Reply]> = [
    ["a non-operator MEMBER", { login: "someone-else" }],
    ["a bot posting under the operator login", { type: "Bot" }],
    ["a lower-case bot type", { type: "bot" }],
    ["the operator on an issue that is not needs-human", { labels: ["bug"] }],
    ["the operator's edited comment", { action: "edited" }],
  ];
  for (const [why, r] of refused) {
    assert.equal(isOwnerEscalationReply("issue_comment", r.action ?? "created", reply(r), OPERATORS), false, why);
  }
  const loginless = reply();
  delete ((loginless.comment as Record<string, unknown>).user as Record<string, unknown>).login;
  assert.equal(isOwnerEscalationReply("issue_comment", "created", loginless, OPERATORS), false, "a comment with no login");
  assert.equal(isOwnerEscalationReply("issue_comment", "created", null, OPERATORS), false, "a bodiless delivery never wakes");
  assert.equal(isOwnerEscalationReply("pull_request", "created", reply(), OPERATORS), false, "only an issue_comment can");

  // No configured list: origin/main's rule, OWNER only.
  assert.equal(isOwnerEscalationReply("issue_comment", "created", reply({ association: "OWNER" })), true, "positive control: OWNER");
  assert.equal(isOwnerEscalationReply("issue_comment", "created", reply()), false, "a MEMBER, even the operator's login");
  assert.equal(isOwnerEscalationReply("issue_comment", "created", reply({ association: "OWNER", type: "Bot" })), false, "a bot OWNER");

  const routeRoot = scratch(t);
  const route = await serveRoute(t, routeRoot, OPERATORS);
  for (const [i, [why, r]] of refused.entries()) {
    assert.equal(await wakes(route, routeRoot, reply(r), `route-refused-${i}`), false, `serve's route: ${why}`);
  }
  const unlisted = scratch(t);
  const plainRoute = await serveRoute(t, unlisted);
  assert.equal(await wakes(plainRoute, unlisted, reply(), "no-list-member"), false, "no list: the operator's MEMBER reply does not wake");
  assert.equal(await wakes(plainRoute, unlisted, reply({ association: "OWNER" }), "no-list-owner"), true, "no list: OWNER wakes");

  const hookRoot = scratch(t);
  const hook = await hookListener(t, hookRoot);
  hook.configure({ ...hook.config, operatorGithubLogins: [...OPERATORS] });
  assert.equal(await wakes(hook.url, hookRoot, reply({ login: "someone-else" }), "hook-non-operator"), false, "the listener: a non-operator MEMBER");
  hook.configure(hook.config);
  assert.equal(await wakes(hook.url, hookRoot, reply(), "hook-no-list"), false, "the listener with no list: the MEMBER reply does not wake");
  assert.equal(await wakes(hook.url, hookRoot, reply({ association: "OWNER" }), "hook-owner"), true, "the listener with no list: OWNER wakes");
});

test("W1-T15280 criterion 3: a configured list wins over OWNER, as in the escalation reader", async (t) => {
  assert.equal(isOwnerEscalationReply("issue_comment", "created", reply({ association: "OWNER", login: "repo-owner" }), OPERATORS), false,
    "an OWNER the configured list does not name: the reader would refuse the answer, so it wakes nothing");

  const hookRoot = scratch(t);
  const hook = await hookListener(t, hookRoot);
  assert.equal(isGithubHookConfig({ ...hook.config, operatorGithubLogins: [7] }), false, "a pushed list of non-strings is refused");
  hook.configure({ ...hook.config, operatorGithubLogins: [...OPERATORS] });
  assert.equal(await wakes(hook.url, hookRoot, reply({ association: "OWNER", login: "repo-owner" }), "hook-unlisted-owner"), false,
    "the listener: an unlisted OWNER");
  assert.equal(await wakes(hook.url, hookRoot, reply(), "hook-listed"), true, "positive control: the listed operator wakes");
  hook.configure(hook.config);
  assert.equal(await wakes(hook.url, hookRoot, reply(), "hook-list-dropped"), false, "a push that drops the list falls back to OWNER only");
});
