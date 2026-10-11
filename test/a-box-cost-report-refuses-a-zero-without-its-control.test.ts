import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { makeTempDir } from "../src/lib/tmp.js";
import { BoxCostRefusal, boxCostReportCli, buildBoxCostReport, deltaOf, POSITIVE_CONTROL_STEP } from "../scripts/box-cost-report.js";

const WINDOW = { since: "2026-10-06T00:00:00Z", until: "2026-10-07T00:00:00Z" };
const SECRET = "SECRET-ROW-BODY-do-not-print";

const ndjson = (rows: object[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
const MiB = 1024 * 1024;

function memory(ts: string, rss = 100): object {
  return { ts, step: "serve.memory", rss_bytes: rss * MiB, heap_used_bytes: 40 * MiB, unattributed_bytes: 10 * MiB, note: SECRET };
}

const ARCHIVE_ROWS = [
  memory("2026-10-06T01:00:00.000Z", 100),
  { ts: "2026-10-06T01:00:01.000Z", step: "read_model.slow_view", view: "now@core", ms: 1000, stages: { plan: 400, ledger: 600 }, detail: SECRET },
  { ts: "2026-10-06T02:10:00.000Z", step: "workstreams.built", instances: 3, reused: 2, derived: 1 },
];
const LIVE_ROWS = [
  memory("2026-10-06T03:00:00.000Z", 300),
  { ts: "2026-10-06T03:00:01.000Z", step: "read_model.slow_view", view: "now@core", ms: 500, body: SECRET },
  { ts: "2026-10-06T03:00:02.000Z", step: "read_model.memo_retention", thread: "views", lane: "fast", holder: "ledger-memo", archives: 5, rows: 90, tornRows: 0, failedArchives: 0, path: `/${SECRET}` },
  { ts: "2026-10-06T03:00:03.000Z", step: "serve.plan_pin_adopted", parseMs: 120, parsedBlobs: 4, reusedBlobs: 6, threadId: SECRET },
  { ts: "2026-10-06T03:00:04.000Z", step: "serve.handoff_done", toSha: "0123456789abcdef", prepMs: 10, readyMs: 20, drainMs: 30, peakBytes: 200 * MiB },
  { ts: "2026-10-08T03:00:00.000Z", step: "serve.memory", rss_bytes: 999 * MiB },
];

function stateDir(t: { after(fn: () => void): void }, opts: { archive?: object[] | "corrupt"; live?: object[] | "absent" } = {}): string {
  const dir = makeTempDir("box-cost-report");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const archive = opts.archive ?? ARCHIVE_ROWS;
  const name = "ledger.2026-10-06T12-00-00-000Z.ndjson.gz";
  writeFileSync(join(dir, name), archive === "corrupt" ? Buffer.from("not gzip at all") : gzipSync(Buffer.from(ndjson(archive))));
  if (opts.live !== "absent") writeFileSync(join(dir, "ledger.ndjson"), ndjson(opts.live ?? LIVE_ROWS));
  return dir;
}

async function refusal(promise: Promise<unknown>): Promise<BoxCostRefusal> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BoxCostRefusal, `expected a refusal, got ${String(error)}`);
    return error;
  }
  assert.fail("the report answered where it should have refused");
}

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: an empty ledger window reports no numbers and is refused", async (t) => {
  const dir = stateDir(t, { archive: [], live: [] });
  const refused = await refusal(buildBoxCostReport(dir, WINDOW));
  assert.deepEqual(refused.reasons, ["positive-control-zero"]);
  assert.equal(refused.counts.controlRows, 0);
  const lines: string[] = [];
  assert.equal(await boxCostReportCli(["--state-dir", dir, "--since", WINDOW.since, "--until", WINDOW.until], (line) => lines.push(line)), 2);
  const printed = JSON.parse(lines.join("")) as Record<string, unknown>;
  assert.equal(printed.ok, false);
  assert.equal(printed.report, undefined);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: a window whose rows lie outside it has a zero control and is refused", async (t) => {
  const dir = stateDir(t);
  const refused = await refusal(buildBoxCostReport(dir, { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" }));
  assert.deepEqual(refused.reasons, ["positive-control-zero"]);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: an unread archive fails the run rather than reporting a partial window", async (t) => {
  const dir = stateDir(t, { archive: "corrupt" });
  const refused = await refusal(buildBoxCostReport(dir, WINDOW));
  assert.ok(refused.reasons.includes("archive-unread"), refused.reasons.join(","));
  assert.ok(refused.counts.unreadArchives >= 1);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: a missed live file fails the run", async (t) => {
  const dir = stateDir(t, { live: "absent" });
  const refused = await refusal(buildBoxCostReport(dir, WINDOW));
  assert.ok(refused.reasons.includes("live-ledger-missing"), refused.reasons.join(","));
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: every aggregate carries its positive control and the window bounds the rows", async (t) => {
  const dir = stateDir(t);
  const report = await buildBoxCostReport(dir, WINDOW);
  const control = { step: POSITIVE_CONTROL_STEP, rows: 2 };
  assert.deepEqual(report.positiveControl, control);
  for (const section of [report.slowView, report.workstreamsBuilt, report.memoRetention, report.planPinAdopted, report.serveMemory, report.handoffDone]) {
    assert.deepEqual(section.positiveControl, control);
  }
  assert.deepEqual(report.slowView.views["now@core"], { count: 2, totalMs: 1500, maxMs: 1000, stages: { ledger: { count: 1, totalMs: 600 }, plan: { count: 1, totalMs: 400 } } });
  assert.deepEqual(report.workstreamsBuilt.perHour, { "2026-10-06T02:00Z": { builds: 1, instances: 3, reused: 2, derived: 1 } });
  assert.deepEqual(report.memoRetention.holders["views/fast/ledger-memo"], { reports: 1, maxArchives: 5, maxRows: 90, maxTornRows: 0, maxFailedArchives: 0 });
  assert.deepEqual(report.planPinAdopted, { adoptions: 1, parseMsTotal: 120, parseMsMax: 120, parsedBlobs: 4, reusedBlobs: 6, positiveControl: control });
  assert.deepEqual(report.serveMemory.rssMiB, { max: 300, mean: 200 });
  assert.equal(report.handoffDone.peakMiBMax, 200);
  assert.deepEqual(report.handoffDone.toShas, ["0123456"]);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: the printed report carries counts and field names only, never a row body", async (t) => {
  const dir = stateDir(t);
  const lines: string[] = [];
  assert.equal(await boxCostReportCli(["--state-dir", dir, "--since", WINDOW.since, "--until", WINDOW.until], (line) => lines.push(line)), 0);
  const text = lines.join("\n");
  assert.ok(!text.includes(SECRET), "a row body reached the output");
  assert.ok(!text.includes("0123456789abcdef"), "a full sha reached the output");
  assert.ok(!text.includes(dir), "a path reached the output");
  const strings: string[] = [];
  const walk = (value: unknown, key = ""): void => {
    if (typeof value === "string") strings.push(`${key}=${value}`);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(JSON.parse(text));
  const allowed = ["step", "since", "until", "toShas"];
  assert.deepEqual(strings.filter((s) => !allowed.includes(s.split("=")[0]!)), []);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: a free-text view name is never printed", async (t) => {
  const dir = stateDir(t, { archive: [memory("2026-10-06T01:00:00.000Z"), { ts: "2026-10-06T01:00:01.000Z", step: "read_model.slow_view", view: `has spaces ${SECRET}`, ms: 5 }], live: [] });
  const report = await buildBoxCostReport(dir, WINDOW);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.deepEqual(Object.keys(report.slowView.views), ["(unnamed)"]);
});

test("test/a-box-cost-report-refuses-a-zero-without-its-control.test.ts: two windows print their deltas, and each must carry its own control", async (t) => {
  const dir = stateDir(t);
  const lines: string[] = [];
  const argv = ["--state-dir", dir, "--since", WINDOW.since, "--until", WINDOW.until, "--compare-since", "2026-10-06T03:00:00Z", "--compare-until", "2026-10-07T00:00:00Z"];
  assert.equal(await boxCostReportCli(argv, (line) => lines.push(line)), 0);
  const printed = JSON.parse(lines.join("")) as { delta: { slowView: { views: Record<string, { count: number }> }; serveMemory: { samples: number; rssMiB: { max: number } } } };
  assert.equal(printed.delta.slowView.views["now@core"]!.count, -1);
  assert.equal(printed.delta.serveMemory.samples, -1);
  assert.equal(printed.delta.serveMemory.rssMiB.max, 0);
  assert.deepEqual(deltaOf({ a: { b: 1 } }, { a: { b: 4, c: 2 } }), { a: { b: 3, c: 2 } });

  const refusedLines: string[] = [];
  const empty = ["--state-dir", dir, "--since", WINDOW.since, "--until", WINDOW.until, "--compare-since", "2027-01-01T00:00:00Z", "--compare-until", "2027-01-02T00:00:00Z"];
  assert.equal(await boxCostReportCli(empty, (line) => refusedLines.push(line)), 2);
  assert.deepEqual((JSON.parse(refusedLines.join("")) as { reasons: string[] }).reasons, ["positive-control-zero"]);
});
