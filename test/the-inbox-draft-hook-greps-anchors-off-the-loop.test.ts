/**
 * 2026-10-06: the inbox draft hook ran one sync `git grep` per evidence anchor on the core daemon
 * loop (up to 29 s a spawn). These drive the hook through its seams and import only what main
 * already exports, so each fails on main's sync wiring rather than failing to load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceAnchor } from "../src/lib/inbox.js";
import { buildInboxDraftHook } from "../src/run-task.js";
import { loadPlan } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";

const landed: EvidenceAnchor = { description: "landed", pattern: "LANDED", path: "sub/note.md" };
const anywhere: EvidenceAnchor = { description: "anywhere", pattern: "LANDED" };

function hookFixture() {
  const root = makeTempDir("anchor-grep-hook");
  mkdirSync(join(root, "state"), { recursive: true });
  const proposals = [{ id: "P-ANCHOR", summary: "p", evidenceAnchors: [landed, anywhere] }];
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { config: { root } as Config, plan: loadPlan(planPath) };
}

test("the inbox draft hook greps its evidence anchors off the loop and never on it", async () => {
  const { config, plan } = hookFixture();
  const syncCalls: string[] = [];
  const asyncCalls: string[] = [];
  let ticks = 0;
  const timer = setInterval(() => void ticks++, 5);
  const hook = buildInboxDraftHook(
    "o", "r", config, "RUN-ANCHOR", () => {},
    async (due) => due.map((p) => ({ proposalId: p.id, ok: false as const, error: "ordinary failure" })),
    (_ref, anchor) => { syncCalls.push(anchor.description); return true; },
    () => "a".repeat(40),
    undefined,
    async (ref, anchor) => { asyncCalls.push(`${ref.slice(0, 1)}:${anchor.description}`); await delay(30); return true; },
  );
  type DraftTickRead = NonNullable<Parameters<typeof hook>[0]>;
  try {
    await hook({ plan, projection: [] } as unknown as DraftTickRead);
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(asyncCalls.sort(), ["a:anywhere", "a:landed"], "every anchor is answered by the async grep at main's sha");
  assert.deepEqual(syncCalls, [], "no anchor reaches the sync grep on the daemon loop");
  assert.ok(ticks >= 2, `the loop kept serving timers (${ticks} ticks) while the anchor greps ran`);
});

test("a timed out anchor grep in the draft hook leaves the proposal draftable without a sync retry", async () => {
  const { config, plan } = hookFixture();
  const syncCalls: string[] = [];
  const drafted: string[] = [];
  const hook = buildInboxDraftHook(
    "o", "r", config, "RUN-ANCHOR-TIMEOUT", () => {},
    async (due) => { drafted.push(...due.map((p) => p.id)); return due.map((p) => ({ proposalId: p.id, ok: false as const, error: "x" })); },
    (_ref, anchor) => { syncCalls.push(anchor.description); return true; },
    () => "b".repeat(40),
    undefined,
    async (_ref, anchor) => { throw new Error(`git grep for evidence anchor "${anchor.description}" exceeded its 1ms bound`); },
  );
  type DraftTickRead = NonNullable<Parameters<typeof hook>[0]>;
  await hook({ plan, projection: [] } as unknown as DraftTickRead);
  assert.deepEqual(syncCalls, [], "the timed-out grep is not re-run synchronously");
  assert.deepEqual(drafted, ["P-ANCHOR"], "an anchor that cannot be checked keeps the proposal draftable, as before");
});

test("the draft hook warms through an injected sync grep when no async grep is given", async () => {
  const { config, plan } = hookFixture();
  const syncCalls: string[] = [];
  const hook = buildInboxDraftHook(
    "o", "r", config, "RUN-ANCHOR-SYNC-SEAM", () => {},
    async (due) => due.map((p) => ({ proposalId: p.id, ok: false as const, error: "x" })),
    (_ref, anchor) => { syncCalls.push(anchor.description); return true; },
    () => "c".repeat(40),
  );
  type DraftTickRead = NonNullable<Parameters<typeof hook>[0]>;
  await hook({ plan, projection: [] } as unknown as DraftTickRead);
  assert.deepEqual(syncCalls.sort(), ["anywhere", "landed"], "each anchor answered once, through the injected seam");
});
