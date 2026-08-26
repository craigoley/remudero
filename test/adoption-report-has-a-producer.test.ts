import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADOPTION_SHAPE4_LIST_LAST_EDITED,
  ADOPTION_SHAPE4_PREDICATES,
  runMeasurementCadenceReport,
  type AdoptionFinding,
  type AdoptionReportResult,
} from "../src/lib/measurement-cadence.js";
import { buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2266 — the fourth verb: did anything anyone shipped ever gain an ADOPTER. Four shapes:
// a symbol with no caller, a plan field with no writer, a script with no invoker, a runtime gate
// with no subject. This file proves the eight acceptance criteria on this task's own shard, in
// that order, against SYNTHETIC fixtures (never this host's live repo/ledger state, which the
// task's own rationale (2) already measured moves under a snapshot).

/**
 * The two tests below make a file unreadable with `chmodSync(f, 0o000)` and assert that the
 * producer DEGRADES to empty text rather than throwing or counting the content as real. Under
 * uid 0 that premise cannot hold: root bypasses the permission bits and reads the file anyway,
 * so the producer sees the content, the "must never be seen" assertion fires, and the test fails
 * for a reason that has nothing to do with what it tests.
 *
 * MEASURED 2026-08-26 in a root container: `chmod 000 <file>` then reading it back SUCCEEDS. Both
 * tests failed there, and they fail identically on `origin/main` and on every PR head — which
 * reads as a base-caused outage and sends an investigation looking for a regression that does not
 * exist. A vacuous red costs more than an honest skip.
 *
 * SO THE REASON BELOW NAMES THE PREMISE, NOT THE SKIP. "Skipped under root" would leave the next
 * reader to rediscover why. This is NOT a weakened assertion and NOT a broader guard: the
 * assertions are unchanged, the `chmod` is unchanged, and the condition is `uid === 0` and
 * nothing else — CI's runner is non-root, so both tests still execute and can still fail there,
 * which is the only place their failure would mean anything.
 */
const ROOT_CANNOT_BE_DENIED_A_READ: string | false =
  typeof process.getuid === "function" && process.getuid() === 0
    ? "uid 0 — chmod 000 cannot deny root a read, so this test's unreadable-file premise never holds here; " +
      "the assertion is unchanged and still runs on CI's non-root runner"
    : false;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const NO_GIT = () => {
  throw new Error("no real git in this test — irrelevant to the adoption report");
};

/** Deterministic ship-date stub — never real git. Encodes (file, needle) into the returned
 *  string so a test can assert the finding's `shippedAt` actually threads THIS value through,
 *  rather than a hardcoded constant living somewhere else. */
const STUB_SHIP_DATE = (checkoutDir: string, file: string, needle?: string) => `stub-date:${file}:${needle ?? ""}`;

/** Recursive, sorted file listing — repo-relative-ish, just for before/after snapshots. */
function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * Builds one synthetic checkout with a live instance of each of the three STATIC shapes
 * (symbol/field/script), each paired with a CONTROL that must never be flagged — mirroring this
 * task's own rationale, which re-derives every zero against a control of the same kind the same
 * query CAN see.
 */
function buildFixtureCheckout(): string {
  const root = tmp("rmd-adopt-fixture-");

  // SHAPE 1 — symbol with no caller, plus a control that DOES have a cross-file caller.
  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(
    join(root, "src/lib/mechanism.ts"),
    "export function orphanMechanism(): number {\n  return 1;\n}\n\nexport function calledMechanism(): number {\n  return 2;\n}\n",
  );
  writeFileSync(join(root, "src/lib/caller.ts"), "import { calledMechanism } from \"./mechanism.js\";\ncalledMechanism();\n");

  // SHAPE 2 — field with no writer, plus a control field that IS written.
  writeFileSync(
    join(root, "src/lib/plan.ts"),
    "export interface Task {\n  id: string;\n  unadoptedField?: string;\n  usedField?: string;\n}\n",
  );
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan/tasks.yaml"), "- id: T1\n  usedField: hello\n");

  // SHAPE 3 — script with no invoker, plus a control script referenced from package.json.
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/orphan.mjs"), "console.log('never invoked');\n");
  writeFileSync(join(root, "scripts/invoked.mjs"), "console.log('invoked');\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { control: "node scripts/invoked.mjs" } }, null, 2));

  return root;
}

/** Builds one ledger rotation file under `<stateDir>/state` carrying `containment.probe` rows
 *  for the two DECLARED shape-4 predicates, plus a control field this scan must never surface
 *  (not on the declared list). `credentialExpiredTrue`/`credentialFailureTrue` let a caller flip
 *  a field to "adopted" for the gained-an-adopter test. */
function buildLedgerFixture(stateDir: string, opts: { credentialExpiredTrue?: boolean; credentialFailureTrue?: boolean } = {}): void {
  mkdirSync(stateDir, { recursive: true });
  const lines = [
    JSON.stringify({ step: "containment.probe", credential_expired: !!opts.credentialExpiredTrue, other: "x" }),
    JSON.stringify({ step: "containment.probe", credential_expired: false }),
    JSON.stringify({ step: "containment.probe", credential_failure: !!opts.credentialFailureTrue }),
    // A gate-shaped field that is NOT on the declared list — must never be reported (criterion 4).
    JSON.stringify({ step: "containment.probe", undeclared_gate: false }),
    JSON.stringify({ step: "other.step", credential_expired: true }),
  ];
  writeFileSync(join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson"), lines.join("\n") + "\n");
}

function runReport(checkoutDir: string | undefined, stateDir: string): AdoptionReportResult {
  const result = runMeasurementCadenceReport({
    stateDir,
    cwd: checkoutDir ?? stateDir,
    escalate: false,
    gitLog: NO_GIT,
    checkoutDir,
    shipDateFor: STUB_SHIP_DATE,
  });
  assert.ok(result.adoptionReport, "the producer must always attach an adoptionReport");
  return result.adoptionReport;
}

function findingsByShape(report: AdoptionReportResult, shape: AdoptionFinding["shape"]): AdoptionFinding[] {
  return report.findings.filter((f) => f.shape === shape);
}

// ── acceptance 1: THE REPORT NAMES EACH UNADOPTED MECHANISM WITH THE SHAPE IT BELONGS TO ──────

test("all four shapes are named on the report, each control cleared", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const report = runReport(checkoutDir, stateDir);

    const symbol = findingsByShape(report, "symbol-no-caller");
    assert.ok(symbol.some((f) => f.mechanism === "orphanMechanism"), "the unwired symbol must be named");
    assert.ok(!symbol.some((f) => f.mechanism === "calledMechanism"), "the cross-file-called control must clear");

    const field = findingsByShape(report, "field-no-writer");
    assert.ok(field.some((f) => f.mechanism === "unadoptedField:"), "the never-written field must be named");
    assert.ok(!field.some((f) => f.mechanism === "usedField:"), "the written control field must clear");

    const script = findingsByShape(report, "script-no-invoker");
    assert.ok(script.some((f) => f.mechanism === "scripts/orphan.mjs"), "the un-invoked script must be named");
    assert.ok(!script.some((f) => f.mechanism === "scripts/invoked.mjs"), "the package.json-referenced control must clear");

    const gate = findingsByShape(report, "gate-no-subject");
    assert.ok(gate.some((f) => f.mechanism === "credential_expired"));
    assert.ok(gate.some((f) => f.mechanism === "credential_failure"));
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 2: REACHABLE THROUGH THE DAEMON PRODUCER, NOT ONLY THE CLI ─────────────────────

test("the daemon's own producer hook attaches an adoptionReport when called for real, unmocked", async () => {
  // `buildMeasurementCadenceDaemonHooks` is exactly what `daemonCommand`'s call site constructs
  // (src/run-task.ts) and what `lib/daemon.ts`'s poll loop consults — this test calls it with NO
  // `run`/`check` override, so the real closure (including this task's new `checkoutDir:
  // repoRoot` wiring) actually executes, never a mock standing in for it. There is no separate
  // CLI subcommand for this verb at all — the daemon producer is the ONLY reachable path, which
  // trivially clears "not only through the CLI".
  const root = tmp("rmd-adopt-hook-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config, now: () => new Date("2026-08-25T12:00:00Z") });
    const result = await hooks.runMeasurementCadence();
    assert.ok(result.adoptionReport, "the real daemon producer must attach an adoptionReport");
    assert.ok(Array.isArray(result.adoptionReport.findings));
    assert.equal(typeof result.adoptionReport.shape4ListSize, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3: EVERY REPORTED COUNT CARRIES ITS MECHANISM'S SHIP DATE ──────────────────────

test("every static-shape finding carries the ship date threaded through shipDateFor", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const report = runReport(checkoutDir, stateDir);
    const symbol = findingsByShape(report, "symbol-no-caller").find((f) => f.mechanism === "orphanMechanism");
    assert.equal(symbol?.shippedAt, "stub-date:src/lib/mechanism.ts:orphanMechanism");

    const field = findingsByShape(report, "field-no-writer").find((f) => f.mechanism === "unadoptedField:");
    assert.equal(field?.shippedAt, "stub-date:src/lib/plan.ts:unadoptedField?:");

    const script = findingsByShape(report, "script-no-invoker").find((f) => f.mechanism === "scripts/orphan.mjs");
    assert.equal(script?.shippedAt, "stub-date:scripts/orphan.mjs:");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("every shape-4 finding carries its predicate's declared ship date", () => {
  const stateDir = tmp("rmd-adopt-ledger-");
  buildLedgerFixture(stateDir);
  try {
    const report = runReport(undefined, stateDir);
    const gate = findingsByShape(report, "gate-no-subject");
    for (const f of gate) {
      const predicate = ADOPTION_SHAPE4_PREDICATES.find((p) => p.mechanism === f.mechanism);
      assert.ok(predicate, `${f.mechanism} must be a declared predicate`);
      assert.equal(f.shippedAt, predicate!.shippedAt);
      assert.match(f.shippedAt, /^\d{4}-\d{2}-\d{2}$/, "a real date, never a placeholder");
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── acceptance 4: A SHAPE-4 INSTANCE IS READ FROM A DECLARED LIST, NEVER DISCOVERED ────────────

test("a gate-shaped field NOT on the declared list is never surfaced, however gate-like its data looks", () => {
  const stateDir = tmp("rmd-adopt-undeclared-");
  buildLedgerFixture(stateDir); // includes `undeclared_gate`: present, always false — gate-shaped
  try {
    const report = runReport(undefined, stateDir);
    assert.ok(
      !report.findings.some((f) => f.mechanism === "undeclared_gate"),
      "shape 4 can only ever report what ADOPTION_SHAPE4_PREDICATES names, never a discovered field",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── acceptance 5: THE DECLARED LIST REPORTS ITS OWN SIZE AND LAST EDIT BESIDE ITS FINDINGS ─────

test("shape4ListSize/shape4ListLastEdited travel with the report, even when nothing is found", () => {
  const stateDir = tmp("rmd-adopt-listmeta-");
  mkdirSync(stateDir, { recursive: true }); // no ledger at all — zero findings, list metadata still present
  try {
    const report = runReport(undefined, stateDir);
    assert.equal(report.shape4ListSize, ADOPTION_SHAPE4_PREDICATES.length);
    assert.ok(report.shape4ListSize > 0, "sanity: the declared list is not itself empty");
    assert.equal(report.shape4ListLastEdited, ADOPTION_SHAPE4_LIST_LAST_EDITED);
    assert.match(report.shape4ListLastEdited, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── acceptance 6: THE VERB WRITES NOTHING AND FILES NOTHING ───────────────────────────────────

test("a run with plenty to report leaves the checkout and state dir byte-for-byte untouched", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  const beforeCheckout = listAllFiles(checkoutDir);
  try {
    const report = runReport(checkoutDir, stateDir);
    assert.ok(report.findings.length > 0, "the fixture must actually produce findings, or this proves nothing");
    const afterCheckout = listAllFiles(checkoutDir);
    assert.deepEqual(afterCheckout, beforeCheckout, "no file created, removed, or renamed anywhere under the checkout");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 7: NO RESULT OF THE REPORT CAN FAIL A CHECK OR BLOCK A MERGE ────────────────────

test("the report is plain data — no pass/fail/ok/blocking field for anything to gate on", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const report = runReport(checkoutDir, stateDir);
    assert.deepEqual(
      Object.keys(report).sort(),
      ["findings", "shape4ListLastEdited", "shape4ListSize", "shape4Unmeasurable"].sort(),
      "no verdict-shaped field (ok/pass/fail/blocking) exists for a caller to gate on",
    );
    // A report with findings must not throw, exit non-zero, or otherwise behave as a failure —
    // it already didn't throw to get here; this just names that as the assertion.
    assert.ok(report.findings.length > 0);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── acceptance 8: A MECHANISM THAT GAINED AN ADOPTER STOPS BEING REPORTED ──────────────────────

test("SHAPE 1: a symbol gains a caller and drops off the report", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const before = runReport(checkoutDir, stateDir);
    assert.ok(findingsByShape(before, "symbol-no-caller").some((f) => f.mechanism === "orphanMechanism"));

    writeFileSync(join(checkoutDir, "src/lib/caller.ts"), "import { orphanMechanism, calledMechanism } from \"./mechanism.js\";\norphanMechanism();\ncalledMechanism();\n");

    const after = runReport(checkoutDir, stateDir);
    assert.ok(!findingsByShape(after, "symbol-no-caller").some((f) => f.mechanism === "orphanMechanism"), "an adopted symbol must stop being reported");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 2: a field gains a writer and drops off the report", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const before = runReport(checkoutDir, stateDir);
    assert.ok(findingsByShape(before, "field-no-writer").some((f) => f.mechanism === "unadoptedField:"));

    writeFileSync(join(checkoutDir, "plan/tasks.yaml"), "- id: T1\n  usedField: hello\n  unadoptedField: now-set\n");

    const after = runReport(checkoutDir, stateDir);
    assert.ok(!findingsByShape(after, "field-no-writer").some((f) => f.mechanism === "unadoptedField:"), "an adopted field must stop being reported");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 3: a script gains an invoker and drops off the report", () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  try {
    const before = runReport(checkoutDir, stateDir);
    assert.ok(findingsByShape(before, "script-no-invoker").some((f) => f.mechanism === "scripts/orphan.mjs"));

    writeFileSync(
      join(checkoutDir, "package.json"),
      JSON.stringify({ scripts: { control: "node scripts/invoked.mjs", second: "node scripts/orphan.mjs" } }, null, 2),
    );

    const after = runReport(checkoutDir, stateDir);
    assert.ok(!findingsByShape(after, "script-no-invoker").some((f) => f.mechanism === "scripts/orphan.mjs"), "an adopted script must stop being reported");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 4: a gate observes a true subject and drops off the report", () => {
  const stateDir = tmp("rmd-adopt-shape4-flip-");
  buildLedgerFixture(stateDir);
  try {
    const before = runReport(undefined, stateDir);
    assert.ok(findingsByShape(before, "gate-no-subject").some((f) => f.mechanism === "credential_expired"));

    buildLedgerFixture(stateDir, { credentialExpiredTrue: true });

    const after = runReport(undefined, stateDir);
    assert.ok(
      !findingsByShape(after, "gate-no-subject").some((f) => f.mechanism === "credential_expired"),
      "a gate that observed a true subject must stop being reported",
    );
    assert.ok(
      findingsByShape(after, "gate-no-subject").some((f) => f.mechanism === "credential_failure"),
      "an UNRELATED predicate must still be reported — the flip is per-mechanism, not global",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── unreachable-I/O branches (never a caller's mocked path) — proven directly so a real,
// non-git checkout / an absent schema file / an unreadable plan or workflow file all degrade
// exactly as documented, rather than only appearing "covered" through a stub that never lets
// the real catch branch fire. ─────────────────────────────────────────────────────────────────

test("shipDateFor omitted + a real, non-git checkout ⇒ the default git-log resolver's own catch fires, 'unknown'", () => {
  // No shipDateFor override here — this is the ONE test in this file that lets the module's own
  // default (`defaultAdoptionShipDate`) run for real. The checkout has no `.git` at all, so its
  // `git log -S <needle> -- <file>` read throws ("not a git repository") and the resolver's catch
  // must degrade to the literal string "unknown" rather than propagate.
  const checkoutDir = tmp("rmd-adopt-nogit-");
  try {
    mkdirSync(join(checkoutDir, "src/lib"), { recursive: true });
    writeFileSync(join(checkoutDir, "src/lib/mechanism.ts"), "export function orphanMechanism(): number {\n  return 1;\n}\n");
    const result = runMeasurementCadenceReport({
      stateDir: join(checkoutDir, "state"),
      cwd: checkoutDir,
      escalate: false,
      gitLog: NO_GIT,
      checkoutDir,
      // shipDateFor deliberately omitted
    });
    const finding = result.adoptionReport?.findings.find((f) => f.shape === "symbol-no-caller" && f.mechanism === "orphanMechanism");
    assert.ok(finding, "the orphaned symbol must still be found even off the real resolver");
    assert.equal(finding?.shippedAt, "unknown", "a git-log failure in a non-git checkout must degrade to 'unknown', never throw");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 2: no src/lib/plan.ts in the checkout ⇒ the schema read's own catch fires, zero findings, no throw", () => {
  const checkoutDir = tmp("rmd-adopt-noschema-");
  try {
    mkdirSync(join(checkoutDir, "src/lib"), { recursive: true }); // deliberately no plan.ts written under it
    const report = runReport(checkoutDir, join(checkoutDir, "state"));
    assert.deepEqual(findingsByShape(report, "field-no-writer"), [], "an absent schema file must read as zero fields, never throw");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 2: an unreadable plan/ file degrades to empty text — the writer search still finds the readable file", { skip: ROOT_CANNOT_BE_DENIED_A_READ }, () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  const unreadable = join(checkoutDir, "plan/unreadable.yaml");
  writeFileSync(unreadable, "unadoptedField: this-must-never-be-seen\n");
  chmodSync(unreadable, 0o000);
  try {
    const report = runReport(checkoutDir, stateDir);
    // The unreadable file's content is invisible (read failed ⇒ "") so the field it "writes" must
    // still report as unadopted — proving the catch degraded to "" rather than surfacing an error
    // OR silently treating the unreadable file's content as a real write.
    assert.ok(
      findingsByShape(report, "field-no-writer").some((f) => f.mechanism === "unadoptedField:"),
      "an unreadable plan file's content must never count as a write",
    );
    // The readable control fixture (plan/tasks.yaml, `usedField: hello`) must still be found.
    assert.ok(!findingsByShape(report, "field-no-writer").some((f) => f.mechanism === "usedField:"));
  } finally {
    chmodSync(unreadable, 0o644);
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("SHAPE 4: a ledger with no containment.probe row at all leaves both predicates unmeasurable, never a false pass", () => {
  // A real ROTATION file (so `resolveLedgerUnion` reports `ok: true`, real archive present) whose
  // rows never match either predicate's `ledgerLinePattern` at all — `present` stays 0 for both,
  // which must land each predicate's id on `shape4Unmeasurable`, never silently counted as clean.
  const stateDir = tmp("rmd-adopt-shape4-nomatch-");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson"),
    [JSON.stringify({ step: "unrelated.thing", note: "no containment.probe row here at all" })].join("\n") + "\n",
  );
  try {
    const report = runReport(undefined, stateDir);
    assert.deepEqual(
      report.shape4Unmeasurable.slice().sort(),
      ADOPTION_SHAPE4_PREDICATES.map((p) => p.id).sort(),
      "a ledger with zero matching rows must mark BOTH declared predicates unmeasurable",
    );
    assert.deepEqual(findingsByShape(report, "gate-no-subject"), [], "unmeasurable is never read as a clean pass");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("SHAPE 4: a malformed JSON line that still text-matches the pattern is skipped, never thrown", () => {
  // The line below CONTAINS the literal text `"step": "containment.probe"` (so the regex — a
  // plain text match, not a JSON parse — selects it into `matches`) but is not valid JSON
  // (unquoted key, unterminated object). `scanShape4Gates`'s own `JSON.parse` must catch this and
  // `continue`, counting it toward neither `present` nor `trueCount`, and the run must not throw.
  const stateDir = tmp("rmd-adopt-shape4-malformed-");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson"),
    [
      '{"step": "containment.probe", credential_expired: true', // malformed — text-matches, parse-fails
      JSON.stringify({ step: "containment.probe", credential_expired: false }), // real, present, never true
    ].join("\n") + "\n",
  );
  try {
    const report = runReport(undefined, stateDir);
    assert.ok(
      findingsByShape(report, "gate-no-subject").some((f) => f.mechanism === "credential_expired"),
      "the one well-formed, present-but-never-true row must still be counted despite the malformed sibling line",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("SHAPE 3: an unreadable .github/workflows file degrades to empty text, never throws", { skip: ROOT_CANNOT_BE_DENIED_A_READ }, () => {
  const checkoutDir = buildFixtureCheckout();
  const stateDir = join(checkoutDir, "state");
  buildLedgerFixture(stateDir);
  mkdirSync(join(checkoutDir, ".github/workflows"), { recursive: true });
  const unreadable = join(checkoutDir, ".github/workflows/unreadable.yml");
  writeFileSync(unreadable, "run: node scripts/orphan.mjs\n");
  chmodSync(unreadable, 0o000);
  try {
    const report = runReport(checkoutDir, stateDir);
    // The unreadable workflow's own reference to scripts/orphan.mjs must never be seen ⇒ the
    // script is still reported as un-invoked, proving the read failure degraded to "" rather than
    // throwing or silently counting as a real reference.
    assert.ok(
      findingsByShape(report, "script-no-invoker").some((f) => f.mechanism === "scripts/orphan.mjs"),
      "an unreadable workflow file's content must never count as an invocation",
    );
  } finally {
    chmodSync(unreadable, 0o644);
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});
