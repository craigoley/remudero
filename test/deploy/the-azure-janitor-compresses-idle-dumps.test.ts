/**
 * Dump housekeeping on the Azure host (operator 2026-10-23, the Mac rule): outside any repository an
 * idle, unopened JSON/log dump of at least dump_min_mb is gzipped beside itself after a full read-back;
 * elsewhere than the gzip-only roots a dump unchanged for dump_retain_days is deleted; in a gzip-only
 * root (Codex sessions) nothing is ever deleted. Runs the REAL deploy/rmd-host-cleanup.sh on the host
 * layout rebuilt under a fixture root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { age, run } from "#test/helpers/host-cleanup-fixture.js";
import { ageDays, cloneAt, phaseFixture } from "#test/helpers/host-cleanup-phases.js";

const MB = 1024 * 1024;

function dump(path: string, bytes: number): Buffer {
  mkdirSync(join(path, ".."), { recursive: true });
  const body = Buffer.from(`{"line":"${"x".repeat(80)}"}\n`.repeat(Math.ceil(bytes / 92))).subarray(0, bytes);
  writeFileSync(path, body);
  return body;
}

test("outside any repository an idle dump is gzipped beside itself, an old one expires, and fresh, open or in-repo dumps stay", () => {
  const fx = phaseFixture();
  const root = join(fx.root, "dump-root");
  const unit = join(root, "rmd-smart-validation-v8.1kyYot");
  const big = join(unit, "results", "native.json");
  const body = dump(big, 6 * MB);
  const fresh = join(unit, "results", "live.log");
  dump(fresh, 6 * MB);
  const open = join(unit, "results", "held.ndjson");
  dump(open, 6 * MB);
  const old = join(unit, "old-run.log");
  dump(old, 1024);
  const oldGz = join(unit, "older.json.gz");
  dump(oldGz, 100);
  const repo = cloneAt(fx, join(root, "creditq-x6LSzP"));
  const inRepo = join(repo, "coverage-run.lcov");
  dump(inRepo, 6 * MB);
  age(unit, 13);
  age(repo, 13);
  ageDays(old, 20);
  ageDays(oldGz, 20);
  age(fresh, 1);
  const mtime = statSync(big).mtimeMs;
  writeFileSync(fx.lsofList, `${open}\n`);

  const r = run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: root, RMD_CLEANUP_DUMP_GZIP_ONLY_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const compressed = r.stdout.split("\n").filter(l => /^PRUNE .*compressed beside itself/.test(l));
  assert.equal(compressed.length, 1, `exactly the one idle dump is compressed:\n${r.stdout}`);
  assert.equal(existsSync(big), false, r.stdout);
  assert.deepEqual(gunzipSync(readFileSync(`${big}.gz`)), body, "the compressed copy reads back byte for byte");
  assert.equal(Math.round(statSync(`${big}.gz`).mtimeMs / 1000), Math.round(mtime / 1000), "its modification time is kept");
  assert.equal(existsSync(old), false, `a dump unchanged 14 days expires:\n${r.stdout}`);
  assert.equal(existsSync(oldGz), false, "so does a compressed one");
  for (const kept of [fresh, open, inRepo]) assert.equal(existsSync(kept), true, `${kept}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`KEEP ${open}: held open by a process`));
  assert.match(r.stdout, new RegExp(`reclaim-total dumps-gzip ${root}: reclaimed [1-9]\\d* MB`));
});

test("Codex sessions are gzipped once idle and never deleted, however old", () => {
  const fx = phaseFixture();
  const sessions = join(fx.state, "agent-codex", "sessions", "2026", "09", "28");
  const bigOld = join(sessions, "rollout-2026-09-28T10-00-00-aaaa.jsonl");
  dump(bigOld, 6 * MB);
  const smallOld = join(sessions, "rollout-2026-09-28T11-00-00-bbbb.jsonl");
  dump(smallOld, 2048);
  const recent = join(sessions, "rollout-2026-10-23T09-00-00-cccc.jsonl");
  dump(recent, 6 * MB);
  ageDays(join(fx.state, "agent-codex"), 25);
  age(recent, 2);

  // the default gzip-only root on the host layout is <state disk>/agent-codex/sessions
  const r = run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(`${bigOld}.gz`), true, r.stdout);
  assert.equal(existsSync(bigOld), false, r.stdout);
  assert.equal(existsSync(smallOld), true, `a gzip-only root never deletes a session:\n${r.stdout}`);
  assert.equal(existsSync(recent), true, "a session written within six hours is left for Codex to resume");
  assert.doesNotMatch(r.stdout, /REMOVE .*agent-codex/);
});
