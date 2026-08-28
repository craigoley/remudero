import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditRuntimeAdoption,
  declaredEnvVarNames,
  declaredLedgerSteps,
  type RuntimeAdoptionRow,
} from "../src/lib/producer-completeness.js";

// ── W1-T2408 — the fifth shape. W1-T2266's four shapes (symbol/field/script/gate) and
// producer-completeness above both ask a STATIC corpus whether a mechanism was WIRED. This file
// proves the report that instead asks a RUNNING one whether it ever RAN, over the two corpora
// (ledger union, deployed environment) neither of those already-owned checks reaches. Every
// fixture below is synthetic — never this host's real src/ or ledger.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One synthetic `src/` tree: a ledger-step-emitting file, a `panel.*`-shaped family that never
 *  fires, a governor-shaped step that only logs while deferring (the correctly-rare zero), an
 *  env seam nothing supplies, a supplied control env var, and a filename that LOOKS dotted but
 *  must never be read as a step. */
function buildFixtureSrc(): string {
  const root = tmp("rmd-runtime-adoption-src-");
  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(
    join(root, "src/lib/serve.ts"),
    [
      'appendLedger(p, { step: "serve.start" });',
      'appendLedger(p, { step: "panel.proposal_accepted" });',
      'appendLedger(p, { step: "panel.proposal_rejected" });',
      'log("daemon.cost_governor", {});',
      'const ACCOUNT_FILE_PATH_ENV = "RMD_ACCOUNT_FILE_PATH";',
      'const TOKEN_ENV = "RMD_SUPPLIED_TOKEN";',
      '// not a step: "package.json" and "scripts/orphan.mjs" look dotted but are filenames',
      'const notAStep = "package.json";',
    ].join("\n"),
  );
  return root;
}

/** One rotation file under `<stateDir>` carrying `serve.start` (the ledger control, fires) and
 *  `daemon.cost_governor` deliberately ABSENT (the healthy-governor zero) — `panel.*` is also
 *  absent (the inert zero the whole task is about). */
function buildLedgerFixture(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const lines = [
    '{"ts":"2026-08-01T00:00:00.000Z","host":"h","step":"serve.start"}',
    '{"ts":"2026-08-01T00:00:01.000Z","host":"h","step":"serve.start"}',
    '{"ts":"2026-08-01T00:00:02.000Z","host":"h","step":"serve.bind_failed"}',
  ];
  writeFileSync(join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson"), lines.join("\n") + "\n");
}

function runFixtureReport(srcRoot: string, stateDir: string): RuntimeAdoptionRow[] {
  return auditRuntimeAdoption({
    srcRoot,
    stateDir,
    env: { RMD_SUPPLIED_TOKEN: "present" }, // RMD_ACCOUNT_FILE_PATH deliberately absent
    ledgerControlName: "serve.start",
    envControlName: "RMD_SUPPLIED_TOKEN",
    possiblyHealthyZero: {
      "daemon.cost_governor":
        "DispatchGovernorState only ever logs while deferring; a zero means nothing was deferred, the healthy case",
    },
  });
}

function byName(rows: RuntimeAdoptionRow[], name: string): RuntimeAdoptionRow | undefined {
  return rows.find((r) => r.name === name);
}

// ── acceptance 1: A PURE REPORT FUNCTION RETURNS ROWS, NEVER A VERDICT OR BOOLEAN ──────────────

test("the report is a plain array of rows — no wrapping verdict object anywhere", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir);
  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    assert.ok(Array.isArray(rows), "the report itself must be an array — rows, not a verdict object");
    assert.ok(rows.length > 0, "the fixture must actually produce rows, or this proves nothing");
    for (const row of rows) {
      const keys = Object.keys(row);
      for (const bad of ["ok", "pass", "fail", "blocking", "gate", "verdict"]) {
        assert.ok(!keys.includes(bad), `row for ${row.name} must never carry a verdict-shaped field "${bad}"`);
      }
    }
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 2: DECLARED FROM SOURCE, NEVER FROM THE LEDGER'S OWN OBSERVED KEYS ───────────────

test("a step family that has never fired once is still enumerated, because it comes from src/ not the ledger", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir); // no panel.* line anywhere in this ledger

  // Prove the enumerator itself never touches the ledger: declaredLedgerSteps only takes srcRoot.
  const declared = declaredLedgerSteps(srcRoot).map((d) => d.name);
  assert.ok(declared.includes("panel.proposal_accepted"), "panel.* must be enumerated from src/ alone");
  assert.ok(declared.includes("panel.proposal_rejected"));
  assert.ok(!declared.includes("package.json"), "a file-extension-shaped literal must never be read as a step");

  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    const accepted = byName(rows, "panel.proposal_accepted");
    const rejected = byName(rows, "panel.proposal_rejected");
    assert.ok(accepted, "a family that never fired must still produce a row");
    assert.ok(rejected, "a family that never fired must still produce a row");
    assert.equal(accepted?.reading, 0);
    assert.equal(rejected?.reading, 0);
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 3: EVERY ROW NAMES THE CORPUS ITS READING CAME FROM ─────────────────────────────

test("a ledger zero and an environment zero are distinguishable by corpus alone, without reading code", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir);
  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    const ledgerZero = byName(rows, "panel.proposal_accepted");
    const envZero = byName(rows, "RMD_ACCOUNT_FILE_PATH");
    assert.equal(ledgerZero?.reading, 0);
    assert.equal(envZero?.reading, 0);
    assert.equal(ledgerZero?.corpus, "ledger");
    assert.equal(envZero?.corpus, "environment");
    assert.notEqual(ledgerZero?.corpus, envZero?.corpus, "two zeros from different corpora must not read alike");
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 4: EVERY ROW CARRIES A POPULATION CONTROL, SO A ZERO IS NEVER PRINTED ALONE ─────

test("every row's control proves the same read mechanism can see a nonzero", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir);
  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    const ledgerZero = byName(rows, "panel.proposal_accepted");
    assert.equal(ledgerZero?.control.label, "serve.start");
    assert.ok((ledgerZero?.control.reading ?? 0) > 0, "the ledger control must itself read nonzero (it fired twice)");

    const envZero = byName(rows, "RMD_ACCOUNT_FILE_PATH");
    assert.equal(envZero?.control.label, "RMD_SUPPLIED_TOKEN");
    assert.equal(envZero?.control.reading, 1, "the env control must itself read supplied");

    for (const row of rows) {
      assert.ok(row.control, `row for ${row.name} must carry a control`);
      assert.equal(typeof row.control.reading, "number");
    }
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 5: THE REPORT CARRIES ITS OWN LIMIT AS DATA ──────────────────────────────────────

test("a healthy-governor fixture comes back bearing the possibly-healthy-zero marker", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir); // daemon.cost_governor never fires — the healthy case
  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    const governor = byName(rows, "daemon.cost_governor");
    assert.ok(governor, "the governor step must still be enumerated");
    assert.equal(governor?.reading, 0);
    assert.equal(governor?.possiblyHealthyZero, true, "a healthy-governor zero must carry the marker");
    assert.ok(governor?.note?.includes("deferring"), "the marker must carry ITS reason, not a bare boolean");

    // The inert panel.* zero, by contrast, must NOT carry the marker — it was never allowlisted.
    const inert = byName(rows, "panel.proposal_accepted");
    assert.equal(inert?.possiblyHealthyZero, false);
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 6: NOTHING MAY REFUSE, THROW, EXIT, OR RETURN A FAILING STATUS ───────────────────

test("a nonexistent srcRoot and stateDir degrade to an empty report, never a throw", () => {
  assert.doesNotThrow(() => {
    const rows = auditRuntimeAdoption({
      srcRoot: "/nonexistent/rmd-runtime-adoption-src",
      stateDir: "/nonexistent/rmd-runtime-adoption-state",
      env: {},
      ledgerControlName: "serve.start",
      envControlName: "RMD_SUPPLIED_TOKEN",
    });
    assert.deepEqual(rows, [], "no declared names ⇒ no rows, not an error");
  });
});

test("an unreadable ledger union (archives present but unread) degrades to a noted zero, never a throw", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  // A file matching the rotation NAME pattern but holding invalid gzip content — resolveLedgerUnion
  // must mark this `unread`, not throw, and this report must not throw either.
  writeFileSync(join(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson.gz"), "not actually gzip");
  try {
    assert.doesNotThrow(() => {
      const rows = runFixtureReport(srcRoot, stateDir);
      const row = byName(rows, "panel.proposal_accepted");
      assert.equal(row?.reading, 0);
      assert.ok(row?.note?.includes("UNMEASURED"), "an unreadable union must say so, not silently report a clean zero");
    });
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

// ── acceptance 7: NO PER-SECTION REACHING FIGURE ────────────────────────────────────────────────

test("the report never produces a joinable per-section reaching fraction", () => {
  const srcRoot = buildFixtureSrc();
  const stateDir = join(srcRoot, "state");
  buildLedgerFixture(stateDir);
  try {
    const rows = runFixtureReport(srcRoot, stateDir);
    assert.ok(Array.isArray(rows), "the top-level shape is rows, not a section-summary object");
    for (const row of rows) {
      const keys = Object.keys(row);
      for (const bad of ["reaching", "reachingCount", "reachingFraction", "section", "sectionCount", "of"]) {
        assert.ok(!keys.includes(bad), `row for ${row.name} must never carry a section-reaching field "${bad}"`);
      }
    }
    // Sanity: declaredEnvVarNames on its own is also just names, never a fraction.
    const envNames = declaredEnvVarNames(srcRoot);
    assert.ok(Array.isArray(envNames));
    assert.ok(envNames.every((n) => typeof n.name === "string" && typeof n.declaredAt === "string"));
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
  }
});
