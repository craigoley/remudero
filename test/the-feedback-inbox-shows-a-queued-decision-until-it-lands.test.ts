/**
 * W1-T5524 — THE FEEDBACK INBOX SHOWS A QUEUED DECISION UNTIL IT LANDS.
 *
 * Since W1-T5460 a console accept or reject is staged under the state root for the daemon's landing sweep
 * and answered `landing: "queued"` ONCE, on the POST. GET /v1/feedback never said so, so a board that
 * reloads (or a second viewer) saw the decision as if nothing were pending. The GET now reads the queue
 * once per request and marks each staged entry `landing: "queued"` until the sweep drops the record; a
 * queue that cannot be read marks every entry `landingUnknown: true`, never "nothing queued".
 *
 * The decision is staged by the real POST route; the sweep's acknowledgement (an unlink of the queued
 * record once origin/main carries it) is W1-T5460's own suite, so here the record is removed directly.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import * as feedback from "../src/lib/feedback.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const QUEUE_DIR = join("state", "feedback-landing-pending", "plan", "feedback");

type Entry = { id: string; status: string; landing?: unknown; landingUnknown?: unknown };

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5524-${label}-`));
}

/** A checkout holding two `proposed` entries, a state root outside it, and the console's panel deps. */
function inboxFixture(label: string, wired = true) {
  const root = tmpDir(`${label}-root`);
  const stateRoot = tmpDir(`${label}-state`);
  const staged = feedback.captureFeedback(root, { raw: "a proposal the operator accepts", origin: "ui" });
  const other = feedback.captureFeedback(root, { raw: "a proposal nobody decided", origin: "ui" });
  for (const e of [staged, other]) feedback.setFeedbackStatus(root, e.id, "proposed", { proposalPr: "https://github.com/o/r/pull/7" });
  const logged: Array<[string, Record<string, unknown>]> = [];
  const gh = () => {
    throw new Error("the inbox read and the queued decision make no GitHub call");
  };
  const panel = {
    root,
    inboxRoot: stateRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath: join(tmpDir(`${label}-ledger`), "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    logProjection: (step: string, extra: Record<string, unknown>) => logged.push([step, extra]),
    ...(wired ? { feedbackLand: { gh } } : {}),
  };
  return { root, stateRoot, staged, other, panel, logged };
}

async function withServer<T>(panel: unknown, run: (base: string) => Promise<T>): Promise<T> {
  const deps = panel as Parameters<typeof panelGraph.buildFeedbackInboxRoute>[0];
  const server = createService({
    tokens: { read: "r-token", write: "w-token" },
    routes: [panelGraph.buildFeedbackInboxRoute(deps), panelGraph.buildProposalDecisionRoute(deps)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function getEntries(base: string, query = ""): Promise<Map<string, Entry>> {
  const res = await fetch(`${base}/v1/feedback${query}`, { headers: { authorization: "Bearer r-token" } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return new Map((JSON.parse(text) as { entries: Entry[] }).entries.map((e) => [e.id, e]));
}

async function postDecision(base: string, id: string): Promise<Record<string, unknown>> {
  const res = await withLiveWritesAllowed(() =>
    fetch(`${base}/v1/feedback/decision`, {
      method: "POST",
      headers: { authorization: "Bearer w-token", "content-type": "application/json" },
      body: JSON.stringify({ id, decision: "accept" }),
    }),
  );
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as Record<string, unknown>;
}

test("GET /v1/feedback marks a decision staged for the landing sweep landing: queued until the queue drops it", async () => {
  const fx = inboxFixture("queued");
  await withServer(fx.panel, async (base) => {
    const before = await getEntries(base);
    assert.equal(before.get(fx.staged.id)?.landing, undefined, "nothing is queued before the decision");

    const decided = await postDecision(base, fx.staged.id);
    assert.equal(decided.landing, "queued", "the POST stages the decision (W1-T5460)");

    // A reload — or a second viewer that never saw the POST's answer — still sees it pending.
    const reloaded = await getEntries(base);
    assert.equal(reloaded.get(fx.staged.id)?.status, "accepted");
    assert.equal(reloaded.get(fx.staged.id)?.landing, "queued", "the staged decision reads back as queued");
    assert.equal(reloaded.get(fx.other.id)?.landing, undefined, "an entry with nothing staged carries no landing field");
    assert.equal(reloaded.get(fx.staged.id)?.landingUnknown, undefined, "a readable queue is never landingUnknown");
    const filtered = await getEntries(base, "?status=accepted");
    assert.equal(filtered.get(fx.staged.id)?.landing, "queued", "the status filter keeps the decoration");

    // The sweep acknowledges a landed record by dropping it from the queue; the inbox follows on the next read.
    rmSync(join(fx.stateRoot, QUEUE_DIR, `${fx.staged.id}.yaml`));
    const landed = await getEntries(base);
    assert.equal(landed.get(fx.staged.id)?.landing, undefined, "a record the queue dropped is no longer queued");
    assert.equal(landed.get(fx.staged.id)?.status, "accepted");
  });
});

test("GET /v1/feedback marks every entry landingUnknown when the landing queue cannot be read", async () => {
  const fx = inboxFixture("unreadable");
  // A file where the queue's directory belongs: readdir fails, which must never read as "nothing queued".
  mkdirSync(join(fx.stateRoot, "state", "feedback-landing-pending", "plan"), { recursive: true });
  writeFileSync(join(fx.stateRoot, QUEUE_DIR), "not a directory\n");
  await withServer(fx.panel, async (base) => {
    const entries = await getEntries(base);
    assert.equal(entries.size, 2);
    for (const e of entries.values()) {
      assert.equal(e.landingUnknown, true, `${e.id} says the queue could not be read`);
      assert.equal(e.landing, undefined, `${e.id} claims no landing state it could not read`);
    }
  });
  const unreadable = fx.logged.filter(([step]) => step === "serve.feedback_landing_queue_unreadable");
  assert.equal(unreadable.length, 1, "the failed read is recorded once per request");
  assert.match(String(unreadable[0]?.[1].reason), /ENOTDIR/, "the record carries the read's own error");
});

test("GET /v1/feedback reads no landing queue when feedbackLand is not wired", async () => {
  const fx = inboxFixture("unwired", false);
  mkdirSync(join(fx.stateRoot, QUEUE_DIR), { recursive: true });
  writeFileSync(join(fx.stateRoot, QUEUE_DIR, `${fx.staged.id}.yaml`), `id: ${fx.staged.id}\nstatus: accepted\n`);
  await withServer(fx.panel, async (base) => {
    const entries = await getEntries(base);
    assert.equal(entries.get(fx.staged.id)?.landing, undefined, "no landing lane, no queue read");
    assert.equal(entries.get(fx.staged.id)?.landingUnknown, undefined);
  });
});

test("the openapi feedback entry schema documents landing and landingUnknown next to discharged", () => {
  const spec = parse(readFileSync(new URL("../openapi/daemon.yaml", import.meta.url), "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, { type?: unknown; enum?: unknown[]; description?: string }> }> };
  };
  const entry = Object.values(spec.components.schemas).find((s) => s.properties?.discharged && s.properties?.dischargeUndecidable);
  assert.ok(entry?.properties, "the feedback entry schema (the one carrying `discharged`) exists");
  const { landing, landingUnknown } = entry.properties;
  assert.deepEqual(landing?.enum, ["queued"], "landing is documented as the queued marker");
  assert.equal(landing?.type, "string");
  assert.match(landing?.description ?? "", /W1-T5524/);
  assert.equal(landingUnknown?.type, "boolean", "landingUnknown is documented");
  assert.match(landingUnknown?.description ?? "", /W1-T5524/);
});
