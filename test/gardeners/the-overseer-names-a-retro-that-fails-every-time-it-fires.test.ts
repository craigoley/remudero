import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { gardenStatePath } from "#src/lib/gardener.js";
import { OVERSEER_STEP_PATTERN, productionGardenerOverseerPorts, runGardenerOverseer, type GardenerOverseerPorts } from "#src/lib/gardener-overseer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-20T00:00:00Z");
type Row = Record<string, unknown>;
const row = (step: string, at: number, extra: Row = {}): Row => ({ step, ts: new Date(at).toISOString(), ...extra });

const RETRO_OUTCOMES = ["retro.synthesized", "retro.no_op", "retro.error", "retro_aborted_integrity"];
/** Retro rows that are neither a pass nor a failure of this rule, plus look-alikes the prefilter must not take. */
const NOT_RETRO_OUTCOMES = ["retro.skipped_open_pr", "retro.skipped_in_flight", "retro.preflight_failed", "retro_triggered",
  "retro.publication.escalated", "lane.retro.error", "retro.error.detail"];

/** An overseer fed through its `readRows` port, whose escalation ledger is the rows it logged itself. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}overseer-retro-`));
  const rows: Row[] = [];
  const logs: Row[] = [];
  const escalations: Escalation[] = [];
  const closes: Array<{ url: string; comment: string }> = [];
  const deps: GardenerOverseerPorts = {
    stateDir: dir, readRows: () => rows, stateMtime: () => undefined,
    log: (step, extra) => logs.push({ step, ...extra }),
    escalate: e => { escalations.push(e); return `https://github.com/o/r/issues/${escalations.length}`; },
    closeIssue: (url, comment) => { closes.push({ url, comment }); },
    readEscalationRows: () => logs.filter(r => r.step === "gardener_overseer.escalated" || r.step === "gardener_overseer.cleared"),
  };
  const pass = (at: number) => runGardenerOverseer({ ...deps, clock: fixedClock(at) });
  const events = (step: string) => logs.filter(r => r.step === `gardener_overseer.${step}`);
  const episodes = () => JSON.parse(readFileSync(join(dir, "gardener-overseer.json"), "utf8")).episodes as Record<string, { kind: string }>;
  return { dir, rows, escalations, closes, pass, events, episodes };
}

test("W1-T10728: a retro that errors on every fire opens a failure episode and escalates once after the heal", () => {
  const h = harness();
  try {
    h.rows.push(row("retro.synthesized", T0 - 5 * DAY), row("retro.error", T0 - 2 * DAY, { error: "no PR opened" }));
    h.pass(T0);
    assert.deepEqual(h.events("noticed").map(r => [r.gardener, r.kind, r.failures, r.last_error]),
      [["retro", "failure", 1, "no PR opened"]], "tier 1: the failed fire is noticed");

    h.pass(T0 + HOUR);
    assert.deepEqual(h.events("healed").map(r => [r.gardener, r.cleared, r.unreadable]), [["retro", [], null]],
      "tier 2: the heal finds no retro gardener state and clears nothing");
    assert.equal(existsSync(gardenStatePath(h.dir, "retro")), false, "the heal writes no state file for the retro");
    h.pass(T0 + 2 * HOUR);
    assert.equal(h.escalations.length, 0, "a streak that has not grown since the heal is not escalated");

    const integrity = "retro integrity gate: the trigger observed 30 merge(s) since the marker, but the gather credited 0";
    h.rows.push(row("retro_aborted_integrity", T0 + 3 * HOUR, { reason: integrity }));
    h.pass(T0 + 3 * HOUR);
    assert.equal(h.escalations.length, 1, "tier 3: the next failed fire after the heal escalates");
    const escalation = h.escalations[0]!;
    assert.equal(escalation.taskId, "retro-gardener-liveness");
    assert.equal(escalation.summary, "the retro is unhealthy: its passes have failed 2 times in a row");
    assert.match(escalation.detail, /`retro\.error` and `retro_aborted_integrity` rows carry the failures/);
    assert.match(escalation.detail, /`retro\.synthesized` and `retro\.no_op` rows the passes/);
    assert.match(escalation.detail, /nothing was cleared/);
    assert.ok(escalation.detail.includes(integrity), "the latest error is the integrity gate's own reason");
    assert.doesNotMatch(escalation.detail, /gardener_failed|\.scorecard|lastCheap/);
    assert.deepEqual(escalation.options.map(o => o.label), ["fix-gardener"], "no switch is offered that nothing reads");
    assert.doesNotMatch(JSON.stringify(escalation), /_OFF/);
    assert.equal(escalation.recommendation, "fix-gardener");
    assert.equal(h.events("escalated")[0]?.gardener, "retro");

    h.rows.push(row("retro.error", T0 + 4 * HOUR, { error: "still no PR opened" }));
    h.pass(T0 + 4 * HOUR);
    assert.equal(h.escalations.length, 1, "never a second escalation for the same episode");
    assert.equal(h.events("noticed").length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T10728: a retro pass closes the failure episode", () => {
  for (const passStep of ["retro.synthesized", "retro.no_op"]) {
    const h = harness();
    try {
      h.rows.push(row("retro.error", T0 - 3 * HOUR, { error: "retro PR is NOT plan-only" }));
      h.pass(T0);
      h.pass(T0 + HOUR);
      h.rows.push(row("retro.error", T0 + 2 * HOUR, { error: "no PR opened" }));
      h.pass(T0 + 2 * HOUR);
      assert.equal(h.escalations.length, 1, passStep);
      assert.equal(h.episodes().retro?.kind, "failure");

      h.rows.push(row(passStep, T0 + 3 * HOUR));
      h.pass(T0 + 3 * HOUR);
      assert.equal(h.episodes().retro, undefined, `${passStep} ends the episode`);
      assert.deepEqual(h.closes, [{ url: "https://github.com/o/r/issues/1",
        comment: `Recovered: first passing \`${passStep}\` row at ${new Date(T0 + 3 * HOUR).toISOString()}. Closing automatically; a relapse opens its own issue.` }]);
      assert.deepEqual(h.events("cleared").map(r => [r.gardener, r.issue_url]), [["retro", "https://github.com/o/r/issues/1"]]);

      h.rows.push(row("retro.error", T0 + 4 * HOUR, { error: "relapse" }));
      h.pass(T0 + 4 * HOUR);
      assert.equal(h.episodes().retro?.kind, "failure", "a relapse opens its own episode");
      assert.equal(h.events("noticed").length, 2);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("W1-T10728: a quiet retro opens no silence episode", () => {
  const h = harness();
  try {
    const now = T0 + 12 * DAY;
    // Six daily passes, the last five days ago: for a gardener that is a silence of five cadences.
    for (let i = 0; i < 6; i++) {
      h.rows.push(row("retro.synthesized", now - (10 - i) * DAY), row("daily.scorecard", now - (10 - i) * DAY));
    }
    // A skip and a preflight failure are neither a pass nor a failure of this rule.
    h.rows.push(row("retro.skipped_open_pr", now - 2 * DAY), row("retro.skipped_in_flight", now - DAY),
      row("retro.preflight_failed", now - HOUR, { error: "preflight red" }));
    for (const at of [now, now + HOUR, now + 2 * HOUR]) h.pass(at);
    assert.deepEqual(h.events("noticed").map(r => [r.gardener, r.kind]), [["daily", "silence"]],
      "positive control: the same timestamps under a gardener's name are a silence");
    assert.equal(h.episodes().retro, undefined);
    assert.equal([...h.events("healed"), ...h.events("escalated")].some(r => r.gardener === "retro"), false);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T10728: the production ledger filter keeps exactly the retro's four outcome rows", () => {
  for (const step of RETRO_OUTCOMES) assert.match(JSON.stringify(row(step, T0)), OVERSEER_STEP_PATTERN, step);
  for (const step of NOT_RETRO_OUTCOMES) assert.doesNotMatch(JSON.stringify(row(step, T0)), OVERSEER_STEP_PATTERN, step);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}overseer-retro-filter-`));
  try {
    const now = Date.now();
    writeFileSync(join(dir, "ledger.ndjson"),
      [...RETRO_OUTCOMES, ...NOT_RETRO_OUTCOMES].map((step, i) => JSON.stringify(row(step, now - (i + 1) * HOUR))).join("\n") + "\n");
    const ports = productionGardenerOverseerPorts({ stateDir: dir, repoRoot: dir, owner: "o", repo: "r", clock: fixedClock(now),
      fetch: () => ({}), log: () => {}, registeredGardenNames: () => [] });
    assert.deepEqual(ports.readRows().map(r => r.step).sort(), [...RETRO_OUTCOMES].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
