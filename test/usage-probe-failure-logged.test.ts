import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import {
  ledgerUsageProbeFailure,
  readUsageSnapshot,
  type UsageProbeFailureStage,
  type UsageProbeRunner,
} from "../src/run-task.js";

/**
 * A USAGE-PROBE FAILURE MUST NAME ITSELF, DURABLY, ON THE FIRST TICK.
 *
 * This is the half of the 2026-07-31 outage that made it expensive rather than merely broken.
 * `readUsageSnapshot` ran the probe and parsed its output inside ONE `try`, under a bare
 * `catch { return undefined }`. So a perfect read that could not be parsed was indistinguishable
 * from no read at all, and the message that would have ended the investigation in two minutes —
 * `unparseable weekly (Fable) window: 0% used` — existed in memory on every 60-second tick and
 * was thrown away every time. The daemon logged nothing for hours.
 *
 * These tests pin the two properties that fix that: the two failures are DISTINGUISHED, and the
 * reason is RECORDED. `readUsageSnapshot`'s spawn half is driven through W1-T267's own injected
 * `UsageProbeRunner` seam, so nothing here spawns a real `claude`, touches a real keychain, or
 * reaches a real `runTask`/`drain`/`sweep`.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/usage/usage-resetless-weekly.txt", import.meta.url));
const REAL_CAPTURE = readFileSync(FIXTURE, "utf8");

function tmpConfig(): Config {
  // `claudeBin` is never executed here — every test injects the probe runner.
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-usage-fail-")) } as Config;
}

test("a parse failure is LOGGED with its message rather than silently swallowed", () => {
  const config = tmpConfig();
  const calls: Array<{ stage: UsageProbeFailureStage; reason: string }> = [];
  // A probe that SUCCEEDS and returns text the parser cannot understand — i.e. exactly the
  // 2026-07-31 state: exit 0, real bytes, unparseable content.
  const runner: UsageProbeRunner = () =>
    REAL_CAPTURE.replace("Current week (Fable): 0% used", "Current week (Fable): quota exhausted");

  const snap = readUsageSnapshot(config, runner, (stage, reason) => calls.push({ stage, reason }));

  // The ratified return polarity is UNCHANGED — an unreadable read still yields undefined so the
  // drain continues. Only the silence is fixed.
  assert.equal(snap, undefined);

  // ASSERT THE CALL AND ITS CONTENT, not merely that something happened.
  assert.equal(calls.length, 1, "exactly one failure is reported, not zero and not a duplicate per attempt");
  assert.equal(calls[0].stage, "parse", "classified as a PARSE failure — the read itself succeeded");
  assert.match(
    calls[0].reason,
    /unparseable weekly \(Fable\) window: quota exhausted/,
    "the reason names the offending window and quotes the line it choked on",
  );
});

test("a spawn failure is reported separately from a parse failure so the two are never conflated", () => {
  const config = tmpConfig();
  const calls: Array<{ stage: UsageProbeFailureStage; reason: string }> = [];
  const runner: UsageProbeRunner = () => {
    throw new Error("spawn ENOENT: claude not found");
  };

  const snap = readUsageSnapshot(config, runner, (stage, reason) => calls.push({ stage, reason }));

  assert.equal(snap, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, "spawn", "a probe that could not RUN is a different failure from one that could not be UNDERSTOOD");
  assert.match(calls[0].reason, /ENOENT/);
});

test("a successful read reports no failure at all — the sink fires only on failure", () => {
  const config = tmpConfig();
  const calls: Array<{ stage: UsageProbeFailureStage; reason: string }> = [];
  const snap = readUsageSnapshot(config, () => REAL_CAPTURE, (stage, reason) => calls.push({ stage, reason }));

  // The real capture — the one that used to blow the whole read up — now yields a usable snapshot.
  assert.equal(calls.length, 0, "no failure line on a good read; a diagnostic that fires always is noise");
  assert.equal(snap?.session.percentUsed, 13);
  assert.equal(snap?.weekly.length, 2);
  assert.equal(snap?.weekly.find((w) => w.label === "Fable")?.percentUsed, 0);
});

test("the default sink writes a durable greppable usage.probe_failed ledger line carrying the reason", () => {
  // THE DEFAULT IMPLEMENTATION, exercised for real rather than left as unreachable glue: the
  // three tests above all inject their own sink, so `ledgerUsageProbeFailure` — the thing that
  // actually makes the record DURABLE — would otherwise never run. It is called here directly
  // against a temp root, and the file it writes is read back.
  const config = tmpConfig();
  ledgerUsageProbeFailure(config, "parse", "unparseable weekly (Fable) window: 0% used");

  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const failure = lines.find((l) => l.step === "usage.probe_failed");

  assert.ok(failure, "the line is on disk — greppable after the process that saw the error is gone");
  assert.equal(failure.stage, "parse");
  assert.equal(failure.reason, "unparseable weekly (Fable) window: 0% used");
  assert.equal(failure.task_id, "DAEMON");
  assert.ok(typeof failure.ts === "string" && failure.ts.length > 0, "and it is timestamped, so the first tick is identifiable");
});

test("the default sink truncates a pathological reason and never throws on its own failure", () => {
  const config = tmpConfig();
  // An execFileSync error can carry an entire captured stderr; the ledger must not grow without
  // bound because of a diagnostic.
  ledgerUsageProbeFailure(config, "spawn", "x".repeat(5000));
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const line = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).at(-1)!;
  assert.equal(String(line.reason).length, 400, "bounded, not unbounded");

  // And an unwritable destination is swallowed: a best-effort diagnostic must never be the reason
  // a best-effort read becomes a crash.
  assert.doesNotThrow(() => ledgerUsageProbeFailure({ claudeBin: "/bin/true", root: "/dev/null/not-a-directory" } as Config, "parse", "boom"));
});
