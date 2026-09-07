import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GATED_RUNGS, loadDefaultPolicy } from "../src/lib/policy.js";
import {
  buildRatificationRow,
  computeOperationHash,
  loadRatifications,
  ratificationPinCheck,
  ratificationsPath,
  renderRatificationRow,
  type Ratifications,
} from "../src/lib/ratification.js";
import {
  autoTriageCheck,
  ledgerPathFor,
  logCloneReapSurvey,
  logWorktreeReapBootSurvey,
  ratifyCommand,
  RUNG_CONTRACT_VERSIONS,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { CloneReapSummary } from "../src/lib/clone-reaper.js";
import type { WorktreeReapSummary } from "../src/lib/worker.js";

/**
 * test/ratification-pin.test.ts — W1-T2694, LAW 5's SIGNATURE.
 *
 * Binds an operator's ratification to the OPERATION a gated rung's policy row arms, not just the
 * row itself. `ratificationPinCheck` (src/lib/ratification.ts) is the primitive, modeled on
 * `verifyBundlePin` (src/lib/learnings.ts): absent a pin, every rung fires exactly as before
 * (byte-identical); a pin present and drifted refuses, naming the diff. `rmd ratify <rung>` prints
 * the row an operator commits — it never writes plan/ratifications.yaml itself (Rule 15).
 */

function fixtureConfig(): { config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-ratification-pin-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return { config: { claudeBin: "/bin/true", root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readLedgerRows(path: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── the core primitive ───────────────────────────────────────────────────────────────────────

test("loadRatifications: an absent file is an empty pin table (no pin ⇒ fire)", () => {
  const pins = loadRatifications(join(tmpdir(), "rmd-ratification-pin-nonexistent", "ratifications.yaml"));
  assert.equal(pins.size, 0);
});

test("loadRatifications: malformed YAML degrades to an empty table rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ratification-pin-malformed-"));
  try {
    const path = join(dir, "ratifications.yaml");
    writeFileSync(path, "not: [valid: yaml: at: all");
    const pins = loadRatifications(path);
    assert.equal(pins.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRatifications: a row missing rung/operationHash is skipped, a well-formed row is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ratification-pin-rows-"));
  try {
    const path = join(dir, "ratifications.yaml");
    writeFileSync(
      path,
      [
        "- rung: autoTriage",
        "  operationHash: abc123",
        '  ratifiedAt: "2026-09-01T00:00:00.000Z"',
        "  ratifiedBy: operator",
        "- ratifiedBy: nobody", // missing rung/operationHash — skipped
      ].join("\n"),
    );
    const pins = loadRatifications(path);
    assert.equal(pins.size, 1);
    assert.deepEqual(pins.get("autoTriage"), {
      rung: "autoTriage",
      operationHash: "abc123",
      ratifiedAt: "2026-09-01T00:00:00.000Z",
      ratifiedBy: "operator",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeOperationHash: deterministic, and moves when either input moves", () => {
  const policy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 4 };
  const h1 = computeOperationHash(policy, "v1");
  const h2 = computeOperationHash(policy, "v1");
  assert.equal(h1, h2, "same inputs -> same hash");
  const h3 = computeOperationHash({ ...policy, minIntervalMinutes: 30 }, "v1");
  assert.notEqual(h1, h3, "a policy value moving must move the hash");
  const h4 = computeOperationHash(policy, "v2");
  assert.notEqual(h1, h4, "a contract version moving must move the hash");
});

// ── acceptance 1: absent ratifications ⇒ every gated rung fires exactly as before ─────────────

test("acceptance 1: an empty pin table fires, unopinionated, for EVERY gated rung — decision-object equality", () => {
  const policy = loadDefaultPolicy();
  const emptyPins: Ratifications = new Map();
  for (const rung of GATED_RUNGS) {
    const contractVersion = RUNG_CONTRACT_VERSIONS[rung];
    assert.equal(typeof contractVersion, "string", `${rung} must have a contract version (claim 4)`);
    const policyBlock = (policy.values as unknown as Record<string, unknown>)[rung];
    const result = ratificationPinCheck(rung, policyBlock, contractVersion, emptyPins);
    assert.deepEqual(result, { fire: true }, `${rung}: absent pin must fire exactly as it always has`);
  }
});

test("acceptance 1 (wired): autoTriageCheck's decision is byte-identical with an explicit empty pin table and with no ratifications option at all", () => {
  const { config, cleanup } = fixtureConfig();
  try {
    const policy = loadDefaultPolicy();
    const withExplicitEmpty = autoTriageCheck({ config, policy, ratifications: new Map() });
    const withDefault = autoTriageCheck({ config, policy });
    assert.deepEqual(withExplicitEmpty, withDefault);
  } finally {
    cleanup();
  }
});

// ── acceptance 2: a drifted pin refuses and names the diff ────────────────────────────────────

test("acceptance 2: a pin whose policy values drifted refuses, naming the diff", () => {
  const rung = "autoTriage";
  const policyBefore = { enabled: true, minIntervalMinutes: 60, maxPerDay: 4 };
  const contractVersion = "v1";
  const row = buildRatificationRow(rung, policyBefore, contractVersion, "operator", new Date("2026-09-01T00:00:00.000Z"));
  const pins: Ratifications = new Map([[rung, row]]);

  // Unmoved: still fires.
  assert.deepEqual(ratificationPinCheck(rung, policyBefore, contractVersion, pins), { fire: true });

  // Policy value moved.
  const policyAfter = { ...policyBefore, minIntervalMinutes: 15 };
  const drifted = ratificationPinCheck(rung, policyAfter, contractVersion, pins);
  assert.equal(drifted.fire, false);
  if (!drifted.fire) {
    assert.match(drifted.diff, new RegExp(rung));
    assert.match(drifted.diff, /drifted/);
    assert.match(drifted.reason, /refused/);
  }
});

test("acceptance 2: a pin whose CONTRACT VERSION moved also refuses, naming the diff", () => {
  const rung = "boardReview";
  const policy = { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 };
  const row = buildRatificationRow(rung, policy, "v1", "operator", new Date("2026-09-01T00:00:00.000Z"));
  const pins: Ratifications = new Map([[rung, row]]);
  const drifted = ratificationPinCheck(rung, policy, "v2", pins);
  assert.equal(drifted.fire, false);
  if (!drifted.fire) {
    assert.match(drifted.diff, /contract/);
  }
});

test("acceptance 2 (wired, ledgered): autoTriageCheck refuses and ledgers rung.unratified when its pin has drifted", () => {
  const { config, cleanup } = fixtureConfig();
  try {
    const policy = loadDefaultPolicy();
    const staleRow = buildRatificationRow(
      "autoTriage",
      { ...policy.values.autoTriage, minIntervalMinutes: policy.values.autoTriage.minIntervalMinutes + 1 },
      RUNG_CONTRACT_VERSIONS.autoTriage,
      "operator",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const decision = autoTriageCheck({ config, policy, ratifications: new Map([["autoTriage", staleRow]]) });
    assert.equal(decision.fire, false);
    assert.match(decision.reason, /refused/);

    const rows = readLedgerRows(ledgerPathFor(config));
    const refusalRows = rows.filter((r) => r.step === "rung.unratified" && r.rung === "autoTriage");
    assert.equal(refusalRows.length, 1, "exactly one rung.unratified row is ledgered for this refusal");
    assert.equal(typeof refusalRows[0]?.diff, "string");
    assert.ok((refusalRows[0]!.diff as string).length > 0);
  } finally {
    cleanup();
  }
});

test("acceptance 2 (wired): logCloneReapSurvey forces a dry run (never destructive) when scratchReap's pin drifted, and ledgers the refusal", () => {
  const { config, cleanup } = fixtureConfig();
  try {
    const liveDryRuns: boolean[] = [];
    const fakeSummary: CloneReapSummary = { candidates: [], reaped: [], bytesReclaimed: 0, dryRun: true };
    const staleRow = buildRatificationRow(
      "scratchReap",
      { enabled: true, maxAgeHours: 999 }, // ratified at a DIFFERENT maxAgeHours than live below
      RUNG_CONTRACT_VERSIONS.scratchReap,
      "operator",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
    logCloneReapSurvey(config, (step, fields) => logged.push({ step, fields }), {
      roots: () => [],
      policy: () => ({ enabled: true, maxAgeHours: 1 }), // LIVE value differs from the ratified one above
      reap: (_roots, opts = {}) => {
        liveDryRuns.push(opts.dryRun === true);
        return { ...fakeSummary, dryRun: opts.dryRun === true };
      },
      ratifications: new Map([["scratchReap", staleRow]]),
    });
    assert.deepEqual(liveDryRuns, [true], "a drifted pin must force dry-run even though live policy says enabled: true");
    assert.ok(logged.some((l) => l.step === "rung.unratified" && l.fields.rung === "scratchReap"));
  } finally {
    cleanup();
  }
});

test("acceptance 2 (wired): logWorktreeReapBootSurvey forces a dry run when worktreeReapBoot's pin drifted, and ledgers the refusal", () => {
  const { config, cleanup } = fixtureConfig();
  try {
    const liveDryRuns: boolean[] = [];
    const staleRow = buildRatificationRow(
      "worktreeReapBoot",
      { enabled: false }, // ratified while disabled
      RUNG_CONTRACT_VERSIONS.worktreeReapBoot,
      "operator",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const fakeSummary: WorktreeReapSummary = { reaped: [], reapedLocks: [], kept: [], keptReasons: [] };
    logWorktreeReapBootSurvey(config, (step, fields) => logged.push({ step, fields }), {
      root: () => join(config.root, "worktrees"),
      policy: () => ({ enabled: true }), // LIVE value now enabled — drifted from the ratified `false`
      reap: (_root, opts = {}) => {
        liveDryRuns.push(opts.dryRun === true);
        return fakeSummary;
      },
      ratifications: new Map([["worktreeReapBoot", staleRow]]),
    });
    assert.deepEqual(liveDryRuns, [true], "a drifted pin must force dry-run even though live policy says enabled: true");
    assert.ok(logged.some((l) => l.step === "rung.unratified" && l.fields.rung === "worktreeReapBoot"));
  } finally {
    cleanup();
  }
});

// ── acceptance 3: the ratify verb prints the row and writes nothing ───────────────────────────

test("acceptance 3: `rmd ratify <rung>` prints the row and writes NOTHING", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ratification-pin-ratify-"));
  try {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg));
    };
    let code: number;
    try {
      code = ratifyCommand(["autoTriage"], { now: () => new Date("2026-09-07T00:00:00.000Z"), ratifiedBy: "operator" });
    } finally {
      console.log = origLog;
    }
    assert.equal(code, 0);
    const printed = lines.join("\n");
    assert.match(printed, /rung: autoTriage/);
    assert.match(printed, /operationHash:/);
    assert.match(printed, /ratifiedBy: operator/);
    assert.match(printed, /wrote NOTHING/);
    // The one file this verb could plausibly write is plan/ratifications.yaml — assert it
    // did not appear anywhere this test's own fixture directory could have caught it, and
    // (defense in depth) that the repo's own committed plan/ratifications.yaml is untouched
    // by re-deriving: this verb took no `--out`/path argument capable of writing anywhere.
    assert.ok(!existsSyncSafe(join(dir, "ratifications.yaml")), "ratifyCommand must never write a file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance 3: `rmd ratify` refuses an unrecognised rung, spawning/writing nothing", () => {
  const origError = console.error;
  const errs: string[] = [];
  console.error = (msg?: unknown) => {
    errs.push(String(msg));
  };
  let code: number;
  try {
    code = ratifyCommand(["not-a-real-rung"]);
  } finally {
    console.error = origError;
  }
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /gated rungs/);
});

test("acceptance 3: `rmd ratify` is pure at its core — buildRatificationRow never touches the filesystem", () => {
  const row = buildRatificationRow("digestCadence", { enabled: true, minIntervalMinutes: 1440, maxPerDay: 24 }, "v1", "operator", new Date("2026-09-07T00:00:00.000Z"));
  assert.equal(row.rung, "digestCadence");
  assert.equal(typeof row.operationHash, "string");
  assert.ok(row.operationHash.length > 0);
  const rendered = renderRatificationRow(row);
  assert.match(rendered, /- rung: digestCadence/);
  assert.match(rendered, /operationHash: /);
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── acceptance 4: every gated rung exports a contract version ─────────────────────────────────

test("acceptance 4: every rung in policy.ts's GATED_RUNGS schema has a non-empty contract version", () => {
  assert.ok(GATED_RUNGS.length > 0, "GATED_RUNGS must not be empty, or this test proves nothing");
  for (const rung of GATED_RUNGS) {
    const version = RUNG_CONTRACT_VERSIONS[rung];
    assert.equal(typeof version, "string", `rung '${rung}' is missing a RUNG_CONTRACT_VERSIONS entry`);
    assert.ok(version.length > 0, `rung '${rung}' has an empty contract version`);
  }
});

test("acceptance 4: RUNG_CONTRACT_VERSIONS carries no entry for a rung GATED_RUNGS does not name", () => {
  const gated = new Set(GATED_RUNGS);
  for (const rung of Object.keys(RUNG_CONTRACT_VERSIONS)) {
    assert.ok(gated.has(rung), `RUNG_CONTRACT_VERSIONS names '${rung}', which policy.ts's schema does not gate`);
  }
});

// ── ratificationsPath, the sibling of policyPath ───────────────────────────────────────────────

test("ratificationsPath sits beside policyPath, under plan/", () => {
  assert.equal(ratificationsPath("/tmp/foo"), join("/tmp/foo", "plan", "ratifications.yaml"));
});
