// W1-T14314 — the security producer (W1-T13787) opens a SQLite lock at `<ledger>.security-producer.lock.sqlite`, and
// SQLite leaves the file in place. listedLedgerFiles called it unclassified, so every strict history reader refused:
// OBSERVED, the fleet reconciler repaired nothing for 28 hours. The lock is the ledger's own file now, by exact name,
// and a source census fails the next time src builds a ledger sidecar the classifier would not recognise.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import * as ledgerPathModule from "#src/lib/ledger-path.js";
import {
  LEDGER_CARRIED_PREFIX_SUFFIX,
  LEDGER_FILENAME,
  LEDGER_RETAINED_STEPS_SUFFIX,
  LEDGER_ROTATION_LOCK_SUFFIX,
  LEDGER_SECURITY_PRODUCER_LOCK_SUFFIX,
} from "#src/lib/ledger-path.js";
import { listedLedgerFiles } from "#src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildSweepEffects, lightPassHeadContractRefresh, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const SCRATCH = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14314-`));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const LOCK = `${LEDGER_FILENAME}${LEDGER_SECURITY_PRODUCER_LOCK_SUFFIX}`;
const NOW = Date.parse("2026-11-22T13:43:00Z");
const HEAD = "14314".padEnd(40, "0");
const ARM_PR = 14301;
const HOLD_PR = 14302;
const HOLD_TASK = "W1-T14302";

function pr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: n, prUrl: `https://github.com/craigoley/remudero/pull/${n}`, taskId: `W1-T${n}`, reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-22T12:00:00Z", headSha: HEAD,
    autoMergeArmed: false, ...over };
}

/** A clean archived verdict (the arm decision's), an archived head-contract hold, and an archived fleet row. */
const ARCHIVED: Array<Record<string, unknown>> = [
  { ts: "2026-11-21T07:00:00.000Z", run_id: "DAEMON-1", task_id: `W1-T${ARM_PR}`, step: "review.posted", context: "remudero-review",
    state: "success", pr_url: pr(ARM_PR).prUrl, head_sha: HEAD, proof_exec: ["executed_pass"], capped: false,
    keyword_only: false, plan_only: false },
  { ts: "2026-11-21T07:10:00.000Z", step: "fix.contract_hold", kind: "open-escalation", task_id: HOLD_TASK,
    pr_url: pr(HOLD_PR).prUrl, head_sha: HEAD, contract_revision: "contract-A" },
  { ts: "2026-11-21T07:20:00.000Z", step: "reconcile.escalated", target: "archived-fleet-row" },
];

let fixtures = 0;
/** `<root>/state` holding the live ledger, one rotation, and `extra` (each an empty file, as the producer leaves it). */
function stateWith(extra: readonly string[]) {
  const root = join(SCRATCH, `case-${fixtures++}`);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "ci.yml"), "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
  writeLedger([{ ts: "2026-11-22T13:00:00.000Z", run_id: "DAEMON-1", task_id: "W1-T1", step: "heartbeat.tick" }],
    { dir: stateDir, rotations: [{ at: "2026-11-21T08:00:00.000Z", rows: ARCHIVED }] });
  for (const name of extra) writeFileSync(join(stateDir, name), "");
  return { root, stateDir, ledgerPath: join(stateDir, LEDGER_FILENAME) };
}

/** The real fleet reconciler read (buildSweepEffects' readFleetState), every GitHub read answered by a fixture. */
function fleetEffects(root: string, ledgerPath: string) {
  const sha = "fleet14314";
  return buildSweepEffects({
    owner: "o", repo: "r", repoRoot: root, config: { root } as never, ledgerPath, runId: "W1-T14314",
    plan: { tasks: [], byId: new Map() } as never, log: () => {},
    ghRunImpl: () => { throw new Error("unexpected dispatch"); },
    readJsonImpl: async (args: string[]) => {
      const endpoint = args[1]!;
      if (endpoint.includes("commits?")) return [{ sha, parents: [] }];
      if (endpoint.includes("/commits/")) return { files: [{ filename: "src/example.ts" }] };
      return { total_count: 1 };
    },
    fleetDeployStateImpl: {
      deploy: { newestBakedSha: () => sha, imagePublished: () => true, imageBakedCommitsBehind: () => 0, imageRecycleManual: () => false },
      failedAt: () => undefined, clearFailure: () => {}, deployRequested: () => false,
      requestDeploy: () => { throw new Error("unexpected repair"); },
    } as never,
  });
}

/** The three strict history readers the lock blinded, each driven through its production entry point. */
async function strictReads(stateDir: string, ledgerPath: string, root: string) {
  let fleet: { ok: true; rows: number } | { ok: false; reason: string };
  try {
    const read = await fleetEffects(root, ledgerPath).readFleetState!([]);
    fleet = { ok: true, rows: read.history.filter((row) => row.target === "archived-fleet-row").length };
  } catch (error) {
    fleet = { ok: false, reason: String((error as Error).message) };
  }

  const armed: number[] = [];
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const armDeps: SweepDeps = {
    arm: (p) => { armed.push(p.prNumber); }, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-T14314", now: () => NOW, log: (step, fields) => { logs.push({ step, fields: fields ?? {} }); },
  };
  await runSweep([pr(ARM_PR)], armDeps);
  const armHistory = logs.filter((row) => row.step === "sweep.arm_verdict_history_read").map((row) => row.fields);

  const updateBranch: NonNullable<SweepDeps["updateBranch"]> = async () => "updated" as const;
  const holdPr = pr(HOLD_PR, { taskId: HOLD_TASK, checksState: "red", reviewState: "pending" });
  const capability = await lightPassHeadContractRefresh([holdPr], {
    ledgerPath, updateBranch, readTaskContractRevision: () => "contract-B", log: () => {},
  });
  return { stateDir, fleet, armHistory, armed, headContractRefresh: capability.headContractRefreshFor?.(holdPr) === updateBranch };
}

test("W1-T14314 criterion 1: with the security producer's lock beside the live ledger and a rotation, nothing is unclassified and the reconciler's, arm decision's and head-contract refresh's history reads are complete", async () => {
  for (const extra of [[LOCK], [LOCK, `${LOCK}-journal`]]) {
    const { root, stateDir, ledgerPath } = stateWith(extra);
    const listed = listedLedgerFiles(stateDir, { readdirSync: (dir) => readdirSync(dir), readFileSync: (path) => readFileSync(path) });
    assert.equal(listed.rotations.length, 1, "positive control: the rotation is listed");
    assert.deepEqual(listed.unclassified, [], `nothing unclassified beside ${extra.join(", ")}`);

    const reads = await strictReads(stateDir, ledgerPath, root);
    assert.deepEqual(reads.fleet, { ok: true, rows: 1 }, "the fleet reconciler reads its archived history");
    assert.equal(reads.armHistory.length, 1, "positive control: the arm decision loaded its archived history");
    assert.equal(reads.armHistory[0]!.complete, true, "the arm decision's history read is complete");
    assert.deepEqual(reads.armed, [ARM_PR], "the archived clean verdict arms");
    assert.equal(reads.headContractRefresh, true, "the head-contract refresh finds its archived hold and selects the refresh");
  }
});

// ── criterion 2: the source census ──────────────────────────────────────────────────────────────────────────────
/** An expression naming the live ledger's path or file name: `ledgerPath`, `deps.ledgerPath`, `livePath`,
 *  `LEDGER_FILENAME`, `ledgerLivePath(dir)` or `ledgerPathFor(config)`. */
const LEDGER_BASE = String.raw`(?<![\w$])(?:[A-Za-z_$][\w$]*\.)*(?:ledgerPath|livePath|LEDGER_FILENAME|ledgerLivePath\([^()]*\)|ledgerPathFor\([^()]*\))`;
const TEMPLATE_SIDECAR = new RegExp(String.raw`\$\{${LEDGER_BASE}\}(?:(\.[\w.-]+)|\$\{([A-Z][A-Z0-9_]*)\})(\x60|\$\{)?`, "g");
const CONCAT_SIDECAR = new RegExp(String.raw`${LEDGER_BASE}\s*\+\s*(?:"(\.[^"]*)"|'(\.[^']*)'|([A-Z][A-Z0-9_]*)\b)`, "g");

interface SidecarSite { file: string; line: number; suffix?: string; problem?: string }

/** Every file name `sources` build as the ledger path plus a literal or a named `ledger-path.ts` suffix constant. */
function sidecarSitesIn(sources: ReadonlyArray<{ file: string; text: string }>): SidecarSite[] {
  const sites: SidecarSite[] = [];
  const constant = (name: string): string | undefined => {
    const value = (ledgerPathModule as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  for (const { file, text } of sources) {
    const lineOf = (index: number) => text.slice(0, index).split("\n").length;
    for (const m of text.matchAll(TEMPLATE_SIDECAR)) {
      const [, literal, named, end] = m;
      const at = { file, line: lineOf(m.index!) };
      const suffix = literal ?? constant(named!);
      if (suffix === undefined) sites.push({ ...at, problem: `the suffix constant ${named} is not a string export of ledger-path.ts` });
      else if (literal !== undefined && end !== "`") sites.push({ ...at, problem: `the name ${literal}… has a computed tail no exact name can classify` });
      else sites.push({ ...at, suffix });
    }
    for (const m of text.matchAll(CONCAT_SIDECAR)) {
      const [, double, single, named] = m;
      const at = { file, line: lineOf(m.index!) };
      const suffix = double ?? single ?? constant(named!);
      sites.push(suffix === undefined ? { ...at, problem: `the suffix constant ${named} is not a string export of ledger-path.ts` } : { ...at, suffix });
    }
  }
  return sites;
}

/** A body every producer metadata validator accepts, so a metadata sidecar is judged as its producer writes it. */
const PRODUCER_BODY = Buffer.from(JSON.stringify({ bytes: 0, sha256: "0".repeat(64), steps: [] }));

/** The names a site's file can appear under (a SQLite file's rollback journal too) that the classifier leaves unclassified. */
function unclassifiedNames(suffix: string): string[] {
  const names = [`${LEDGER_FILENAME}${suffix}`, ...(suffix.endsWith(".sqlite") ? [`${LEDGER_FILENAME}${suffix}-journal`] : [])];
  return names.filter((name) => listedLedgerFiles("/census-state", {
    readdirSync: () => [LEDGER_FILENAME, name], readFileSync: () => PRODUCER_BODY,
  }).unclassified.length > 0);
}

function census(sources: ReadonlyArray<{ file: string; text: string }>): string[] {
  return sidecarSitesIn(sources).flatMap((site) => site.problem !== undefined
    ? [`${site.file}:${site.line}: ${site.problem}`]
    : unclassifiedNames(site.suffix!).map((name) => `${site.file}:${site.line}: ${name} would be unclassified by listedLedgerFiles`));
}

function srcSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name)) out.push({ file: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(join(REPO_ROOT, "src"));
  return out;
}

test("W1-T14314 criterion 2: a source census fails when src builds a ledger sidecar the corpus classifier would report as unclassified", () => {
  const sources = srcSources();
  assert.ok(sources.length > 100, `positive control: the census walked src (${sources.length} files)`);
  const sites = sidecarSitesIn(sources);
  const suffixes = new Set(sites.map((site) => site.suffix));
  for (const known of [LEDGER_ROTATION_LOCK_SUFFIX, LEDGER_CARRIED_PREFIX_SUFFIX, LEDGER_RETAINED_STEPS_SUFFIX, LEDGER_SECURITY_PRODUCER_LOCK_SUFFIX]) {
    assert.ok(suffixes.has(known), `positive control: the census finds the ${known} sidecar src builds`);
  }
  assert.ok(sites.some((site) => site.file === join("src", "lib", "sweep.ts") && site.suffix === LEDGER_SECURITY_PRODUCER_LOCK_SUFFIX),
    "positive control: the security producer's lock site in sweep.ts is in the population");

  // The census's own falsifier: an unregistered sidecar, a literal or a named one, is named with its site.
  const planted = census([{ file: "src/planted.ts", text: [
    "const a = new DatabaseSync(`${deps.ledgerPath}.unregistered.lock.sqlite`, { timeout: 0 });",
    "writeFileSync(ledgerPath + \".bak\", body);",
    "const c = `${livePath}${LEDGER_NOT_A_CONSTANT}`;",
    "const d = `${ledgerPath}.stage-${process.pid}`;",
  ].join("\n") }]);
  assert.deepEqual(planted, [
    "src/planted.ts:1: ledger.ndjson.unregistered.lock.sqlite would be unclassified by listedLedgerFiles",
    "src/planted.ts:1: ledger.ndjson.unregistered.lock.sqlite-journal would be unclassified by listedLedgerFiles",
    "src/planted.ts:3: the suffix constant LEDGER_NOT_A_CONSTANT is not a string export of ledger-path.ts",
    "src/planted.ts:4: the name .stage-… has a computed tail no exact name can classify",
    "src/planted.ts:2: ledger.ndjson.bak would be unclassified by listedLedgerFiles",
  ]);

  assert.deepEqual(census(sources), [], "every ledger sidecar src builds is classified by listedLedgerFiles");
});

test("W1-T14314 criterion 3: ledger.ndjson.bak, another *.lock.sqlite name and a misnamed rotation stay unclassified and still make each strict reader refuse", async () => {
  for (const stray of [
    `${LEDGER_FILENAME}.bak`,
    `${LEDGER_FILENAME}.other-producer.lock.sqlite`,
    "ledger.security-producer.lock.sqlite",
    `${LOCK}-wal`,
    "ledger.2026-11-21T08-53-25-000Z.ndjson.gzip",
  ]) {
    const { root, stateDir, ledgerPath } = stateWith([LOCK, stray]);
    const listed = listedLedgerFiles(stateDir, { readdirSync: (dir) => readdirSync(dir), readFileSync: (path) => readFileSync(path) });
    assert.deepEqual(listed.unclassified, [join(stateDir, stray)], `${stray} alone stays unclassified`);

    const reads = await strictReads(stateDir, ledgerPath, root);
    assert.equal(reads.fleet.ok, false, `${stray}: the fleet reconciler refuses`);
    assert.ok(!reads.fleet.ok && reads.fleet.reason.includes(join(stateDir, stray)), `${stray}: the refusal names the file`);
    assert.equal(reads.armHistory.length, 1, `${stray}: positive control, the arm decision tried its history`);
    assert.equal(reads.armHistory[0]!.complete, false, `${stray}: the arm decision's history is incomplete`);
    assert.equal(reads.headContractRefresh, false, `${stray}: the head-contract refresh admits nothing`);
  }
});
