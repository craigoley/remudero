/**
 * test/report-commands.test.ts — W1-T2888: the report verbs moved out of `src/run-task.ts` into
 * `src/lib/report-commands.ts` (decomposition step 5).
 *
 * Each test below imports its verb from the LIB MODULE directly (never `../src/run-task.js`) and
 * runs it over a FIXED, injected state (a synthetic ledger, a tmp state dir, a fake HOME) —
 * asserting the exit code and stdout the pre-move `run-task.ts` version of the same function
 * produced for the identical input, since the move is a byte-identical relocation (same
 * discipline `lib/cli-args.ts`'s `unknownArgError`/`flagValue` moves used). `run-task.ts` itself
 * still re-exports every one of these names, so the many pre-existing per-domain test files
 * (test/receipt.test.ts, test/ledger-replay.test.ts, test/ledger-grep.test.ts, test/doctor.test.ts,
 * test/rate-limit-bucket-surface.test.ts, test/learnings-commons.test.ts, etc.) keep exercising
 * the identical functions unchanged — this file's job is narrower: prove the LIB import path
 * itself works end to end for every moved verb, which is what a `lib -> run-task` regression
 * would break first.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  receiptCommand,
  replayCommand,
  ledgerGrepCommand,
  digestPlistCommand,
  doctorCommand,
  statusCommand,
  digestCommand,
  learningsCommand,
  learningsExportCommand,
  learningsImportCommand,
  traceCommand,
  LAUNCHCTL_PID_RE,
  LAUNCHCTL_LIST_LINE_RE,
} from "../src/lib/report-commands.js";
import type { RestPullRow } from "../src/lib/open-prs-rest.js";
import type { Config } from "../src/lib/config.js";

// W1-T2775: every mkdtempSync prefix here starts with `RMD_TMP_PREFIX` ("rmd-") so the boot
// sweep (src/lib/tmp.ts's sweepStaleTempDirs) can reap a dir this run leaves behind.
function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}`));
}

function fakeConfig(root: string): Config {
  return { claudeBin: "/bin/true", root } as Config;
}

/** Points `$HOME` at a synthetic `~/.config/remudero/config.json` for the duration of `fn` —
 *  the seam `learningsImportCommand`/`digestCommand` read `loadConfig()` through (neither takes
 *  an injectable config), same helper shape test/learnings-commons.test.ts's own
 *  `setupHome`/`withHome` use. */
function withFakeHome<T>(root: string, fn: () => T): T {
  const home = tmpDir("report-commands-home-");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = oldHome;
  }
}

// ── receiptCommand ───────────────────────────────────────────────────────────────────────────

test("receiptCommand: refuses (exit 1) when the PR body carries no Remudero-Task trailer", async () => {
  const raw: RestPullRow = { number: 9001, html_url: "https://github.com/craigoley/remudero/pull/9001", updated_at: "2026-01-01T00:00:00Z", body: "no trailer here" };
  const rc = await receiptCommand("https://github.com/craigoley/remudero/pull/9001", [], { gh: () => raw });
  assert.equal(rc, 1);
});

test("receiptCommand: a resolvable trailer + a fixed ledger prints a deterministic JSON receipt (exit 0)", async () => {
  const taskId = "W1-T71";
  const prUrl = "https://github.com/craigoley/remudero/pull/9001";
  const raw: RestPullRow = {
    number: 9001,
    html_url: prUrl,
    updated_at: "2026-01-01T00:00:00Z",
    body: `Remudero-Task: ${taskId}\n`,
    head: { ref: `run-${taskId}-1755000000000`, sha: "deadbeef" },
  };
  const lines = [
    { run_id: `${taskId}-1755000000000`, task_id: taskId, step: "run.start" },
    { run_id: `${taskId}-1755000000000`, task_id: taskId, step: "pr.opened", pr_url: prUrl },
  ];
  const printed: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => printed.push(s);
  let rc: number;
  try {
    rc = await receiptCommand(prUrl, [], {
      gh: () => raw,
      config: fakeConfig("/nonexistent/root/for/tests"),
      resolveReceiptLedgerLines: () => ({ ok: true, lines }),
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0);
  assert.equal(printed.length, 1);
  const receipt = JSON.parse(printed[0]);
  assert.equal(receipt.subject.task_id, taskId);
  assert.equal(receipt.subject.pr_url, prUrl);
});

// ── replayCommand ────────────────────────────────────────────────────────────────────────────

test("replayCommand: a refused ledger union (ok:false) exits 1, never narrating a partial corpus", () => {
  const rc = replayCommand("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", [], {
    resolveReplayLedgerLines: () => ({ ok: false, reason: "ZERO archives" }),
  });
  assert.equal(rc, 1);
});

test("replayCommand: a fixed in-window ledger narrates the window's rows deterministically (exit 0)", () => {
  const lines = [
    { ts: "2026-01-01T05:00:00.000Z", task_id: "W1-T71", step: "run.start" },
    { ts: "2026-01-03T00:00:00.000Z", task_id: "W1-T71", step: "run.outside_window" },
  ];
  const printed: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => printed.push(s);
  let rc: number;
  try {
    rc = replayCommand("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", [], {
      resolveReplayLedgerLines: () => ({ ok: true, lines }),
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /run\.start/);
  assert.doesNotMatch(printed[0], /run\.outside_window/);
});

// ── ledgerGrepCommand ────────────────────────────────────────────────────────────────────────

test("ledgerGrepCommand: unions a gzipped archive and the live ledger for a fixed state dir (exit 0)", () => {
  const dir = tmpDir("report-commands-ledger-grep-");
  writeFileSync(
    join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"),
    gzipSync(Buffer.from('{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}\n', "utf8")),
  );
  writeFileSync(join(dir, "ledger.ndjson"), '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T2"}\n');
  const printed: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => printed.push(s);
  let rc: number;
  try {
    rc = ledgerGrepCommand(["run\\.start"], { stateDir: dir });
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0);
  const out = printed.join("\n");
  assert.match(out, /archives:   1 matched/);
  assert.match(out, /matches:    2/);
});

// ── digestPlistCommand ───────────────────────────────────────────────────────────────────────

test("digestPlistCommand: print mode (no --write) prints the plist text and the commissioning note, writing nothing (exit 0)", async () => {
  const root = tmpDir("report-commands-digest-plist-root-");
  mkdirSync(join(root, "daemon-install", "bin"), { recursive: true });
  const printed: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => printed.push(s);
  let rc: number;
  try {
    rc = await withFakeHome(root, () => digestPlistCommand([]));
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0);
  const out = printed.join("\n");
  assert.match(out, /com\.remudero\.digest/);
  assert.match(out, /launchctl load/);
});

// ── doctorCommand ────────────────────────────────────────────────────────────────────────────

test("doctorCommand: every reader injected over a fixed, empty state prints a full report deterministically", async () => {
  const printed: string[] = [];
  const nowMs = Date.parse("2026-08-20T12:00:00Z");
  const rc = await doctorCommand([], {
    out: (l) => printed.push(l),
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    nowMs,
    readLedgerLines: () => [],
    loadPlan: () => undefined,
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readMemInfo: () => ({}),
    readDiskFreeBytes: () => undefined,
    readDiskTotalBytes: () => undefined,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => undefined,
    readNvmrcVersion: () => undefined,
  });
  assert.equal(typeof rc, "number");
  assert.equal(printed.length, 1);
  assert.match(printed[0], /rmd doctor|WORST|OK|WARN|FAIL/i);
});

// ── statusCommand's own launchd-query regexes — negative-reachability-ratchet.test.ts's census
// counts every module-scope `NAME_RE` regex as fixture-less until a test drives BOTH its
// rejecting and its accepting arm by identifier; these two moved here with statusCommand's
// default `queryService` and are exported (report-commands.ts's own doc note) solely so this
// file can do exactly that.

test("LAUNCHCTL_PID_RE: matches launchctl print's quoted-or-bare pid line, rejects a line with none", () => {
  assert.equal(LAUNCHCTL_PID_RE.test('\t"pid" = 61234;'), true);
  assert.equal(LAUNCHCTL_PID_RE.test("\tpid = 61234;"), true);
  assert.equal(LAUNCHCTL_PID_RE.test('\t"state" = "running";'), false);
});

test("LAUNCHCTL_LIST_LINE_RE: matches launchctl list's PID/Status/Label line, rejects an unrelated line", () => {
  assert.equal(LAUNCHCTL_LIST_LINE_RE.test("1234\t0\tcom.remudero.supervisor"), true);
  assert.equal(LAUNCHCTL_LIST_LINE_RE.test("-\t0\tcom.remudero.supervisor"), true);
  assert.equal(LAUNCHCTL_LIST_LINE_RE.test("not a launchctl list line at all"), false);
});

// ── statusCommand — invoked through the lib module, per this task's own acceptance claim ───────

test("statusCommand: text mode renders HEADROOM beside GITHUB BUCKETS over a fixed, injected state (exit 0)", async () => {
  const printed: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => "/nonexistent/ledger/for/tests.ndjson",
    repoRoot: "/nonexistent/repo/for/tests",
    readLedgerLines: () => [],
    out: (l) => printed.push(l),
  });
  assert.equal(rc, 0);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /HEADROOM/);
  assert.match(printed[0], /GITHUB BUCKETS/);
});

test("statusCommand: an unknown flag refuses (exit 2) before any reader runs", async () => {
  const errors: string[] = [];
  const rc = await statusCommand(["--bogus"], { err: (l) => errors.push(l), usage: "USAGE-STUB" });
  assert.equal(rc, 2);
  assert.match(errors.join("\n"), /USAGE-STUB/);
});

// ── digestCommand ────────────────────────────────────────────────────────────────────────────

test("digestCommand: --dry-run with an explicit --since prints the digest text without sending or touching the marker (exit 0)", async () => {
  const root = tmpDir("report-commands-digest-root-");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const printed: string[] = [];
  const origLog = console.log;
  console.log = (s: string) => printed.push(s);
  let rc: number;
  try {
    rc = await withFakeHome(root, () => digestCommand(["--since", "2026-01-01T00:00:00.000Z", "--dry-run"]));
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0);
  assert.equal(printed.length, 1);
});

// ── learningsCommand / learningsExportCommand / learningsImportCommand ─────────────────────────

test("learningsCommand: an unrecognized subcommand refuses (exit 2), spawning/writing nothing", () => {
  assert.equal(learningsCommand(["frobnicate"]), 2);
});

test("learningsExportCommand -> learningsImportCommand: a share:public entry round-trips export -> pin-verified import (exit 0 both ways)", () => {
  const projectDir = tmpDir("report-commands-learnings-project-");
  writeFileSync(
    join(projectDir, "shard.yaml"),
    JSON.stringify([{ id: "report-commands-shared", subsystem: "knowledge", lifecycle: "active", files: ["src/lib/learnings.ts"], fact: "one shared fact.", src: "W1-T2888", share: "public" }]),
  );
  const outDir = tmpDir("report-commands-learnings-out-");
  const out = join(outDir, "bundle.yaml");
  const exportRc = learningsExportCommand([out], { projectDir });
  assert.equal(exportRc, 0);
  const bundleText = readFileSync(out, "utf8");
  const hashLine = bundleText.match(/^hash:\s*(\S+)/m);
  assert.ok(hashLine, "exported bundle must carry a hash: line");
  const pin = hashLine![1];

  const root = tmpDir("report-commands-learnings-root-");
  const importRc = withFakeHome(root, () => learningsImportCommand([out, "--pin", pin]));
  assert.equal(importRc, 0);
  const written = readFileSync(join(root, "learnings-global", "artifact.yaml"), "utf8");
  assert.equal(written, bundleText);
});

test("learningsImportCommand: a pin mismatch refuses (exit 1), writing nothing to the global home", () => {
  const projectDir = tmpDir("report-commands-learnings-project-2-");
  writeFileSync(
    join(projectDir, "shard.yaml"),
    JSON.stringify([{ id: "report-commands-shared-2", subsystem: "knowledge", lifecycle: "active", files: ["src/lib/learnings.ts"], fact: "another shared fact.", src: "W1-T2888", share: "public" }]),
  );
  const outDir = tmpDir("report-commands-learnings-out-2-");
  const out = join(outDir, "bundle.yaml");
  assert.equal(learningsExportCommand([out], { projectDir }), 0);

  const root = tmpDir("report-commands-learnings-root-2-");
  const importRc = withFakeHome(root, () => learningsImportCommand([out, "--pin", "0".repeat(64)]));
  assert.equal(importRc, 1);
  assert.throws(() => readFileSync(join(root, "learnings-global", "artifact.yaml"), "utf8"));
});

// ── traceCommand ─────────────────────────────────────────────────────────────────────────────

test("traceCommand: no <id> refuses (exit 2), touching no plan/ledger/GitHub read", async () => {
  const rc = await traceCommand([]);
  assert.equal(rc, 2);
});

test("traceCommand: an unrecognized flag refuses (exit 2)", async () => {
  const rc = await traceCommand(["--bogus"]);
  assert.equal(rc, 2);
});
