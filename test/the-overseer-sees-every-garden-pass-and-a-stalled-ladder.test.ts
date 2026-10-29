import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { REGISTERED_GARDEN_NAMES } from "#src/lib/garden-registry.js";
import { createGardenerRuntimeWriter } from "#src/lib/gardener-runtime.js";
import { productionGardenerOverseerPorts, runGardenerOverseer, type GardenerOverseerPorts } from "#src/lib/gardener-overseer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.now();
const clock = fixedClock(NOW);
type Row = Record<string, unknown>;
const row = (step: string, at: number, extra: Row = {}): Row => ({ step, ts: new Date(at).toISOString(), ...extra });
const legacy = (name: string): string => ({ "machine-judge": "machine_judge", "host-resource": "host_resource",
  "evidence-coverage": "evidence_coverage", "selector-shadow": "flake_incident" })[name] ?? name;

function harness(names: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}overseer-pass-`));
  const rows: Row[] = [];
  const logs: Row[] = [];
  const escalations: Escalation[] = [];
  const deps: GardenerOverseerPorts = {
    stateDir: dir, clock, readRows: () => rows, stateMtime: () => undefined,
    registeredGardenNames: () => names,
    log: (step, extra) => logs.push({ step, ...extra }),
    escalate: e => { escalations.push(e); return `https://github.com/o/r/issues/${escalations.length}`; },
  };
  const events = (step: string) => logs.filter(r => r.step === `gardener_overseer.${step}`);
  const state = () => JSON.parse(readFileSync(join(dir, "gardener-overseer.json"), "utf8"));
  return { dir, rows, logs, escalations, deps, events, state };
}

test("W1-T9044: a garden.pass row with a non-zero exit or heap exhaustion is a failure the overseer notices", () => {
  for (const name of REGISTERED_GARDEN_NAMES.filter(n => n !== "overseer")) {
    for (const fields of [{ exit: 1 }, { exit: null, error: "heap_exhausted: heap cap exceeded" }, { exit: 0, heap_exhausted: true }]) {
      const h = harness([name]);
      try {
        h.rows.push(row("garden.pass", NOW - HOUR, { name, exit: 0 }),
          row(`${legacy(name)}.scorecard`, NOW - 1), row("garden.pass", NOW, { name, ...fields }));
        runGardenerOverseer(h.deps);
        assert.equal(h.events("noticed").length, 1, name);
        assert.equal(h.events("noticed")[0]?.gardener, legacy(name));
        assert.equal(h.events("noticed")[0]?.kind, "failure");
        assert.equal((h.events("scorecard")[0]?.gardeners as Record<string, { passes: number }>)[legacy(name)]?.passes, 1);
        assert.equal(h.events("unobserved").length, 0, "a failed completion is observed");
        h.rows.push(row("garden.pass", NOW + 1, { name, exit: 0 }));
        runGardenerOverseer({ ...h.deps, clock: fixedClock(NOW + 1) });
        assert.equal(h.state().episodes[legacy(name)], undefined, "a clean registry pass recovers");
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
  }
});

test("W1-T9044: a registered garden with no pass in the window is reported unobserved", () => {
  const h = harness(["flow", "machine-judge", "overseer"]);
  try {
    h.rows.push(row("garden.pass", NOW - 15 * 24 * HOUR, { name: "flow", exit: 0 }),
      row("machine_judge.scorecard", NOW - HOUR));
    runGardenerOverseer(h.deps);
    runGardenerOverseer(h.deps);
    assert.deepEqual(h.events("unobserved").map(r => r.gardener), ["flow"]);
    assert.equal(h.escalations.length, 1);
    assert.match(h.escalations[0]!.summary, /flow.*unobserved/);
    assert.equal(h.state().unobservedEscalated.flow, clock.iso());
    h.rows.push(row("garden.pass", NOW, { name: "flow", exit: 0 }));
    runGardenerOverseer(h.deps);
    assert.equal(h.state().unobservedEscalated.flow, undefined);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

function card(name: string, cost: number, at: number, fields: Row = {}): Row {
  return row(`${name}.scorecard`, at, {
    next: null, actions: 0, acting: [], pr_url: null,
    ...(name === "ci-friction" ? { ladder: [{ cause: "settled", state: "resolved", minutes: 100 }, { cause: "growing", state: "draft", minutes: cost }] }
      : { causes: 1, total_pr_hours: cost, ladder: [{ cause: "growing", state: "draft", rung: 1 }] }),
    ...fields,
  });
}

test("W1-T9044: a ladder whose top cause keeps growing while nothing is drafted is escalated once", () => {
  for (const name of ["ci-friction", "flow-remedy", "fix-lane"]) {
    const h = harness();
    try {
      h.rows.push(card(name, 2, NOW - 2 * HOUR), card(name, 3, NOW - HOUR), card(name, 4, NOW));
      runGardenerOverseer(h.deps);
      runGardenerOverseer(h.deps);
      assert.equal(h.events("stalled_cause").length, 1, name);
      assert.equal(h.events("stalled_cause")[0]?.cause, "growing");
      assert.deepEqual(h.events("stalled_cause")[0]?.settled_causes, name === "ci-friction" ? ["settled"] : []);
      assert.equal(h.escalations.length, 1);
      assert.match(h.escalations[0]!.detail, /Settled causes above it/);
      assert.equal(Object.keys(h.state().stalledEscalated).length, 1);
      h.rows.push(card(name, 5, NOW + HOUR));
      runGardenerOverseer({ ...h.deps, clock: fixedClock(NOW + HOUR) });
      assert.equal(h.escalations.length, 1, "growth cannot reopen the same cause");
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("the real ci-friction priced shape exposes a growing cause hidden below settled ladder entries", () => {
  const h = harness();
  try {
    const settled = Array.from({ length: 8 }, (_, i) => ({ cause: `check:settled-${i}`, state: "in_progress", minutes: 100 + i }));
    for (const [i, minutes] of [2, 3, 4].entries()) {
      h.rows.push(card("ci-friction", minutes, NOW - (2 - i) * HOUR, { ladder: settled,
        priced: [...settled.map(line => ({ cause: { kind: "check", name: line.cause.slice(6) }, minutes: line.minutes })),
          { cause: { kind: "check", name: "hidden" }, minutes }] }));
    }
    runGardenerOverseer(h.deps);
    assert.equal(h.events("stalled_cause")[0]?.cause, "check:hidden");
    assert.deepEqual(h.events("stalled_cause")[0]?.settled_causes, settled.map(line => line.cause));
    assert.equal(h.escalations.length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("fix-lane's own per-class reports price a multi-cause ladder through the production reader", () => {
  const h = harness();
  try {
    for (const [i, hours] of [2, 3, 4].entries()) {
      const at = NOW - (2 - i) * HOUR;
      h.rows.push(row("fixlane.report", at - 1, { class: "settled", hours: 100 }),
        row("fixlane.report", at - 1, { class: "growing", hours }),
        card("fix-lane", hours + 100, at, { causes: 2, total_pr_hours: hours + 100,
          ladder: [{ cause: "settled", state: "resolved", rung: 1 }, { cause: "growing", state: "draft", rung: 1 }] }));
    }
    writeFileSync(join(h.dir, "ledger.ndjson"), h.rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const ports = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r", clock,
      fetch: () => ({}), log: h.deps.log, registeredGardenNames: () => [] });
    runGardenerOverseer({ ...h.deps, readRows: ports.readRows });
    assert.deepEqual(h.events("stalled_cause")[0]?.costs, [2, 3, 4]);
    assert.deepEqual(h.events("stalled_cause")[0]?.settled_causes, ["settled"]);
    assert.equal(h.escalations.length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("aggregate growth cannot prove which unpriced flow-remedy cause grew and is reported unmeasured", () => {
  const h = harness();
  try {
    for (const [i, total_pr_hours] of [2, 3, 4].entries()) h.rows.push(card("flow-remedy", total_pr_hours, NOW - (2 - i) * HOUR,
      { causes: 2, ladder: [{ cause: "top", state: "draft", rung: 1 }, { cause: "other", state: "draft", rung: 1 }] }));
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 0);
    assert.equal(h.events("stalled_cause").length, 0);
    assert.equal(h.events("stalled_unmeasured")[0]?.gardener, "flow-remedy");
    assert.match(String(h.events("stalled_unmeasured")[0]?.reason), /per-cause prices/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("an unavailable escalation port does not consume delivery and distinct stalled causes have distinct identities", () => {
  const h = harness(["flow"]);
  try {
    h.rows.push(card("ci-friction", 2, NOW - 2 * HOUR), card("ci-friction", 3, NOW - HOUR), card("ci-friction", 4, NOW));
    runGardenerOverseer({ ...h.deps, escalate: undefined });
    assert.equal(Object.keys(h.state().stalledEscalated).length, 0);
    assert.equal(h.state().unobservedEscalated.flow, undefined);
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 2);
    for (const [i, minutes] of [2, 3, 4].entries()) h.rows.push(card("ci-friction", minutes, NOW + (i + 1) * HOUR,
      { ladder: [{ cause: "another", state: "draft", minutes }] }));
    runGardenerOverseer({ ...h.deps, clock: fixedClock(NOW + 3 * HOUR) });
    assert.equal(h.escalations.length, 3);
    assert.notEqual(h.escalations[1]!.taskId, h.escalations[2]!.taskId);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("unreadable runtime inventory is reported and cannot become a measured empty registry", () => {
  for (const content of [undefined, "{", JSON.stringify({ gardens: [] })]) {
    const h = harness();
    try {
      if (content !== undefined) writeFileSync(join(h.dir, "gardener-runtime.json"), content);
      h.rows.push(row("garden.pass", NOW, { name: "flow", exit: 1 }));
      const deps = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r",
        fetch: () => ({}), clock, log: h.deps.log, escalate: h.deps.escalate });
      assert.equal(deps.registeredGardenNames!(), undefined);
      assert.equal(typeof h.events("registry_unreadable")[0]?.error, "string");
      runGardenerOverseer({ ...deps, readRows: () => h.rows });
      assert.equal(h.events("noticed")[0]?.gardener, "flow");
      assert.equal(h.events("unobserved").length, 0);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("malformed persisted observation identities refuse before emitting or escalating", () => {
  const h = harness(["flow"]);
  try {
    runGardenerOverseer(h.deps);
    const original = h.state();
    for (const history of ["unobservedEscalated", "stalledEscalated"]) {
      const malformed = { ...original, [history]: { flow: "invalid date" } };
      const body = JSON.stringify(malformed);
      writeFileSync(join(h.dir, "gardener-overseer.json"), body);
      assert.throws(() => runGardenerOverseer(h.deps), /malformed/);
      assert.equal(readFileSync(join(h.dir, "gardener-overseer.json"), "utf8"), body);
    }
    assert.equal(h.escalations.length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("an unreadable ledger refuses the production pass instead of escalating an unobserved garden", () => {
  const h = harness();
  try {
    mkdirSync(join(h.dir, "ledger.ndjson"));
    const deps = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r",
      fetch: () => ({}), clock, log: h.deps.log, escalate: h.deps.escalate, registeredGardenNames: () => ["flow"] });
    assert.throws(() => runGardenerOverseer(deps), /incomplete|unreadable/);
    assert.equal(h.escalations.length, 0);
    assert.equal(h.events("unobserved").length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("due failures stay degraded through that child's successful completion and recover on a clean pass", () => {
  const h = harness(["flow"]);
  try {
    h.rows.push(row("garden.pass", NOW - HOUR, { name: "flow", exit: 0 }),
      row("garden.due_failed", NOW - 1, { name: "flow", error: "cannot read inputs" }), row("garden.pass", NOW, { name: "flow", exit: 0 }));
    runGardenerOverseer(h.deps);
    assert.equal(h.events("noticed")[0]?.last_error, "cannot read inputs");
    h.rows.push(row("garden.pass", NOW + 1, { name: "flow", exit: 0 }));
    runGardenerOverseer({ ...h.deps, clock: fixedClock(NOW + 1) });
    assert.equal(h.state().episodes.flow, undefined);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("legacy names and non-scorecard passes share their registry garden's recovery", () => {
  for (const [name, prefix, pass] of [["machine-judge", "machine_judge", "machine_judge.scorecard"],
    ["host-resource", "host_resource", "host_resource.scorecard"], ["selector-shadow", "flake_incident", "selector-shadow.report"],
    ["flow", "flow", "flow.report"]]) {
    const h = harness([name!]);
    try {
      h.rows.push(row(`${prefix}.gardener_failed`, NOW - HOUR), row(pass!, NOW));
      runGardenerOverseer(h.deps);
      assert.equal(h.events("noticed").length, 0);
      assert.equal(h.events("unobserved").length, 0);
      h.rows.push(row("garden.pass", NOW + 1, { name, exit: 1 }));
      runGardenerOverseer({ ...h.deps, clock: fixedClock(NOW + 1) });
      assert.equal(h.events("noticed").length, 1);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("machine-judge and host-resource's failed steps remain visible through the production ledger filter", () => {
  for (const name of ["machine-judge", "host-resource"]) {
    const h = harness([name]);
    try {
      h.rows.push(row("garden.pass", NOW - HOUR, { name, exit: 0 }), row(`${legacy(name)}.failed`, NOW, { error: "producer failed" }));
      writeFileSync(join(h.dir, "ledger.ndjson"), h.rows.map(r => JSON.stringify(r)).join("\n") + "\n");
      const ports = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r", clock,
        fetch: () => ({}), log: h.deps.log, registeredGardenNames: () => [name] });
      runGardenerOverseer({ ...h.deps, readRows: ports.readRows });
      assert.equal(h.events("noticed")[0]?.gardener, legacy(name));
      assert.equal(h.events("noticed")[0]?.last_error, "producer failed");
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("registry alias recovery closes a selector-shadow escalation persisted before the change", () => {
  const h = harness(["selector-shadow"]);
  const closed: string[] = [];
  const issue = "https://github.com/o/r/issues/1";
  try {
    const at = new Date(NOW - HOUR).toISOString();
    writeFileSync(join(h.dir, "gardener-overseer.json"), JSON.stringify({ episodes: {
      "selector-shadow": { kind: "failure", since: at, healedAt: at, escalatedAt: at },
    }, prs: {}, verdicts: [], churnEscalated: {} }));
    h.rows.push(row("garden.pass", NOW, { name: "selector-shadow", exit: 0 }));
    runGardenerOverseer({ ...h.deps, closeIssue: url => closed.push(url),
      readEscalationRows: () => [row("gardener_overseer.escalated", NOW - HOUR, { gardener: "selector-shadow", issue_url: issue })] });
    assert.deepEqual(closed, [issue]);
    assert.equal(h.state().episodes["selector-shadow"], undefined);
    assert.equal(h.escalations.length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a cancelled registry pass cannot clear a failure, and unknown or future rows do not establish health", () => {
  const h = harness(["flow"]);
  try {
    h.rows.push(row("flow.gardener_failed", NOW - HOUR, { error: "failed" }),
      row("garden.pass", NOW, { name: "flow", exit: null }), row("garden.pass", NOW + HOUR, { name: "flow", exit: 0 }),
      row("garden.pass", NOW, { name: "unknown", exit: 1 }), row("garden.pass", NOW, { exit: 1 }),
      row("garden.pass", NOW, { name: "overseer", exit: 1 }));
    assert.deepEqual(runGardenerOverseer(h.deps).gardeners, ["flow"]);
    assert.equal(h.events("noticed")[0]?.kind, "failure");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("the production reader observes registry passes, due failures and enabled gardens from runtime inventory", async () => {
  const h = harness();
  try {
    const writer = createGardenerRuntimeWriter({ stateDir: h.dir, repository: "o/r", daemonRunId: "test", clock,
      gardens: REGISTERED_GARDEN_NAMES.map(name => ({ name, enabled: true, cadenceMs: HOUR, scope: "repository" })), log: () => {} });
    await writer.flush();
    h.rows.push(...REGISTERED_GARDEN_NAMES.filter(n => n !== "flow").map(name => row("garden.pass", NOW - HOUR, { name, exit: 0 })),
      row("garden.due_failed", NOW, { name: "machine-judge", error: "due read failed" }),
      row("garden.pass", NOW, { name: "host-resource", exit: null, error: "heap_exhausted: cap exceeded" }));
    writeFileSync(join(h.dir, "ledger.ndjson"), h.rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const deps = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r",
      fetch: () => { throw new Error("no GitHub reads expected"); }, clock, log: h.deps.log, escalate: h.deps.escalate });
    runGardenerOverseer(deps);
    assert.deepEqual(h.events("noticed").map(r => r.gardener).sort(), ["host_resource", "machine_judge"]);
    assert.deepEqual(h.events("unobserved").map(r => r.gardener), ["flow"]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("stable cost, a changed cause, a draft, a filing or missing prices prevent a stalled-ladder escalation", () => {
  for (const fields of [{ ladder: [{ cause: "growing", state: "draft", minutes: 3 }] },
    { ladder: [{ cause: "other", state: "draft", minutes: 4 }] }, { acting: ["draft"], actions: 1 },
    { pr_url: "https://github.com/o/r/pull/1" }, { filing_failed: 1, actions: 1 }, { awaiting: "https://github.com/o/r/pull/2" },
    { ladder: [{ cause: "growing", state: "draft" }] }]) {
    const h = harness();
    try {
      h.rows.push(card("ci-friction", 2, NOW - 2 * HOUR), card("ci-friction", 3, NOW - HOUR), card("ci-friction", 4, NOW, fields));
      runGardenerOverseer(h.deps);
      assert.equal(h.events("stalled_cause").length, 0);
      assert.equal(h.escalations.length, 0);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});
