import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  COVERAGE_IMPROVEMENT_READ_STEP,
  COVERAGE_IMPROVEMENT_REFUSED_STEP,
  COVERAGE_MERGED_ARTIFACT_NAME,
  extractLcovFromArtifactZip,
  fetchMergedCoverageArtifact,
  workflowArtifactZipRestArgs,
  workflowArtifactsForRunRestArgs,
  workflowJobsForRunRestArgs,
  workflowRunsForHeadRestArgs,
  type FetchMergedCoverageArtifactResult,
} from "../src/lib/coverage-improvement.js";
import { runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { coverageImproveCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const OWNER = "owner";
const REPO = "repo";
const LCOV = "SF:src/debt.ts\nBRF:100\nBRH:85\nend_of_record\n";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function fakeEntry(id: string, raw: string): FeedbackEntry {
  return { id, ts: "2026-09-07T00:00:00.000Z", raw, attachments: [], origin: "cli", status: "new", proposal_pr: null };
}

function storedZip(name: string, text: string): Buffer {
  const nameBuf = Buffer.from(name);
  const data = Buffer.from(text);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

function readerFixture(overrides: {
  pulls?: unknown;
  runsBySha?: Record<string, unknown>;
  jobsByRun?: Record<number, unknown>;
  artifactsByRun?: Record<number, unknown>;
  zipByArtifact?: Record<number, Buffer>;
  throwDownloadFor?: number;
  throwPulls?: string;
}): {
  result: FetchMergedCoverageArtifactResult;
  jsonCalls: string[];
  bufferCalls: string[];
  ledgerLines: LedgerLine[];
} {
  const jsonCalls: string[] = [];
  const bufferCalls: string[] = [];
  const ledgerLines: LedgerLine[] = [];
  const result = fetchMergedCoverageArtifact({
    owner: OWNER,
    repo: REPO,
    ledgerPath: "/state/ledger.ndjson",
    ledgerRunId: "test-reader",
    writeLedgerLine: (_path, line) => ledgerLines.push(line),
    ghJson: (args) => {
      const path = args[1];
      jsonCalls.push(path);
      if (path.includes("/pulls?")) {
        if (overrides.throwPulls) throw new Error(overrides.throwPulls);
        return overrides.pulls ?? [];
      }
      for (const [sha, payload] of Object.entries(overrides.runsBySha ?? {})) {
        if (path === workflowRunsForHeadRestArgs(OWNER, REPO, sha)[1]) return payload;
      }
      for (const [run, payload] of Object.entries(overrides.jobsByRun ?? {})) {
        if (path === workflowJobsForRunRestArgs(OWNER, REPO, Number(run))[1]) return payload;
      }
      for (const [run, payload] of Object.entries(overrides.artifactsByRun ?? {})) {
        if (path === workflowArtifactsForRunRestArgs(OWNER, REPO, Number(run))[1]) return payload;
      }
      throw new Error(`unrouted gh api path: ${path}`);
    },
    ghBuffer: (args) => {
      const path = args[1];
      bufferCalls.push(path);
      for (const [artifact, zip] of Object.entries(overrides.zipByArtifact ?? {})) {
        if (path === workflowArtifactZipRestArgs(OWNER, REPO, Number(artifact))[1]) {
          if (overrides.throwDownloadFor === Number(artifact)) throw new Error("HTTP 403 Resource not accessible by integration");
          return zip;
        }
      }
      throw new Error(`unrouted gh api path: ${path}`);
    },
  });
  return { result, jsonCalls, bufferCalls, ledgerLines };
}

test("fetchMergedCoverageArtifact: resolves the newest merged PR with a completed aggregator run and returns its lcov", () => {
  const { result, jsonCalls, bufferCalls, ledgerLines } = readerFixture({
    pulls: [
      { number: 10, merged_at: "2026-09-07T12:00:00Z", head: { sha: "new-no-run" } },
      { number: 9, merged_at: "2026-09-07T11:00:00Z", head: { sha: "older-with-run" } },
    ],
    runsBySha: {
      "new-no-run": { workflow_runs: [] },
      "older-with-run": {
        workflow_runs: [
          { id: 901, status: "completed", conclusion: "success", run_started_at: "2026-09-07T11:05:00Z" },
          { id: 902, status: "completed", conclusion: "success", run_started_at: "2026-09-07T11:06:00Z" },
        ],
      },
    },
    jobsByRun: {
      901: { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] },
      902: { jobs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    },
    artifactsByRun: { 901: { artifacts: [{ id: 77, name: COVERAGE_MERGED_ARTIFACT_NAME }] } },
    zipByArtifact: { 77: storedZip("lcov.info", LCOV) },
  });

  assert.equal(result.status, "read");
  if (result.status !== "read") throw new Error("unreachable");
  assert.equal(result.workflowRunId, 901);
  assert.equal(result.headSha, "older-with-run");
  assert.equal(result.artifactId, 77);
  assert.equal(result.prNumber, 9);
  assert.equal(result.lcovText, LCOV);
  assert.deepEqual(bufferCalls, [workflowArtifactZipRestArgs(OWNER, REPO, 77)[1]]);
  assert.ok(jsonCalls.includes(workflowRunsForHeadRestArgs(OWNER, REPO, "new-no-run")[1]));
  assert.ok(jsonCalls.includes(workflowRunsForHeadRestArgs(OWNER, REPO, "older-with-run")[1]));
  assert.ok(
    ledgerLines.some(
      (line) =>
        line.step === COVERAGE_IMPROVEMENT_READ_STEP &&
        line.workflow_run_id === 901 &&
        line.head_sha === "older-with-run" &&
        line.artifact_id === 77,
    ),
  );
});

test("fetchMergedCoverageArtifact: named refusals never return an empty lcov", () => {
  const cases: Array<{ name: string; reason: string; fixture: Parameters<typeof readerFixture>[0] }> = [
    {
      name: "unreadable merged PR list",
      reason: "github_unreadable",
      fixture: { throwPulls: "HTTP 403 Resource not accessible by integration" },
    },
    {
      name: "missing merged PR",
      reason: "no_merged_pr",
      fixture: { pulls: [] },
    },
    {
      name: "missing run",
      reason: "no_completed_coverage_ratchet_run",
      fixture: {
        pulls: [{ number: 1, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-a" } }],
        runsBySha: { "sha-a": { workflow_runs: [] } },
      },
    },
    {
      name: "unreadable workflow lookup",
      reason: "github_unreadable",
      fixture: {
        pulls: [{ number: 11, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-unrouted" } }],
      },
    },
    {
      name: "missing artifact",
      reason: "no_coverage_merged_artifact",
      fixture: {
        pulls: [{ number: 2, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-b" } }],
        runsBySha: { "sha-b": { workflow_runs: [{ id: 201, status: "completed", conclusion: "success" }] } },
        jobsByRun: { 201: { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] } },
        artifactsByRun: { 201: { artifacts: [] } },
      },
    },
    {
      name: "unreadable artifact list",
      reason: "artifact_unreadable",
      fixture: {
        pulls: [{ number: 12, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-artifact-list" } }],
        runsBySha: {
          "sha-artifact-list": { workflow_runs: [{ id: 202, status: "completed", conclusion: "success" }] },
        },
        jobsByRun: { 202: { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] } },
      },
    },
    {
      name: "unreadable artifact",
      reason: "artifact_unreadable",
      fixture: {
        pulls: [{ number: 3, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-c" } }],
        runsBySha: { "sha-c": { workflow_runs: [{ id: 301, status: "completed", conclusion: "success" }] } },
        jobsByRun: { 301: { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] } },
        artifactsByRun: { 301: { artifacts: [{ id: 88, name: COVERAGE_MERGED_ARTIFACT_NAME }] } },
        zipByArtifact: { 88: storedZip("lcov.info", LCOV) },
        throwDownloadFor: 88,
      },
    },
    {
      name: "non-lcov download",
      reason: "download_not_lcov",
      fixture: {
        pulls: [{ number: 4, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-d" } }],
        runsBySha: { "sha-d": { workflow_runs: [{ id: 401, status: "completed", conclusion: "success" }] } },
        jobsByRun: { 401: { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] } },
        artifactsByRun: { 401: { artifacts: [{ id: 99, name: COVERAGE_MERGED_ARTIFACT_NAME }] } },
        zipByArtifact: { 99: storedZip("README.txt", "not an lcov report") },
      },
    },
  ];

  for (const c of cases) {
    const { result, ledgerLines } = readerFixture(c.fixture);
    assert.equal(result.status, "refused", c.name);
    if (result.status !== "refused") throw new Error("unreachable");
    assert.equal(result.reason, c.reason, c.name);
    assert.ok(!("lcovText" in result), c.name);
    assert.ok(
      ledgerLines.some((line) => line.step === COVERAGE_IMPROVEMENT_REFUSED_STEP && line.reason === c.reason),
      `${c.name} must ledger its own refusal reason`,
    );
  }
});

test("fetchMergedCoverageArtifact: the production gh transport reads JSON and the artifact zip", { concurrency: false }, () => {
  const root = tmp("rmd-coverage-gh-");
  const binDir = join(root, "bin");
  const fakeGh = join(binDir, "gh");
  const previousPath = process.env.PATH;
  mkdirSync(binDir, { recursive: true });
  const zipBase64 = storedZip("lcov.info", LCOV).toString("base64");
  const script = `#!/usr/bin/env node
const path = process.argv[3] ?? "";
if (path.includes("/pulls?")) process.stdout.write(JSON.stringify([{ number: 13, merged_at: "2026-09-07T12:00:00Z", head: { sha: "sha-default" } }]));
else if (path.includes("/actions/runs?")) process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 203, status: "completed", conclusion: "success" }] }));
else if (path.endsWith("/runs/203/jobs?per_page=100")) process.stdout.write(JSON.stringify({ jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] }));
else if (path.endsWith("/runs/203/artifacts?per_page=100")) process.stdout.write(JSON.stringify({ artifacts: [{ id: 103, name: "coverage-merged" }] }));
else if (path.endsWith("/artifacts/103/zip")) process.stdout.write(Buffer.from("${zipBase64}", "base64"));
else process.exit(2);
`;
  writeFileSync(fakeGh, script);
  chmodSync(fakeGh, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  try {
    const result = fetchMergedCoverageArtifact({
      owner: OWNER,
      repo: REPO,
      ledgerPath: join(root, "ledger.ndjson"),
      ledgerRunId: "default-gh",
      writeLedgerLine: () => undefined,
    });
    assert.equal(result.status, "read");
    if (result.status !== "read") throw new Error("unreachable");
    assert.equal(result.workflowRunId, 203);
    assert.equal(result.artifactId, 103);
    assert.equal(result.lcovText, LCOV);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMeasurementCadenceReport: coverage-improvement is measured through the producer and refused through the reader", () => {
  const root = tmp("rmd-coverage-cadence-");
  try {
    const stateDir = join(root, "state");
    const ledgerPath = join(stateDir, "ledger.ndjson");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ledger.2026-09-07T00-00-00-000Z.ndjson"), "");

    const measured = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      checkoutDir: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
      ledgerUnion: () => ({ stateDir, archiveFiles: ["a"], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
      coverageImprovement: {
        owner: OWNER,
        repo: REPO,
        root,
        ledgerPath,
        reader: () => ({ status: "read", lcovText: LCOV, workflowRunId: 501, headSha: "head-501", artifactId: 22, prNumber: 5 }),
        writeLedgerLine: (path, line) => appendLine(path, line),
        ledgerUnion: () => ({ stateDir, archiveFiles: ["a"], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
      },
    });
    assert.equal(measured.coverageImprovement?.status, "measured");
    assert.equal(measured.coverageImprovement?.coverageTier, "improve");
    assert.equal(measured.coverageImprovement?.producerAction, "filed");
    assert.equal(measured.coverageImprovement?.workflowRunId, 501);
    const entries = readdirSync(join(root, "plan", "feedback")).filter((f) => f.endsWith(".yaml"));
    assert.equal(entries.length, 1);
    const parsed = parseYaml(readFileSync(join(root, "plan", "feedback", entries[0]), "utf8")) as { raw: string };
    assert.match(parsed.raw, /src\/debt\.ts/);

    let captureCalls = 0;
    const refused = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      checkoutDir: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
      ledgerUnion: () => ({ stateDir, archiveFiles: ["a"], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
      coverageImprovement: {
        owner: OWNER,
        repo: REPO,
        root,
        ledgerPath,
        reader: () => ({ status: "refused", reason: "no_coverage_merged_artifact", detail: "no coverage-merged artifact on run 501" }),
        capture: () => {
          captureCalls++;
          return fakeEntry("bad", "bad");
        },
      },
    });
    assert.equal(refused.coverageImprovement?.status, "refused");
    assert.match(refused.coverageImprovement?.refusedReason ?? "", /no_coverage_merged_artifact/);
    assert.equal(captureCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverageImproveCommand: --from-ci shares the artifact reader and the existing producer", () => {
  const root = tmp("rmd-coverage-cli-ci-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ledger.2026-09-07T00-00-00-000Z.ndjson"), "");
    let readerCalls = 0;
    let captureCalls = 0;
    const code = coverageImproveCommand(["--from-ci"], {
      root,
      stateDir,
      ledgerPath: join(stateDir, "ledger.ndjson"),
      runId: "cli-from-ci",
      resolveOwnerRepo: () => ({ owner: OWNER, repo: REPO }),
      fetchCoverageArtifact: () => {
        readerCalls++;
        return { status: "read", lcovText: LCOV, workflowRunId: 601, headSha: "head-601", artifactId: 44, prNumber: 6 };
      },
      capture: (_captureRoot, opts) => {
        captureCalls++;
        return fakeEntry("fb-601", opts.raw);
      },
      ledgerUnion: () => ({ stateDir, archiveFiles: ["a"], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
      writeLedgerLine: (path, line) => appendLine(path, line),
    });

    assert.equal(code, 0);
    assert.equal(readerCalls, 1);
    assert.equal(captureCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractLcovFromArtifactZip: refuses a zip with no LCOV-looking member", () => {
  assert.equal(extractLcovFromArtifactZip(storedZip("notes.txt", "plain text")), undefined);
});

function appendLine(path: string, line: LedgerLine): void {
  writeFileSync(path, JSON.stringify(line) + "\n", { flag: "a" });
}
