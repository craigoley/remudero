import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { resolveLedgerUnion } from "../src/lib/ledger-grep.js";
import { ledgerGrepCommand } from "../src/run-task.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

// ── resolveLedgerUnion: the pure core ───────────────────────────────────────────────────────

test("unions the gzipped archives and the live ledger, deduplicated, for a pattern in both", () => {
  const dir = tmpStateDir("rmd-ledger-grep-union-");
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}',
      '{"ts":"2026-07-01T00:00:01.000Z","step":"pr.opened","task":"W1-T2"}',
    ]);
    // A second archive repeats the FIRST archive's run.start line verbatim — rotations are
    // cumulative snapshots (emissions.ts's own doc), so a naive union double-counts identical
    // lines unless dedup is by exact line text.
    writeGzArchive(dir, "ledger.2026-07-02T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}',
      '{"ts":"2026-07-02T00:00:02.000Z","step":"run.start","task":"W1-T3"}',
    ]);
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T4"}\n',
    );

    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, true, "archives were present, so the run must succeed");
    assert.equal(result.archiveCount, 2);
    assert.equal(result.liveFileRead, true);
    // Three DISTINCT run.start lines (W1-T1, W1-T3 from the archives, W1-T4 from the live file);
    // the repeated W1-T1 line counts once.
    assert.equal(result.matches.length, 3, `expected 3 deduplicated matches, got: ${JSON.stringify(result.matches)}`);
    assert.ok(result.matches.some((l) => l.includes("W1-T1")));
    assert.ok(result.matches.some((l) => l.includes("W1-T3")));
    assert.ok(result.matches.some((l) => l.includes("W1-T4")));
    // pr.opened never matched the pattern and must not leak into the result.
    assert.ok(!result.matches.some((l) => l.includes("pr.opened")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a state root with a live ledger but NO archives is a verdict failure, not a live-only answer", () => {
  const dir = tmpStateDir("rmd-ledger-grep-noarchive-");
  try {
    // The exact silent-failure shape this module exists to kill: a plausible, matching live file
    // and zero archives.
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T4"}\n',
    );
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, false);
    assert.equal(result.archiveCount, 0);
    assert.deepEqual(result.matches, [], "must never answer from the live file alone when no archive was read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable/absent state dir reads as zero archives, never a throw", () => {
  const result = resolveLedgerUnion(join(tmpdir(), "rmd-ledger-grep-does-not-exist"), "anything");
  assert.equal(result.ok, false);
  assert.equal(result.archiveCount, 0);
});

test("a corrupt archive is skipped, not a crash, and the archive count still reflects it was found", () => {
  const dir = tmpStateDir("rmd-ledger-grep-corrupt-");
  try {
    // Not actually gzip — gunzipSync throws.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), "not gzip data");
    writeFileSync(join(dir, "ledger.ndjson"), '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start"}\n');
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, true, "one archive FILE was found (and counted), even though it failed to decompress");
    assert.equal(result.archiveCount, 1);
    assert.equal(result.matches.length, 1, "the live file's match still comes through");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ledgerGrepCommand: the CLI shell ────────────────────────────────────────────────────────

test("ledgerGrepCommand refuses a missing pattern and an unknown flag, spawning nothing", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(ledgerGrepCommand([]), 2);
    assert.equal(ledgerGrepCommand(["pattern", "--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

test("FALSIFIER: zero archives exits non-zero and prints no result line — the mirror of the positive case below", () => {
  const dir = tmpStateDir("rmd-ledger-grep-cli-noarchive-");
  const logs: string[] = [];
  const errs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  try {
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T4"}\n',
    );
    const code = ledgerGrepCommand(["run\\.start"], { stateDir: dir });
    assert.equal(code, 1, "must exit non-zero when it read zero archives");
    const out = logs.join("\n");
    // Positively assert the ABSENCE of a result line — not merely that the exit code is non-zero.
    assert.doesNotMatch(out, /^matches:/m, "must print nothing that could be mistaken for a count");
    assert.doesNotMatch(out, /W1-T4/, "must never leak a live-file-only match into output");
    assert.match(errs.join("\n"), /ZERO archive files matched/);
  } finally {
    console.log = realLog;
    console.error = realErr;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mirror case: archives present reports the archive count and the deduplicated matches", () => {
  const dir = tmpStateDir("rmd-ledger-grep-cli-archives-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}',
    ]);
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T4"}\n',
    );
    const code = ledgerGrepCommand(["run\\.start"], { stateDir: dir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /^archives:\s+1 matched$/m);
    assert.match(out, /^matches:\s+2$/m);
    assert.match(out, /W1-T1/);
    assert.match(out, /W1-T4/);
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
