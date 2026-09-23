/**
 * W1-T4118: the inbox draft cache is collected. On 2026-09-23, 482 of 728 cached drafts (8.5 MB) belonged to
 * proposals no longer in the registry, and every inbox read parsed them. The draft rung now drops those drafts
 * once per pass, under the registry's own lock, and ledgers what it removed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { pruneOrphanedDrafts, type DraftedCandidate } from "../src/lib/inbox.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildInboxDraftHook } from "../src/run-task.js";

const cand = (id: string): DraftedCandidate => ({ proposalId: id, fragmentYaml: `- id: ${id}\n`, stampLine: "stamp", anchorFingerprint: "" });

function seed(liveIds: string[], draftIds: string[]): { root: string; registryPath: string; draftsPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4118-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const registryPath = join(root, "state", "inbox-proposals.json");
  const draftsPath = join(root, "state", "inbox-drafts.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: liveIds.map((id) => ({ id, summary: "s", evidenceAnchors: [] })) }));
  writeFileSync(draftsPath, JSON.stringify(Object.fromEntries(draftIds.map((id) => [id, cand(id)])), null, 2));
  return { root, registryPath, draftsPath };
}

const cached = (draftsPath: string) => Object.keys(JSON.parse(readFileSync(draftsPath, "utf8")) as Record<string, unknown>).sort();

test("W1-T4118: a draft whose proposal left the registry is collected", async () => {
  const { root, draftsPath } = seed(["LIVE"], ["LIVE", "GONE-1", "GONE-2"]);
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  // The real draft rung, with a batch that drafts nothing: the collection is the rung's own pass.
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", (step, extra = {}) => void logs.push({ step, extra }), async () => []);
  await hook();
  assert.deepEqual(cached(draftsPath), ["LIVE"], "the drafts whose proposals left the registry are gone");
  const row = logs.find((l) => l.step === "inbox.drafts_pruned");
  assert.equal(row?.extra.count, 2);
  assert.ok((row?.extra.bytes_before as number) > (row?.extra.bytes_after as number), "the cache got smaller");
  // Nothing orphaned on the next pass: nothing is written and nothing is ledgered.
  logs.length = 0;
  await hook();
  assert.equal(logs.filter((l) => l.step === "inbox.drafts_pruned").length, 0);
});

test("W1-T4118: a draft for a live proposal is kept", () => {
  const { registryPath, draftsPath } = seed(["A", "B"], ["A", "B"]);
  const before = readFileSync(draftsPath, "utf8");
  assert.deepEqual(pruneOrphanedDrafts(draftsPath, registryPath), { count: 0, bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(before) });
  assert.equal(readFileSync(draftsPath, "utf8"), before, "an untouched cache is not rewritten");
  // A proposal kept only as its own shard file is live too: the registry the lock guards is blob plus shards.
  const shard = seed(["A"], ["A", "SHARDED"]);
  mkdirSync(join(shard.root, "state", "inbox-proposals.d"), { recursive: true });
  writeFileSync(join(shard.root, "state", "inbox-proposals.d", "SHARDED.json"), JSON.stringify({ id: "SHARDED", summary: "s", evidenceAnchors: [] }));
  pruneOrphanedDrafts(shard.draftsPath, shard.registryPath);
  assert.deepEqual(cached(shard.draftsPath), ["A", "SHARDED"]);
});

test("W1-T4118: a registry that cannot be read collects nothing", () => {
  // Read as empty, an unreadable registry would make every draft look orphaned.
  const { registryPath, draftsPath } = seed(["A"], ["A", "B"]);
  writeFileSync(registryPath, "{ torn");
  assert.equal(pruneOrphanedDrafts(draftsPath, registryPath), undefined);
  assert.deepEqual(cached(draftsPath), ["A", "B"]);
  const missing = seed(["A"], ["A"]);
  assert.equal(pruneOrphanedDrafts(missing.draftsPath, join(missing.root, "state", "absent.json")), undefined);
  assert.equal(pruneOrphanedDrafts(join(missing.root, "state", "no-drafts.json"), missing.registryPath), undefined);
  assert.equal(existsSync(join(missing.root, "state", "no-drafts.json")), false);
});
