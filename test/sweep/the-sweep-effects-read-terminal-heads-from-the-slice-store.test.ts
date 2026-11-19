import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { resolveLedgerUnion } from "#src/lib/ledger-union.js";
import { parseLedger } from "#src/lib/retro.js";
import { buildSweepEffects, createEscalationTriageHistoryReader, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const terminalStep = "sweep.fix.uncreditable_head";
const escalatedStep = "sweep.fix.uncreditable_head_escalated";
const legacyPattern = /"step":"sweep\.fix\.uncreditable_head"|"step":"sweep\.fix\.uncreditable_head_escalated"/;
const standDownReason = `terminal uncreditable head already escalated for this PR@head (${escalatedStep})`;
const childFlag = "--terminal-heads-child";
const candidates = [1, 2, 3, 4, 5].map((prNumber) => ({ prNumber, headSha: `sha-${prNumber}` }));
candidates.push({ prNumber: 1, headSha: "sha-new-push" });

function terminal(prNumber: number) {
  return {
    step: terminalStep, pr_number: prNumber, head_sha: `sha-${prNumber}`, head: "foreign/fix",
    reason: "not_a_run_branch", terminal: true, repair_task_id: "W1-T12271", cause: "review",
  };
}

function escalated(prNumber: number) {
  return { step: escalatedStep, pr_number: prNumber, head_sha: `sha-${prNumber}` };
}

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "terminal-head-slices");
  const ledger = writeLedger([escalated(2), terminal(3), escalated(3), terminal(4)], {
    dir: join(root, "state"),
    rotations: [
      { at: "2026-11-01T00:00:00.000Z", gz: true, rows: [terminal(1), { step: "unrelated" }] },
      { at: "2026-11-02T00:00:00.000Z", gz: true, rows: [
        escalated(1), terminal(2), { ...terminal(5), reason: "wrong_task_id" }, escalated(5),
      ] },
    ],
  });
  const spacedEscalation = JSON.stringify(escalated(4)).replace('"step":"', '"step": "');
  writeFileSync(ledger.path, `${spacedEscalation}\n`, { flag: "a" });
  return { root, ...ledger };
}

interface BuildObservation {
  gunzips: number;
  stoodDown: typeof candidates;
}

function observeBuild(root: string, ledgerPath: string): BuildObservation {
  const gunzip = zlib.gunzipSync;
  let gunzips = 0;
  zlib.gunzipSync = (...args) => {
    gunzips++;
    return gunzip(...args);
  };
  syncBuiltinESMExports();
  try {
    const effects = buildSweepEffects({
      owner: "acme", repo: "scratch", config: { root } as never,
      ledgerPath, runId: "SWEEP-terminal-heads", plan: { tasks: [], byId: new Map() },
      log: () => {}, policy: DEFAULT_SWEEP_POLICY,
    });
    assert.ok(effects.terminalFixStandDown);
    const standDown = effects.terminalFixStandDown;
    const stoodDown = candidates.filter((candidate) => {
      const answer = standDown(candidate as OpenPrView);
      if (answer === undefined) return false;
      assert.equal(answer, standDownReason, `unexpected stand-down reason: ${answer}`);
      return true;
    });
    return { gunzips, stoodDown };
  } finally {
    zlib.gunzipSync = gunzip;
    syncBuiltinESMExports();
  }
}

function buildInNewProcess(root: string, ledgerPath: string): BuildObservation {
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    fileURLToPath(import.meta.url), childFlag, root, ledgerPath,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as BuildObservation;
}

if (process.argv[2] === childFlag) {
  process.stdout.write(JSON.stringify(observeBuild(process.argv[3]!, process.argv[4]!)));
} else {
  test("W1-T12271 criterion 1: a fresh sweep process decompresses no previously read rotations", (t) => {
    const { root, path } = fixture(t);
    const first = observeBuild(root, path);
    assert.equal(first.gunzips, 2, "a cold build decompresses both rotations");
    assert.deepEqual(first.stoodDown, candidates.slice(0, 3));

    const second = buildInNewProcess(root, path);
    assert.equal(second.gunzips, 0);
    assert.deepEqual(second.stoodDown, first.stoodDown);
  });

  test("W1-T12271 criterion 2: the sweep stands down the same heads as the ledger union", (t) => {
    const { root, dir, path } = fixture(t);
    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    assert.equal(union.archiveCount, 2);
    const rows = parseLedger(union.matches.join("\n"));
    const expected = candidates.filter(({ prNumber, headSha }) => {
      const headRows = rows.filter((row) => row.pr_number === prNumber && row.head_sha === headSha);
      return headRows.some((row) => row.step === terminalStep && row.reason === "not_a_run_branch" && row.terminal === true)
        && headRows.some((row) => row.step === escalatedStep);
    });
    assert.deepEqual(expected, candidates.slice(0, 3));
    assert.deepEqual(observeBuild(root, path).stoodDown, expected);
  });

  test("W1-T12271 criterion 3: an unread rotation invalidates the index even after a successful build", (t) => {
    const { root, dir, path } = fixture(t);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    const archive = join(dir, "ledger.2026-11-02T00-00-00-000Z.ndjson.gz");
    const original = readFileSync(archive);
    writeFileSync(archive, "unreadable gzip");

    const unread = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(unread.ok, false);
    assert.deepEqual(unread.unread, [archive]);
    assert.deepEqual(unread.matches, []);
    const unreadAnswer = observeBuild(root, path);
    assert.deepEqual(unreadAnswer, { gunzips: 1, stoodDown: candidates.slice(0, 3) },
      "a known terminal head stays blocked when its rotation becomes unreadable");

    writeFileSync(archive, original);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
  });

  test("W1-T12271 criterion 4: production sweep effects keep complete rotations when the live read fails", (t) => {
    const { root, dir, path } = fixture(t);
    unlinkSync(path);
    mkdirSync(path);

    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    assert.deepEqual(observeBuild(root, path), { gunzips: 2, stoodDown: candidates.slice(0, 1) });
  });

  test("W1-T12271: an unreadable rotation does not turn a cached slice into a universal stand-down", async (t) => {
    const { root, dir, path } = fixture(t);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    const slice = {
      holder: "sweep.terminal-uncreditable-heads",
      steps: [terminalStep, escalatedStep],
      version: "2",
      rawPattern: legacyPattern,
      sharedSnapshot: true,
      project: (row: Record<string, unknown>) => ({
        ts: row.ts, step: row.step, pr_number: row.pr_number, head_sha: row.head_sha,
        head: row.head, repair_task_id: row.repair_task_id, cause: row.cause, reason: row.reason, terminal: row.terminal,
      }),
    };
    await createEscalationTriageHistoryReader({ slice })(dir);
    const archive = join(dir, "ledger.2026-11-02T00-00-00-000Z.ndjson.gz");
    const access = fs.accessSync;
    try {
      fs.accessSync = ((candidate: Parameters<typeof fs.accessSync>[0], mode?: Parameters<typeof fs.accessSync>[1]) => {
        if (String(candidate) === archive) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return access(candidate, mode);
      }) as typeof fs.accessSync;
      syncBuiltinESMExports();
      assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 3) },
        "the cached projection keeps known heads blocked without standing down unrelated PRs");
    } finally {
      fs.accessSync = access;
      syncBuiltinESMExports();
    }
  });

  test("without rotations the sweep uses the caller's live ledger path", (t) => {
    const { dir: root } = ownedFixtureDir(t, "terminal-head-live-only");
    const { path: livePath } = writeLedger([terminal(1), escalated(1)], { dir: root });
    const path = join(root, "custom.ndjson");
    renameSync(livePath, path);

    assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 1) });
  });
}
