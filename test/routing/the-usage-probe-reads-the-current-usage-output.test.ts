import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { runDaemon } from "#src/lib/daemon.js";
import { NO_USAGE_PANEL_REASON, UsageParseError, headroomExhausted, parseUsage, usageOutputShape, type UsageSnapshot } from "#src/lib/headroom.js";
import { loadPlan } from "#src/lib/plan.js";
import { claudeCapacityFromUsage } from "#src/lib/worker-provider.js";
import { readUsageSnapshotAsync, readUsageSnapshotPreferSdk, type RunResult } from "#test/helpers/run-task-test.js";

// W1-T12153. Since 2026-11-11 11:09Z `claude -p /usage` prints weekly lines and no session line.
// This is that output, with the paths and the account parts replaced.
const CURRENT_OUTPUT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current week (all models): 69% used · resets Nov 15, 4:59am (UTC)",
  "Current week (Fable): 0% used · resets Nov 15, 5am (UTC)",
  "",
  "What's contributing to your usage?",
  "Approximate · sessions on this machine only · shares overlap",
  "",
  "Last 24h · 14 requests · 1 session",
  "  59%  Trim /home/fixture-user/project/CLAUDE.md · 11k tokens per request",
  "",
  "Last 7d · 3359 requests · 3 sessions",
  "  100%  Give \"fork\" subagents a cheaper model",
  "",
].join("\n");

const ACCOUNT_LINES = ["Account: jane.fixture@example.com", "Jane Fixture's Organization"];

type Row = Record<string, unknown>;

async function readThroughProduction(cliText: string): Promise<{ snap: UsageSnapshot | undefined; rows: Row[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12153-root-"));
  const home = mkdtempSync(join(tmpdir(), "rmd-t12153-home-"));
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    const config: Config = { claudeBin: "claude-fake", root };
    const snap = await readUsageSnapshotPreferSdk(config, {
      viaSdk: async (sink) => {
        sink("sdk", "usage control request returned no usable rate-limit windows — falling back");
        return undefined;
      },
      viaCli: (sink) => readUsageSnapshotAsync(config, async () => cliText, sink, 5_000),
    });
    let text = "";
    try {
      text = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rows = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
      .filter((row) => row.step === "usage.probe_failed");
    return { snap, rows };
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T12153 criterion 1: an output that cannot be parsed writes its shape, with digits masked and no account name", async () => {
  const garbled = [...ACCOUNT_LINES, CURRENT_OUTPUT.replace("Current week (all models): 69% used", "Current week (all models): unavailable")].join("\n");
  const { snap, rows } = await readThroughProduction(garbled);
  assert.equal(snap, undefined, "a garbled weekly line is still unreadable");
  const parse = rows.find((row) => row.stage === "parse");
  assert.ok(parse, "the parse failure has a row");
  const shape = String(parse.shape);
  const lineCount = garbled.replace(/\s+$/, "").split("\n").length;
  assert.ok(shape.startsWith(`${lineCount} lines: `), shape);
  const labels = shape.slice(`${lineCount} lines: `.length);
  assert.match(labels, /Current week \(all models\)/, "the label of each line is kept");
  assert.match(labels, /Last ##h/, "digits are masked");
  assert.doesNotMatch(labels, /\d/, "no digit survives in a label");
  for (const secret of ["jane", "Jane", "Fixture", "example", "fixture-user", "project", "subagents"]) {
    assert.ok(!shape.includes(secret), `the shape must not carry "${secret}": ${shape}`);
  }
  assert.ok(shape.length <= 400, "the row keeps its 400-character limit");
  assert.ok(usageOutputShape("x\n".repeat(2_000)).length <= 400);
});

test("W1-T12153 criterion 2: the current output gives a readable weekly-only snapshot through the production reader, and the row names that case", async () => {
  const { snap, rows } = await readThroughProduction(CURRENT_OUTPUT);
  assert.ok(snap, "the SDK gave nothing and the CLI output is readable");
  assert.equal(snap.session, undefined, "the session window is absent, not 0% used");
  assert.deepEqual(snap.weekly.map((w) => [w.label, w.percentUsed]), [["all models", 69], ["Fable", 0]]);
  assert.equal(snap.billingMode, "subscription");
  assert.deepEqual(rows.map((row) => row.stage), ["sdk", "weekly-only"]);
  assert.match(String(rows[1]!.reason), /no 'Current session:' line/);
  assert.match(String(rows[1]!.shape), /Current week \(all models\)/);

  const capacity = claudeCapacityFromUsage(snap);
  assert.equal(capacity.readable, true);
  assert.deepEqual(capacity.windows.map((w) => w.name), ["weekly (all models)", "weekly (Fable)"]);
  assert.equal(capacity.detail, "no five-hour window in the reading: weekly windows only", "the same case as the SDK weekly-only reading");

  const breached = { ...snap, weekly: snap.weekly.map((w) => (w.label === "all models" ? { ...w, percentUsed: 99 } : w)) };
  assert.equal(headroomExhausted(breached)?.window, "weekly (all models)");
  const dir = mkdtempSync(join(tmpdir(), "rmd-t12153-plan-"));
  writeFileSync(join(dir, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const breaches: string[] = [];
  let spawned = 0;
  let sleeps = 0;
  await runDaemon(loadPlan(join(dir, "tasks.yaml")), {
    refreshMerged: () => () => false,
    runOne: async (id): Promise<RunResult> => {
      spawned++;
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    readUsage: () => breached,
    onHeadroomBreach: async (info) => {
      breaches.push(info.window);
    },
    now: () => new Date(2026, 10, 11, 12, 0, 0, 0),
    sleep: async () => {
      sleeps++;
    },
    checkStop: () => (sleeps >= 2 ? "test done observing the breach" : undefined),
  }, { max: 1 });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(spawned, 0, "the governor holds dispatch on the weekly window");
  assert.equal(breaches[0], "weekly (all models)", "the weekly window binds");
});

test("W1-T12153 criterion 3: an output with no account panel has its own reason, apart from a garbled panel", async () => {
  const noPanel = await readThroughProduction("Total cost: $0.00\nTotal duration (API): 0s\n");
  assert.equal(noPanel.snap, undefined);
  const noPanelRow = noPanel.rows.find((row) => row.stage === "parse");
  assert.equal(noPanelRow?.reason, NO_USAGE_PANEL_REASON);
  assert.equal(noPanelRow?.shape, "2 lines: Total cost | Total duration (API)");

  const garbled = await readThroughProduction(`Current session: unavailable\n${CURRENT_OUTPUT}`);
  const garbledRow = garbled.rows.find((row) => row.stage === "parse");
  assert.match(String(garbledRow?.reason), /unparseable session window: unavailable/);
  assert.notEqual(garbledRow?.reason, NO_USAGE_PANEL_REASON);
  assert.throws(() => parseUsage("no panel here"), (e: unknown) => e instanceof UsageParseError && e.message === NO_USAGE_PANEL_REASON);
});

test("W1-T12153 criterion 4: a window with no readable percentage is still unreadable, and no case reads as 0% used", () => {
  assert.throws(() => parseUsage(`Current session: unavailable\n${CURRENT_OUTPUT}`), /unparseable session window/);
  assert.throws(() => parseUsage(CURRENT_OUTPUT.replace("Current week (Fable): 0% used", "Current week (Fable): -- used")), /unparseable weekly \(Fable\) window/);
  assert.throws(() => parseUsage("You are currently using your subscription\nCurrent month: 3% used\n"), /no 'Current week/);

  const snap = parseUsage(CURRENT_OUTPUT);
  assert.equal("session" in snap, false, "no session key, so nothing can read it as 0% used");
  const idle = parseUsage(CURRENT_OUTPUT.replace("69% used", "0% used"));
  assert.equal(headroomExhausted(idle, 0)?.window, "weekly (all models)", "at a 0% limit the first window listed is weekly, so no session window was added");
  const capacity = claudeCapacityFromUsage(snap);
  assert.ok(capacity.windows.every((w) => w.name !== "session (5h)"), "the capacity row has no session window");
});
