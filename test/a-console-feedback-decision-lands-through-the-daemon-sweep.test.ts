/**
 * W1-T5460 — A CONSOLE FEEDBACK DECISION LANDS THROUGH THE DAEMON SWEEP, WHERE THE FILER PREFLIGHT RUNS.
 *
 * W1-T5348's ~290 s `planPrPreflight` could not run on `POST /v1/feedback/decision`'s request path, so #8891
 * skipped it there and console-originated landings shipped unchecked. The route now QUEUES the decision's
 * bytes under the state root (the ci-learning shape) and returns at once; `sweepFeedbackLanding` lands the
 * queue in the same tree and the same preflight as its disk scan, and drops a record once origin/main has it.
 *
 * Every git fixture comes from test/helpers/git-repo.ts; GitHub is a fake `gh`, never the network.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as feedback from "../src/lib/feedback.js";
import * as landing from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { buildProposalDecisionRoute } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

// Namespace reads, so this file LOADS at a base without the queue and each test fails there by name.
const { LANDING_BRANCH } = landing;
const QUEUE_DIR = join("state", "feedback-landing-pending");

type LogRow = { step: string; extra?: Record<string, unknown> };

/** A bare origin whose main carries `files`, plus a clone of it. */
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
  const show = (ref: string, rel: string) => origin.git("show", `${ref}:${rel}`);
  /** What a merged landing PR does: origin/main fast-forwards to the landing branch. */
  const mergeLanding = () => origin.git("update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`);
  return { origin, clone, heads, show, mergeLanding };
}

function fakeGh() {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/77\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

/** A preflight that counts its runs and passes — the real one is W1-T5348's own suite. */
function countingPreflight() {
  const counter = { runs: 0 };
  const planPrPreflight = () => (counter.runs++, { ok: true, failures: [], unreadable: [] });
  return { counter, planPrPreflight };
}

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5460-${label}-`));
}

/** A clone whose origin/main holds one `proposed` entry, a state root outside it, and the console's panel deps. */
function decisionFixture(kind: string) {
  const f = originWith({ "README.md": "seed\n" }, kind);
  const entry = feedback.captureFeedback(f.clone.dir, { raw: "a proposal", origin: "ui" });
  feedback.setFeedbackStatus(f.clone.dir, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/7" });
  f.clone.git("add", "-A");
  f.clone.git("commit", "-q", "-m", "chore: a feedback entry");
  f.clone.git("push", "-q", "origin", "HEAD:main");
  const stateRoot = tmpDir(`${kind}-state`);
  const ledgerPath = join(tmpDir(`${kind}-ledger`), "ledger.ndjson");
  const { gh, calls } = fakeGh();
  const preflight = countingPreflight();
  const panel = {
    root: f.clone.dir,
    inboxRoot: stateRoot,
    planPath: join(f.clone.dir, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    feedbackLand: { gh, planPrPreflight: preflight.planPrPreflight },
  };
  const ledger = () =>
    existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  const relPath = `plan/feedback/${entry.id}.yaml`;
  return { f, entry, relPath, stateRoot, panel, gh, calls, preflight, ledger };
}

async function postDecision(panel: Parameters<typeof buildProposalDecisionRoute>[0], body: unknown): Promise<Record<string, unknown>> {
  const server = createService({ tokens: { read: "r-token", write: "w-token" }, routes: [buildProposalDecisionRoute(panel)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await withLiveWritesAllowed(() =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/feedback/decision`, {
        method: "POST",
        headers: { authorization: "Bearer w-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

test("a console feedback decision is queued by the route and landed by the daemon sweep with the filer preflight", async () => {
  const fx = decisionFixture("w5460-decision");
  const body = await postDecision(fx.panel as never, { id: fx.entry.id, decision: "accept" });

  // The request path: queued, answered at once — no push, no preflight, no skip, no GitHub call.
  assert.equal(body.status, "accepted");
  assert.equal(body.landing, "queued", "the console is told the landing is queued");
  assert.deepEqual(fx.f.heads(), ["main"], "the route pushed nothing");
  assert.equal(fx.preflight.counter.runs, 0, "the route ran no preflight check");
  assert.deepEqual(fx.calls, [], "the route made no GitHub call");
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [fx.relPath]);
  assert.match(readFileSync(join(fx.stateRoot, QUEUE_DIR, fx.relPath), "utf8"), /^status: accepted$/m);
  assert.deepEqual(readdirSync(join(fx.stateRoot, QUEUE_DIR, "plan", "feedback")), [`${fx.entry.id}.yaml`], "no staging file is left behind");
  const rows = fx.ledger();
  assert.equal(rows.some((r) => r.step === "plan_pr.preflight_skipped"), false, "the request-path skip is gone for this route");
  assert.equal(rows.find((r) => r.step === "panel.proposal_accepted")?.landing, "queued");
  assert.match(fx.f.show("main", fx.relPath), /^status: proposed$/m, "origin/main is untouched until the sweep");

  // The daemon sweep: the preflight runs on the queued bytes, then the landing pushes and opens its PR.
  const log: LogRow[] = [];
  const sweep = () =>
    withLiveWritesAllowed(() =>
      landing.sweepFeedbackLanding(fx.f.clone.dir, {
        gh: fx.gh,
        planPrPreflight: fx.preflight.planPrPreflight,
        stateRoot: fx.stateRoot,
        log: (step, extra) => log.push({ step, extra }),
      }),
    );
  const first = sweep();
  assert.equal(first.landed, true, JSON.stringify(first));
  assert.equal(first.pushed, true);
  assert.deepEqual(first.files, [fx.relPath]);
  assert.equal(fx.preflight.counter.runs, 1, "the sweep ran the filer preflight once");
  assert.deepEqual(fx.f.heads(), [LANDING_BRANCH, "main"]);
  assert.match(fx.f.show(LANDING_BRANCH, fx.relPath), /^status: accepted$/m);
  assert.equal(fx.calls.filter((c) => c[1] === "create").length, 1);
  assert.equal(log.some((r) => r.step === "plan_pr.preflight_skipped"), false);

  // Bounded: an unchanged queue re-reads as the same tree, so a quiet pass runs no second preflight.
  const quiet = sweep();
  assert.equal(quiet.pushed, false);
  assert.equal(fx.preflight.counter.runs, 1, "an unchanged landing never re-runs the preflight");
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [fx.relPath], "pending until origin/main carries it");

  // Once the landing PR merges, the next pass acknowledges the queued record and lands nothing.
  fx.f.mergeLanding();
  const settled = sweep();
  assert.equal(settled.landed, false, JSON.stringify(settled));
  assert.deepEqual(landing.queuedFeedbackLandings(fx.stateRoot), [], "a landed decision leaves the queue");
  assert.equal(fx.preflight.counter.runs, 1);
});

test("a queued record origin/main has never seen lands as a new file and leaves the queue once merged", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5460-new-record");
  const stateRoot = tmpDir("new-record-state");
  const rel = "plan/feedback/fb-queued.yaml";
  const queued = landing.landFeedbackStatusContent(f.clone.dir, rel, "id: fb-queued\nstatus: grilling\nraw: queued\n", { stateRoot });
  assert.deepEqual(queued, { landed: false, files: [], queued: [rel] }, "a status write with a state root queues, never pushes");
  assert.deepEqual(f.heads(), ["main"]);

  const { gh } = fakeGh();
  const { counter, planPrPreflight } = countingPreflight();
  const r = withLiveWritesAllowed(() => landing.sweepFeedbackLanding(f.clone.dir, { gh, planPrPreflight, stateRoot }));
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.deepEqual(r.files, [rel]);
  assert.equal(counter.runs, 1);
  assert.match(f.show(LANDING_BRANCH, rel), /^status: grilling$/m);

  f.mergeLanding();
  withLiveWritesAllowed(() => landing.sweepFeedbackLanding(f.clone.dir, { gh, planPrPreflight, stateRoot }));
  assert.deepEqual(landing.queuedFeedbackLandings(stateRoot), []);
});

test("a queued decision wins over a dirty disk copy of the same record, in one tree and one preflight", () => {
  const rel = "plan/feedback/fb-both.yaml";
  const f = originWith({ "README.md": "seed\n", [rel]: "id: fb-both\nstatus: proposed\nraw: both\n" }, "w5460-both");
  writeFileSync(join(f.clone.dir, rel), "id: fb-both\nstatus: proposed\nraw: both\nsummary: a disk edit\n");
  writeFileSync(join(f.clone.dir, "plan", "feedback", "fb-disk.yaml"), "id: fb-disk\nstatus: new\nraw: disk\n");
  const stateRoot = tmpDir("both-state");
  landing.landFeedbackStatusContent(f.clone.dir, rel, "id: fb-both\nstatus: rejected\nraw: both\n", { stateRoot });

  const { gh } = fakeGh();
  const { counter, planPrPreflight } = countingPreflight();
  const r = withLiveWritesAllowed(() => landing.sweepFeedbackLanding(f.clone.dir, { gh, planPrPreflight, stateRoot }));
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.deepEqual(r.files, ["plan/feedback/fb-both.yaml", "plan/feedback/fb-disk.yaml"]);
  assert.equal(counter.runs, 1, "the disk inbox and the queue share one preflight");
  assert.match(f.show(LANDING_BRANCH, rel), /^status: rejected$/m, "the queued decision's bytes landed");
});

test("only the named sweep drains the queue: a capture's own landing leaves it for the daemon", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5460-capture");
  const stateRoot = tmpDir("capture-state");
  const rel = "plan/feedback/fb-later.yaml";
  landing.landFeedbackStatusContent(f.clone.dir, rel, "id: fb-later\nstatus: new\nraw: later\n", { stateRoot });
  const { gh } = fakeGh();
  const r = withLiveWritesAllowed(() => landing.landFeedback(f.clone.dir, { gh, stateRoot }));
  assert.equal(r.landed, false, JSON.stringify(r));
  assert.deepEqual(f.heads(), ["main"]);
  assert.deepEqual(landing.queuedFeedbackLandings(stateRoot), [rel]);
});

test("the queue refuses a path outside plan/feedback and names an unwritable state root, never reporting queued", () => {
  const stateRoot = tmpDir("refuse-state");
  const outside = landing.landFeedbackStatusContent("/unused", "plan/tasks.d/W9-T1.yaml", "x\n", { stateRoot });
  assert.equal(outside.landed, false);
  assert.equal(outside.queued, undefined);
  assert.match(outside.error ?? "", /refusing to queue plan\/tasks\.d\/W9-T1\.yaml/);
  assert.deepEqual(landing.queuedFeedbackLandings(stateRoot), []);

  const blocked = join(stateRoot, "a-file");
  writeFileSync(blocked, "not a directory\n");
  const unwritable = landing.landFeedbackStatusContent("/unused", "plan/feedback/fb-x.yaml", "x\n", { stateRoot: blocked });
  assert.equal(unwritable.queued, undefined);
  assert.match(unwritable.error ?? "", /queueing plan\/feedback\/fb-x\.yaml under .* failed/);
});
