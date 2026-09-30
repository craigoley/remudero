import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Escalation } from "../src/lib/escalate.js";
import { gardenEffectsPath, gardenStatePath, runGarden, type GardenSpec } from "../src/lib/gardener.js";
import {
  GARDENER_OVERSEER_OFF,
  ciFrictionEffectReading,
  classifyGardenerStep,
  runGardenerOverseer,
  type GardenerOverseerPorts,
  type GardenerPrInfo,
} from "../src/lib/gardener-overseer.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-20T00:00:00Z");

function makeClock(start: number): Clock & { set(ms: number): void } {
  let t = start;
  return { now: () => t, date: () => new Date(t), iso: () => new Date(t).toISOString(), set: (ms) => { t = ms; } };
}

function row(step: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { step, ts: new Date(at).toISOString(), ...extra };
}

/** `count` hourly-spaced pass rows for `name`, the last at `lastAt`. */
function passes(name: string, count: number, lastAt: number, gapMs: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => row(`${name}.scorecard`, lastAt - (count - 1 - i) * gapMs));
}

interface Harness {
  dir: string;
  clock: ReturnType<typeof makeClock>;
  rows: Record<string, unknown>[];
  logs: Array<{ step: string; extra?: Record<string, unknown> }>;
  escalations: Escalation[];
  deps: GardenerOverseerPorts;
  steps: (step: string) => Array<Record<string, unknown> | undefined>;
}

function harness(now: number, over: Partial<GardenerOverseerPorts> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gardener-overseer-`));
  const clock = makeClock(now);
  const h: Harness = {
    dir,
    clock,
    rows: [],
    logs: [],
    escalations: [],
    deps: undefined as unknown as GardenerOverseerPorts,
    steps: (step) => h.logs.filter((l) => l.step === step).map((l) => l.extra),
  };
  h.deps = {
    stateDir: dir,
    clock,
    readRows: () => h.rows,
    log: (step, extra) => h.logs.push({ step, extra }),
    escalate: (e) => {
      h.escalations.push(e);
      return `https://github.com/o/r/issues/${h.escalations.length}`;
    },
    stateMtime: () => undefined,
    ...over,
  };
  return h;
}

test("W1-T4802: a failure streak is noticed then healed then escalated once", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T);
  try {
    writeFileSync(gardenStatePath(h.dir, "alpha"), JSON.stringify({ classes: {}, lastCheap: "c", lastPass: { fingerprint: "f" } }));
    h.rows.push(...passes("alpha", 5, T0, HOUR));
    h.rows.push(row("alpha.gardener_failed", T - 2 * HOUR, { error: "Bad credentials" }), row("alpha.gardener_failed", T - HOUR, { error: "Bad credentials" }));

    runGardenerOverseer(h.deps);
    assert.equal(h.steps("gardener_overseer.noticed").length, 1, "tier 1: noticed");
    assert.equal(h.steps("gardener_overseer.healed").length, 0);
    assert.equal(h.escalations.length, 0);

    runGardenerOverseer(h.deps);
    assert.equal(h.steps("gardener_overseer.healed").length, 1, "tier 2: healed");
    assert.deepEqual(h.steps("gardener_overseer.healed")[0]?.cleared, ["lastCheap", "lastPass"]);
    const healed = JSON.parse(readFileSync(gardenStatePath(h.dir, "alpha"), "utf8")) as Record<string, unknown>;
    assert.equal("lastCheap" in healed, false);
    assert.equal("lastPass" in healed, false);
    assert.equal(h.escalations.length, 0, "no escalation while the heal has had no chance to work");

    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 0, "a streak that has not grown since the heal is not escalated");

    h.rows.push(row("alpha.gardener_failed", T, { error: "Bad credentials again" }));
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 1, "tier 3: escalated once the streak persists after the heal");
    assert.equal(h.escalations[0]?.headDedup, "independent");
    assert.match(h.escalations[0]?.detail ?? "", /Bad credentials again/);

    h.rows.push(row("alpha.gardener_failed", T + HOUR, { error: "still" }));
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 1, "never a second escalation for the same episode");
    assert.equal(h.steps("gardener_overseer.noticed").length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: silence is judged against the gardener own cadence", () => {
  const now = T0 + 100 * HOUR;
  const h = harness(now);
  try {
    // Both went quiet 30 hours ago: `daily` passes once a day, `hourly` once an hour.
    h.rows.push(...passes("daily", 6, now - 30 * HOUR, 24 * HOUR), ...passes("hourly", 6, now - 30 * HOUR, HOUR));
    runGardenerOverseer(h.deps);
    const noticed = h.steps("gardener_overseer.noticed");
    assert.deepEqual(noticed.map((n) => n?.gardener), ["hourly"], "30 quiet hours is a long silence for hourly, an ordinary one for daily");
    assert.equal(noticed[0]?.kind, "silence");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: silence is not judged before a cadence has been observed", () => {
  const now = T0 + 100 * HOUR;
  const h = harness(now);
  try {
    h.rows.push(...passes("fresh", 2, now - 50 * HOUR, HOUR));
    runGardenerOverseer(h.deps);
    assert.equal(h.logs.filter((l) => l.step === "gardener_overseer.noticed").length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: a filing streak already escalated is not escalated again", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T);
  try {
    h.rows.push(...passes("beta", 5, T0, HOUR));
    h.rows.push(
      row("beta.garden_filing_failed", T - 3 * HOUR, { reason: "rule 15" }),
      row("beta.garden_filing_failed", T - 2 * HOUR, { reason: "rule 15" }),
      row("beta.garden_filing_failed", T - HOUR, { reason: "rule 15" }),
      row("beta.garden_filing_escalated", T - HOUR, { issue_url: "https://github.com/o/r/issues/9" }),
    );
    for (let i = 0; i < 4; i++) {
      h.rows.push(row("beta.garden_filing_failed", T + i * 1000, { reason: "rule 15" }));
      runGardenerOverseer(h.deps);
    }
    assert.equal(h.escalations.length, 0, "gardener.ts owns that streak");
    assert.equal(h.steps("gardener_overseer.healed").length, 0);
    assert.equal(h.steps("gardener_overseer.deferred").length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

const demoSpec: GardenSpec<"draft" | "other", Record<string, never>, never, never> = {
  name: "demo",
  classes: ["draft", "other"],
  review: { draft: "a merged draft is credited", other: "same" },
  cheapFingerprint: () => "cheap",
  inventory: () => ({}),
  fingerprint: () => "fp",
  candidates: () => [],
  scorecard: () => ({}),
  apply: () => undefined,
};

function prInfo(over: Partial<GardenerPrInfo> & { mergedAt: string }): GardenerPrInfo {
  return { state: "merged", title: "chore(plan): fix", paths: ["plan/a.yaml"], ...over };
}

test("W1-T4802: an effect verdict reaches the class Beta record on the next pass", () => {
  const T = T0 + 10 * HOUR;
  for (const [after, verdict, alpha, beta] of [[10, "credit", 4, 1], [300, "debit", 3, 2]] as const) {
    const h = harness(T, {
      prInfo: () => prInfo({ mergedAt: new Date(T - 5 * HOUR).toISOString() }),
      effectReading: () => ({ before: 100, after, se: 20 }),
    });
    try {
      const statePath = gardenStatePath(h.dir, "demo");
      const seeded = JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 }, other: { alpha: 3, beta: 1 } } });
      writeFileSync(statePath, seeded);
      h.rows.push(...passes("demo", 5, T0, HOUR), row("demo.scorecard", T - 6 * HOUR, { pr_url: "https://github.com/o/r/pull/7", acting: ["draft"] }));

      runGardenerOverseer(h.deps);
      assert.equal(readFileSync(statePath, "utf8"), seeded, "the overseer never writes another gardener's state file");
      const effects = JSON.parse(readFileSync(gardenEffectsPath(h.dir, "demo"), "utf8")) as { effects: Array<{ verdict: string; actionClass: string }> };
      assert.deepEqual(effects.effects.map((e) => [e.actionClass, e.verdict]), [["draft", verdict]]);

      // A second overseer pass does not issue the verdict again.
      runGardenerOverseer(h.deps);
      assert.equal(JSON.parse(readFileSync(gardenEffectsPath(h.dir, "demo"), "utf8")).effects.length, 1);

      // The gardener's next pass folds it, then clears the file; a replay of the same file credits nothing more.
      const gardenLogs: string[] = [];
      const gardenDeps = { stateDir: h.dir, repoRoot: h.dir, openWorkspace: () => { throw new Error("no workspace"); }, log: (s: string) => gardenLogs.push(s), clock: h.clock };
      const effectsBefore = readFileSync(gardenEffectsPath(h.dir, "demo"), "utf8");
      runGarden(demoSpec, gardenDeps);
      const folded = JSON.parse(readFileSync(statePath, "utf8")) as { classes: Record<string, { alpha: number; beta: number }> };
      assert.deepEqual(folded.classes.draft, { alpha, beta }, `${verdict} lands on the class record`);
      assert.deepEqual(folded.classes.other, { alpha: 3, beta: 1 }, "no other class moves");
      assert.equal(existsSync(gardenEffectsPath(h.dir, "demo")), false, "the folded file is cleared");
      assert.ok(gardenLogs.includes("demo.gardener_effects_folded"));
      writeFileSync(gardenEffectsPath(h.dir, "demo"), effectsBefore);
      runGarden(demoSpec, gardenDeps);
      const replayed = JSON.parse(readFileSync(statePath, "utf8")) as { classes: Record<string, { alpha: number; beta: number }> };
      assert.deepEqual(replayed.classes.draft, { alpha, beta }, "a replayed verdict is folded once");
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T4802: an effect inside one standard error waits", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T, {
    prInfo: () => prInfo({ mergedAt: new Date(T - HOUR).toISOString() }),
    effectReading: () => ({ before: 100, after: 90, se: 20 }),
  });
  try {
    h.rows.push(row("demo.scorecard", T - 2 * HOUR, { pr_url: "https://github.com/o/r/pull/7", acting: ["draft"] }));
    runGardenerOverseer(h.deps);
    assert.equal(existsSync(gardenEffectsPath(h.dir, "demo")), false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: the ci-friction effect reading follows the priced cause once its remedy landed", () => {
  const cause = { kind: "check", name: "test" };
  const priced = (minutes: number) => [{ cause, minutes, rounds: 4 }];
  const rows = [
    row("ci-friction.scorecard", T0, { pr_url: "https://github.com/o/r/pull/3", untracked: "check:test", priced: priced(80) }),
    row("ci-friction.scorecard", T0 + 5 * HOUR, { untracked: null, priced: priced(20) }),
  ];
  const pr = { gardener: "ci-friction", url: "https://github.com/o/r/pull/3", mergedAt: new Date(T0 + HOUR).toISOString() };
  assert.deepEqual(ciFrictionEffectReading(pr, rows, () => true), { before: 80, after: 20, se: 40 });
  assert.equal(ciFrictionEffectReading(pr, rows, () => false), undefined, "unmeasured until the filed task's remedy lands");
  assert.equal(ciFrictionEffectReading({ ...pr, gardener: "test" }, rows, () => true), undefined);
});

test("W1-T4802: near-identical proposals debit the class as churn", () => {
  const T = T0 + 10 * HOUR;
  const merges: Record<string, number> = {
    "https://github.com/o/r/pull/1": T - 4 * HOUR,
    "https://github.com/o/r/pull/2": T - 3 * HOUR,
    "https://github.com/o/r/pull/3": T - 1.5 * HOUR,
  };
  const h = harness(T, {
    prInfo: (url) => {
      const n = url.split("/").pop();
      return merges[url] === undefined ? undefined : prInfo({ mergedAt: new Date(merges[url]!).toISOString(), title: `chore(test): adopt ${n}00 measured durations`, paths: ["scripts/test-tier-manifest.json", "a.txt"] });
    },
  });
  try {
    h.rows.push(...passes("test", 5, T0, HOUR));
    h.rows.push(row("test.scorecard", T - 5 * HOUR, { pr_url: "https://github.com/o/r/pull/1", acting: ["adopt-durations"] }));
    h.rows.push(row("test.scorecard", T - 4 * HOUR, { pr_url: "https://github.com/o/r/pull/2", acting: ["adopt-durations"] }));
    h.clock.set(T - 2.5 * HOUR);
    runGardenerOverseer(h.deps);
    const debits = (JSON.parse(readFileSync(gardenEffectsPath(h.dir, "test"), "utf8")) as { effects: Array<{ id: string; kind: string; verdict: string; actionClass: string }> }).effects;
    assert.deepEqual(debits.map((d) => [d.id, d.kind, d.verdict, d.actionClass]), [["churn:https://github.com/o/r/pull/2", "churn", "debit", "adopt-durations"]], "the repeat, not the first, is the debit");
    assert.equal(h.escalations.length, 0, "one repeat is debited, not yet escalated");

    // Another near-identical merge lands after the debit was in force: the debit did not slow it.
    h.rows.push(row("test.scorecard", T - 2 * HOUR, { pr_url: "https://github.com/o/r/pull/3", acting: ["adopt-durations"] }), row("test.scorecard", T - HOUR / 2));
    h.clock.set(T);
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 1, "escalated only when the debits did not slow it");
    runGardenerOverseer(h.deps);
    assert.equal(h.escalations.length, 1, "once per run");
    assert.equal((JSON.parse(readFileSync(gardenEffectsPath(h.dir, "test"), "utf8")) as { effects: unknown[] }).effects.length, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: PRs that differ in title or paths are not churn", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T, {
    prInfo: (url) => {
      const n = url.split("/").pop()!;
      return prInfo({ mergedAt: new Date(T - Number(n) * 10 * 60_000).toISOString(), title: n === "1" ? "feat: one thing" : "fix: another thing", paths: [`f${n}.ts`] });
    },
  });
  try {
    for (const n of [1, 2, 3]) h.rows.push(row("test.scorecard", T - 3 * HOUR, { pr_url: `https://github.com/o/r/pull/${n}`, acting: ["a"] }));
    runGardenerOverseer(h.deps);
    assert.equal(existsSync(gardenEffectsPath(h.dir, "test")), false);
    assert.equal(h.steps("gardener_overseer.churn").length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: the weekly scorecard names every gardener seen", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T);
  try {
    writeFileSync(gardenStatePath(h.dir, "disk-only"), JSON.stringify({ classes: { c: { alpha: 3, beta: 1 } } }));
    h.rows.push(...passes("one", 3, T - HOUR, HOUR), row("two.gardener_failed", T - HOUR, { error: "x" }), row("three.gardener_judged", T - HOUR), row("evidence_coverage.pass", T - HOUR));
    runGardenerOverseer(h.deps);
    const cards = h.steps("gardener_overseer.scorecard");
    assert.equal(cards.length, 1);
    const gardeners = cards[0]?.gardeners as Record<string, { passes: number; failures: number; class_beta_means: Record<string, number> }>;
    assert.deepEqual(Object.keys(gardeners).sort(), ["disk-only", "evidence_coverage", "one", "three", "two"]);
    assert.equal(gardeners.one?.passes, 3);
    assert.equal(gardeners.two?.failures, 1);
    assert.deepEqual(gardeners["disk-only"]?.class_beta_means, { c: 0.75 });

    runGardenerOverseer(h.deps);
    assert.equal(h.steps("gardener_overseer.scorecard").length, 1, "weekly, not per pass");
    h.clock.set(T + 8 * 24 * HOUR);
    runGardenerOverseer(h.deps);
    assert.equal(h.steps("gardener_overseer.scorecard").length, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: the overseer's own rows are never mistaken for a gardener", () => {
  assert.equal(classifyGardenerStep("gardener_overseer.scorecard"), undefined);
  assert.deepEqual(classifyGardenerStep("ci-friction.garden_filing_failed"), { name: "ci-friction", kind: "filing_failed" });
  assert.deepEqual(classifyGardenerStep("evidence_coverage.pass"), { name: "evidence_coverage", kind: "pass" });
  assert.equal(classifyGardenerStep("sweep.escalation_reconcile.summary"), undefined);
});

test("W1-T4802: state/GARDENER_OVERSEER_OFF stops the pass", () => {
  const h = harness(T0);
  try {
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(join(h.dir, GARDENER_OVERSEER_OFF), "");
    h.rows.push(row("x.gardener_failed", T0, { error: "e" }));
    assert.equal(runGardenerOverseer(h.deps).ran, false);
    assert.equal(h.logs.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
