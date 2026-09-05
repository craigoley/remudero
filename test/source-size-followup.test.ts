import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreflightSummary } from "../src/lib/ci-parity.js";
import {
  SOURCE_SIZE_FOLLOWUP_FILED_STEP,
  SOURCE_SIZE_FOLLOWUP_POLICY_VERSION,
  buildSourceSizeFollowupFeedback,
  classifySourceSizeSummary,
  consumeSourceSizeFollowup,
  sourceSizeHotspotSignature,
  type MaterialSourceSizeHotspot,
} from "../src/lib/source-size-followup.js";

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

function summary(hotspots: unknown[], overrides: Partial<PreflightSummary> = {}): PreflightSummary {
  const report = { schema_version: 1, base: BASE, head: HEAD, hotspots };
  return {
    ok: true,
    finishedAt: "2026-09-05T04:00:00.000Z",
    durationMs: 1,
    headSha: HEAD,
    args: ["--fast"],
    passed: 1,
    failed: 0,
    steps: [
      {
        name: "source-size",
        ok: true,
        detail: "source-size: PASS — npm run --silent source-size-signal",
        successOutput: {
          text: `source-size-signal: OK\nsource-size-signal-json: ${JSON.stringify(report)}`,
          truncated: false,
        },
      },
    ],
    ...overrides,
  };
}

const line = (path: string, before: number, after: number) => ({
  path,
  before_lines: before,
  after_lines: after,
  delta_lines: after - before,
  delta_percent: before === 0 ? null : Number((((after - before) / before) * 100).toFixed(2)),
});

test("W1-T2862: a 1,000-line result with either 250 lines or 20 percent growth is material", () => {
  const result = classifySourceSizeSummary(
    summary([
      line("src/lib/by-lines.ts", 900, 1150),
      line("src/lib/by-percent.ts", 900, 1080),
      line("src/lib/below.ts", 900, 1079),
    ]),
    HEAD,
  );
  assert.equal(result.action, "material");
  if (result.action !== "material") return;
  assert.deepEqual(result.hotspots.map((h) => h.path), ["src/lib/by-lines.ts", "src/lib/by-percent.ts"]);
  assert.match(buildSourceSizeFollowupFeedback(result.hotspots), /priority: 1/i);
  assert.match(buildSourceSizeFollowupFeedback(result.hotspots), /1150 lines.*\+250 lines.*27\.78%/);
  assert.match(buildSourceSizeFollowupFeedback(result.hotspots), /1080 lines.*\+180 lines.*20\.00%/);
});

test("W1-T2862: small, malformed, stale, unknown-schema and non-source evidence are named no-ops", () => {
  assert.deepEqual(classifySourceSizeSummary(summary([line("src/lib/small.ts", 700, 950)]), HEAD), {
    action: "noop",
    reason: "no_material_hotspots",
  });
  assert.equal(classifySourceSizeSummary(summary([line("test/not-source.ts", 900, 1200)]), HEAD).reason, "invalid_hotspot");
  assert.equal(classifySourceSizeSummary(summary([line("src/../escape.ts", 900, 1200)]), HEAD).reason, "invalid_hotspot");
  assert.equal(classifySourceSizeSummary(summary([line("src/lib/x.ts", 900, 1200)]), "c".repeat(40)).reason, "stale_head");
  const unknown = summary([line("src/lib/x.ts", 900, 1200)]);
  const output = unknown.steps[0].successOutput!;
  output.text = output.text.replace('"schema_version":1', '"schema_version":2');
  assert.equal(classifySourceSizeSummary(unknown, HEAD).reason, "unknown_schema");
  const malformed = summary([line("src/lib/x.ts", 900, 1200)]);
  malformed.steps[0].successOutput!.text = "source-size-signal-json: {not json";
  assert.equal(classifySourceSizeSummary(malformed, HEAD).reason, "payload_malformed");
  const oversized = summary([line("src/lib/x.ts", 900, 1200)]);
  oversized.steps[0].successOutput = { text: "x".repeat(65_536), truncated: true };
  assert.equal(classifySourceSizeSummary(oversized, HEAD).reason, "source_output_oversized");
});

test("W1-T2862: one exact report groups material files, dedupes its signature, and changed measurements file again", () => {
  const first = line("src/lib/one.ts", 900, 1200);
  const second = line("src/lib/two.ts", 800, 1000);
  const classified = classifySourceSizeSummary(summary([second, first]), HEAD);
  assert.equal(classified.action, "material");
  if (classified.action !== "material") return;
  const signature = sourceSizeHotspotSignature(classified.hotspots);
  const changed = sourceSizeHotspotSignature([
    ...classified.hotspots.filter((h) => h.path !== "src/lib/one.ts"),
    { ...classified.hotspots.find((h) => h.path === "src/lib/one.ts")!, afterLines: 1201, deltaLines: 301 },
  ]);
  assert.notEqual(changed, signature, "materially changed measurements must form a new obligation");

  const captures: Array<{ raw: string }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const baseDeps = {
    root: "/repo",
    worktreeRoot: "/worktree",
    expectedHead: HEAD,
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "W1-T2862-1",
    sourceTask: "W1-T999",
    sourcePr: "https://github.com/o/r/pull/99",
    sourceBranch: "run-W1-T999-1",
    readFile: () => JSON.stringify(summary([second, first])),
    capture: (_root: string, opts: { raw: string }) => {
      captures.push(opts);
      return { id: "fb-one" } as never;
    },
    writeLedgerLine: (_path: string, row: Record<string, unknown>) => ledger.push(row),
  };
  const filed = consumeSourceSizeFollowup({
    ...baseDeps,
    ledgerUnion: () => ({ ok: true, matches: [], archiveFiles: ["x"], archiveCount: 1, liveFileRead: true, unread: [], stateDir: "/state" }),
  });
  assert.equal(filed.action, "filed");
  assert.equal(captures.length, 1, "all hotspots belong to one feedback entry");
  assert.match(captures[0].raw, /src\/lib\/one\.ts/);
  assert.match(captures[0].raw, /src\/lib\/two\.ts/);
  assert.deepEqual(ledger[0], {
    run_id: "W1-T2862-1",
    task_id: "W1-T999",
    step: SOURCE_SIZE_FOLLOWUP_FILED_STEP,
    policy_version: SOURCE_SIZE_FOLLOWUP_POLICY_VERSION,
    signature,
    source_task: "W1-T999",
    source_pr: "https://github.com/o/r/pull/99",
    source_branch: "run-W1-T999-1",
    feedback_id: "fb-one",
    files: ["src/lib/one.ts", "src/lib/two.ts"],
  });
  assert.doesNotMatch(JSON.stringify(ledger[0]), /Requested task priority|1200 lines/);

  const duplicate = consumeSourceSizeFollowup({
    ...baseDeps,
    ledgerUnion: () => ({
      ok: true,
      matches: [JSON.stringify({ step: SOURCE_SIZE_FOLLOWUP_FILED_STEP, signature })],
      archiveFiles: ["x"],
      archiveCount: 1,
      liveFileRead: true,
      unread: [],
      stateDir: "/state",
    }),
  });
  assert.deepEqual(duplicate, { action: "noop", reason: "duplicate", signature });
  assert.equal(captures.length, 1, "the duplicate must not capture another entry");
});

test("W1-T2862: unreadable dedupe evidence and filing failures are explicit best-effort outcomes", () => {
  const deps = {
    root: "/repo",
    worktreeRoot: "/worktree",
    expectedHead: HEAD,
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-1",
    sourceTask: "W1-T999",
    readFile: () => JSON.stringify(summary([line("src/lib/one.ts", 900, 1200)])),
  };
  const unreadable = consumeSourceSizeFollowup({
    ...deps,
    ledgerUnion: () => ({ ok: false, matches: [], archiveFiles: [], archiveCount: 0, liveFileRead: true, unread: [], stateDir: "/state" }),
  });
  assert.deepEqual(unreadable.action, "noop");
  assert.equal(unreadable.reason, "ledger_unreadable");

  const failed = consumeSourceSizeFollowup({
    ...deps,
    ledgerUnion: () => ({ ok: true, matches: [], archiveFiles: ["x"], archiveCount: 1, liveFileRead: true, unread: [], stateDir: "/state" }),
    capture: () => {
      throw new Error("landing unavailable");
    },
  });
  assert.equal(failed.action, "error");
  assert.equal(failed.reason, "filing_failed");
  assert.doesNotMatch(failed.detail, /auth|token|credential/i);
});

test("W1-T2862: deleting either material threshold changes the classifier result", () => {
  const byLines = classifySourceSizeSummary(summary([line("src/lib/lines.ts", 900, 1150)]), HEAD);
  const byPercent = classifySourceSizeSummary(summary([line("src/lib/percent.ts", 900, 1080)]), HEAD);
  assert.equal(byLines.action, "material", "the 250-line arm is load-bearing");
  assert.equal(byPercent.action, "material", "the 20-percent arm is load-bearing");
});

test("source-size signatures are stable under report order", () => {
  const hotspots: MaterialSourceSizeHotspot[] = [
    { path: "src/lib/b.ts", beforeLines: 900, afterLines: 1200, deltaLines: 300, deltaPercent: 33.33 },
    { path: "src/lib/a.ts", beforeLines: 800, afterLines: 1000, deltaLines: 200, deltaPercent: 25 },
  ];
  assert.equal(sourceSizeHotspotSignature(hotspots), sourceSizeHotspotSignature([...hotspots].reverse()));
});
