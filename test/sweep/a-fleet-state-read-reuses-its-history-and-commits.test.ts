import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { readLedgerUnionRawLinesAsync, realLedgerFs } from "#src/lib/ledger-union.js";
import { parseLedger } from "#src/lib/retro.js";

const proof = "test/sweep/a-fleet-state-read-reuses-its-history-and-commits.test.ts";
const steps = ["reconcile.repaired", "reconcile.repair_failed", "reconcile.escalated", "main.run_gap.dispatched", "deploy.ok"];

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-fleet-history-"));
  const stateDir = join(root, "state");
  fs.mkdirSync(stateDir);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const workflows = join(root, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(join(workflows, "ci.yml"), "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
  const sha = basename(root);
  const commits = [{ sha: `${sha}-head`, parents: [{ sha }] }, { sha, parents: [] }];
  const archived = [
    { step: "reconcile.repaired", gap_id: JSON.stringify(["ci", `${sha}:ci.yml`]), head: `${sha}-head` },
    { step: "reconcile.repair_failed", target: "unrelated" },
    { step: "reconcile.escalated", target: "another" },
    { step: "main.run_gap.dispatched", commit: sha, workflows: ["ci.yml"], head: `${sha}-head` },
    { step: "deploy.ok", ts: "2026-10-15T00:00:00Z" },
    { step: "heartbeat.tick", ignored: true },
  ];
  const plain = join(stateDir, "ledger.2026-10-14T00-00-00-000Z.ndjson");
  const gzip = join(stateDir, "ledger.2026-10-15T00-00-00-000Z.ndjson.gz");
  fs.writeFileSync(plain, archived.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(gzip, gzipSync(JSON.stringify({ step: "reconcile.escalated", target: "gzip" }) + "\n"));
  fs.writeFileSync(ledgerPath, JSON.stringify({ step: "heartbeat.tick", live: true }) + "\n");
  const reads: string[] = [];
  let workflowRuns = 0;
  let changedFailure: "throw" | "missing" | undefined;
  const readJsonImpl = async (args: string[]) => {
    const endpoint = args[1];
    reads.push(endpoint);
    if (endpoint.includes("commits?")) return commits;
    if (endpoint.includes("/commits/")) {
      if (changedFailure === "throw") throw new Error("commit unavailable");
      if (changedFailure === "missing") return {};
      return { files: [{ filename: "src/example.ts" }] };
    }
    return { total_count: endpoint.includes("/workflows/") ? workflowRuns : 1 };
  };
  const deploy = {
    deploy: { newestBakedSha: () => sha, imagePublished: () => true,
      imageBakedCommitsBehind: () => 0, imageRecycleManual: () => false },
    failedAt: () => Date.parse("2026-10-14T00:00:00Z"), clearFailure: () => {},
    deployRequested: () => false, requestDeploy: () => { throw new Error("unexpected repair"); },
  };
  const effects = () => buildSweepEffects({
    owner: "o", repo: "r", repoRoot: root, config: { root } as never,
    ledgerPath, runId: "W1-T11267", plan: { tasks: [], byId: new Map() } as never,
    log: () => {}, ghRunImpl: () => { throw new Error("unexpected dispatch"); },
    readJsonImpl, fleetDeployStateImpl: deploy,
  });
  return { root, stateDir, ledgerPath, plain, gzip, sha, commits, reads, deploy, effects,
    setRuns: (count: number) => { workflowRuns = count; },
    failChanged: (failure?: typeof changedFailure) => { changedFailure = failure; } };
}

type FleetState = Awaited<ReturnType<NonNullable<ReturnType<typeof buildSweepEffects>["readFleetState"]>>>;

async function observed(rows: FleetState["rows"]) {
  return Promise.all(rows.map(async ({ pipeline, target, desired, evidence, observe }) =>
    ({ pipeline, target, desired, evidence, observed: await observe() })));
}

test(`${proof}: history and fleet rows match the whole union while unchanged archives read zero bytes`, async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const live = [{ step: "reconcile.escalated", target: "in-memory" }];
  const whole = await readLedgerUnionRawLinesAsync(f.stateDir, { step: steps, refuseIncomplete: true });
  assert.equal(whole.archiveCount, 2);
  assert.equal(whole.ok, true);
  const history = [...parseLedger(whole.rawLines.join("\n")), ...parseLedger(fs.readFileSync(f.ledgerPath, "utf8")), ...live];
  let archiveBytes = 0;
  const archivesRead = new Set<string>();
  const isArchive = (path: unknown) => path === f.plain || path === f.gzip;
  const stream = fs.createReadStream;
  const read = fsPromises.readFile;
  const syncRead = realLedgerFs.readFileSync;
  t.mock.method(fs, "createReadStream", (...args: Parameters<typeof stream>) => {
    const result = stream(...args);
    if (isArchive(args[0])) result.on("data", chunk => {
      archiveBytes += chunk.length;
      archivesRead.add(String(args[0]));
    });
    return result;
  });
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    if (isArchive(args[0])) {
      archiveBytes += Buffer.byteLength(result);
      archivesRead.add(String(args[0]));
    }
    return result;
  });
  t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
    const result = syncRead(path);
    if (isArchive(path)) {
      archiveBytes += result.length;
      archivesRead.add(path);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = await f.effects().readFleetState!(live);
  assert.ok(archiveBytes > 0, "positive control: the first pass reads both rotation forms");
  assert.deepEqual([...archivesRead].sort(), [f.plain, f.gzip].sort());
  assert.deepEqual(first.history, history);
  assert.deepEqual(await observed(first.rows), [
    { pipeline: "ci", target: `${f.sha}:ci.yml`, desired: `ci.yml run covering main commit ${f.sha}`,
      evidence: { commit: f.sha, workflow: "ci.yml", head: `${f.sha}-head` }, observed: false },
    { pipeline: "image", target: f.sha, desired: `published image containing ${f.sha}`, evidence: undefined, observed: true },
    { pipeline: "deploy", target: f.sha, desired: `healthy deployed image containing ${f.sha}`, evidence: undefined, observed: true },
    { pipeline: "failure-latch", target: String(Date.parse("2026-10-14T00:00:00Z")),
      desired: "no failure latch older than the last healthy deploy",
      evidence: { failed_at: Date.parse("2026-10-14T00:00:00Z"), healthy_at: Date.parse("2026-10-15T00:00:00Z") }, observed: false },
  ]);
  archiveBytes = 0;
  f.setRuns(1);
  const second = await f.effects().readFleetState!(live);
  assert.equal(archiveBytes, 0, "the reader persists across effect builders");
  assert.deepEqual(second.history, history);
  const secondRows = await observed(second.rows);
  assert.equal(secondRows.find(row => row.pipeline === "ci")?.observed, true);
  assert.equal(f.reads.filter(path => path.includes("/commits/")).length, 1);
  // W1-T12234: both commits have a run, so the second call reads no run count again.
  assert.equal(f.reads.filter(path => path.includes("/actions/runs?")).length, 2);
  assert.equal(f.reads.filter(path => path.includes("/workflows/")).length, 3);
  fs.appendFileSync(f.ledgerPath, JSON.stringify({ step: "deploy.ok", ts: "2026-10-16T00:00:00Z" }) + "\n");
  const third = await f.effects().readFleetState!([]);
  assert.equal(archiveBytes, 0);
  assert.ok(third.history.some(row => row.ts === "2026-10-16T00:00:00Z"));
  f.commits.unshift({ sha: `${f.sha}-new`, parents: [{ sha: `${f.sha}-head` }] });
  await f.effects().readFleetState!([]);
  assert.equal(f.reads.filter(path => path.endsWith(`/commits/${f.sha}`)).length, 1);
  assert.equal(f.reads.filter(path => path.endsWith(`/commits/${f.sha}-head`)).length, 1);
});

test(`${proof}: unreadable and unclassified rotations still refuse history`, async (t) => {
  for (const failure of ["unreadable", "unclassified"] as const) {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const effects = f.effects();
    await effects.readFleetState!([]);
    if (failure === "unreadable") fs.writeFileSync(f.gzip, "invalid gzip");
    else fs.writeFileSync(join(f.stateDir, "ledger.unknown"), "unclassified");
    await assert.rejects(effects.readFleetState!([]), /fleet reconciliation history unreadable/);
  }
});

test(`${proof}: failed or absent changed-files responses are retried`, async (t) => {
  for (const failure of ["throw", "missing"] as const) {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    f.failChanged(failure);
    const effects = f.effects();
    const first = await effects.readFleetState!([]);
    assert.equal(first.rows.filter(row => row.pipeline === "ci").length, 0);
    f.failChanged();
    const second = await effects.readFleetState!([]);
    assert.equal(second.rows.filter(row => row.pipeline === "ci").length, 1);
    await effects.readFleetState!([]);
    assert.equal(f.reads.filter(path => path.includes("/commits/")).length, 2);
  }
});
