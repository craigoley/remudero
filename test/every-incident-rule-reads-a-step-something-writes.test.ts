// @source-text-subject: this census's subject is the ledger writes in src/ — it reads each source file's text
// to find a writer for every step an incident rule reads, and an emitter for every runbook incident name.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
  DISPATCH_STALL_RULE_ID,
  evaluateIncidentInvariants,
  INCIDENT_RULE_INPUTS,
  NO_MERGES_WITH_GREEN_QUEUE_RULE_ID,
  type IncidentInvariantRow,
} from "../src/lib/incident-invariants.js";
import { SRE_RUNBOOK_INCIDENTS } from "../src/lib/sre-runbooks.js";

/**
 * W1-T8233 — EVERY INCIDENT RULE READS A STEP SOMETHING WRITES.
 *
 * On 2026-10-11 the one operator page for "the fleet built nothing for hours" (sre-governor's
 * FLEET_STALL_RULES) rested on two rules reading `queue.priority_snapshot` and `queue.merge_ready`, which
 * nothing in src/ wrote, and `pr.merged`, which had no row in 24 h. Neither fired through a 52-minute
 * recycle hold or four core pauses. This census walks src/ so a rule can never again read a step with no
 * writer, and so a runbook's incident name without an emitter is visible debt rather than silence.
 */

const SRC = join(import.meta.dirname, "..", "src");
const RULE_MODULE = "lib/incident-invariants.ts";
const RUNBOOK_MODULE = "lib/sre-runbooks.ts";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SOURCES: ReadonlyArray<{ file: string; text: string }> = walk(SRC).map((path) => ({
  file: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

/** Steps whose writer spells them through a constant or a builder, so the literal is not at the call site. */
const WRITTEN_THROUGH_SYMBOL: Readonly<Record<string, { file: string; symbol: string }>> = {
  "serve.memory": { file: "lib/serve-memory.ts", symbol: "log(SERVE_MEMORY_STEP" },
  "serve.memory_relieved": { file: "lib/serve-memory.ts", symbol: "log(SERVE_MEMORY_RELIEVED_STEP" },
  "runtime.loop_lag": { file: "lib/serve.ts", symbol: "eventLoopLagLedgerLine(" },
};

function quoted(text: string, literal: string): boolean {
  return ['"', "'", "`"].some((q) => text.includes(`${q}${literal}${q}`));
}

/** The files other than the rule module that write `step` (a trailing `*` is a prefix, a leading `*` a suffix). */
function writersOf(step: string): string[] {
  const symbol = WRITTEN_THROUGH_SYMBOL[step];
  if (symbol) return SOURCES.filter((s) => s.file === symbol.file && s.text.includes(symbol.symbol)).map((s) => s.file);
  return SOURCES.filter((s) => {
    if (s.file === RULE_MODULE) return false;
    if (step.endsWith("*")) {
      const prefix = step.slice(0, -1);
      return new RegExp(`["'\`]${prefix.replace(/\./g, "\\.")}[a-z_]+["'\`]`).test(s.text);
    }
    if (step.startsWith("*")) {
      const suffix = step.slice(1);
      return new RegExp(`["'\`][a-z_.]+${suffix}["'\`]`).test(s.text);
    }
    return quoted(s.text, step);
  }).map((s) => s.file);
}

/** Runbook incident names no `incident.event` producer emits today. The table can only shrink: a name that
 *  gains an emitter must be removed from here, and a name that is neither emitted nor listed fails. */
const UNREACHABLE_RUNBOOK_DEBT: Readonly<Record<string, string>> = {
  "ci-red-unrelated": "no incident.event builder emits it, so rerun-failed-ci-once is never selected",
  "stale-managed-checkout": "no incident.event builder emits it, so catch-up-managed-checkout is never selected",
  "stale-container": "no incident.event builder emits it, so recycle-stale-container is never selected",
  "stale-lock": "no incident.event builder emits it, so clear-stale-lock-or-nudge is never selected",
  "stale-review": "no incident.event builder emits it, so clear-stale-lock-or-nudge is never selected",
};

function emittersOf(name: string): string[] {
  return SOURCES.filter((s) => s.file !== RUNBOOK_MODULE && s.file !== RULE_MODULE && quoted(s.text, name)).map((s) => s.file);
}

test("W1-T8233: every incident rule input has a writer", () => {
  const ruleIds = Object.keys(INCIDENT_RULE_INPUTS);
  assert.ok(ruleIds.length >= 6, `the rule table is exported with its rules, got ${ruleIds.join(",")}`);
  const unwritten: string[] = [];
  for (const [ruleId, inputs] of Object.entries(INCIDENT_RULE_INPUTS)) {
    assert.ok(inputs.length > 0, `${ruleId} must declare the steps it reads`);
    for (const step of inputs) {
      if (writersOf(step).length === 0) unwritten.push(`${ruleId} reads ${step}`);
    }
  }
  assert.deepEqual(unwritten, [], "a rule reads a step no file in src/ writes, so it can never fire");

  // The two retired inputs stay retired: nothing writes them, so no rule may read them again.
  const allInputs = Object.values(INCIDENT_RULE_INPUTS).flat();
  assert.ok(!allInputs.includes("queue.priority_snapshot"));
  assert.ok(!allInputs.includes("queue.merge_ready"));
  assert.ok(INCIDENT_RULE_INPUTS[NO_MERGES_WITH_GREEN_QUEUE_RULE_ID]!.includes("verdict.merged"));
});

test("W1-T8233: every runbook incident name is emitted or listed as debt", () => {
  const names = Object.values(SRE_RUNBOOK_INCIDENTS).flat() as string[];
  assert.ok(names.length >= 5);
  const problems: string[] = [];
  for (const name of names) {
    const emitters = emittersOf(name);
    const debt = UNREACHABLE_RUNBOOK_DEBT[name];
    if (emitters.length === 0 && debt === undefined) problems.push(`${name}: no emitter and not listed as debt`);
    if (emitters.length > 0 && debt !== undefined) problems.push(`${name}: now emitted by ${emitters.join(",")} — remove it from the debt table`);
  }
  for (const listed of Object.keys(UNREACHABLE_RUNBOOK_DEBT)) {
    if (!names.includes(listed)) problems.push(`${listed}: listed as debt but no runbook answers it`);
  }
  assert.deepEqual(problems, []);
});

const NOW_MS = Date.parse("2026-10-11T19:00:00.000Z");

function row(atMs: number, fields: Record<string, unknown>): IncidentInvariantRow {
  return { ts: new Date(atMs).toISOString(), run_id: "TEST", task_id: "TEST", ...fields };
}

test("W1-T8233: dispatch-stall fires on the recycle-hold replay", () => {
  const rows: IncidentInvariantRow[] = [];
  // 2026-10-11 16:16-17:08: a recycle drain holds dispatch 52 minutes — a daemon.pause row every minute
  // and no implement run.start (a triage run.start is not implement work).
  const holdStart = NOW_MS - 52 * 60_000;
  for (let t = holdStart; t <= NOW_MS; t += 60_000) {
    rows.push(row(t, { step: "daemon.pause", detail: "recycle drain", poll_interval_ms: 60_000 }));
  }
  rows.push(row(NOW_MS - 20 * 60_000, { step: "run.start", type: "triage" }));

  const stall = evaluateIncidentInvariants(rows, NOW_MS).find((f) => f.ruleId === DISPATCH_STALL_RULE_ID);
  assert.ok(stall, "a 52-minute hold with held dispatch rows and no implement run.start must fire dispatch-stall");
  assert.match(stall!.message, /implement run starts=0/);

  // The pause window of the same day: held lane refills with the fleet PAUSE reason.
  const pauseRows: IncidentInvariantRow[] = [];
  for (let t = NOW_MS - 30 * 60_000; t <= NOW_MS; t += 60_000) {
    pauseRows.push(row(t, { step: "dispatch.lane_refill_held", lane: 1, reason: "fleet PAUSE hold" }));
  }
  assert.ok(evaluateIncidentInvariants(pauseRows, NOW_MS).some((f) => f.ruleId === DISPATCH_STALL_RULE_ID));

  // An implement run.start inside the window clears it, even while the pause rows continue.
  const moving = [...rows, row(NOW_MS - 3 * 60_000, { step: "run.start", type: "implement" })];
  assert.ok(!evaluateIncidentInvariants(moving, NOW_MS).some((f) => f.ruleId === DISPATCH_STALL_RULE_ID));

  // No hold evidence at all is no evidence: an idle, empty ledger never fires.
  assert.ok(!evaluateIncidentInvariants([], NOW_MS).some((f) => f.ruleId === DISPATCH_STALL_RULE_ID));
});

test("W1-T8233: no-merges fires on awaiting-arm with no verdict.merged", () => {
  const rows: IncidentInvariantRow[] = [];
  for (let t = NOW_MS - 4 * 60 * 60_000 + 60_000; t <= NOW_MS; t += 10 * 60_000) {
    rows.push(row(t, { step: "sweep.disposed", disposition: "mergeable", blocker: "awaiting-arm", pr_number: 10900 + (t % 3) }));
  }
  const finding = evaluateIncidentInvariants(rows, NOW_MS).find((f) => f.ruleId === NO_MERGES_WITH_GREEN_QUEUE_RULE_ID);
  assert.ok(finding, "awaiting-arm dispositions across the window with no merge must fire no-merges-with-green-queue");
  assert.match(finding!.message, /merges=0/);
  assert.doesNotMatch(finding!.message, /green-queued=0/);

  // A verdict.merged row inside the window clears it.
  const merged = [...rows, row(NOW_MS - 60 * 60_000, { step: "verdict.merged", pr_number: 10900 })];
  assert.ok(!evaluateIncidentInvariants(merged, NOW_MS).some((f) => f.ruleId === NO_MERGES_WITH_GREEN_QUEUE_RULE_ID));

  // Other blockers are not green work waiting.
  const notGreen = rows.map((r) => ({ ...r, blocker: "awaiting-ci" }));
  assert.ok(!evaluateIncidentInvariants(notGreen, NOW_MS).some((f) => f.ruleId === NO_MERGES_WITH_GREEN_QUEUE_RULE_ID));
});
