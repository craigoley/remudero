/**
 * test/doctor-node-pin.test.ts — R-49 (docs/audits/recon-2026-09-05.md).
 *
 * `.nvmrc`, `package.json#engines` (`>=22.22.3`) and `deploy/Dockerfile` all pin an exact Node
 * version, but `npm ci` only WARNS (EBADENGINE) on a mismatch and lets a stale install through —
 * OBSERVED on this very container: Node 22.22.2 running against a 22.22.3 pin, `npm ci` succeeds.
 * The only thing that actually REFUSES on the drift today is `assertPinnedNodeVersion`
 * (scripts/coverage-merge-ratchet.mjs) throwing deep inside test/merge-lcov.test.ts — a random
 * test failure, nowhere near where an operator could act on it.
 *
 * The operator explicitly ruled against `engine-strict` in `.npmrc` (it would refuse `npm ci` on
 * every machine not on the exact patch version, agent containers included). Both surfaces added
 * here REPORT and CONTINUE, never refuse: `rmd doctor`'s new `node-version-pin` row, and one
 * stderr line from `bin/rmd` before it dispatches.
 *
 * Every test below is pinned against an INJECTED reading (a fake `.nvmrc` reader, or a fake
 * `node` on PATH) rather than this host's own ambient node — the live 22.22.2/22.22.3 mismatch is
 * exactly the CI-parity "self-expiring" shape CLAUDE.md already warns about (the image eventually
 * lands on the pin, and a test that hard-asserts today's drift would then read as broken).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDoctorReport, judgeNodeVersionPin, readNvmrcVersion } from "../src/lib/doctor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── criterion 1/2 — judgeNodeVersionPin against an injected .nvmrc reader ─────────────────────

test("R-49: judgeNodeVersionPin reads OK when the injected .nvmrc reader returns the running version", () => {
  const running = "22.22.3";
  const pinned = readNvmrcVersion("/pkg-root", () => `${running}\n`);
  const check = judgeNodeVersionPin(running, pinned);
  assert.equal(check.verdict, "OK");
  assert.match(check.measured, /22\.22\.3/);
  assert.equal(check.name, "node-version-pin");

  // POSITIVE CONTROL, the pattern every arm in this file requires: a leading `v` and stray
  // whitespace on either side must not manufacture a mismatch — `process.version`-shaped input
  // (`v22.22.3`) against a plain `.nvmrc` reading still reads OK.
  assert.equal(judgeNodeVersionPin("v22.22.3", "22.22.3\n").verdict, "OK");
});

test("R-49: judgeNodeVersionPin reads WARN and names both versions and .nvmrc when the injected reader returns a different version", () => {
  const running = "22.22.2";
  const pinned = readNvmrcVersion("/pkg-root", () => "22.22.3\n");
  const check = judgeNodeVersionPin(running, pinned);
  assert.equal(check.verdict, "WARN", "a drifting node is a WARN, never a FAIL — see the file header on severity tier");
  assert.match(check.measured, /22\.22\.2/, "the running version is named");
  assert.match(check.measured, /22\.22\.3/, "the pinned version is named");
  assert.match(check.measured + check.threshold + (check.detail ?? ""), /\.nvmrc/, ".nvmrc itself is named");
});

test("R-49: an unreadable .nvmrc reads WARN, never OK — a failed read must never render as a match", () => {
  const pinned = readNvmrcVersion("/pkg-root", () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  assert.equal(pinned, undefined, "control: the reader really did degrade to undefined rather than throwing");
  const check = judgeNodeVersionPin("22.22.3", pinned);
  assert.equal(check.verdict, "WARN");
  assert.match(check.measured, /unreadable/);
  assert.notEqual(check.verdict, "OK", "a read that FAILED must never report as a read that SAID a match (W1-T472 design (v))");
});

// ── the reader itself, against a real temp .nvmrc — not only an injected string ────────────────

test("R-49: readNvmrcVersion reads a real .nvmrc from a temp package root", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-doctor-nvmrc-"));
  writeFileSync(join(dir, ".nvmrc"), "22.22.3\n");
  assert.equal(readNvmrcVersion(dir), "22.22.3");
});

test("R-49: readNvmrcVersion returns undefined when .nvmrc is absent, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-doctor-nvmrc-absent-"));
  assert.equal(readNvmrcVersion(dir), undefined);
});

// ── criterion 3 — the doctor exit code follows the tier ────────────────────────────────────────

function baseInputs(over: Partial<Parameters<typeof buildDoctorReport>[0]> = {}): Parameters<typeof buildDoctorReport>[0] {
  const now = Date.parse("2026-08-20T12:00:00Z");
  return {
    nowMs: now,
    ledgerLines: [
      { step: "daemon.alive", phase: "dispatch", ts: "2026-08-20T11:59:00Z", poll_interval_ms: 300_000 },
      { step: "sweep.pass", ts: "2026-08-20T11:50:00Z" },
      { step: "sweep.summary", ts: "2026-08-20T11:50:05Z" },
    ],
    candidateCount: 0,
    mem: { availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 },
    diskFreeBytes: 40 * 1024 ** 3,
    totalLocks: 0,
    deadLocks: [],
    gitLocks: [],
    workerCount: 0,
    checkoutDepth: { shallow: false, commitCount: 980 },
    runningNodeVersion: "22.22.3",
    nvmrcVersion: "22.22.3",
    ...over,
  };
}

test("R-49: buildDoctorReport wires node-version-pin into the composed report, and a mismatch moves the exit code from 0 to 1", () => {
  const healthy = buildDoctorReport(baseInputs());
  const healthyCheck = healthy.checks.find((c) => c.name === "node-version-pin");
  assert.ok(healthyCheck, "node-version-pin must actually appear in the composed report, not merely be defined and unreached");
  assert.equal(healthyCheck!.verdict, "OK");
  assert.equal(healthy.worst, "OK");
  assert.equal(healthy.exitCode, 0);

  // CONTROL: swap in a drifted reading and the SAME composed report reads WARN end to end, and
  // the exit code follows the WARN tier (1) — never FAIL (2) and never silently OK (0).
  const drifted = buildDoctorReport(baseInputs({ runningNodeVersion: "22.22.2" }));
  assert.equal(drifted.checks.find((c) => c.name === "node-version-pin")!.verdict, "WARN");
  assert.equal(drifted.worst, "WARN");
  assert.equal(drifted.exitCode, 1, "doctor's own WARN tier — 0 OK / 1 WARN / 2 FAIL");

  // CONTROL: an unreadable .nvmrc reads WARN through the same composed path, never OK.
  const unreadable = buildDoctorReport(baseInputs({ nvmrcVersion: undefined }));
  assert.equal(unreadable.checks.find((c) => c.name === "node-version-pin")!.verdict, "WARN");
  assert.equal(unreadable.exitCode, 1);
});

// ── criterion 4 — bin/rmd warns once and still dispatches, never refuses ───────────────────────
//
// A fake `node` is put ahead of PATH: it answers `--version` itself and execs the REAL node
// (`process.execPath`) for everything else, so `env node <tsx-cli>.mjs --help` (bin/rmd's own
// shebang-resolved exec line) still runs for real — the check must warn without breaking the
// dispatch it warns about.

function withFakeNode(reportedVersion: string, run: (env: NodeJS.ProcessEnv) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rmd-doctor-node-pin-fakebin-"));
  const nodeScript = join(dir, "node");
  writeFileSync(
    nodeScript,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
      `  echo "${reportedVersion}"`,
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(nodeScript, 0o755);
  run({
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    // Same discipline as test/repo-root-identity.test.ts's real bin/rmd spawn: this is not a
    // freshness test, and a spawned checkCliFreshness able to run `git merge --ff-only
    // origin/main` mid-suite is a hazard this env var exists to opt out of.
    RMD_SELF_SYNC_DONE: "1",
  });
}

test("R-49: bin/rmd warns exactly once to stderr when the running node differs from .nvmrc, and still dispatches --help with exit 0", () => {
  withFakeNode("v0.0.1-fake-mismatch", (env) => {
    const result = spawnSync(join(REPO_ROOT, "bin", "rmd"), ["--help"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `expected exit 0; stderr:\n${result.stderr}`);
    const stderrLines = result.stderr.split("\n").filter((l) => l.length > 0);
    assert.equal(stderrLines.length, 1, `expected exactly one stderr line; got:\n${result.stderr}`);
    assert.match(stderrLines[0]!, /differs from the pinned/);
    assert.match(stderrLines[0]!, /0\.0\.1-fake-mismatch/, "the running (fake) version is named");
    assert.match(stderrLines[0]!, /rmd doctor/, "points the operator at the read-only surface for detail");
    assert.match(result.stdout, /^usage:/, "bin/rmd still dispatched --help normally, never refused");
  });
});

test("R-49: bin/rmd stays silent when the running node matches .nvmrc — the positive control proving the warning is conditional, not unconditional", () => {
  const nvmrcVersion = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  withFakeNode(`v${nvmrcVersion.replace(/^v/, "")}`, (env) => {
    const result = spawnSync(join(REPO_ROOT, "bin", "rmd"), ["--help"], { env, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "", `expected no stderr on a matching node; got:\n${result.stderr}`);
    assert.match(result.stdout, /^usage:/);
  });
});
