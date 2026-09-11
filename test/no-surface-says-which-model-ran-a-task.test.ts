import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildShellRoute, recentConsoleRunHistory, renderRecentRunHistoryHtml } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import type { LedgerRecord } from "../src/lib/retro.js";

const READ_TOKEN = "read-token";
const WRITE_TOKEN = "write-token";

function records(...rows: LedgerRecord[]): LedgerRecord[] {
  return rows;
}

function shellScript(html: string): string {
  const match = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the shell must still emit its client script");
  return match[1]!;
}

async function fetchShellHtml(ledger: LedgerRecord[]): Promise<string> {
  const route = buildShellRoute(
    {},
    "abc123",
    {
      ledgerPath: "/tmp/rmd-test-ledger.ndjson",
      readLedger: () => ledger,
      now: () => new Date("2026-09-11T00:00:00.000Z"),
    },
    { armed: false },
    () => "abc123",
  );
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/?token=${READ_TOKEN}`);
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    server.close();
  }
}

test("W1-T3158: the console run-history section lists recent task runs in time order with model, effort, and provenance", async () => {
  const ledger = records(
    {
      run_id: "W1-T3158-old",
      task_id: "W1-T3158-old",
      step: "run.start",
      type: "implement",
      ts: "2026-09-10T08:00:00.000Z",
      mount: { model: "haiku", effort: "low", max_turns: 20, context_budget: 10000 },
    },
    {
      run_id: "W1-T3158-old",
      task_id: "W1-T3158-old",
      step: "verdict",
      ts: "2026-09-10T08:30:00.000Z",
      verdict: "merged",
      model: "haiku",
    },
    {
      run_id: "W1-T3158-unattributed",
      task_id: "W1-T3158-unattributed",
      step: "run.start",
      type: "implement",
      ts: "2026-09-10T09:00:00.000Z",
    },
    {
      run_id: "W1-T3158-unattributed",
      task_id: "W1-T3158-unattributed",
      step: "verdict",
      ts: "2026-09-10T09:20:00.000Z",
      verdict: "failed",
    },
    {
      run_id: "W1-T3158-mounted",
      task_id: "W1-T3158-mounted",
      step: "run.start",
      type: "implement",
      ts: "2026-09-10T10:00:00.000Z",
      mount: { model: "sonnet", effort: "high", max_turns: 120, context_budget: 200000 },
    },
    {
      run_id: "W1-T3158-mounted",
      task_id: "W1-T3158-mounted",
      step: "verdict",
      ts: "2026-09-10T10:40:00.000Z",
      verdict: "merged",
    },
    {
      run_id: "W1-T3158-done",
      task_id: "W1-T3158-done",
      step: "run.start",
      type: "implement",
      ts: "2026-09-10T11:00:00.000Z",
      mount: { model: "opus", effort: "medium", max_turns: 80, context_budget: 150000 },
    },
    {
      run_id: "W1-T3158-done",
      task_id: "W1-T3158-done",
      step: "implement.done",
      ts: "2026-09-10T11:30:00.000Z",
      model: "sonnet",
      served_model: "claude-sonnet-5",
      effort: "xhigh",
      max_turns: 90,
    },
    {
      run_id: "W1-T3158-done",
      task_id: "W1-T3158-done",
      step: "verdict",
      ts: "2026-09-10T11:40:00.000Z",
      verdict: "merged",
    },
    {
      run_id: "W1-T3158-row",
      task_id: "W1-T3158-row",
      step: "run.start",
      type: "implement",
      ts: "2026-09-10T12:00:00.000Z",
      mount: { model: "sonnet", effort: "low", max_turns: 40, context_budget: 120000 },
    },
    {
      run_id: "W1-T3158-row",
      task_id: "W1-T3158-row",
      step: "verdict",
      ts: "2026-09-10T12:30:00.000Z",
      verdict: "merged",
      model: "opus",
      effort: "max",
    },
    {
      run_id: "TRIAGE-3158",
      task_id: "TRIAGE-3158",
      step: "run.start",
      type: "triage",
      ts: "2026-09-10T13:00:00.000Z",
    },
  );

  const history = recentConsoleRunHistory(ledger, 4);
  assert.deepEqual(
    history.items.map((item) => item.taskId),
    ["W1-T3158-row", "W1-T3158-done", "W1-T3158-mounted", "W1-T3158-unattributed"],
    "the section is newest-first, bounded, and ignores non-implement lane run.start rows",
  );
  assert.equal(history.windowStartTs, "2026-09-10T09:20:00.000Z");
  assert.equal(history.windowEndTs, "2026-09-10T12:30:00.000Z");
  assert.equal(history.items[0]!.model, "opus");
  assert.equal(history.items[0]!.modelProvenance, "row");
  assert.equal(history.items[0]!.effort, "max");
  assert.equal(history.items[0]!.effortProvenance, "row");
  assert.equal(history.items[1]!.model, "claude-sonnet-5");
  assert.equal(history.items[1]!.modelProvenance, "implement.done");
  assert.equal(history.items[1]!.effort, "xhigh");
  assert.equal(history.items[1]!.effortProvenance, "implement.done");
  assert.equal(history.items[1]!.maxTurns, 90);
  assert.equal(history.items[2]!.model, "sonnet");
  assert.equal(history.items[2]!.modelProvenance, "run.start.mount");
  assert.equal(history.items[2]!.effort, "high");
  assert.equal(history.items[2]!.effortProvenance, "run.start.mount");
  assert.equal(history.items[2]!.contextBudget, 200000);
  assert.equal(history.items[3]!.model, "unattributed");
  assert.equal(history.items[3]!.modelProvenance, "unattributed");

  const rendered = renderRecentRunHistoryHtml(history);
  assert.match(rendered, /id="run-history"/);
  assert.match(rendered, /model <span class="mono">opus<\/span> <span class="counts">\(row\)<\/span>/);
  assert.match(rendered, /model <span class="mono">claude-sonnet-5<\/span> <span class="counts">\(implement\.done\)<\/span>/);
  assert.match(rendered, /model <span class="mono">sonnet<\/span> <span class="counts">\(run\.start\.mount\)<\/span>/);
  assert.match(rendered, /model <span class="mono">unattributed<\/span> <span class="counts">\(unattributed\)<\/span>/);
  assert.match(rendered, /effort <span class="mono">high<\/span> <span class="counts">\(run\.start\.mount\)<\/span>/);
  assert.match(rendered, /bounded to newest 4 task runs from 12 live ledger rows/);

  const html = await fetchShellHtml(ledger);
  assert.match(html, /Recent task run history/);
  assert.match(html, /W1-T3158-row/);
  assert.match(html, /model <span class="mono">opus<\/span> <span class="counts">\(row\)<\/span>/);
  assert.doesNotMatch(html, /TRIAGE-3158/, "the shell does not report non-implement lane run.start rows as task runs");
  assert.doesNotThrow(() => new Function(shellScript(html)), "the rendered client script must still parse");
});
