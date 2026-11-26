/**
 * W1-T14401: the Azure host janitor rotates its own logs. A log over its bound is gzipped to a dated sibling,
 * verified, then truncated in place; only the newest few siblings are kept. A rotation that fails leaves the live
 * log as it was, so the pass's own lines still reach it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { fixture, run } from "#test/helpers/host-cleanup-fixture.js";

const MB = 1048576;

test("W1-T14401 criterion 1: a log over its bound is compressed to a dated sibling and only the newest few are kept", () => {
  const fx = fixture();
  const logs = join(fx.root, "logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, "host-cleanup.log");
  const body = "KEEP /x: reason\n".repeat(Math.ceil((2 * MB) / 16));
  writeFileSync(log, body);
  for (const stamp of ["20261101T000000Z", "20261102T000000Z", "20261103T000000Z"]) writeFileSync(`${log}.${stamp}.gz`, "old\n");
  const r = run(fx, { RMD_CLEANUP_LOG_ROTATE_PATHS: log, RMD_CLEANUP_LOG_MAX_MB: "1", RMD_CLEANUP_LOG_KEEP: "2" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const siblings = readdirSync(logs).filter(n => n.endsWith(".gz")).sort();
  assert.equal(siblings.length, 2, `only the newest two siblings are kept: ${siblings.join(", ")}`);
  const stale = ["20261101T000000Z", "20261102T000000Z", "20261103T000000Z"].map(stamp => `host-cleanup.log.${stamp}.gz`);
  const fresh = siblings.find(n => /^host-cleanup\.log\.\d{8}T\d{6}Z\.gz$/.test(n) && !stale.includes(n));
  assert.deepEqual(siblings.filter(n => stale.includes(n)), ["host-cleanup.log.20261103T000000Z.gz"], "the newest older sibling is kept, the two oldest removed");
  assert.ok(fresh, `a dated sibling was written: ${siblings.join(", ")}`);
  assert.equal(gunzipSync(readFileSync(join(logs, fresh!))).toString(), body, "the sibling holds the whole rotated log");
  assert.ok(statSync(log).size < MB, "the live log was truncated in place");
  assert.match(r.stdout, /^ROTATE .*host-cleanup\.log: \d+ bytes to .*\.gz$/m);
});

test("W1-T14401 criterion 1: a log under its bound, a dry run, and a log another uid owns are left as they are", () => {
  const fx = fixture();
  const log = join(fx.root, "small.log");
  writeFileSync(log, "x\n");
  const big = join(fx.root, "big.log");
  writeFileSync(big, Buffer.alloc(2 * MB, 120));
  const dry = run(fx, { RMD_CLEANUP_LOG_ROTATE_PATHS: `${log}:${big}`, RMD_CLEANUP_LOG_MAX_MB: "1", DRY_RUN: "1" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /DRYRUN would: rotate .*big\.log/);
  assert.equal(statSync(big).size, 2 * MB, "a dry run rotates nothing");
  const other = run(fx, { RMD_CLEANUP_LOG_ROTATE_PATHS: big, RMD_CLEANUP_LOG_MAX_MB: "1", RMD_CLEANUP_UID: "99999" });
  assert.equal(other.status, 0, other.stderr + other.stdout);
  assert.match(other.stdout, /KEEP .*big\.log: log rotation skipped \(owner uid \d+, pass uid 99999\)/);
  assert.equal(statSync(big).size, 2 * MB, "another uid's log is left as it is");
  assert.equal(readFileSync(log, "utf8"), "x\n", "a log under its bound is untouched");
});

test("W1-T14401 criterion 2: a failed rotation still lets the run write its lines to the live log", () => {
  const fx = fixture();
  const logs = join(fx.root, "logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, "host-cleanup.log");
  const body = Buffer.alloc(2 * MB, 120);
  writeFileSync(log, body);
  // A gzip that fails for every uid: the rotation must stop before it truncates the live log.
  const bin = join(fx.root, "failing-gzip");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gzip"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const r = run(fx, { RMD_CLEANUP_LOG_ROTATE_PATHS: log, RMD_CLEANUP_LOG_MAX_MB: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /WARN .*host-cleanup\.log: log rotation failed; the live log is unchanged/);
  assert.equal(statSync(log).size, body.length, "the live log keeps every byte");
  assert.equal(readdirSync(logs).filter(n => n.endsWith(".gz") || n.endsWith(".part")).length, 0, "no partial sibling is left");
  assert.match(r.stdout, /^rmd-host-cleanup: /m, "the pass still ran and wrote its own lines");
  assert.ok(existsSync(log));
});
