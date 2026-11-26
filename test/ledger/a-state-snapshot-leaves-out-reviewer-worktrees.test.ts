/**
 * W1-T13222: the 2026-11-16 nightly core snapshot on the Azure host failed with ENOENT on
 * engines/worktrees/reviewer-14a374e14939/node_modules: a leased reviewer checkout was reaped mid-walk. Those checkouts
 * (1.3 GB) are rebuilt from a revision, so the snapshot leaves engines/worktrees out and never reads it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotState, STATE_BACKUP_EXCLUDED_RELPATHS } from "#src/lib/ledger.js";

const engine = `engines/${"a".repeat(64)}`;
const reviewer = "engines/worktrees/reviewer-14a374e14939";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-reviewer-worktree-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  fs.mkdirSync(join(state, engine), { recursive: true });
  fs.mkdirSync(join(state, reviewer, "src"), { recursive: true });
  fs.writeFileSync(join(state, "ledger.ndjson"), '{"step":"run.start"}\n');
  fs.writeFileSync(join(state, "inbox-proposals.json"), '{"proposals":["P45"]}\n');
  fs.writeFileSync(join(state, engine, "engine.json"), JSON.stringify({ sha: "b".repeat(40), sourceHash: "a".repeat(64), builtAt: 123 }));
  fs.writeFileSync(join(state, engine, "package.json"), '{"name":"engine"}');
  fs.writeFileSync(join(state, reviewer, "src", "a.ts"), "export const a = 1;\n");
  fs.symlinkSync("../../../../missing-install/node_modules", join(state, reviewer, "node_modules"));
  fs.writeFileSync(join(state, "engines", "worktrees-notes.json"), "{}\n");
  return { state, backups: join(root, "backups") };
}

test("W1-T13222 criterion 1: the snapshot holds no reviewer worktree and keeps the ledger, the proposals and the engine tree", (t) => {
  const live = fixture(t);
  const snapshot = snapshotState(live.state, live.backups);
  assert.equal(snapshot.entries.some((rel) => rel.startsWith("engines/worktrees/")), false, snapshot.entries.join(", "));
  assert.equal(fs.existsSync(join(snapshot.archiveDir, "engines", "worktrees")), false);
  for (const rel of ["ledger.ndjson", "inbox-proposals.json", `${engine}/engine.json`]) assert.ok(snapshot.entries.includes(rel), `${rel} is kept`);
});

test("W1-T13222 criterion 2: a reviewer worktree reaped while the snapshot walks still publishes a verified archive", (t) => {
  const live = fixture(t);
  const path = join(live.state, reviewer, "node_modules");
  const original = fs.statSync;
  (fs as any).statSync = (...args: any[]) => {
    if (String(args[0]) === path) fs.rmSync(join(live.state, reviewer), { recursive: true, force: true });
    return Reflect.apply(original, fs, args);
  };
  syncBuiltinESMExports();
  try {
    const snapshot = snapshotState(live.state, live.backups);
    assert.ok(fs.existsSync(snapshot.archiveDir), "the archive was published");
    assert.ok(snapshot.entries.includes("ledger.ndjson"));
  } finally {
    (fs as any).statSync = original;
    syncBuiltinESMExports();
  }
});

test("W1-T13222 criterion 3: only status.json, engines/worktrees and daemon-slots are excluded, and a prefix-sharing sibling is still copied", (t) => {
  assert.deepEqual([...STATE_BACKUP_EXCLUDED_RELPATHS].sort(), ["daemon-slots", "engines/worktrees", "status.json"]);
  const live = fixture(t);
  const snapshot = snapshotState(live.state, live.backups);
  assert.ok(snapshot.entries.includes("engines/worktrees-notes.json"), "a sibling that only shares the prefix is copied");
});
