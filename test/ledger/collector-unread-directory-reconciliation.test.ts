import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { openLedgerUnion } from "#src/lib/ledger-union.js";

test("collector reconciliation retains strict unread-directory evidence and exact dedupe admission", async () => {
  assert.ok(existsSync(join(REPO_ROOT, "src/lib/ledger-exact-dedupe.ts")),
    "this source tree must contain the exact ledger index implementation");
  const { createLedgerExactDedupe } = await import("#src/lib/ledger-exact-dedupe.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-collector-directory-reconciliation-"));
  const index = createLedgerExactDedupe();
  try {
    writeFileSync(join(dir, "ledger.ndjson"), '{"step":"positive"}\n{"step":"positive"}\n');
    const rows: unknown[] = [];
    for await (const row of openLedgerUnion(dir, { exactDedupe: index })) rows.push(row);
    assert.deepEqual(rows, [{ step: "positive" }]);
    assert.equal(index.evidence().accepted, 1);
    assert.equal(index.evidence().replayed, 1);
    const invalid = join(dir, "ledger.ndjson");
    const failures: { path: string; error: unknown }[] = [];
    const onUnreadDirectory = (path: string, error: unknown) => {
      failures.push({ path, error });
      throw error;
    };
    await assert.rejects(async () => {
      for await (const _row of openLedgerUnion(invalid, { exactDedupe: index, onUnreadDirectory })) void _row;
    }, (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, invalid);
    assert.equal((failures[0].error as NodeJS.ErrnoException).code, "ENOTDIR");
    await assert.rejects(async () => {
      for await (const _row of openLedgerUnion(invalid, {
        exactDedupe: index, dedupeWindowPerStep: 1, onUnreadDirectory,
      })) void _row;
    }, /exactDedupe requires whole-corpus dedupe/);
    assert.equal(failures.length, 1, "incompatible dedupe is refused before directory access");
    assert.equal(index.evidence().accepted, 1, "a failed directory read cannot fabricate a distinct row");
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
