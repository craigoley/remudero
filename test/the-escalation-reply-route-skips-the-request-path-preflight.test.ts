/**
 * W1-T5473 — THE ESCALATION REPLY ROUTE SKIPS THE REQUEST-PATH PREFLIGHT.
 *
 * PR #8891 routed the console's decision, submit and skills/run landings through `requestPathLand`, so the ~290 s
 * plan-PR preflight never runs inside a synchronous HTTP request. POST /v1/escalation/reply still called
 * `captureFeedback` with no landing options. This suite stands up a real server over a real git origin/clone pair
 * and a fake `gh`, posts one reply, and reads the ledger the route writes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as landing from "../src/lib/feedback-landing.js";
import { appendThreadMessage, type ThreadIdentity } from "../src/lib/inbox-thread.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as panel from "../src/lib/panel-actions.js";
import { createService } from "../src/lib/service.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const { LANDING_BRANCH } = landing;
const TASK_ID = "W1-T9473";

/** A clone of a bare origin whose main holds `files`; `heads()` lists origin's branches. */
function originWith(files: Record<string, string>, kind: string) {
  const seed = gitRepo({ kind: `${kind}-seed` });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed.dir, rel)), { recursive: true });
    writeFileSync(join(seed.dir, rel), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-clone` });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  return { origin, clone, heads };
}

/** Everything one escalation reply needs: a raised thread, a ledger, and a landing whose `gh` and preflight are fakes. */
function replyFixture(kind: string) {
  const f = originWith({ "README.md": "seed\n" }, kind);
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5473-${kind}-`));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const threadStorePath = join(stateDir, "threads.jsonl");
  const identity: ThreadIdentity = { taskId: TASK_ID, class: "BLOCKED" };
  appendThreadMessage(identity, "escalation", "the retry still failed CI", { threadStorePath });
  const counter = { preflights: 0 };
  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/77\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const landLog: string[] = [];
  const feedbackLand = {
    gh,
    planPrPreflight: () => (counter.preflights++, { ok: true, failures: [], unreadable: [] }),
    log: (step: string) => landLog.push(step),
  };
  const deps = { root: f.clone.dir, ledgerPath, issues: { close: () => undefined }, threadStorePath, feedbackLand };
  return { f, deps, counter, ghCalls, landLog };
}

async function postReply(deps: Parameters<typeof panel.buildEscalationReplyRoute>[0]): Promise<void> {
  const server = createService({ tokens: { read: "r-token", write: "w-token" }, routes: [panel.buildEscalationReplyRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await withLiveWritesAllowed(() =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/escalation/reply`, {
        method: "POST",
        headers: { authorization: "Bearer w-token", "content-type": "application/json" },
        body: JSON.stringify({ taskId: TASK_ID, class: "BLOCKED", text: "retry once more, the flake looks like ci noise" }),
      }),
    );
    assert.equal(res.status, 200, await res.text());
  } finally {
    server.close();
  }
}

test("the console's POST /v1/escalation/reply lands its capture without running the plan-PR preflight", async () => {
  const fx = replyFixture("reply-lands");
  await postReply(fx.deps);
  assert.equal(fx.counter.preflights, 0, "the reply's request path never runs the preflight checks");
  assert.deepEqual(fx.f.heads(), [LANDING_BRANCH, "main"], "the reply's feedback entry still landed");
  assert.equal(fx.ghCalls.filter((c) => c[1] === "create").length, 1, "the landing PR was still opened");
});

test("an escalation reply ledgers plan_pr.preflight_skipped under the reply's task and the caller's origin", async () => {
  const fx = replyFixture("reply-ledgers");
  await postReply(fx.deps);
  // ledger-read-intent: live
  const rows = readLedgerLines(fx.deps.ledgerPath);
  const skipped = rows.filter((r) => r.step === "plan_pr.preflight_skipped");
  assert.equal(skipped.length, 1, JSON.stringify(rows));
  assert.equal(skipped[0].task_id, TASK_ID);
  assert.equal(skipped[0].reason, "request-path");
  assert.equal(skipped[0].lane, "feedback-landing");
  const replied = rows.find((r) => r.step === "panel.escalation_replied");
  assert.ok(replied, "the reply itself is still ledgered");
  assert.equal(skipped[0].origin, replied.origin, "the skip names the same bearer as the reply");
  assert.ok(fx.landLog.includes("plan_pr.preflight_skipped"), "the configured landing's own log still sees the skip");
});
