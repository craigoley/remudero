import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  citeRetrosInWindow,
  DIGEST_INTERVAL_OPTIONS_HOURS,
  digestCadenceCheck,
  digestCadenceMarkerPath,
  digestIntervalOptionsMinutes,
  digestIntervalOptionsOutOfBounds,
  inboxDigestsPath,
  inboxNotifyChannel,
  recordDigestCadenceFire,
  renderDigestCadenceItem,
  renderDigestCadenceItems,
  runDigestCadenceReport,
  type DeterministicDigestItem,
  type DigestCadencePolicy,
  type GenerativeDigestItem,
} from "../src/lib/digest.js";
import { measurementCadenceMarkerPath, readMeasurementCadenceMarker, recordMeasurementCadenceFire } from "../src/lib/measurement-cadence.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { daemonCommand, buildDigestCadenceDaemonHooks } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { NotifyChannel } from "../src/lib/notify.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2277: the digest (lib/digest.ts) shipped built and had a CLI verb, but nothing ever
// fired it on a cadence, its window had no configurable interval, and its one delivery adapter
// (iMessage) cannot run on this (Linux) fleet. This file proves the eight acceptance criteria on
// W1-T2277's own shard, in order.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-08-25T12:00:00.000Z");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ledgerFile(dir: string, lines: Array<Record<string, unknown>>): string {
  mkdirSync(join(dir, "state"), { recursive: true });
  const p = join(dir, "state", "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function fakeChannel(): NotifyChannel & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (m) => sent.push(m) };
}

const ON: DigestCadencePolicy = { enabled: true, minIntervalMinutes: 1440, maxPerDay: 24 };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 1 — the digest fires on its own cadence from the daemon loop, not only when a verb is
// typed
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("DEFAULT OFF: with the flag false the digest cadence never fires, whatever else is true", () => {
  const d = digestCadenceCheck({ root: tmp("rmd-dc-off-"), policy: { ...ON, enabled: false }, now: NOW });
  assert.equal(d.fire, false);
  assert.match(d.reason, /disabled/);
});

test("FIRST RUN: an absent marker fires immediately, and a recorded fire then refuses within the interval", () => {
  const root = tmp("rmd-dc-check-");
  try {
    const first = digestCadenceCheck({ root, policy: ON, now: NOW });
    assert.equal(first.fire, true, "no marker recorded yet — must fire");

    recordDigestCadenceFire(root, NOW);
    const second = digestCadenceCheck({ root, policy: ON, now: new Date(NOW.getTime() + 60 * 1000) });
    assert.equal(second.fire, false, "immediately after a recorded fire, the interval bound must refuse");
    assert.match(second.reason, /minInterval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-dc-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, planPath };
}

test("REACHABILITY: daemonCommand actually WIRES checkDigestCadence/runDigestCadence into the deps it hands runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
    assert.equal(typeof captured!.checkDigestCadence, "function", "a self-target daemon must wire the decision hook");
    assert.equal(typeof captured!.runDigestCadence, "function", "a self-target daemon must wire the runner");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("THE WIRED HOOK, CALLED FOR REAL: check + run actually execute the producer's body, not just its type", async () => {
  const root = tmp("rmd-dc-hook-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const sent = fakeChannel();
    const hooks = buildDigestCadenceDaemonHooks({ config: { root } as Config, now: () => NOW, channel: sent });

    const decision = hooks.checkDigestCadence();
    assert.equal(decision.fire, true, "no marker yet under this fresh root — must fire");

    const result = await hooks.runDigestCadence();
    assert.equal(sent.sent.length, 1, "the real channel must actually have been sent to");
    assert.equal(result.delivered, true);

    // THE MARKER-FIRST DISCIPLINE, mirroring measurement-cadence's own producer.
    const again = hooks.checkDigestCadence();
    assert.equal(again.fire, false, "immediately after a real run, the interval bound must hold");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon: with no checkDigestCadence hook the loop behaves exactly as before", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-dc-noop-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 2 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
    });
    assert.equal(lines.filter((l) => l.step.startsWith("digest_cadence")).length, 0, "an unwired rung emits nothing at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a FIRING digest-cadence decision runs the digest and logs its result", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-dc-fire-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
      checkDigestCadence: () => ({ fire: true, reason: "first run" }),
      runDigestCadence: async () => {
        runs++;
        return { text: "digest text", channelName: "inbox", delivered: true };
      },
    });
    assert.ok(runs >= 1, "the wired runner must actually be invoked when the decision fires");
    assert.ok(lines.some((l) => l.step === "digest_cadence.fired"));
    assert.ok(lines.some((l) => l.step === "digest_cadence.ran"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a REFUSING digest-cadence decision never runs the digest, and names why", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-dc-skip-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
      checkDigestCadence: () => ({ fire: false, reason: "only 5.0m since the last run (minInterval 1440m)" }),
      runDigestCadence: async () => {
        runs++;
        throw new Error("must never be called");
      },
    });
    assert.equal(runs, 0, "a refusing decision must never invoke the runner");
    assert.ok(lines.some((l) => l.step === "digest_cadence.skipped"));
    assert.equal(lines.filter((l) => l.step === "digest_cadence.fired").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a THROWING checkDigestCadence/runDigestCadence is caught and ledgered, never fatal", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-dc-throw-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
      checkDigestCadence: () => {
        throw new Error("simulated decision failure");
      },
    });
    assert.equal(summary.stopReason, "stopped", "a thrown decision must NOT take the daemon down");
    assert.ok(lines.some((l) => l.step === "digest_cadence.check_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 2 — the interval is read from policy and every value the console offers is inside the
// declared bounds
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("shipped plan/policy.yaml carries digestCadence, its OWN row, safe-on by default", () => {
  const p = loadPolicy(policyPath(REPO_ROOT));
  assert.equal(p.values.digestCadence.enabled, true);
  assert.ok(p.values.digestCadence.minIntervalMinutes > 0);
  assert.ok(p.values.digestCadence.maxPerDay > 0);
});

test("every console-offered interval value (1,2,4,8,12,24 hours) is inside the SHIPPED declared bound — checked, not assumed", () => {
  const p = loadPolicy(policyPath(REPO_ROOT));
  const bounds = p.bounds["digestCadence.minIntervalMinutes"];
  assert.ok(bounds, "the shipped policy must record a committed bound for the console to check against");
  const violations = digestIntervalOptionsOutOfBounds(bounds);
  assert.deepEqual(violations, [], `every offered interval must fit [${bounds.min}, ${bounds.max}]`);
  assert.deepEqual(digestIntervalOptionsMinutes(), DIGEST_INTERVAL_OPTIONS_HOURS.map((h) => h * 60));
});

test("digestIntervalOptionsOutOfBounds NAMES a value that falls outside a tightened bound — never silently clamped", () => {
  // A hypothetical tightened bound (e.g. an operator dials minIntervalMinutes.max down to 720)
  // must catch the 24h option as out of bounds, by name.
  const violations = digestIntervalOptionsOutOfBounds({ min: 60, max: 720 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].hours, 24);
  assert.equal(violations[0].minutes, 1440);
});

test("DEFAULT: a policy.yaml with no digestCadence block still loads — absent means the SAFE always-on daily cadence", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-dc-default-"));
  try {
    const shipped = readFileSync(policyPath(REPO_ROOT), "utf8");
    const withoutBlock = shipped.replace(/^digestCadence:\n(?:[ \t].*\n|\n)*/m, "");
    assert.ok(!/^digestCadence:/m.test(withoutBlock), "the fixture really has no digestCadence block");

    const file = join(dir, "policy.yaml");
    writeFileSync(file, withoutBlock);
    const values = loadPolicy(file).values.digestCadence;

    assert.equal(values.enabled, true, "absence means the SAFE always-on cadence, not off");
    assert.equal(values.minIntervalMinutes, 1440);
    assert.equal(values.maxPerDay, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 3 — the existing three cadence verbs keep their own row and are not dragged to the
// digest interval
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("digestCadence and measurementCadence are DIFFERENT rows in the shipped policy — independently settable", () => {
  const p = loadPolicy(policyPath(REPO_ROOT));
  assert.notDeepEqual(p.values.digestCadence, p.values.measurementCadence);
});

test("digestCadenceMarkerPath and measurementCadenceMarkerPath are DIFFERENT files — firing one never advances the other's marker", () => {
  const root = tmp("rmd-dc-separate-marker-");
  try {
    assert.notEqual(digestCadenceMarkerPath(root), measurementCadenceMarkerPath(root));

    recordDigestCadenceFire(root, NOW);
    // The measurement-cadence marker must still be untouched — reading it resolves "absent",
    // never "ok" — a 1-hour digest interval can never drag the three measurement verbs to it.
    const measurementMarker = readMeasurementCadenceMarker(measurementCadenceMarkerPath(root));
    assert.equal(measurementMarker.kind, "absent");

    // And the reverse: firing the measurement cadence never advances the digest's own marker.
    recordMeasurementCadenceFire(measurementCadenceMarkerPath(root), NOW, 24 * 60 * 60 * 1000);
    const digestDecisionStillFirst = digestCadenceCheck({ root, policy: ON, now: NOW });
    assert.equal(digestDecisionStillFirst.fire, false, "the digest's OWN marker was already recorded above — it must not fire again yet");
    // But an independent fresh root proves the digest marker was never seeded by the
    // measurement-cadence fire recorded just above.
    const freshRoot = tmp("rmd-dc-separate-marker-fresh-");
    try {
      mkdirSync(join(freshRoot, "state"), { recursive: true });
      recordMeasurementCadenceFire(measurementCadenceMarkerPath(freshRoot), NOW, 24 * 60 * 60 * 1000);
      const stillFirstRun = digestCadenceCheck({ root: freshRoot, policy: ON, now: NOW });
      assert.equal(stillFirstRun.fire, true, "a measurement-cadence fire must never seed the digest's own marker");
    } finally {
      rmSync(freshRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 4 — every deterministic figure carries the query that reproduces it, and an item
// without one fails the render
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("a deterministic item WITH a query renders as a marked [FIGURE] line carrying it", () => {
  const item: DeterministicDigestItem = { kind: "deterministic", label: "merged", value: "3", query: 'ledger: step=="verdict"' };
  const line = renderDigestCadenceItem(item);
  assert.match(line, /^\[FIGURE\] merged: 3/);
  assert.match(line, /query: ledger: step=="verdict"/);
});

test("a deterministic item with NO query FAILS THE RENDER — thrown, never silently printed", () => {
  const item: DeterministicDigestItem = { kind: "deterministic", label: "merged", value: "3", query: "" };
  assert.throws(() => renderDigestCadenceItem(item), /no re-runnable query/);
});

test("renderDigestCadenceItems throws on the first unattributed deterministic item among many", () => {
  const items: (DeterministicDigestItem | GenerativeDigestItem)[] = [
    { kind: "deterministic", label: "merged", value: "1", query: "ledger: q1" },
    { kind: "generative", text: "consider raising the daily cap" },
    { kind: "deterministic", label: "blocked", value: "2", query: "" },
  ];
  assert.throws(() => renderDigestCadenceItems(items), /blocked.*no re-runnable query/s);
});

test("runDigestCadenceReport's own deterministic figures all carry a re-runnable query and render clean", () => {
  const dir = tmp("rmd-dc-figures-");
  try {
    ledgerFile(dir, [
      { ts: "2026-08-25T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1.5 },
      { ts: "2026-08-25T01:00:00.000Z", step: "verdict", task_id: "W1-T2", verdict: "blocked_ci", cost_usd: 0.5 },
    ]);
    const channel = fakeChannel();
    const result = runDigestCadenceReport({
      ledgerPath: join(dir, "state", "ledger.ndjson"),
      sinceIso: "2026-08-24T00:00:00.000Z",
      deps: { channel, ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "DIGEST-1", taskId: "DIGEST" },
    });
    assert.match(result.text, /\[FIGURE\] merged: 1 {2}\(query: .+\)/);
    assert.match(result.text, /\[FIGURE\] blocked: 1 {2}\(query: .+\)/);
    assert.match(result.text, /\[FIGURE\] notional cost: \$2\.00 {2}\(query: .+\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 5 — a generated item is marked per item rather than only by its section, so a quoted
// line stays identifiable
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("a generative item is ALWAYS marked [SUGGESTED], per item — not a bare heading", () => {
  const line = renderDigestCadenceItem({ kind: "generative", text: "consider raising the daily cap" });
  assert.equal(line, "[SUGGESTED] consider raising the daily cap");
});

test("a mixed list marks EVERY item individually — a line quoted out of the digest still tells its own kind, without reading its neighbours", () => {
  const items: (DeterministicDigestItem | GenerativeDigestItem)[] = [
    { kind: "deterministic", label: "merged", value: "4", query: "ledger: q" },
    { kind: "generative", text: "worth a look: the retry rate crept up this week" },
    { kind: "generative", text: "consider raising the daily cap" },
    { kind: "deterministic", label: "blocked", value: "0", query: "ledger: q2" },
  ];
  const rendered = renderDigestCadenceItems(items);
  assert.equal(rendered.length, 4);
  assert.match(rendered[0], /^\[FIGURE\]/);
  assert.match(rendered[1], /^\[SUGGESTED\]/);
  assert.match(rendered[2], /^\[SUGGESTED\]/);
  assert.match(rendered[3], /^\[FIGURE\]/);
  // A single line, quoted alone (no section context), still identifies itself.
  for (const line of rendered.filter((l) => l.startsWith("[SUGGESTED]"))) {
    assert.ok(!line.includes("query:"), "a generative line never masquerades as a measured figure");
  }
});

test("runDigestCadenceReport renders caller-supplied suggestions marked, alongside the deterministic figures", () => {
  const dir = tmp("rmd-dc-suggestions-");
  try {
    ledgerFile(dir, [{ ts: "2026-08-25T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1 }]);
    const channel = fakeChannel();
    const result = runDigestCadenceReport({
      ledgerPath: join(dir, "state", "ledger.ndjson"),
      sinceIso: "2026-08-24T00:00:00.000Z",
      deps: { channel, ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "DIGEST-1", taskId: "DIGEST" },
      suggestions: [{ kind: "generative", text: "worth a look next week" }],
    });
    assert.match(result.text, /\[SUGGESTED\] worth a look next week/);
    assert.match(result.text, /\[FIGURE\] merged: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 6 — the digest depends on the notify channel interface and never on a concrete
// delivery target
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("runDigestCadenceReport delivers over ANY NotifyChannel implementation, with zero digest-side branching on which one", () => {
  const dir = tmp("rmd-dc-channel-plain-");
  try {
    ledgerFile(dir, []);
    const plain = fakeChannel();
    const result = runDigestCadenceReport({
      ledgerPath: join(dir, "state", "ledger.ndjson"),
      sinceIso: "2026-08-24T00:00:00.000Z",
      deps: { channel: plain, ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "DIGEST-1", taskId: "DIGEST" },
    });
    assert.equal(plain.sent.length, 1);
    assert.equal(result.delivered, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inboxNotifyChannel IS a NotifyChannel implementation — swappable with zero change to the digest producer", () => {
  const dir = tmp("rmd-dc-channel-inbox-");
  try {
    ledgerFile(dir, []);
    const channel: NotifyChannel = inboxNotifyChannel(dir);
    const result = runDigestCadenceReport({
      ledgerPath: join(dir, "state", "ledger.ndjson"),
      sinceIso: "2026-08-24T00:00:00.000Z",
      deps: { channel, ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "DIGEST-1", taskId: "DIGEST", channelName: "inbox" },
    });
    assert.equal(result.delivered, true);
    const entries = JSON.parse(readFileSync(inboxDigestsPath(dir), "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, result.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inboxNotifyChannel reports NO unavailable() at all — always deliverable, unlike the Darwin-only imessage adapter", () => {
  const channel = inboxNotifyChannel(tmp("rmd-dc-avail-"));
  assert.equal(channel.unavailable, undefined);
});

test("digest.ts imports NO concrete delivery target by name in its producer's TYPE signature — the NotifyDeps.channel field is NotifyChannel-typed only", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  assert.match(src, /from "\.\/notify\.js"/, "sanity: digest.ts does import notify.ts for NotifyDeps/notify()/NotifyChannel");
  // The producer signature itself names NotifyDeps (which carries `channel: NotifyChannel`),
  // never a concrete channel constructor.
  assert.match(src, /deps: NotifyDeps/);
  assert.ok(!/\bimport\b[^;]*imessageChannel/.test(src), "digest.ts must never IMPORT the Darwin-only concrete channel itself");
  assert.ok(!/[^./]\bimessageChannel\(/.test(src), "digest.ts must never CONSTRUCT the Darwin-only concrete channel itself");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 7 — the digest files nothing, mints nothing, and spawns no worker to judge a task
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("LAW 5, DIRECTLY: running the digest cadence writes NOTHING under state/ besides the ledger fixture, the digest's own marker and the inbox feed", async () => {
  const root = tmp("rmd-dc-law5-");
  try {
    const stateDir = join(root, "state");
    ledgerFile(root, [{ ts: "2026-08-25T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1 }]);

    const hooks = buildDigestCadenceDaemonHooks({ config: { root } as Config, now: () => NOW });
    await hooks.runDigestCadence();

    const entries = readdirSync(stateDir).sort();
    assert.deepEqual(entries, ["inbox-digests.json", "last-digest-cadence.json", "ledger.ndjson"].sort());
    // Specifically NOT the inbox proposal/draft registries, and NOT a new task/plan shard.
    assert.ok(!entries.includes("inbox-proposals.json"));
    assert.ok(!entries.includes("inbox-drafts.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDigestCadenceReport's own dependency shape carries no spawn/gh/task-filing seam at all — structurally incapable of minting an id", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  const body = src.slice(src.indexOf("export function runDigestCadenceReport"));
  assert.ok(!/spawn/i.test(body.slice(0, body.indexOf("{") + 400)), "no spawn-shaped parameter in the producer's signature");
  assert.ok(!/ChildProcess|execFile|execSync/.test(body), "the producer never shells out — no worker spawn is even reachable from here");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// claim 8 — a retro that landed inside the window is cited rather than re-derived
// ═══════════════════════════════════════════════════════════════════════════════════════════

const RETRO_LINES = [
  { ts: "2026-08-24T00:00:00.000Z", step: "verdict", task_id: "RETRO", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/2814" },
  { ts: "2026-08-20T00:00:00.000Z", step: "verdict", task_id: "RETRO", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/2700" }, // outside window
];

test("citeRetrosInWindow cites the merged retro PR inside the window, and excludes one outside it", () => {
  const cited = citeRetrosInWindow(RETRO_LINES, "2026-08-23T00:00:00.000Z");
  assert.deepEqual(cited, [{ taskId: "RETRO", prUrl: "https://github.com/craigoley/remudero/pull/2814" }]);
});

test("runDigestCadenceReport's text CITES the retro's PR rather than re-deriving its findings", () => {
  const dir = tmp("rmd-dc-retro-");
  try {
    ledgerFile(dir, RETRO_LINES);
    const channel = fakeChannel();
    const result = runDigestCadenceReport({
      ledgerPath: join(dir, "state", "ledger.ndjson"),
      sinceIso: "2026-08-23T00:00:00.000Z",
      deps: { channel, ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "DIGEST-1", taskId: "DIGEST" },
    });
    assert.match(result.text, /retro cited: RETRO — https:\/\/github\.com\/craigoley\/remudero\/pull\/2814/);
    assert.ok(!result.text.includes("2700"), "a retro outside the window must never be cited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest.ts is structurally incapable of RE-DERIVING a retro's own findings — it imports none of rule-efficacy/verdict-calibration/autonomy", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  assert.ok(!/rule-efficacy\.js/.test(src));
  assert.ok(!/verdict-calibration\.js/.test(src));
  assert.ok(!/from "\.\/autonomy\.js"/.test(src));
});

test("citeRetrosInWindow returns empty (never a fabricated citation) when no retro merged in the window", () => {
  const cited = citeRetrosInWindow([{ ts: "2026-08-24T00:00:00.000Z", step: "verdict", task_id: "W1-T9", verdict: "merged" }], "2026-08-23T00:00:00.000Z");
  assert.deepEqual(cited, []);
});
