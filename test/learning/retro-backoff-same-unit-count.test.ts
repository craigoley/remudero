import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { boardSnapshotPath, createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { configPath, loadConfig, type Config } from "#src/lib/config.js";
import { mapBoardPr, type RestPullRow } from "#src/lib/open-prs-rest.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import { saveMarker, type GitLogCommit, type ShippedGithub } from "#src/lib/retro.js";
import * as runTask from "#test/helpers/run-task-test.js";

// All evidence and decision times are fixture times, never compared with today's clock.
const MARKER = "2026-10-01T00:00:00.000Z";
const MERGED = "2026-10-02T10:00:00.000Z";
const NOW = new Date("2026-10-02T12:30:00.000Z");
const POLICY = loadPolicy(policyPath(new URL("../../", import.meta.url).pathname));
type Mode = "sync" | "async";
let sequence = 0;

function fixture(t: TestContext, seed: "valid" | "missing" | "invalid" = "valid") {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-count-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const config: Config = { root, claudeBin: "/bin/true" };
  // Isolate the real default config reader, too: no dependency on an installed Claude CLI
  // and no access to the operator's config/credentials when this file runs on its own.
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  mkdirSync(join(configPath(), ".."), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
  const ownerRepo = { owner: "retro-backoff", repo: `fixture-${++sequence}` };
  const url = (n: number) => `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/pull/${n}`;
  const rows: RestPullRow[] = Array.from({ length: 20 }, (_, i) => ({
    number: i + 1, html_url: url(i + 1), state: "closed", updated_at: MERGED, merged_at: MERGED,
    body: `Remudero-Task: W1-T${i + 1}`, title: `built ${i + 1}`,
    head: { ref: `run-W1-T${i + 1}-1`, sha: "a".repeat(40) },
  }));
  const ledger = rows.flatMap((row, i) => [
    { ts: MERGED, run_id: `W1-T${i + 1}-1`, task_id: `W1-T${i + 1}`, step: "run.start" },
    { ts: MERGED, run_id: `W1-T${i + 1}-1`, task_id: `W1-T${i + 1}`, step: "verdict", verdict: "merged", pr_url: row.html_url },
  ]).map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(root, "state", "ledger.ndjson"), ledger);
  saveMarker(join(root, "state", "last-retro.json"), { ts: MARKER, learnings_count: 0, runs_seen: 0 });
  runTask.recordRetroAttempt(root, new Date("2026-10-02T12:00:00.000Z"), 5);
  // Real default snapshot IO at the configured (test-isolated) root: neither gateway receives snapshotFor.
  const snapshotRoot = loadConfig().root;
  const snapshot = createBoardSnapshotCache(snapshotRoot, ownerRepo.owner, ownerRepo.repo);
  const snapshotPath = boardSnapshotPath(snapshotRoot, ownerRepo.owner, ownerRepo.repo);
  if (seed === "valid") assert.equal(snapshot.commitClosed(rows.map(mapBoardPr)), true);
  if (seed === "invalid") { mkdirSync(join(snapshotPath, ".."), { recursive: true }); writeFileSync(snapshotPath, "{torn"); }
  const commits: GitLogCommit[] = Array.from({ length: 10 }, (_, i) => ({ date: MERGED, message: `chore(plan): runless filing ${i}` }));
  return { config, ownerRepo, rows, ledger, commits, snapshot, snapshotPath };
}

async function check(f: ReturnType<typeof fixture>, mode: Mode, authoritative = f.rows, rewriteAfterCapture = false) {
  let probes = 0;
  const calls: string[][] = [];
  const exec = (args: readonly string[]) => {
    calls.push([...args]);
    assert.equal(args[0], "api");
    const query = new URL(`https://fixture/${args[1]}`).searchParams;
    const rows = query.get("state") === "open" ? [] : authoritative;
    const page = Number(query.get("page")), size = Number(query.get("per_page"));
    assert.ok(page > 0 && size > 0);
    return JSON.stringify(rows.slice((page - 1) * size, page * size));
  };
  const options = { ownerRepo: f.ownerRepo };
  const gateway = mode === "sync"
    ? runTask.retroShippedGithubGateway({ ...options, exec })
    : await runTask.retroShippedGithubGatewayAsync({ ...options, execAsync: async (_file, args) => ({ stdout: exec(args), stderr: "" }), log: () => {} });
  if (rewriteAfterCapture) assert.equal(f.snapshot.commitClosed([]), true);
  const before = (() => { try { return readFileSync(f.snapshotPath, "utf8"); } catch { return undefined; } })();
  const github: ShippedGithub = { ...gateway, mergedCommits: () => f.commits, unavailable: () => {
    probes++;
    assert.equal(calls.length, 0, "the local backoff precheck does not make a GitHub request");
    return undefined;
  } };
  const deps = { config: f.config, policy: POLICY, github };
  const decision = mode === "sync" ? runTask.retroTriggerCheck(NOW, deps)
    : await runTask.retroTriggerCheckAsync(NOW, { ...deps, readMergedCommits: async () => f.commits });
  const after = (() => { try { return readFileSync(f.snapshotPath, "utf8"); } catch { return undefined; } })();
  assert.equal(after, before, "neither the hint nor the refreshed retro reader writes the board snapshot");
  return { decision, calls, probes };
}

test("retro backoff counts cached shipped and runless merges in the same units", async t => {
  for (const mode of ["sync", "async"] as const) {
    const f = fixture(t);
    const result = await check(f, mode, f.rows, true);
    assert.equal(result.decision?.fire, true, `${mode}: 20 P9-owned runs plus 10 runless merges reach the unchanged 5+25 floor`);
    assert.equal(result.decision?.mergesSinceMarker, 30);
    assert.equal(result.probes, 1);
    assert.ok(result.calls.length > 0, "a cached hint admits the existing refreshed pass, not a cache-certified retry");
  }
});

test("retro backoff rechecks the authoritative count after a cached hint", async t => {
  for (const mode of ["sync", "async"] as const) {
    // Positive control discriminates against the old precheck, which would refuse both cases before reading.
    assert.equal((await check(fixture(t), mode)).decision?.fire, true);
    const f = fixture(t);
    const changed = f.rows.map((row, i) => i < 3 ? { ...row, head: { ref: "run-foreign-1", sha: "b".repeat(40) } } : row);
    const result = await check(f, mode, changed);
    assert.equal(result.probes, 1, "the cached 30 admits a refresh");
    assert.ok(result.calls.length > 0);
    assert.equal(result.decision, undefined, `${mode}: authoritative 17+10=27 reaches cadence25 but not the retry floor30`);
  }
});

test("retro backoff evidence names the count that refused the retry", async t => {
  for (const mode of ["sync", "async"] as const) {
    const f = fixture(t);
    const changed = f.rows.map((row, i) => i < 3 ? { ...row, head: { ref: "run-foreign-1", sha: "b".repeat(40) } } : row);
    assert.equal((await check(f, mode, changed)).decision, undefined);
    const rows = readFileSync(join(f.config.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const refusal = rows.findLast(row => row.step === "daemon.retro_trigger.backoff");
    assert.equal(refusal?.merges_since_marker, 27, "report the authoritative decision, not the optimistic cached30 or old proxy10");
    assert.equal(refusal?.count_basis, "authoritative-shipped-plus-runless");
    assert.equal(refusal?.merges_floor, 30);
  }
});

test("retro backoff missing or invalid default snapshot keeps the zero-request refusal", async t => {
  for (const seed of ["missing", "invalid"] as const) for (const mode of ["sync", "async"] as const) {
    const result = await check(fixture(t, seed), mode);
    assert.equal(result.decision, undefined);
    assert.equal(result.probes, 0);
    assert.equal(result.calls.length, 0);
  }
});

test("retro backoff cached credit still refuses foreign heads and unknown merge times", async t => {
  for (const mode of ["sync", "async"] as const) {
    const f = fixture(t);
    const path = join(f.config.root, "state", "ledger.ndjson");
    const records = f.ledger.trim().split("\n").map(line => JSON.parse(line));
    delete records[1].ts;
    writeFileSync(path, records.map(row => JSON.stringify(row)).join("\n") + "\n");
    const foreign = f.rows.map((row, i) => i === 1 ? { ...row, head: { ref: "run-other-1", sha: "c".repeat(40) } } : row);
    assert.equal(f.snapshot.commitClosed(foreign.map(mapBoardPr)), true);
    const result = await check(f, mode, foreign);
    assert.equal(result.decision, undefined);
    assert.equal(result.probes, 0, "18 owned/timed runs plus10 filings cannot open the floor30");
  }
});

test("retro backoff changed marker still resets the attempt cycle", async t => {
  for (const mode of ["sync", "async"] as const) {
    const f = fixture(t, "missing");
    saveMarker(join(f.config.root, "state", "last-retro.json"), { ts: "2026-10-02T11:00:00.000Z", learnings_count: 0, runs_seen: 0 });
    const result = await check(f, mode);
    assert.equal(result.probes, 1);
    assert.equal(result.decision?.fire, false);
    assert.equal(result.decision?.mergesSinceMarker, 0);
  }
});
