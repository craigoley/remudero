// W1-T12834: one plan-lint check that refuses the filings of several gardens is ONE blocked class, raised once and
// keyed by the check; and a garden whose draft the plan-PR preflight refused retries the finding under the id it
// already minted. MEASURED 2026-11-15: 568 [design-invariant-proof] refusals across 11 lanes ran 60 hours with no
// class joining them, and the scout's 292 refusals carried 207 distinct task ids.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { gardenStatePath, prepareGardenTaskIds, runGarden, type GardenAction, type GardenCheckout, type GardenSpec, type GardenTaskIdMinter } from "#src/lib/gardener.js";
import { OVERSEER_STEP_PATTERN, runGardenerOverseer, type GardenerOverseerPorts } from "#src/lib/gardener-overseer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-15T00:00:00Z");
type Row = Record<string, unknown>;
const iso = (at: number) => new Date(at).toISOString();
const PASS_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A `plan_pr.preflight_refused` row as planPrPreflightAllows writes it: the lint's tag sits on a line after the first. */
function refusal(garden: string, at: number, check = "design-invariant-proof", how: "origin" | "lane" = "origin"): Row {
  const lines = check === "pr-title" ? undefined : ["✗ W1-T99001: 1 violation(s) (0 pre-existing on base origin/main)", `[${check}] task W1-T99001: fixture message`];
  return {
    step: "plan_pr.preflight_refused", ts: iso(at), lane: how === "lane" ? garden : "task-files-landing", branch: "rmd-task-files-landing",
    failures: [{ check: check === "pr-title" ? "pr-title" : "lint-plan", firstLine: lines?.[0] ?? "pr-title: REFUSES the title", ...(lines ? { lines } : {}) }],
    ...(how === "origin" ? { gardener_origin: { state: "linked", version: 1, name: garden, passId: PASS_ID } } : {}),
  };
}

function overseer() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12834-overseer-`));
  const rows: Row[] = [];
  const logs: Row[] = [];
  const escalations: Escalation[] = [];
  const deps: GardenerOverseerPorts = {
    stateDir: dir, readRows: () => rows, stateMtime: () => undefined,
    log: (step, extra) => logs.push({ step, ...extra }),
    escalate: (e) => { escalations.push(e); return `https://github.com/o/r/issues/${escalations.length}`; },
  };
  const pass = (at: number) => runGardenerOverseer({ ...deps, clock: fixedClock(at) });
  const events = (step: string) => logs.filter((r) => r.step === `gardener_overseer.${step}`);
  return { dir, rows, logs, escalations, pass, events, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T12834 criterion 1: three gardens refused by one lint check write one filing_class_blocked row and raise one escalation", () => {
  const h = overseer();
  try {
    h.rows.push(
      refusal("scout", T0 - 20 * HOUR), refusal("scout", T0 - 10 * HOUR), refusal("ci-friction", T0 - 6 * HOUR),
      refusal("hot-file", T0 - 2 * HOUR, "design-invariant-proof", "lane"),
      refusal("scout", T0 - 30 * HOUR), // outside the trailing day: neither counted nor the first refusal
      refusal("flow", T0 - 3 * HOUR, "proof-test-only-discrimination"),
    );
    for (const r of h.rows) assert.match(JSON.stringify(r), OVERSEER_STEP_PATTERN, "the production prefilter reads the refusal rows");
    h.pass(T0);

    const blocked = h.events("filing_class_blocked");
    assert.equal(blocked.length, 1, "one class row for the one check that refused three gardens");
    assert.deepEqual([blocked[0]!.check, blocked[0]!.gardens, blocked[0]!.refusals, blocked[0]!.first_refusal_at, blocked[0]!.issue_url],
      ["design-invariant-proof", ["ci-friction", "hot-file", "scout"], 4, iso(T0 - 20 * HOUR), "https://github.com/o/r/issues/1"]);
    assert.equal(h.escalations.length, 1, "one escalation, keyed by the check");
    const e = h.escalations[0]!;
    assert.equal(e.taskId, "filing-class-blocked:design-invariant-proof");
    assert.match(e.summary, /`design-invariant-proof` check refuses the filings of 3 gardens/);
    assert.ok(e.detail.includes("4 `plan_pr.preflight_refused` rows"), "it names the refusal count");
    assert.ok(e.detail.includes("`ci-friction`, `hot-file`, `scout`"), "it names the gardens");
    assert.ok(e.detail.includes(iso(T0 - 20 * HOUR)), "it names the first refusal time");
    assert.equal(e.recommendation, "fix-check");

    // A failure with no lint tag is joined by its check's own name.
    h.rows.push(refusal("scout", T0 + HOUR, "pr-title"), refusal("flow", T0 + HOUR, "pr-title"), refusal("gate", T0 + HOUR, "pr-title", "lane"));
    h.pass(T0 + 2 * HOUR);
    assert.deepEqual(h.events("filing_class_blocked").map((r) => [r.check, r.gardens]),
      [["design-invariant-proof", ["ci-friction", "hot-file", "scout"]], ["pr-title", ["flow", "gate", "scout"]]]);
    assert.equal(h.escalations.length, 2);
    assert.equal(h.escalations[1]!.taskId, "filing-class-blocked:pr-title");
  } finally { h.dispose(); }
});

test("W1-T12834 criterion 2: a check still refusing raises nothing more, and clears with a cleared row after a quiet day", () => {
  const h = overseer();
  try {
    h.rows.push(refusal("scout", T0 - 3 * HOUR), refusal("ci-friction", T0 - 2 * HOUR), refusal("hot-file", T0 - HOUR));
    h.pass(T0);
    assert.equal(h.escalations.length, 1);

    // Later passes, more refusals, even a fourth garden: the same blocked episode.
    const last = T0 + 5 * HOUR;
    h.rows.push(refusal("scout", T0 + 2 * HOUR), refusal("flow", T0 + 3 * HOUR), refusal("gate", last));
    for (const at of [T0 + HOUR, T0 + 4 * HOUR, last + HOUR, last + 23 * HOUR]) h.pass(at);
    assert.equal(h.escalations.length, 1, "one escalation per check per blocked episode");
    assert.equal(h.events("filing_class_blocked").length, 1);
    assert.equal(h.events("filing_class_cleared").length, 0, "a refusal inside the trailing day holds the class");

    h.pass(last + DAY);
    const cleared = h.events("filing_class_cleared");
    assert.deepEqual(cleared.map((r) => [r.check, r.since, r.gardens, r.issue_url]),
      [["design-invariant-proof", iso(T0 - 3 * HOUR), ["ci-friction", "hot-file", "scout"], "https://github.com/o/r/issues/1"]]);
    const state = JSON.parse(readFileSync(join(h.dir, "gardener-overseer.json"), "utf8")) as { filingClasses: Record<string, unknown> };
    assert.deepEqual(state.filingClasses, {}, "the cleared class leaves the overseer's state");
    h.pass(last + DAY + HOUR);
    assert.equal(h.events("filing_class_cleared").length, 1, "a class clears once");

    // A new episode of the same check is a new blocked class.
    const again = last + 2 * DAY;
    h.rows.push(refusal("scout", again), refusal("ci-friction", again), refusal("flow", again));
    h.pass(again + HOUR);
    assert.equal(h.escalations.length, 2);
    assert.equal(h.events("filing_class_blocked").length, 2);
  } finally { h.dispose(); }
});

test("W1-T12834 criterion 3: a check refusing two gardens keeps the per-garden notice, heal and escalate ladder with no class row", () => {
  const h = overseer();
  try {
    h.rows.push(
      { step: "scout.scorecard", ts: iso(T0 - 5 * DAY) },
      refusal("scout", T0 - 2 * HOUR), refusal("ci-friction", T0 - 2 * HOUR), refusal("scout", T0 - HOUR),
      { step: "scout.garden_filing_failed", ts: iso(T0 - HOUR), reason: "the landing's PR did not open (plan_pr.preflight_refused names why)" },
    );
    h.pass(T0);
    assert.deepEqual(h.events("noticed").map((r) => [r.gardener, r.kind]), [["scout", "failure"]], "notice");
    h.pass(T0 + HOUR);
    assert.deepEqual(h.events("healed").map((r) => r.gardener), ["scout"], "heal");
    h.rows.push({ step: "scout.garden_filing_failed", ts: iso(T0 + 90 * 60_000), reason: "refused again" });
    h.pass(T0 + 2 * HOUR);
    assert.deepEqual(h.escalations.map((e) => e.taskId), ["scout-gardener-liveness"], "escalate: the garden's own ladder");
    assert.equal(h.events("filing_class_blocked").length, 0, "two gardens are no class");
    assert.equal(h.events("filing_class_cleared").length, 0);

    // The third garden is what makes it a class.
    h.rows.push(refusal("hot-file", T0 + 3 * HOUR));
    h.pass(T0 + 3 * HOUR);
    assert.deepEqual(h.events("filing_class_blocked").map((r) => r.gardens), [["ci-friction", "hot-file", "scout"]]);
  } finally { h.dispose(); }
});

type Action = GardenAction<"file"> & { origin: string };

/** A garden that files one task per finding through the shared preparation, over a landing the preflight refuses. */
function filingGarden() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12834-garden-`));
  const minted: string[] = [];
  const released: string[] = [];
  const filed: Array<Record<string, string>> = [];
  const logs: Row[] = [];
  const world = { findings: ["scout:step-a", "scout:step-b"], opens: false, note: 0 };
  const mint = Object.assign((branch: string) => {
    assert.equal(branch, "rmd-task-files-landing");
    const id = `W1-T${99101 + minted.length}`;
    minted.push(id);
    return id;
  }, { release: (id: string) => void released.push(id) }) as GardenTaskIdMinter;
  const spec: GardenSpec<"file", string[], Action, GardenCheckout> = {
    name: "fixture", classes: ["file"],
    cheapFingerprint: () => `${world.findings.join()}:${world.note}`,
    inventory: () => world.findings,
    fingerprint: (i) => `${i.join()}:${world.note}`,
    metric: () => ({ trials: 0, successes: 0 }),
    candidates: (i) => i.map((origin) => ({ class: "file" as const, target: origin, origin, reason: `${origin} is uncovered` })),
    scorecard: () => ({}),
    prepare: (ws, plan, async) => prepareGardenTaskIds(ws, plan.actions.length, mint, async),
    apply: (ws, plan, _scorecard, heldIds) => {
      const paths = plan.actions.map((a, i) => {
        const rel = `plan/tasks.d/${heldIds![i]}-fixture.yaml`;
        mkdirSync(join(ws.root, "plan/tasks.d"), { recursive: true });
        writeFileSync(join(ws.root, rel), `- id: ${heldIds![i]}\n  origin: ${a.origin}\n  note: ${world.note}\n`);
        return rel;
      });
      filed.push(Object.fromEntries(plan.actions.map((a, i) => [a.origin, heldIds![i]!])));
      return { paths, title: "chore(plan): file fixture tasks", body: "fixture" };
    },
  };
  writeFileSync(gardenStatePath(dir, "fixture"), JSON.stringify({ classes: { file: { alpha: 1000, beta: 1 } } }));
  let pass = 0;
  const run = () => {
    const root = join(dir, `ws-${++pass}`);
    mkdirSync(root, { recursive: true });
    return runGarden(spec, {
      stateDir: dir, repoRoot: dir, seed: 7, clock: fixedClock(T0 + pass * 2 * DAY),
      log: (step, extra) => logs.push({ step, ...extra }),
      mergedPlanLint: () => undefined,
      openWorkspace: () => ({
        root, branch: "rmd-task-files-landing",
        land: () => (world.opens ? "https://github.com/o/r/pull/1" : undefined),
        dispose: () => rmSync(root, { recursive: true, force: true }),
      }),
    });
  };
  const state = () => JSON.parse(readFileSync(gardenStatePath(dir, "fixture"), "utf8")) as { refusedFindingIds?: Record<string, { id: string }> };
  return { world, minted, released, filed, logs, run, state, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T12834 criterion 4: a refused finding retries under the task id it already minted and mints no new one", () => {
  const g = filingGarden();
  try {
    g.run();
    assert.deepEqual(g.minted, ["W1-T99101", "W1-T99102"]);
    assert.ok(g.logs.some((r) => r.step === "fixture.garden_filing_failed" && r.refusal === "not_opened"), "the preflight refused the landing");
    assert.deepEqual(g.released, [], "a refused finding keeps its id for the retry");
    assert.deepEqual(Object.fromEntries(Object.entries(g.state().refusedFindingIds ?? {}).map(([k, v]) => [k, v.id])),
      { "scout:step-a": "W1-T99101", "scout:step-b": "W1-T99102" });

    // Refused again and again, each a new draft: the same ids every time.
    for (let attempt = 1; attempt <= 3; attempt++) {
      g.world.note = attempt;
      g.run();
    }
    // An unchanged draft is the refused bytes again: skipped, and still under the same ids.
    g.run();
    assert.ok(g.logs.some((r) => r.step === "fixture.landing_repeat_skipped"), "the reused ids make the redraft byte-identical");
    assert.equal(g.filed.length, 5);
    for (const filing of g.filed) assert.deepEqual(filing, { "scout:step-a": "W1-T99101", "scout:step-b": "W1-T99102" });
    assert.deepEqual(g.minted, ["W1-T99101", "W1-T99102"], "one id minted per finding however many times the landing is refused");
    assert.deepEqual(g.released, []);

    // A finding that leaves the inventory gives its id back; the one still there keeps its own.
    g.world.findings = ["scout:step-a"];
    g.world.note = 10;
    g.run();
    assert.deepEqual(g.released, ["W1-T99102"]);
    assert.deepEqual(g.logs.filter((r) => r.step === "fixture.finding_ids_released").map((r) => r.ids), [["W1-T99102"]]);
    assert.deepEqual(g.filed.at(-1), { "scout:step-a": "W1-T99101" });

    // The landing that opens carries the id, and the finding holds nothing more.
    g.world.opens = true;
    g.world.note = 11;
    const opened = g.run();
    assert.equal(opened.prUrl, "https://github.com/o/r/pull/1");
    assert.deepEqual(g.filed.at(-1), { "scout:step-a": "W1-T99101" });
    assert.equal(g.state().refusedFindingIds, undefined);
    assert.deepEqual(g.minted, ["W1-T99101", "W1-T99102"]);
    assert.deepEqual(g.released, ["W1-T99102"], "the opened landing's id is never given back");
  } finally { g.dispose(); }
});
