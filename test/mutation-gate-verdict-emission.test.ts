import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// The gate is a plain `.mjs` with no declaration file -- deliberately, since CI runs it as bare
// `node`. Typing the handful of exports this suite drives keeps the assertions checked without
// pretending the script is TypeScript.
const gate = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mutation-ratchet.mjs")).href)) as unknown as {
  RATCHET_VERDICT_STEP: string;
  ratchetVerdictLine: (i: Record<string, unknown>) => Record<string, unknown>;
  resolveLedgerPath: (
    env: Record<string, string | undefined>,
    opts?: { ledger?: string },
  ) => { path: string | undefined; source: string };
  resolveVerdictRunId: (env: Record<string, string | undefined>, spawn?: unknown) => string;
  resolveVerdictPrUrl: (env: Record<string, string | undefined>) => string | undefined;
  emitRatchetVerdict: (i: Record<string, unknown>, d: Record<string, unknown>) => { emitted: boolean };
  recordRatchetVerdict: (
    conclusion: string,
    totals: Record<string, number>,
    deps: Record<string, unknown>,
  ) => { recorded: boolean; reason?: string; ledgerPath?: string; source?: string };
};
const { emitRatchetVerdict, ratchetVerdictLine, RATCHET_VERDICT_STEP, recordRatchetVerdict, resolveLedgerPath, resolveVerdictPrUrl, resolveVerdictRunId } =
  gate;
import { MUTATION_GATE_VERDICT_STEP, mutationGateVerdictLine, mutationGateLifetime } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");

// ── W1-T2707 (MASTER-PLAN D-10) ──────────────────────────────────────────────────────────────
//
// The whole reader side of `mutation.ratchet_verdict` was built, tested and wired, and nothing
// wrote one — so D-10 read "N=0 verdicts, NO POSITIVE CONTROL" for six retro cycles: not "zero
// escapes", but no population to count. These tests pin the write side in BOTH directions, because
// an emission that fires on a run which scored nothing would manufacture verdicts and answer D-10
// with noise, which is worse than the silence it replaces.

function tmpRoot(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

/** Run the real CLI with RMD_ROOT pointed at a scratch root, so the emission lands where we can
 *  read it. Spawning the actual process (not calling an export) is what makes this a test of the
 *  GATE rather than of a function the gate might not call. */
function runCli(args: string[], root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, RMD_ROOT: root, GITHUB_RUN_ID: "", GITHUB_SHA: "", GITHUB_REF: "", GITHUB_REPOSITORY: "", ...env },
  });
}

function ledgerLines(root: string): Array<Record<string, unknown>> {
  const p = join(root, "state", "ledger.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── the line shape is retro.ts's, pinned rather than re-invented ──────────────────────────────

test("ratchetVerdictLine is field-for-field mutationGateVerdictLine — the copy cannot drift unnoticed", () => {
  // The script is run by CI as plain `node`, with no tsx, so it CANNOT import the TypeScript
  // builder. The shape is therefore duplicated -- and this is the guard that makes the duplicate
  // safe: if either side gains, loses or renames a field, this reds.
  const input = {
    runId: "run-123",
    conclusion: "failure" as const,
    killed: 7,
    survived: 3,
    timeout: 1,
    noCoverage: 2,
  };
  assert.deepEqual(ratchetVerdictLine(input), mutationGateVerdictLine(input) as unknown as Record<string, unknown>);
  assert.equal(RATCHET_VERDICT_STEP, MUTATION_GATE_VERDICT_STEP);

  // …including the optional fields, which a naive copy gets wrong in a different way.
  const withPr = { ...input, prUrl: "https://github.com/o/r/pull/9", taskId: "W1-T2707" };
  assert.deepEqual(ratchetVerdictLine(withPr), mutationGateVerdictLine(withPr) as unknown as Record<string, unknown>);
  assert.equal(ratchetVerdictLine(input).pr_url, undefined, "pr_url is omitted, not emitted as undefined");
});

// ── a real run emits exactly one line; a diff-scoped skip emits none ──────────────────────────

test("a real PR-gate run that BLOCKS emits exactly one verdict line carrying conclusion=failure and the run's totals", () => {
  const root = tmpRoot("w1-t2707-block-");
  const res = runCli(["--report", join(FIXTURES, "below-baseline.json"), "--baseline", BASELINE], root);

  assert.notEqual(res.status, 0, "the gate still BLOCKS -- emission must not change the verdict");
  const lines = ledgerLines(root);
  assert.equal(lines.length, 1, `exactly one line, got ${lines.length}`);
  assert.equal(lines[0]!.step, MUTATION_GATE_VERDICT_STEP);
  assert.equal(lines[0]!.conclusion, "failure");
  // The totals are the ones the gate actually scored, not zeros or placeholders.
  const report = JSON.parse(readFileSync(join(FIXTURES, "below-baseline.json"), "utf8")) as {
    files: Record<string, { mutants: Array<{ status: string }> }>;
  };
  const statuses = Object.values(report.files).flatMap((f) => f.mutants.map((m) => m.status));
  assert.equal(lines[0]!.killed, statuses.filter((s) => s === "Killed").length);
  assert.equal(lines[0]!.survived, statuses.filter((s) => s === "Survived").length);
  assert.ok(typeof lines[0]!.ts === "string" && typeof lines[0]!.host === "string", "appendLedger's record shape");
});

test("a real PR-gate run that PASSES emits exactly one verdict line carrying conclusion=success", () => {
  const root = tmpRoot("w1-t2707-pass-");
  const res = runCli(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], root);

  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = ledgerLines(root);
  assert.equal(lines.length, 1, `exactly one line, got ${lines.length}`);
  assert.equal(lines[0]!.conclusion, "success");
  assert.match(res.stderr, /verdict success recorded to/, "on stderr -- stdout is pinned byte-for-byte");
});

test("a diff-scoped SKIP emits no verdict line at all — it has no report to summarize", () => {
  // This is the half that makes the population meaningful. A line here would be a verdict
  // manufactured from a run that scored nothing, and D-10 would then be answered with noise.
  const root = tmpRoot("w1-t2707-skip-");
  const res = runCli(["--changed-files", join(FIXTURES, "changed-files-plan-only.txt")], root);

  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /mutation-ratchet: skip/, "this really was the skip branch");
  assert.deepEqual(ledgerLines(root), [], "a skip must write nothing");
});

test("a REQUIRED path-filter decision also emits nothing — it decides whether to run, it does not run", () => {
  // The other half of the skip branch: `matched=true` still scores nothing, so it still has no
  // verdict to record. Without this, the previous test passes for the wrong reason.
  const root = tmpRoot("w1-t2707-required-");
  const res = runCli(["--changed-files", join(FIXTURES, "changed-files-classify.txt")], root);

  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /mutation-ratchet: REQUIRED/);
  assert.deepEqual(ledgerLines(root), [], "deciding to run is not a run");
});

// ── the emitted line is what the lifetime rung actually counts ────────────────────────────────

test("the emitted lines give mutationGateLifetime a real population, with the escape named", () => {
  // The reader has never seen a record. Driving retro.ts's own rung over the lines this gate
  // writes is what proves the emission ANSWERS D-10 rather than merely appending JSON.
  const root = tmpRoot("w1-t2707-lifetime-");
  runCli(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], root);
  runCli(["--report", join(FIXTURES, "below-baseline.json"), "--baseline", BASELINE], root);

  const report = mutationGateLifetime(ledgerLines(root) as never);
  assert.equal(report.runCount, 2, "two real runs, two verdicts");
  assert.equal(report.escapeCount, 1, "exactly the failing run is an escape");
  assert.equal(report.escapes.length, 1);
  assert.equal(report.positiveControl, true, "N>0 -- the 'NO POSITIVE CONTROL' state is now falsifiable");
});

// ── resolving the ledger without importing config.ts ──────────────────────────────────────────

test("resolveLedgerPath is EXPLICIT-ONLY: --ledger, then RMD_ROOT, then nowhere at all", () => {
  assert.deepEqual(resolveLedgerPath({}, { ledger: "/tmp/x/ledger.ndjson" }), {
    path: "/tmp/x/ledger.ndjson",
    source: "flag",
  });
  assert.deepEqual(resolveLedgerPath({ RMD_ROOT: "/srv/rmd" }, {}), {
    path: join("/srv/rmd", "state", "ledger.ndjson"),
    source: "env",
  });
  // THE LOAD-BEARING ARM. An ambient fallback (a config file, or ~/Remudero) turns every harness
  // that spawns this CLI into an append to the operator's real ledger -- measured: 35 junk verdict
  // lines landed in it from one test sweep before this arm existed.
  assert.deepEqual(resolveLedgerPath({}, {}), { path: undefined, source: "unconfigured" });
  assert.equal(resolveLedgerPath({ HOME: "/home/u" }, {}).path, undefined, "HOME is not a ledger");
});

test("an UNCONFIGURED real run writes nothing anywhere and leaves the gate's stdout byte-for-byte alone", () => {
  // The pin this protects lives in another suite (W1-T2524 criteria 3 and 4). Asserted here too,
  // because the defect it catches is introduced by THIS file's feature, not by that one's.
  const res = spawnSync(process.execPath, [SCRIPT, "--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], {
    encoding: "utf8",
    env: { ...process.env, RMD_ROOT: "" },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(
    res.stdout,
    "mutation-ratchet: score 90.00% (baseline 80.00%) -- 8 killed, 1 timeout, 0 survived, 1 no-coverage\n" +
      "mutation-ratchet: OK -- at or above baseline.\n",
  );
  assert.equal(res.stderr, "", "an unconfigured run is silent on stderr too");
});

test("resolveVerdictRunId prefers the Actions run id, then the sha, then git HEAD", () => {
  assert.equal(resolveVerdictRunId({ GITHUB_RUN_ID: "42", GITHUB_SHA: "abc" }), "42");
  assert.equal(resolveVerdictRunId({ GITHUB_SHA: "abc" }), "abc");
  assert.equal(resolveVerdictRunId({}, () => ({ stdout: "deadbeef\n" })), "deadbeef");
  assert.equal(resolveVerdictRunId({}, () => ({ stdout: "" })), "unknown", "never an empty id");
  assert.throws(() => resolveVerdictRunId({}, () => ({ error: new Error("git unavailable") })), /git unavailable/);
});

test("resolveVerdictPrUrl builds a URL only for a pull_request ref", () => {
  assert.equal(
    resolveVerdictPrUrl({ GITHUB_REF: "refs/pull/17/merge", GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://gh" }),
    "https://gh/o/r/pull/17",
  );
  assert.equal(resolveVerdictPrUrl({ GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "o/r" }), undefined);
  assert.equal(resolveVerdictPrUrl({}), undefined);
});

// ── recordRatchetVerdict: both arms, including the one that guards the steps before the write ──

const TOTALS = { killed: 1, survived: 0, timeout: 0, noCoverage: 0 };

function recordDeps(over: Record<string, unknown> = {}) {
  return {
    resolveLedger: () => ({ path: "/tmp/ledger.ndjson", source: "flag" }),
    runId: () => "r1",
    prUrl: () => undefined,
    emit: () => ({ emitted: true }),
    io: {},
    log: () => {},
    ...over,
  };
}

test("recordRatchetVerdict: a failure BEFORE the write is reported and never thrown — the arm a missing import once hit", () => {
  // This is the arm diff-coverage found uncovered, and it could not be reached while the logic
  // was an inline closure: emitRatchetVerdict contains the WRITE failure and returns rather than
  // throwing, so nothing exercised the guard around resolving the path, the run id or the host.
  // The arm exists because a missing `homedir` import crashed this gate AFTER it had printed its
  // verdict — a failure in exactly those earlier steps.
  const logged: string[] = [];
  const res = recordRatchetVerdict("success", TOTALS, recordDeps({
    runId: () => {
      throw new Error("ReferenceError: homedir is not defined");
    },
    log: (m: string) => logged.push(m),
  }));

  assert.equal(res.recorded, false);
  assert.match(res.reason ?? "", /homedir is not defined/, "the real reason is returned, not swallowed");
  assert.match(logged.join("\n"), /verdict NOT recorded/, "and printed — a lost measurement is never silent");
});

test("recordRatchetVerdict: an unconfigured ledger records nothing, says nothing, and is not an error", () => {
  const logged: string[] = [];
  const res = recordRatchetVerdict("success", TOTALS, recordDeps({
    resolveLedger: () => ({ path: undefined, source: "unconfigured" }),
    emit: () => {
      throw new Error("must not be reached");
    },
    log: (m: string) => logged.push(m),
  }));

  assert.equal(res.recorded, false);
  assert.equal(res.reason, "unconfigured");
  assert.deepEqual(logged, [], "silence, not a warning — nobody asked for a ledger");
});

test("recordRatchetVerdict: the happy arm passes the conclusion and the run's own totals straight through", () => {
  const seen: Array<Record<string, unknown>> = [];
  const res = recordRatchetVerdict("failure", { killed: 7, survived: 3, timeout: 1, noCoverage: 2 }, recordDeps({
    emit: (input: Record<string, unknown>) => {
      seen.push(input);
      return { emitted: true };
    },
  }));

  assert.equal(res.recorded, true);
  assert.equal(res.ledgerPath, "/tmp/ledger.ndjson");
  assert.deepEqual(seen[0], { runId: "r1", prUrl: undefined, conclusion: "failure", killed: 7, survived: 3, timeout: 1, noCoverage: 2 });
});

// ── a lost ledger write is a lost measurement, never a failed build ───────────────────────────

test("emitRatchetVerdict reports a write failure and does NOT throw — the gate's verdict is not a ledger's to veto", () => {
  const logged: string[] = [];
  const res = emitRatchetVerdict(
    { runId: "r", conclusion: "success", killed: 1, survived: 0, timeout: 0, noCoverage: 0 },
    {
      ledgerPath: "/nope/ledger.ndjson",
      now: () => "2026-01-01T00:00:00.000Z",
      host: () => "h",
      mkdir: () => {
        throw new Error("EACCES: read-only file system");
      },
      append: () => {
        throw new Error("should not be reached");
      },
      log: (m: string) => logged.push(m),
    },
  );
  assert.equal(res.emitted, false);
  assert.match(logged.join("\n"), /verdict NOT recorded/, "the loss is stated, never silent");
  assert.match(logged.join("\n"), /EACCES/, "with the real reason");
});

test("a real run whose ledger cannot be written still returns the gate's own exit code", () => {
  // The emission is strictly additive. If it could change the verdict, this gate would start
  // failing builds for a reason that has nothing to do with mutation score.
  const root = tmpRoot("w1-t2707-unwritable-");
  writeFileSync(join(root, "state"), "not a directory");
  const res = runCli(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], root);
  assert.equal(res.status, 0, "still the gate's own verdict");
  assert.match(res.stderr, /verdict NOT recorded/);
});

test("a real run whose fallback run-id lookup throws still returns the gate's own exit code", () => {
  // This covers the containment around the whole emission call, not only appendLedger's write arm:
  // losing the measurement must not turn a passing mutation score into a red required check.
  const root = tmpRoot("w1-t2707-run-id-error-");
  const res = runCli(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], root, { PATH: "" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stderr, /verdict NOT recorded: spawnSync git ENOENT/);
  assert.deepEqual(ledgerLines(root), [], "the failed emission writes no partial verdict");
});

// ── the production producer, asserted against the REAL workflow ────────────────────────────────
//
// Everything above drives the gate with a `--ledger` this suite supplies itself. That proves the
// emission WORKS; it does not prove anything ever ASKS for it. `resolveLedgerPath` is
// explicit-only by design — no `--ledger`, no `RMD_ROOT`, no line — so until a real caller passes
// one, the whole emission resolves `unconfigured` on every genuine run and D-10 keeps reporting a
// population nothing produces. That caller is ci.yml's mutation-ratchet job, and it is asserted
// here against the CHECKED-IN workflow rather than a fixture, because a fixture cannot go stale
// with the file it stands in for.

const CI_WORKFLOW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml"), "utf8");

/** Every ci.yml line that invokes this gate, normalised. A step written `run: <cmd>` and one
 *  written as a `run: |` block body are the SAME invocation to the runner but differ by that
 *  prefix in the file, and the trigger step is a block — so a recognizer keyed on `run: ` sees
 *  only half the call sites and reports a silence it never actually checked. */
function gateInvocations(workflow: string): string[] {
  return workflow
    .split("\n")
    .map((l) => l.trim().replace(/^run:\s*/, ""))
    .filter((l) => l.startsWith("node scripts/mutation-ratchet.mjs"));
}

/** The gate's real PR-time verdict invocation — the one that reads a report, NOT the
 *  `--changed-files` trigger step (which scores nothing and must stay silent). */
function verdictInvocation(workflow: string): string | undefined {
  return gateInvocations(workflow).find((l) => l.includes("--report"));
}

test("ci.yml's verdict run passes --ledger, so the emission has a production producer and not only a test's own flag", () => {
  const line = verdictInvocation(CI_WORKFLOW);
  assert.ok(line, "the verdict invocation must exist in ci.yml at all — if this fails, the recognizer drifted, not the wiring");
  assert.match(line!, /--ledger\b/, "no --ledger in CI means resolveLedgerPath returns `unconfigured` on every real run");

  // BLOCKING CONTROL: the same recognizer over the same line with the flag removed must FAIL.
  // Without this, a recognizer that matched anything at all would report a passing wiring.
  const stripped = CI_WORKFLOW.replace(/ --ledger "[^"]*"/, "");
  const strippedLine = verdictInvocation(stripped);
  assert.ok(strippedLine, "control: the invocation is still found after the flag is removed");
  assert.doesNotMatch(strippedLine!, /--ledger\b/, "control: the assertion above discriminates rather than matching everything");
});

test("the --changed-files trigger step is NOT given a ledger — it scores nothing, so it must produce no verdict", () => {
  const trigger = gateInvocations(CI_WORKFLOW).find((l) => l.includes("--changed-files"));
  assert.ok(trigger, "the trigger invocation must exist — otherwise this silence is vacuous");
  assert.doesNotMatch(trigger!, /--ledger\b/, "a ledger here would manufacture a verdict from a run that read no report");
});

test("the emitted verdict is uploaded, so a real run's line outlives the job that wrote it", () => {
  // A ledger written to a path the runner discards is unobservable, which is the same dead end as
  // not writing it. `always()` matters: a BLOCKING verdict is the one D-10 most wants counted.
  assert.match(CI_WORKFLOW, /name: mutation-verdict-ledger/, "the verdict ledger is uploaded as an artifact");
  assert.match(CI_WORKFLOW, /if: always\(\) && steps\.trigger\.outputs\.matched == 'true'/, "uploaded on a blocking verdict too, not only a passing one");
});
