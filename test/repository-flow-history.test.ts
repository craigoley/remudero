import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { flowHistoryPath, readRepositoryFlowHistory, recordRepositoryFlowHistory, foldRepositoryFlowHistory } from "../src/lib/repository-flow-history.js";
import { realWriteAtomicIo } from "../src/lib/fs-race-safe.js";

test("W1-T8707: retained backlog preserves source samples overlapping reasons and gaps", t => {
  const root = makeTempDir("repository-flow-history");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = "fixture/repo", at = "2026-10-15T12:00:00.000Z";
  const sample = { at, generation: "generation-one", complete: true,
    prs: [{ pr: 1, head: "a".repeat(40), createdAt: "2026-10-14T12:00:00.000Z", reasons: ["awaiting_review", "required_red", "conflict"] }] };
  assert.equal(recordRepositoryFlowHistory(root, repository, { inventories: [sample] }).ok, true);
  const restored = readRepositoryFlowHistory(root, repository);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  const backlog = foldRepositoryFlowHistory(restored.history, "2026-10-16T00:00:00.000Z").backlog;
  const day = backlog.find(b => b.date === "2026-10-15")!;
  assert.equal(day.distinctPrs, 1);
  assert.equal(day.reasons.awaiting_review, 1);
  assert.equal(day.reasons.required_red, 1);
  assert.equal(day.reasons.conflict, 1);
  assert.equal(day.oldestMs, 86400000);
  assert.equal(backlog.at(-1)!.distinctPrs, null);
  const before = readFileSync(flowHistoryPath(root, repository), "utf8");
  const failed = recordRepositoryFlowHistory(root, repository, { inventories: [{ ...sample, at: "2026-10-15T13:00:00.000Z" }] },
    { io: { ...realWriteAtomicIo, renameSync() { throw new Error("interrupted rename"); } } });
  assert.deepEqual(failed, { ok: false, reason: "write_failed" });
  assert.equal(readFileSync(flowHistoryPath(root, repository), "utf8"), before);
  assert.equal(recordRepositoryFlowHistory(root, "another/repo", { inventories: [sample] }).ok, true);
  assert.equal(readRepositoryFlowHistory(root, "another/repo").ok, true);
  assert.equal(recordRepositoryFlowHistory(root, repository, { inventories: [{ ...sample, complete: false, at: "2026-10-15T14:00:00.000Z" }] }).ok, true);
  const reread = readRepositoryFlowHistory(root, repository);
  assert.ok(reread.ok);
  assert.equal(foldRepositoryFlowHistory(reread.history, "2026-10-16T00:00:00.000Z").backlog.at(-2)!.sampledAt, at);
  writeFileSync(flowHistoryPath(root, repository), JSON.stringify({ version: 99 }));
  assert.deepEqual(readRepositoryFlowHistory(root, repository), { ok: false, reason: "invalid_history" });
  mkdirSync(join(root, "empty"));
  assert.deepEqual(readRepositoryFlowHistory(join(root, "empty"), repository), { ok: false, reason: "missing_history" });
});
