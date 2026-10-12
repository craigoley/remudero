import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

const PROOF = "test/the-janitor-summary-never-reads-an-unknown-disk-as-empty.test.ts";

function readings(fx: Fixture, fields: string[]): void {
  const counter = join(fx.root, "df-count");
  const rows = join(fx.root, "df-rows");
  writeFileSync(counter, "0\n");
  writeFileSync(rows, fields.join("\n") + "\n");
  writeFileSync(fx.env.RMD_CLEANUP_DF, [
    "#!/usr/bin/env bash",
    `count="$(cat '${counter}')"; count=$((count + 1)); echo "$count" > '${counter}'`,
    "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    `sed -n "\${count}p" '${rows}'`,
    "",
  ].join("\n"));
}

function row(pct = "50", avail = "2048"): string {
  return `/dev/fake 1000000 1 ${avail} ${pct}% /`;
}

function summary(stdout: string): string | undefined {
  return stdout.split("\n").find(line => line.startsWith("rmd-host-cleanup: / "));
}

test(`${PROOF}: unreadable root readings are unknown and omit reclaimed space`, () => {
  for (const phase of ["before", "after"]) {
    for (const invalid of ["", row("unreadable"), row("50", "unreadable")]) {
      const fx = fixture();
      const good = row();
      readings(fx, phase === "before"
        ? [invalid, invalid, good, good, good]
        : [good, good, invalid, invalid, good]);
      const r = run(fx);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.stderr, "");
      const pct = invalid === row("50", "unreadable") ? "50%" : "unknown";
      assert.equal(summary(r.stdout), phase === "before"
        ? `rmd-host-cleanup: / ${pct} -> 50%`
        : `rmd-host-cleanup: / 50% -> ${pct}`);
      assert.doesNotMatch(summary(r.stdout)!, /reclaimed/);
    }
  }
  const fx = fixture();
  readings(fx, ["", "", "", "", ""]);
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(summary(r.stdout), "rmd-host-cleanup: / unknown -> unknown");
});

test(`${PROOF}: valid readings retain percentages and reclaimed megabytes`, () => {
  const fx = fixture();
  readings(fx, [row("060", "002048"), row("060", "002048"),
    row("050", "004096"), row("050", "004096"), row()]);
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stderr, "");
  assert.equal(summary(r.stdout), "rmd-host-cleanup: / 060% -> 050% (2 MB reclaimed this pass)");
});

test(`${PROOF}: oversized percent and free marks are refused before the pass`, () => {
  const fx = fixture();
  for (const mark of ["18446744073709551701", "123456789012345678901", "0085",
    "85/1234567890123456", "85/1234567890123456G", "85/0000000000000000K"]) {
    const entry = `${fx.rootfs}:${mark}`;
    const r = run(fx, { RMD_CLEANUP_WATCH_FS: entry });
    assert.equal(r.status, 2, `${entry}\n${r.stderr}${r.stdout}`);
    assert.match(r.stderr, /FATAL RMD_CLEANUP_WATCH_FS entry/);
    assert.doesNotMatch(r.stderr, /integer expression|value too great|syntax error/);
    assert.equal(r.stdout, "", "invalid marks must be rejected before cleanup");
  }
});

test(`${PROOF}: three-digit percent and fifteen-digit free marks remain valid`, () => {
  const fx = fixture();
  const r = run(fx, { RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:100/000000000000001K` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /mark 100%\/000000000000001K/);
});
