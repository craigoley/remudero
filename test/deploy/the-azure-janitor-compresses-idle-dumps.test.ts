/**
 * Dump housekeeping on the Azure host (operator 2026-10-23, the Mac rule): outside any repository an
 * idle, unopened JSON/log dump of at least dump_min_mb is gzipped beside itself after a full read-back;
 * elsewhere than the resumable roots a dump unchanged for dump_retain_days is deleted; a resumable root
 * (Codex sessions) is compressed to `.zst`, the form Codex resumes, and nothing in it is ever deleted. Runs the REAL deploy/rmd-host-cleanup.sh on the host
 * layout rebuilt under a fixture root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

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
  dump(old, 6 * MB);
  const repo = cloneAt(fx, join(root, "creditq-x6LSzP"));
  const inRepo = join(repo, "coverage-run.lcov");
  dump(inRepo, 6 * MB);
  age(unit, 13);
  age(repo, 13);
  ageDays(old, 20);
  age(fresh, 1);
  const mtime = statSync(big).mtimeMs;
  writeFileSync(fx.lsofList, `${open}\n`);

  const r = run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: root, RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const compressed = r.stdout.split("\n").filter(l => /^PRUNE .*compressed beside itself/.test(l));
  assert.equal(compressed.length, 1, `exactly the one idle dump is compressed:\n${r.stdout}`);
  assert.equal(existsSync(big), false, r.stdout);
  assert.deepEqual(gunzipSync(readFileSync(`${big}.gz`)), body, "the compressed copy reads back byte for byte");
  assert.equal(Math.round(statSync(`${big}.gz`).mtimeMs / 1000), Math.round(mtime / 1000), "its modification time is kept");
  assert.equal(existsSync(old), false, `a dump unchanged 14 days expires:\n${r.stdout}`);
  for (const kept of [fresh, open, inRepo]) assert.equal(existsSync(kept), true, `${kept}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`KEEP ${open}: held open by a process`));
  assert.match(r.stdout, new RegExp(`reclaim-total dumps-gzip ${root}: reclaimed [1-9]\\d* MB`));
});

test("Codex sessions are compressed to the resumable .jsonl.zst once idle and never deleted, however old", () => {
  const fx = phaseFixture();
  // Real Zstandard frames without requiring the reviewer's image to carry the host CLI.
  writeFileSync(join(fx.root, "zstd"), `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { zstdCompressSync, zstdDecompressSync } = require("node:zlib");
const args = process.argv.slice(2);
const files = args.filter(a => !["-q", "-3", "-c", "-dc", "--"].includes(a));
if (files.length !== 1 || (!args.includes("-c") && !args.includes("-dc"))) process.exit(64);
const input = readFileSync(files[0]);
process.stdout.write(args.includes("-dc") ? zstdDecompressSync(input) : zstdCompressSync(input));
`, { mode: 0o755 });
  const env = { ...fx.env, PATH: `${fx.root}:${process.env.PATH ?? ""}`, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "" };
  const sessions = join(fx.state, "agent-codex", "sessions", "2026", "09", "28");
  const bigOld = join(sessions, "rollout-2026-09-28T10-00-00-aaaa.jsonl");
  const body = dump(bigOld, 6 * MB);
  const smallOld = join(sessions, "rollout-2026-09-28T11-00-00-bbbb.jsonl");
  dump(smallOld, 2048);
  const recent = join(sessions, "rollout-2026-10-23T09-00-00-cccc.jsonl");
  dump(recent, 6 * MB);
  ageDays(join(fx.state, "agent-codex"), 25);
  age(recent, 2);
  const mtime = statSync(bigOld).mtimeMs;

  // the default resumable root on the host layout is <state disk>/agent-codex/sessions
  const r = run(fx, env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const packed = `${bigOld}.zst`;
  assert.equal(existsSync(packed), true, r.stdout);
  assert.deepEqual(readFileSync(packed).subarray(0, 4), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), "a standard Zstandard frame");
  assert.equal(existsSync(bigOld), false, r.stdout);
  assert.equal(existsSync(`${bigOld}.gz`), false, "a resumable root is never gzipped: Codex cannot resume .jsonl.gz");
  assert.match(packed, /rollout-[^/]+\.jsonl\.zst$/, "the name Codex resumes");
  assert.deepEqual(execFileSync("zstd", ["-q", "-dc", packed], { maxBuffer: 64 * MB, env: { ...process.env, ...env } }), body, "the .zst reads back byte for byte");
  assert.deepEqual(zstdDecompressSync(readFileSync(packed)), body, "the .zst reads back byte for byte");
  assert.equal(Math.round(statSync(packed).mtimeMs / 1000), Math.round(mtime / 1000), "its modification time is kept");
  assert.equal(existsSync(smallOld), true, `a resumable root never deletes a session:\n${r.stdout}`);
  assert.equal(existsSync(recent), true, "a session written within six hours is left as it is");
  assert.doesNotMatch(r.stdout, /REMOVE .*agent-codex/);
  assert.match(r.stdout, new RegExp(`reclaim-total dumps-zstd ${fx.state}/agent-codex/sessions: reclaimed`));

  ageDays(packed, 100);
  const again = run(fx, env);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(zstdDecompressSync(readFileSync(packed)), body, "an old compressed session remains resumable on later passes");
  assert.equal(existsSync(smallOld), true, "later passes also retain old uncompressed sessions");
});

test("a dump whose compressed copy does not read back byte for byte is kept, and no partial copy is left", () => {
  const fx = phaseFixture();
  const root = join(fx.root, "dump-root");
  const big = join(root, "unit", "native.json");
  const body = dump(big, 6 * 1024 * 1024);
  age(join(root, "unit"), 13);
  // a gzip that truncates what it writes (a full disk, a flaky device) but decompresses honestly
  const bin = join(fx.root, "bad-gzip-bin");
  mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v gzip"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "gzip"), `#!/usr/bin/env bash\ncase " $* " in *" -dc "*|*" -t "*) exec '${real}' "$@" ;; esac\n'${real}' "$@" | head -c 4096\n`, { mode: 0o755 });

  const r = run(fx, { ...fx.env, PATH: `${bin}:${process.env.PATH}`, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: root, RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${big}: compression read-back failed`));
  assert.deepEqual(readFileSync(big), body, "the original is untouched");
  assert.equal(existsSync(`${big}.gz`) || existsSync(`${big}.gz.incoming`), false, r.stdout);
});

test("a small file is never a dump: a 1 KB .json unchanged 14 days stays, and only a compressed copy the janitor wrote expires", () => {
  const fx = phaseFixture();
  const root = join(fx.root, "dump-root");
  const big = join(root, "unit", "native.json");
  dump(big, 6 * MB);
  const small = join(root, "unit", "boolean.json");
  dump(small, 1024);
  const foreignGz = join(root, "unit", "fixture.json.gz");
  dump(foreignGz, 100);
  age(join(root, "unit"), 13);
  const env = { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: root, RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "" };
  const first = run(fx, env);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(existsSync(`${big}.gz`), true, first.stdout);

  for (const f of [`${big}.gz`, small, foreignGz]) ageDays(f, 20);
  const second = run(fx, env);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(existsSync(`${big}.gz`), false, `the janitor's own compressed copy expires:\n${second.stdout}`);
  assert.equal(existsSync(small), true, "a 1 KB .json is not a dump, however old");
  assert.equal(existsSync(foreignGz), true, "a .gz the janitor did not write never expires");
});

test("installed package and toolchain trees are never touched: lib/python3.12/test data, a venv, a prefix install", () => {
  const fx = phaseFixture();
  const root = join(fx.root, "dump-root");
  const unit = join(root, "operator-stuck-pr-private-20261020T2215Z");
  const stdlibData = join(unit, "certifi-25-toolchain", "lib", "python3.12", "test", "test_tomllib", "data", "valid", "big.json");
  const stdlibSmall = join(unit, "certifi-25-toolchain", "lib", "python3.12", "test", "test_tomllib", "data", "valid", "boolean.json");
  const prefixLog = join(unit, "certifi-25-toolchain", "install.log");
  const venv = join(unit, "tools-venv");
  const venvData = join(venv, "share", "data.json");
  const distInfo = join(unit, "vendored", "pkg-1.0.dist-info", "RECORD.json");
  for (const f of [stdlibData, prefixLog, venvData, distInfo]) dump(f, 6 * MB);
  dump(stdlibSmall, 1024);
  writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  age(unit, 13);
  for (const f of [stdlibData, stdlibSmall, prefixLog, venvData, distInfo]) ageDays(f, 20);

  const r = run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: root, RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of [stdlibData, stdlibSmall, prefixLog, venvData, distInfo]) {
    assert.equal(existsSync(f), true, `${f}\n${r.stdout}`);
    assert.equal(existsSync(`${f}.gz`), false, `${f} is never compressed`);
  }
});
