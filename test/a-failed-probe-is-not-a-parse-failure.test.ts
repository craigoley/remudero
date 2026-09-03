/**
 * W1-T2755 — a probe that never RAN must not be reported as a probe whose report could not be
 * PARSED.
 *
 * THE DEFECT. `assessIsolation` receives only `IsolationEvidence` — two counts. It has no view
 * of whether the probe SPAWN failed, so a probe that never produced a report at all (a CLI
 * refusing to start, a transport failure, a spawn error) yields `NaN` counts and is handed the
 * "counts could not be parsed" reason. That string then travels into BOTH the
 * `isolation_preflight_failed` ledger row and the thrown `IsolationError`, aiming every reader
 * who follows the run-terminating verdict at the report PARSER — while the real cause sits in
 * `isError`/`transcript`, already carried into `probeIsolation` and used only to populate the
 * row's `stderr_excerpt`. MEASURED COST: a day of investigation at the isolation prompt and the
 * parser when the cause was the Codex CLI refusing a non-git-repo cwd (fixed as W1-T2754).
 *
 * WHAT THESE TESTS PIN. The reason STRING follows the signal that produced the failure, and the
 * fail-closed posture is untouched in every case — `probeIsolation` still throws
 * `IsolationError` on every non-isolated verdict here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  IsolationError,
  assessIsolation,
  defaultExecutor as isolationDefaultExecutor,
  isolationFailureReason,
  probeIsolation,
  type ProbeExecResult,
} from "../src/lib/isolation.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

/** The exact wording the parse-failure branch owns — asserted ABSENT on a spawn failure. */
const PARSE_FAILURE_WORDING = "counts could not be parsed";

/** Minimal fake WorkerResult — mirrors test/worker-stderr-persist.test.ts's helper. */
function fakeWorkerResult(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "sess-fake",
    costUsd: 0.01,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    ...overrides,
  } as WorkerResult;
}

function fakeConfigWithRoot(): Config {
  return { root: mkdtempSync(join(tmpdir(), "rmd-isolation-reason-root-")) } as Config;
}

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-isolation-reason-settings-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true }, permissions: { deny: [], allow: [], ask: [] } }));
  return path;
}

// ── (1) THE REAL LEAF: isolation.ts's own defaultExecutor, with a spawn that actually errors ──
// Not an `exec` fake handing probeIsolation a pre-built result object — the REAL executor runs:
// it makes the scratch cwd, joins text/blocks/stderr into the transcript, runs the real
// parseIsolationReport over that error text (which is what yields NaN), and reaps the cwd. Only
// the spawn leaf is faked, the same seam W1-T238 made injectable for exactly this reason.

test("W1-T2755: a probe whose SPAWN failed is reported as a spawn failure, carrying the probe's own error text — not as a parse failure", async () => {
  const config = fakeConfigWithRoot();
  const cliRefusal = "Codex CLI: refusing to start — cwd is not a git repository (--skip-git-repo-check was not specified)";
  const fakeSpawn = async (_args: SpawnWorkerArgs): Promise<WorkerResult> =>
    fakeWorkerResult({ isError: true, subtype: "error_during_execution", stderr: cliRefusal });

  // The real executor produces the real ProbeExecResult this verdict path consumes.
  const exec = isolationDefaultExecutor(settingsFile(), config, undefined, fakeSpawn);
  const probeResult: ProbeExecResult = await exec();
  assert.equal(probeResult.isError, true, "precondition: the real executor carried the spawn's error flag");
  assert.ok(Number.isNaN(probeResult.aliasCount), "precondition: an errored spawn yields unparseable counts");

  const err = await probeIsolation({ settingsFile: "unused", exec: async () => probeResult }).then(
    () => undefined,
    (e: unknown) => e,
  );

  assert.ok(err instanceof IsolationError, "FAIL CLOSED: an unproven probe must still throw");
  const msg = (err as IsolationError).message;
  assert.match(msg, /probe spawn itself FAILED/, "the message must name the spawn failure");
  assert.match(msg, /refusing to start/, "and must carry the probe's own error text");
  assert.ok(!msg.includes(PARSE_FAILURE_WORDING), `the parse-failure wording must be ABSENT; got: ${msg}`);
  assert.match(msg, /FAIL CLOSED, the run does not proceed/, "the fail-closed posture is unchanged");
});

// ── (1b) THE LEDGER SURFACE — where this defect actually did its damage ───────────────────────
// CLAUDE.md's #981 rule is about LEDGER lines carrying the reason from the decision that
// produced their outcome. A fix that only corrected the thrown message would leave the forensic
// surface lying: `isolation.probe` is written on EVERY probe, so it is the row a reader scanning
// probe history sees. Both rows are asserted here.

test("W1-T2755: BOTH ledger rows — isolation.probe and isolation_preflight_failed — carry the spawn-failure reason, not the parse-failure wording", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const probeResult: ProbeExecResult = {
    transcript: "Codex CLI: refusing to start — cwd is not a git repository",
    aliasCount: NaN,
    functionCount: NaN,
    isError: true,
  };

  await assert.rejects(
    () =>
      probeIsolation({
        settingsFile: "unused",
        exec: async () => probeResult,
        log: (step, extra) => rows.push({ step, extra }),
      }),
    IsolationError,
  );

  const probeRow = rows.find((r) => r.step === "isolation.probe");
  const verdictRow = rows.find((r) => r.step === "isolation_preflight_failed");
  assert.ok(probeRow, "the observation row must still be written");
  assert.ok(verdictRow, "the verdict row must still be written");

  for (const [name, row] of [["isolation.probe", probeRow], ["isolation_preflight_failed", verdictRow]] as const) {
    const reason = String(row!.extra?.reason ?? "");
    assert.match(reason, /probe spawn itself FAILED/, `${name} must name the spawn failure`);
    assert.ok(!reason.includes(PARSE_FAILURE_WORDING), `${name} must not blame the parser; got: ${reason}`);
  }

  // The observation row still reports the VERDICT accurately — only its reason string changed.
  assert.equal(probeRow!.extra?.isolated, false, "the probe row still reports the unproven verdict");
});

// ── (2) the parse-failure branch keeps the message it exists for ──────────────────────────────

test("W1-T2755: a probe that RAN CLEAN but returned an unreadable report still reports a parse failure", () => {
  const evidence = { aliasCount: NaN, functionCount: NaN };
  const verdict = assessIsolation(evidence);
  const reason = isolationFailureReason(evidence, verdict, {
    isError: false,
    transcript: "I ran the commands but here is some prose instead of the report you asked for.",
  });
  assert.equal(reason, verdict.reason, "a genuine parse failure keeps assessIsolation's wording verbatim");
  assert.match(reason, /counts could not be parsed/);
});

// ── (3) neither signal present ⇒ say so, do not blame the parser ──────────────────────────────

test("W1-T2755: no counts, no error and no output is reported as ambiguous rather than as a parse failure", () => {
  const evidence = { aliasCount: NaN, functionCount: NaN };
  const verdict = assessIsolation(evidence);
  const reason = isolationFailureReason(evidence, verdict, { isError: false, transcript: "   " });
  assert.match(reason, /no output and reported no error/, "the ambiguous case names itself");
  assert.ok(!reason.includes(PARSE_FAILURE_WORDING), "a parse failure is not established when nothing was returned to parse");
  assert.match(reason, /UNPROVEN/, "and it is still UNPROVEN — fail closed");
});

// ── (4) the PROVEN-BROKEN case is untouched: its reason was already exact ─────────────────────

test("W1-T2755: a probe that parsed and found real leakage keeps assessIsolation's exact wording, even if the spawn also errored", () => {
  const evidence = { aliasCount: 3, functionCount: 1 };
  const verdict = assessIsolation(evidence);
  const clean = isolationFailureReason(evidence, verdict, { isError: false, transcript: "report" });
  const errored = isolationFailureReason(evidence, verdict, { isError: true, transcript: "some stderr" });
  assert.equal(clean, verdict.reason, "parsed counts are already specific — do not rewrite them");
  assert.equal(errored, verdict.reason, "a real leak is a real leak regardless of the spawn's error flag");
  assert.match(clean, /worker inherited 3 alias\(es\)/);
});

// ── (5) fail-closed is a POLICY this change must not touch ────────────────────────────────────

test("W1-T2755: every non-isolated verdict still throws IsolationError — the reason changed, the policy did not", async () => {
  const cases: Array<{ name: string; r: ProbeExecResult }> = [
    { name: "spawn failed", r: { transcript: "boom", aliasCount: NaN, functionCount: NaN, isError: true } },
    { name: "unparseable report", r: { transcript: "prose", aliasCount: NaN, functionCount: NaN, isError: false } },
    { name: "ambiguous", r: { transcript: "", aliasCount: NaN, functionCount: NaN, isError: false } },
    { name: "proven broken", r: { transcript: "ok", aliasCount: 2, functionCount: 0, isError: false } },
  ];
  for (const c of cases) {
    await assert.rejects(
      () => probeIsolation({ settingsFile: "unused", exec: async () => c.r }),
      IsolationError,
      `${c.name} must fail closed`,
    );
  }
});
