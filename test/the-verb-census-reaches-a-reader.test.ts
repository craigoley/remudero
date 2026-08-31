import assert from "node:assert/strict";
import fsDefault, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  renderVerbCensusDigestLine,
  runMeasurementCadenceReport,
  runVerbCensus,
  type VerbCensusCadenceResult,
} from "../src/lib/measurement-cadence.js";
import { resolveLedgerUnion } from "../src/lib/ledger-grep.js";
import { buildDigestCadenceDaemonHooks, buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2485 — THE VERB CENSUS GETS A SCHEDULER. `lib/emissions.ts` (`rmd emissions`) already
// answers "which CLI verb has written no ledger line", and W1-T2479 fixed its own corpus so the
// answer can be trusted. What it never had was a CLOCK: an operator who never types the command
// never sees it. This file proves the eight acceptance criteria on this task's own shard, in
// that order, against SYNTHETIC fixtures (never this host's live repo/ledger state) except for
// the two tests that deliberately exercise the REAL, unmocked daemon producer wiring — the same
// "reachable through the daemon producer, not only through a mock" precedent
// test/adoption-report-has-a-producer.test.ts already established for the fourth verb.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const NO_GIT = () => {
  throw new Error("no real git in this test — irrelevant to the verb census");
};

/**
 * A synthetic checkout: `src/run-task.ts` declares four verbs (`alpha`/`beta`/`gamma`/`delta`)
 * via the real `COMMANDS` marker shape `deriveCliVerbs` scans for, and a sibling `src/lib` file
 * emits ledger steps for three of them (`alpha`/`beta`/`gamma`) — `delta` carries no attributable
 * prefix at all, the UNMEASURABLE case.
 */
function buildVerbCensusFixtureCheckout(): string {
  const root = tmp("rmd-vc-fixture-");
  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(
    join(root, "src/run-task.ts"),
    'const COMMANDS: readonly CommandSpec[] = [\n' +
      '  { name: "alpha", usage: "alpha" },\n' +
      '  { name: "beta", usage: "beta" },\n' +
      '  { name: "gamma", usage: "gamma" },\n' +
      '  { name: "delta", usage: "delta" },\n' +
      '] as const;\n',
  );
  writeFileSync(
    join(root, "src/lib/stub-steps.ts"),
    'log("alpha.thing", {});\n' + 'log("beta.thing", {});\n' + 'log("gamma.thing", {});\n',
  );
  return root;
}

/** A ledger rotation carrying two `gamma.*` lines and nothing for `alpha`/`beta` — `gamma` is
 *  LIVE this run, `alpha`/`beta` are SILENT (subject to the allowlist). */
function buildVerbCensusLedgerFixture(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const lines = [
    JSON.stringify({ step: "gamma.thing" }),
    JSON.stringify({ step: "gamma.thing2" }),
    JSON.stringify({ step: "other.unrelated" }),
  ];
  writeFileSync(join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson"), lines.join("\n") + "\n");
}

// ── acceptance 3: A VERB THE ALLOWLIST EXCUSES IS NOT COUNTED AS SILENT ────────────────────────

test("a measurable verb with zero ledger lines is silent; one with lines this run is not", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "measured");
    assert.equal(r.measurableCount, 3, "alpha/beta/gamma each carry an attributable prefix");
    assert.deepEqual(r.silentVerbs.slice().sort(), ["alpha", "beta"], "gamma wrote ledger lines this run — not silent");
    assert.equal(r.silentCount, 2);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("a verb the allowlist excuses is not counted as silent, even at zero lines", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({
      checkoutDir,
      stateDir,
      ledgerUnion: resolveLedgerUnion,
      allowlist: new Map([["beta", "excused for this test"]]),
    });
    assert.equal(r.silentCount, 1, "beta is excused; only alpha remains silent");
    assert.deepEqual(r.silentVerbs, ["alpha"]);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 4: A VERB WITH NO ATTRIBUTABLE PREFIX IS UNMEASURABLE, NEVER SILENT ─────────────

test("a verb with no attributable prefix is reported unmeasurable, never folded into silent", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.ok(!r.silentVerbs.includes("delta"), "delta has no prefix at all — it cannot be silent, only unmeasurable");
    assert.deepEqual(r.unmeasurableVerbs, ["delta"]);
    assert.equal(r.unmeasurableCount, 1);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 6: A CENSUS THAT CANNOT READ ITS CORPUS REFUSES RATHER THAN FAKES A ZERO ────────

test("no checkoutDir supplied: refused, never a fabricated zero", () => {
  const stateDir = tmp("rmd-vc-nofix-");
  buildVerbCensusLedgerFixture(stateDir); // a real corpus, but irrelevant with nothing to scan
  try {
    const r = runVerbCensus({ stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "refused");
    assert.match(r.refusedReason ?? "", /checkout/);
    assert.equal(r.silentCount, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unreadable src/run-task.ts refuses rather than silently scanning zero verbs", () => {
  const checkoutDir = tmp("rmd-vc-nosrc-");
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "refused");
    assert.match(r.refusedReason ?? "", /run-task\.ts unreadable/);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("a reshaped run-task.ts (no COMMANDS marker) refuses via deriveCliVerbs's own thrown reason", () => {
  const checkoutDir = tmp("rmd-vc-reshaped-");
  const stateDir = join(checkoutDir, "state");
  mkdirSync(join(checkoutDir, "src"), { recursive: true });
  writeFileSync(join(checkoutDir, "src/run-task.ts"), 'export const nothingHere = "no COMMANDS marker at all";\n');
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "refused");
    assert.match(r.refusedReason ?? "", /deriveCliVerbs: could not find/);
    assert.equal(r.silentCount, 0);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("every declared verb unmeasurable: refuses rather than measuring an empty population", () => {
  const checkoutDir = tmp("rmd-vc-allunmeasurable-");
  const stateDir = join(checkoutDir, "state");
  mkdirSync(join(checkoutDir, "src/lib"), { recursive: true });
  writeFileSync(
    join(checkoutDir, "src/run-task.ts"),
    'const COMMANDS: readonly CommandSpec[] = [\n' + '  { name: "lonely", usage: "lonely" },\n' + '] as const;\n',
  );
  // No ledger step literal anywhere carries the "lonely" prefix — the sole declared verb is
  // unmeasurable, so `measurable.length` is zero and the census must refuse, not report a bare
  // "0 silent of 0 measurable" that would misread as a clean bill.
  writeFileSync(join(checkoutDir, "src/lib/stub-steps.ts"), 'log("other.thing", {});\n');
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "refused");
    assert.match(r.refusedReason ?? "", /no scanned verb carries an attributable ledger prefix/);
    assert.equal(r.unmeasurableCount, 1);
    assert.deepEqual(r.unmeasurableVerbs, ["lonely"]);
    assert.equal(r.silentCount, 0, "a refusal must never masquerade as a measured zero");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("a source subdirectory that cannot be scanned is skipped, never the reason the whole census refuses", (t) => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  const brokenDir = join(checkoutDir, "src/broken");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, "unreadable.ts"), 'log("alpha.thing", {});\n');
  // A MOCKED readdirSync, never a chmod: host-capability-fixtures.test.ts's own DECLARED census
  // refuses an undeclared uid-dependent chmod fixture (its own guidance prefers a uid-independent
  // denial or, failing that, an explicit DECLARED entry — neither of which this task's declared
  // file scope permits touching). Mocking `fsDefault.readdirSync` reaches the exact same
  // `walkVerbCensusSources` catch arm deterministically, on every uid, with no host filesystem
  // side effect at all: only the one path this test names throws; every other call — including
  // the ones this same walk makes for `src/lib`, `state`, etc. — passes through to the real
  // implementation unchanged.
  const originalReaddirSync = fsDefault.readdirSync.bind(fsDefault);
  t.mock.method(fsDefault, "readdirSync", (p: unknown, opts?: unknown) => {
    if (p === brokenDir) {
      const err = new Error(`EACCES: permission denied, scandir '${brokenDir}'`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return (originalReaddirSync as (...args: unknown[]) => unknown)(p, opts);
  });
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    // walkVerbCensusSources's own readdirSync throws on brokenDir (permission denied) and it
    // returns silently rather than aborting the whole walk — the rest of the corpus (alpha/beta/
    // gamma's real prefixes, from src/lib/stub-steps.ts) is still scanned and measured normally.
    assert.equal(r.status, "measured");
    assert.equal(r.measurableCount, 3);
    assert.equal(r.silentCount, 2, "alpha/beta still read as silent — the unreadable subdir changed nothing about the reachable corpus");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("a census that cannot read its ledger corpus reports unmeasured rather than a zero", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state"); // mkdir'd, but never populated: zero archives
  mkdirSync(stateDir, { recursive: true });
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "refused");
    assert.match(r.refusedReason ?? "", /ledger corpus incomplete/);
    assert.equal(r.silentCount, 0, "a refusal must never masquerade as a measured, clean zero");
    assert.equal(r.measurableCount, 3, "the denominator is knowable even when the corpus itself is not");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 2: THE DIGEST LINE ITSELF CARRIES THE SILENT COUNT AND THE DENOMINATOR ──────────

test("renderVerbCensusDigestLine carries the silent count, the measurable denominator, and the unmeasurable count", () => {
  const r: VerbCensusCadenceResult = {
    status: "measured",
    measurableCount: 17,
    unmeasurableCount: 5,
    silentCount: 3,
    silentVerbs: ["ops", "issues", "project"],
    unmeasurableVerbs: ["run-task"],
  };
  const line = renderVerbCensusDigestLine(r);
  assert.match(line, /3 silent of 17 measurable/);
  assert.match(line, /5 unmeasurable/);
  assert.match(line, /ops, issues, project/);
});

test("renderVerbCensusDigestLine on a refused census names why, never a fabricated zero", () => {
  const r: VerbCensusCadenceResult = {
    status: "refused",
    refusedReason: "ledger corpus incomplete under /tmp/x (0 archive(s), 0 unread)",
    measurableCount: 0,
    unmeasurableCount: 0,
    silentCount: 0,
    silentVerbs: [],
    unmeasurableVerbs: [],
  };
  const line = renderVerbCensusDigestLine(r);
  assert.match(line, /unmeasured — ledger corpus incomplete/);
  assert.ok(!/\d+ silent of/.test(line), "a refusal must never render as a measured figure");
});

// ── acceptance 1 + 7: A CADENCE FIRE RUNS THE CENSUS AND RECORDS IT, THE FIVE PRIOR VERBS
//    UNCHANGED IN BEHAVIOUR AND ORDER ───────────────────────────────────────────────────────────

test("runMeasurementCadenceReport attaches verbCensus last, leaving the existing fields unchanged", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: checkoutDir,
      escalate: false,
      gitLog: NO_GIT,
      checkoutDir,
    });
    assert.deepEqual(Object.keys(result), [
      "ruleEfficacy",
      "verdictCalibration",
      "autonomyRate",
      "adoptionReport",
      "adoptionMint",
      "boardReview",
      "proofDebtReport",
      "proofDebtMint",
      "verbCensus",
    ]);
    // The five prior verbs behave exactly as they did before this task — same refusal shapes
    // test/measurement-cadence.test.ts and test/adoption-report-has-a-producer.test.ts already pin.
    assert.equal(result.verdictCalibration.status, "refused");
    assert.match(result.verdictCalibration.refusedReason ?? "", /git history unavailable/);
    assert.equal(result.autonomyRate.status, "refused");
    assert.match(result.autonomyRate.refusedReason ?? "", /git history unavailable/);
    assert.ok(result.adoptionReport, "the fourth verb is still attached, unmoved");
    // The sixth verb: a real, measured outcome — "records its outcome" is this field's own
    // presence on the structured result every fire produces.
    assert.ok(result.verbCensus, "the sixth verb must always be attached");
    assert.equal(result.verbCensus!.status, "measured");
    assert.equal(result.verbCensus!.measurableCount, 3);
    assert.equal(result.verbCensus!.silentCount, 2);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("the measurement-cadence daemon hook attaches a verbCensus when called for real, unmocked", async () => {
  // Mirrors test/adoption-report-has-a-producer.test.ts's own "reachable through the daemon
  // producer, not only a mock" test exactly: no `run`/`check` override, so the real closure
  // (including `checkoutDir: repoRoot`) actually executes against THIS repo's real source.
  const root = tmp("rmd-vc-cadence-");
  try {
    mkdirSync(join(root, "state"), { recursive: true }); // no ledger archive: the corpus refuses
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config, now: () => new Date("2026-08-25T12:00:00Z") });
    const result = await hooks.runMeasurementCadence();
    assert.ok(result.verbCensus, "the real daemon producer must attach a verbCensus");
    assert.equal(result.verbCensus!.status, "refused", "no ledger archive exists in this fixture — refused, not a fabricated zero");
    assert.match(result.verbCensus!.refusedReason ?? "", /ledger corpus incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 2 + 8: THE DIGEST ITSELF CARRIES THE LINE, AND THIS ASSERTION IS NOT VACUOUS ────

test("the digest cadence hook delivers a real notification carrying the verb census's measured line", async () => {
  // Also unmocked (`checkoutDir: repoRoot`, wired inside buildDigestCadenceDaemonHooks itself) —
  // this exercises the REAL production wiring, not a stand-in. A single, harmless ledger rotation
  // (matching no measurable prefix) is enough to make the ledger union COMPLETE (`ok: true`), so
  // the census reports a real MEASURED figure rather than refusing on a bare fixture.
  const root = tmp("rmd-vc-digest-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.2026-08-01T00-00-00-000Z.ndjson"), `${JSON.stringify({ step: "unrelated.thing" })}\n`);
    const sent: string[] = [];
    const hooks = buildDigestCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-30T12:00:00Z"),
      channel: { send: (msg: string) => sent.push(msg) },
    });
    const result = await hooks.runDigestCadence();
    assert.ok(result.delivered);
    assert.equal(sent.length, 1);
    // THE NON-VACUOUS PART: this is the exact line `renderVerbCensusDigestLine` produces for a
    // measured result — removing the `suggestions` wiring in `buildDigestCadenceDaemonHooks`
    // (src/run-task.ts) drops this line from the delivered text entirely, and this assertion
    // fails. The digest is a surface an operator actually opens; this proves the count reaches it.
    assert.match(
      sent[0],
      /verb census \(measured\): \d+ silent of \d+ measurable verb\(s\) \(\d+ unmeasurable\)/,
      "the real, delivered digest text must carry the verb census's own line",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: NOTHING ON THIS PATH MINTS A PROPOSAL OR FILES A TASK ────────────────────────

test("nothing in runVerbCensus's own body mints a proposal, writes the registry, or files a task", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "measurement-cadence.ts"), "utf8");
  const start = src.indexOf("export function runVerbCensus(");
  assert.notEqual(start, -1, "runVerbCensus must exist in lib/measurement-cadence.ts");
  const end = src.indexOf("\nexport function renderVerbCensusDigestLine", start);
  assert.notEqual(end, -1, "renderVerbCensusDigestLine must immediately follow runVerbCensus");
  const body = src.slice(start, end);
  for (const forbidden of [
    "updateProposalRegistry",
    "mintAdoptionProposals",
    "mintProofDebtProposals",
    "escalateRepeatingRules",
    "writeFileSync",
    "mkdirSync",
  ]) {
    assert.ok(!body.includes(forbidden), `runVerbCensus must never call ${forbidden} — it is a report, never a minter`);
  }
});

// ── the unreadable-subtree arm of the source walk ─────────────────────────────────────────────
//
// `walkVerbCensusSources` skips a subtree it cannot read rather than letting the read error escape.
// That arm is unreachable through the real filesystem in this harness: the entry must be a
// DIRECTORY for the walk to recurse into it (so the ENOTDIR trick test/inflight-sweep-rung.test.ts
// uses does not apply), `chmod` is inert for uid 0, and a path long enough to throw ENAMETOOLONG
// cannot afterwards be removed by `rmSync` — MEASURED: rmSync fails ENAMETOOLONG on unlink and the
// tree survives, so that route litters the runner. Driven through the injected reader instead.

test("an unreadable subtree is absorbed by the walk — the census still returns a structured result, and the read error is never its reason", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    let threwFor = 0;
    const readdirImpl = ((dir: string, opts?: unknown) => {
      // Throw for the SUBTREE only — the top-level `src` read must succeed, or the walk never
      // recurses and this would prove nothing about the arm under test.
      if (dir.endsWith(`${"/"}lib`)) {
        threwFor += 1;
        throw Object.assign(new Error("EACCES: permission denied (injected)"), { code: "EACCES" });
      }
      return (fsDefault.readdirSync as (d: string, o?: unknown) => unknown)(dir, opts);
    }) as unknown as Parameters<typeof runVerbCensus>[0]["readdirImpl"];

    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion, readdirImpl });

    assert.ok(threwFor > 0, "the injected reader must actually have been asked for the subtree — otherwise this test drives nothing");
    // THE POINT: the walk does not let the read error escape. The census completes and answers in
    // its own vocabulary; losing the subtree costs it the prefixes that lived there, which is a
    // DIFFERENT fact from a read failure and is reported as such.
    assert.equal(r.status, "refused");
    assert.equal(r.refusedReason, "no scanned verb carries an attributable ledger prefix this run");
    assert.ok(!/EACCES|permission denied|injected/i.test(r.refusedReason ?? ""), "the read error must never surface as the census's reason");
    assert.equal(r.measurableCount, 0, "the prefixes lived in the subtree that was skipped");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("CONTROL: the same fixture WITHOUT the injected failure measures — so the assertion above is not vacuous", () => {
  const checkoutDir = buildVerbCensusFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildVerbCensusLedgerFixture(stateDir);
  try {
    const r = runVerbCensus({ checkoutDir, stateDir, ledgerUnion: resolveLedgerUnion });
    assert.equal(r.status, "measured", "the readable walk measures — the subtree IS load-bearing input");
    assert.equal(r.measurableCount, 3);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});
