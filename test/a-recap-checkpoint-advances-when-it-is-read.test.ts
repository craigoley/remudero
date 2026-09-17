/**
 * test/a-recap-checkpoint-advances-when-it-is-read.test.ts — the three acceptance criteria for
 * W1-T3667 ("the since-you-last-checked marker is five days stale and nothing advances it"),
 * each proven as its own dedicated test against the REAL `buildStatusRoute` + `createLastSeenStore`
 * wiring (lib/board.ts, lib/last-seen.ts) — never a mock of either.
 *
 * The mechanism under test already exists (W1-T163 / the `x-rmd-recap-ack` ack gate fixed by
 * fix(console) #1165): `buildStatusRoute` advances a token's marker via `lastSeen.advance(...)`
 * ONLY when `requestAcknowledgesRecap(req.headers[RECAP_ACK_HEADER])` is true — an ordinary poll
 * (no header) never advances it. This file is the acceptance-shaped proof the task asked for,
 * one test per claim, so each of the three can fail independently and name exactly which
 * invariant broke.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildStatusRoute, RECAP_ACK_HEADER, type BoardDeps } from "../src/lib/board.js";
import { createLastSeenStore, hashToken, type LastSeenStore } from "../src/lib/last-seen.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

const READ_TOKEN = "recap-checkpoint-read-token";
const OTHER_TOKEN = "recap-checkpoint-other-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — never trusted
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-recap-checkpoint-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function tmpLastSeenStore(): LastSeenStore {
  return createLastSeenStore(join(mkdtempSync(join(tmpdir(), "rmd-recap-checkpoint-last-seen-")), "last-seen.json"));
}

async function withMarkerAwareBoardService<T>(
  deps: BoardDeps,
  lastSeen: LastSeenStore,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: OTHER_TOKEN },
    routes: [buildStatusRoute(deps, lastSeen)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, token: string, ack: boolean): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (ack) headers[RECAP_ACK_HEADER] = "1";
  return fetch(`${base}/v1/status`, { headers });
}

// ── criterion 1: a poll must not advance the checkpoint ─────────────────────────────────────

test("a poll (no ack header) never advances the recap checkpoint", async () => {
  const ledgerPath = tmpLedgerPath();
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath, github: fakeGitHub() };
  const store = tmpLastSeenStore();
  const tokenId = hashToken(READ_TOKEN);

  await withMarkerAwareBoardService(deps, store, async (base) => {
    // Establish a marker with one acknowledged view first.
    await get(base, READ_TOKEN, true);
    const established = store.get(tokenId);
    assert.ok(established, "the ack view must have established a marker");

    // New activity lands, then FIVE bare polls (no ack header) read it.
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), task_id: "W1-T1", step: "verdict", verdict: "merged" }) + "\n");
    let lastBody: { recap: unknown[]; sinceCheckpoint?: string } | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await get(base, READ_TOKEN, false);
      lastBody = (await res.json()) as { recap: unknown[]; sinceCheckpoint?: string };
    }

    assert.equal(store.get(tokenId), established, "five automatic polls must leave the checkpoint exactly where it was");
    assert.equal(lastBody?.sinceCheckpoint, established, "a poll's own recap must still be computed from the un-advanced checkpoint");
    assert.equal(lastBody?.recap.length, 1, "the event that landed while polling must still show up — nothing was lost");
  });
});

// ── criterion 2: an explicit ack must advance the checkpoint and shrink the next recap ──────

test("an explicit acknowledgement advances the checkpoint, so the NEXT recap is smaller", async () => {
  const ledgerPath = tmpLedgerPath();
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" }), task({ id: "W1-T2" })]), ledgerPath, github: fakeGitHub() };
  const store = tmpLastSeenStore();
  const tokenId = hashToken(READ_TOKEN);

  await withMarkerAwareBoardService(deps, store, async (base) => {
    // First ack establishes the checkpoint.
    await get(base, READ_TOKEN, true);
    const established = store.get(tokenId);

    // Two events land after the checkpoint.
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), task_id: "W1-T1", step: "verdict", verdict: "merged" }) + "\n");
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), task_id: "W1-T2", step: "verdict", verdict: "merged" }) + "\n");

    const beforeAck = (await (await get(base, READ_TOKEN, false)).json()) as { recap: unknown[] };
    assert.equal(beforeAck.recap.length, 2, "both events are still unread before the next ack");

    // An acknowledged view: it must both see the two events AND advance the checkpoint past them.
    const ackRes = (await (await get(base, READ_TOKEN, true)).json()) as { recap: unknown[] };
    assert.equal(ackRes.recap.length, 2, "the acknowledged view itself still recaps everything pending");
    assert.notEqual(store.get(tokenId), established, "the checkpoint must have moved");

    // The NEXT view — even a bare poll — must see a SMALLER (empty) recap: nothing new since the ack.
    const afterAck = (await (await get(base, READ_TOKEN, false)).json()) as { recap: unknown[] };
    assert.deepEqual(afterAck.recap, [], "the checkpoint advanced, so the recap shrank to nothing");
  });
});

// ── criterion 3: the checkpoint is per token — one ack must not blank another token's recap ─

test("one token's acknowledgement leaves ANOTHER token's checkpoint and recap intact", async () => {
  const ledgerPath = tmpLedgerPath();
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath, github: fakeGitHub() };
  const store = tmpLastSeenStore();

  await withMarkerAwareBoardService(deps, store, async (base) => {
    // Both tokens establish their own marker first.
    await get(base, READ_TOKEN, true);
    await get(base, OTHER_TOKEN, true);

    // New activity lands after both markers were established.
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), task_id: "W1-T1", step: "verdict", verdict: "merged" }) + "\n");

    // READ_TOKEN acknowledges — its own checkpoint advances.
    const readAck = (await (await get(base, READ_TOKEN, true)).json()) as { recap: Array<{ taskId: string }> };
    assert.equal(readAck.recap.length, 1, "READ_TOKEN sees the pending event on its own acknowledged view");

    // OTHER_TOKEN, never having acknowledged since, must STILL see the same event — its
    // checkpoint must not have been advanced by READ_TOKEN's ack.
    const otherStillPending = (await (await get(base, OTHER_TOKEN, false)).json()) as { recap: Array<{ taskId: string }> };
    assert.equal(otherStillPending.recap.length, 1, "OTHER_TOKEN's recap must be untouched by READ_TOKEN's acknowledgement");
    assert.equal(otherStillPending.recap[0]!.taskId, "W1-T1");

    assert.notEqual(
      store.get(hashToken(READ_TOKEN)),
      store.get(hashToken(OTHER_TOKEN)),
      "the two tokens' checkpoints must be independent values, not one shared marker",
    );
  });
});
