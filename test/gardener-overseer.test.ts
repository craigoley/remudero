import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Escalation } from "../src/lib/escalate.js";
import { CI_FRICTION_REMEDIES_FILE } from "../src/lib/ci-friction-gardener.js";
import { gardenEffectsPath, gardenStatePath, readGardenEffects, runGarden, type GardenSpec } from "../src/lib/gardener.js";
import {
  GARDENER_OVERSEER_OFF,
  ciFrictionEffectReading,
  classifyGardenerStep,
  healGardener,
  productionGardenerOverseerPorts,
  runGardenerOverseer,
  startGardenerOverseer,
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

test("a scorecard written beside a failed filing does not hide the filing streak", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T);
  try {
    h.rows.push(...passes("beta", 5, T0, HOUR));
    for (let i = 3; i >= 1; i--) {
      h.rows.push(row("beta.garden_filing_failed", T - i * HOUR, { reason: "header-max-length" }));
      h.rows.push(row("beta.scorecard", T - i * HOUR + 1, { pr_url: null, filing_failed: 4 - i }));
    }
    h.rows.push(row("beta.garden_filing_escalated", T - HOUR, { issue_url: "https://github.com/o/r/issues/9" }));
    runGardenerOverseer(h.deps);
    assert.equal(h.steps("gardener_overseer.deferred").length, 1, "the streak is still seen and left to gardener.ts");
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

test("W1-T4802: unreadable gardener state is reported by healing", () => {
  const h = harness(T0 + 10 * HOUR);
  try {
    writeFileSync(gardenStatePath(h.dir, "junk"), "{not json");
    const healed = healGardener(h.dir, "junk");
    assert.deepEqual(healed.cleared, []);
    assert.match(healed.unreadable ?? "", /JSON/);
    assert.deepEqual(healGardener(h.dir, "absent"), { cleared: [] });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T5073: corrupt overseer state refuses and preserves issued verdicts", () => {
  const h = harness(T0 + 10 * HOUR);
  try {
    const path = join(h.dir, "gardener-overseer.json");
    for (const bytes of ["{not json", JSON.stringify({ verdicts: "lost" })]) {
      writeFileSync(path, bytes);
      assert.throws(() => runGardenerOverseer(h.deps), /gardener-overseer\.json.*(unparseable|malformed)/);
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(h.steps("gardener_overseer.scorecard").length, 0);
    }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: corrupt effects stop the overseer before it overwrites a handoff", () => {
  const h = harness(T0 + 10 * HOUR);
  try {
    const path = gardenEffectsPath(h.dir, "demo");
    for (const bytes of ["{bad", JSON.stringify({ effects: [{ id: "incomplete" }] })]) {
      writeFileSync(path, bytes);
      assert.throws(() => runGardenerOverseer(h.deps), /demo-gardener-effects\.json.*(unparseable|malformed)/);
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(existsSync(join(h.dir, "gardener-overseer.json")), false);
    }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: interrupted verdict handoff replays once after repair", () => {
  const T = T0 + 10 * HOUR;
  const h = harness(T);
  try {
    const statePath = gardenStatePath(h.dir, "demo");
    writeFileSync(statePath, JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 }, other: { alpha: 3, beta: 1 } } }));
    h.rows.push(row("demo.scorecard", T - HOUR, { pr_url: "https://github.com/o/r/pull/7", acting: ["draft"] }));
    h.deps.prInfo = () => prInfo({ mergedAt: new Date(T - HOUR).toISOString() });
    h.deps.effectReading = () => ({ before: 100, after: 10, se: 20 });
    runGardenerOverseer(h.deps);
    const effectsPath = gardenEffectsPath(h.dir, "demo");
    const issued = readFileSync(effectsPath, "utf8");
    rmSync(effectsPath);
    runGardenerOverseer(h.deps);
    assert.equal(readGardenEffects(effectsPath).length, 1, "persisted verdict is reconstructed");
    const gardenDeps = { stateDir: h.dir, repoRoot: h.dir, openWorkspace: () => { throw new Error("no workspace"); }, log: () => {}, clock: h.clock };
    runGarden(demoSpec, gardenDeps);
    runGardenerOverseer(h.deps);
    assert.equal(existsSync(effectsPath), false, "receipt prevents replay after fold");
    writeFileSync(effectsPath, issued);
    runGarden(demoSpec, gardenDeps);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).classes.draft.alpha, 4);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: the 201st verdict never re-credits an older ID", () => {
  const h = harness(T0 + 10 * HOUR);
  try {
    const path = gardenStatePath(h.dir, "demo");
    writeFileSync(path, JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 }, other: { alpha: 3, beta: 1 } } }));
    const verdicts = Array.from({ length: 201 }, (_, i) => ({ id: `effect:${i}`, gardener: "demo", actionClass: "draft", verdict: "credit", kind: "effect", at: h.clock.iso(), sequence: i + 1 }));
    writeFileSync(join(h.dir, "gardener-overseer.json"), JSON.stringify({ episodes: {}, prs: {}, verdicts, churnEscalated: {}, nextVerdictSequence: 201 }));
    runGardenerOverseer(h.deps);
    const gardenDeps = { stateDir: h.dir, repoRoot: h.dir, openWorkspace: () => { throw new Error("no workspace"); }, log: () => {}, clock: h.clock };
    runGarden(demoSpec, gardenDeps);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).classes.draft.alpha, 204);
    runGardenerOverseer(h.deps);
    assert.equal(existsSync(gardenEffectsPath(h.dir, "demo")), false);
    runGarden(demoSpec, gardenDeps);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).classes.draft.alpha, 204);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: an unacknowledged verdict survives the history bound", () => {
  const T = T0 + 40 * 24 * HOUR;
  const h = harness(T);
  try {
    const old = new Date(T - 31 * 24 * HOUR).toISOString();
    const verdicts = [{ id: "effect:old", gardener: "demo", actionClass: "draft", verdict: "credit", kind: "effect", at: old, sequence: 1 }];
    writeFileSync(join(h.dir, "gardener-overseer.json"), JSON.stringify({ episodes: {}, prs: {}, verdicts, churnEscalated: {}, nextVerdictSequence: 1 }));
    runGardenerOverseer(h.deps);
    assert.deepEqual(readGardenEffects(gardenEffectsPath(h.dir, "demo")).map((v) => v.id), ["effect:old"]);
    assert.equal(JSON.parse(readFileSync(join(h.dir, "gardener-overseer.json"), "utf8")).verdicts.length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: an aged-out legacy receipt is unavailable rather than zero", () => {
  const h = harness(T0 + 10 * HOUR);
  try {
    const verdicts = [{ id: "effect:old", gardener: "demo", actionClass: "draft", verdict: "credit", kind: "effect", at: h.clock.iso() }];
    const overseerPath = join(h.dir, "gardener-overseer.json");
    const bytes = JSON.stringify({ episodes: {}, prs: {}, verdicts, churnEscalated: {} });
    writeFileSync(overseerPath, bytes);
    writeFileSync(gardenStatePath(h.dir, "demo"), JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 } }, foldedEffects: Array.from({ length: 200 }, (_, i) => `effect:${i}`) }));
    assert.throws(() => runGardenerOverseer(h.deps), /receipt .*unavailable beyond the retained 200 IDs/);
    assert.equal(readFileSync(overseerPath, "utf8"), bytes);
    assert.equal(existsSync(gardenEffectsPath(h.dir, "demo")), false);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: absent files initialize and healthy effects fold once", () => {
  const h = harness(T0);
  try {
    assert.deepEqual(readGardenEffects(gardenEffectsPath(h.dir, "demo")), []);
    assert.equal(runGardenerOverseer(h.deps).ran, true);
    const path = gardenStatePath(h.dir, "demo");
    writeFileSync(gardenEffectsPath(h.dir, "demo"), JSON.stringify({ effects: [{ id: "first", actionClass: "draft", verdict: "credit", kind: "effect", at: h.clock.iso() }] }));
    const deps = { stateDir: h.dir, repoRoot: h.dir, openWorkspace: () => { throw new Error("no workspace"); }, log: () => {}, clock: h.clock };
    runGarden(demoSpec, deps);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).classes.draft.alpha, 4);
    runGarden(demoSpec, deps);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).classes.draft.alpha, 4);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T5073: overseer timer reports corrupt persistence and retries", () => {
  const h = harness(T0);
  try {
    const path = join(h.dir, "gardener-overseer.json");
    writeFileSync(path, "{bad");
    const timer = startGardenerOverseer(h.deps, 1000);
    timer.stop();
    assert.match(String(h.steps("gardener_overseer.overseer_failed")[0]?.error), /gardener-overseer\.json.*unparseable/);
    assert.equal(h.steps("gardener_overseer.overseer_failed")[0]?.path, path);
    assert.equal(h.steps("gardener_overseer.overseer_failed")[0]?.failure_class, "unparseable");
    assert.equal(readFileSync(path, "utf8"), "{bad");
    writeFileSync(path, JSON.stringify({ episodes: {}, prs: {}, verdicts: [], churnEscalated: {} }));
    const retry = startGardenerOverseer(h.deps, 1000);
    retry.stop();
    assert.equal(h.steps("gardener_overseer.scorecard").length, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("W1-T4802: a throwing pass is ledgered by the timer and never escapes", () => {
  const h = harness(T0, { readRows: () => { throw new Error("ledger unreadable"); } });
  try {
    const timer = startGardenerOverseer(h.deps, 1000);
    timer.stop();
    const failed = h.steps("gardener_overseer.overseer_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.error, "ledger unreadable");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T4802: the production ports read a PR from GitHub and the remedies file from disk", () => {
  const h = harness(T0);
  try {
    const calls: string[] = [];
    const fetchPr = (args: string[]): unknown => {
      const url = args[1]!;
      calls.push(url);
      if (url.endsWith("/pulls/1")) return { merged: true, state: "closed", title: "chore: a", merged_at: "2026-09-20T01:00:00Z" };
      if (url.endsWith("/pulls/1/files?per_page=100")) return [{ filename: "a.ts" }, {}, { filename: "b.ts" }];
      if (url.endsWith("/pulls/2")) return { merged: false, state: "closed", title: "chore: b" };
      if (url.endsWith("/pulls/2/files?per_page=100")) return [];
      if (url.endsWith("/pulls/3")) return { merged: false, state: "open" };
      throw new Error("HTTP 502");
    };
    const ports = productionGardenerOverseerPorts({ stateDir: h.dir, repoRoot: h.dir, owner: "o", repo: "r", fetch: fetchPr, log: h.deps.log });
    assert.deepEqual(ports.prInfo?.("https://github.com/o/r/pull/1"), { state: "merged", title: "chore: a", paths: ["a.ts", "b.ts"], mergedAt: "2026-09-20T01:00:00Z" });
    assert.deepEqual(ports.prInfo?.("https://github.com/o/r/pull/2"), { state: "closed", title: "chore: b", paths: [] });
    assert.deepEqual(ports.prInfo?.("https://github.com/o/r/pull/3"), { state: "open", title: "", paths: [] });
    assert.equal(calls.filter((c) => c.endsWith("/pulls/3/files?per_page=100")).length, 0, "an open PR's files are not fetched");
    assert.equal(ports.prInfo?.("not a pr url"), undefined);
    assert.equal(ports.prInfo?.("https://github.com/o/r/pull/4"), undefined);
    assert.equal(h.steps("gardener_overseer.pr_unreadable")[0]?.error, "HTTP 502");

    const cause = { kind: "check", name: "test" };
    const priced = (minutes: number) => [{ cause, minutes, rounds: 4 }];
    const rows = [
      row("ci-friction.scorecard", T0, { pr_url: "https://github.com/o/r/pull/3", untracked: "check:test", priced: priced(80) }),
      row("ci-friction.scorecard", T0 + 5 * HOUR, { untracked: null, priced: priced(20) }),
    ];
    const tracked = { gardener: "ci-friction", actionClass: "draft", url: "https://github.com/o/r/pull/3", openedAt: new Date(T0).toISOString(), mergedAt: new Date(T0 + HOUR).toISOString() };
    assert.equal(ports.effectReading?.(tracked, rows), undefined, "no remedies file: unmeasured");
    mkdirSync(join(h.dir, "docs"), { recursive: true });
    writeFileSync(join(h.dir, CI_FRICTION_REMEDIES_FILE), "unrelated\n");
    assert.equal(ports.effectReading?.(tracked, rows), undefined, "a remedies file that does not name the cause: unmeasured");
    writeFileSync(join(h.dir, CI_FRICTION_REMEDIES_FILE), "## ci-friction:check:test\n");
    assert.deepEqual(ports.effectReading?.(tracked, rows), { before: 80, after: 20, se: 40 });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
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
