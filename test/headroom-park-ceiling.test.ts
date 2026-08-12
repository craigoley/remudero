import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_UNREADABLE_DEGRADED_LIMIT,
  evaluateHeadroomPark,
  HEADROOM_PARK_CEILING_MS,
  runDaemon,
  type DaemonDeps,
} from "../src/lib/daemon.js";
import { DEPLOY_IDLE_DEFER_CEILING_MS } from "../src/lib/deployer.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { daemonCommand, escalateHeadroomParkCeiling, ledgerPathFor } from "../src/run-task.js";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A BLIND GOVERNOR NEVER RESUMED. `consecutiveUnreadable` is reset only by a READABLE probe (and
 * by the disabled arm), so the degraded branch's only exit was a probe that recovers — and a probe
 * that CANNOT recover parked the fleet permanently about four minutes after boot
 * (`UNREADABLE_DEGRADED_LIMIT = 3` at a 60s poll), alive and ticking, every liveness indicator
 * healthy. Not hypothetical: a real `.claude` DIRECTORY in the worker-home symlink slot made the
 * usage probe fail 33 times out of 33, and re-materialisation never healed it.
 *
 * The deploy supervisor settled this argument once — `DEPLOY_IDLE_DEFER_CEILING_MS` forces a
 * deploy through after thirty minutes and ledgers it — so this mirrors that rather than inventing
 * a second spelling.
 */

const LIMIT = DEFAULT_UNREADABLE_DEGRADED_LIMIT;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "park-ceiling-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", "  status: queued", ""].join("\n"),
  );
  return loadPlan(f);
}

// ── The two numbers must not drift ──────────────────────────────────────────

test("the park ceiling RESOLVES TO the deploy supervisor's, so the two cannot drift apart", () => {
  assert.equal(HEADROOM_PARK_CEILING_MS, DEPLOY_IDLE_DEFER_CEILING_MS);
  assert.equal(HEADROOM_PARK_CEILING_MS, 30 * 60_000, "thirty minutes, the value the deploy ceiling already settled on");
});

// ── THE TRAP, written first: it must NOT fire on a governor that recovers ────

test("THE TRAP: a probe that recovers BEFORE the ceiling never forces — the bound must not fire on a healthy fleet", () => {
  const start = 1_000_000;
  // Parked, but only a minute in — nowhere near the ceiling.
  const early = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + 60_000);
  assert.equal(early.parked, true);
  assert.equal(early.forced, false, "a park that is merely YOUNG must never force");

  // And the moment the probe recovers, the count drops back under the limit and there is no park
  // at all — so no clock, no ceiling, nothing to fire.
  const recovered = evaluateHeadroomPark(0, LIMIT, start, start + 10 * HEADROOM_PARK_CEILING_MS);
  assert.deepEqual(recovered, { parked: false, forced: false, waitedMs: 0 },
    "a readable probe ends the episode outright, however long the PREVIOUS park had run");
});

test("a park with no clock yet reads as FRESH — an untracked caller degrades to the old unbounded park, never a surprise force", () => {
  const gate = evaluateHeadroomPark(LIMIT + 1, LIMIT, undefined, 999_999_999);
  assert.equal(gate.parked, true);
  assert.equal(gate.waitedMs, 0);
  assert.equal(gate.forced, false, "undefined must fail toward the OLD behaviour, never toward forcing");
});

// ── Direction 2: it DOES fire once the park outlives the ceiling ─────────────

test("a park that outlives the ceiling forces, and one that is one millisecond short does not", () => {
  const start = 5_000_000;
  const justShort = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + HEADROOM_PARK_CEILING_MS - 1);
  assert.equal(justShort.forced, false, "strictly below the ceiling is still a park");

  const exactly = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + HEADROOM_PARK_CEILING_MS);
  assert.equal(exactly.forced, true, "at the ceiling it forces — `>=`, matching evaluateIdleGate");
  assert.equal(exactly.waitedMs, HEADROOM_PARK_CEILING_MS);
});

// ── SECOND TRAP: reachable without a real thirty-minute wait ─────────────────

test("SECOND TRAP: the park and its ceiling are reachable with an INJECTED probe and clock — no real wait", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-root-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const escalations: Array<{ consecutiveUnreadable: number; parkedMs: number }> = [];
  let spawned = 0;
  let ticks = 0;

  // A clock the test drives: each sleep advances it past the (tiny, injected) ceiling.
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 5_000;
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 2_000;
    if (ticks >= 12) throw new Error("stop-the-loop");
  };

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => {
        spawned++;
        return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" } as never;
      },
      // NEVER readable — the poisoned-probe condition, exactly.
      readUsage: () => undefined,
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      onHeadroomParkCeiling: (info: { consecutiveUnreadable: number; parkedMs: number; ceilingMs: number }) => {
        escalations.push({ consecutiveUnreadable: info.consecutiveUnreadable, parkedMs: info.parkedMs });
      },
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  const degraded = lines.filter((l) => l.step === "daemon.headroom.degraded");
  const forced = lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced");

  assert.ok(degraded.length > 0, "the fleet really did park — the fixture reproduces the defect");
  assert.ok(forced.length > 0, "and the ceiling forced it out, which is the whole point");
  assert.ok(
    Number(forced[0].extra.parked_ms) >= CEILING,
    "the forced row names how long the park ran, and it is at or past the ceiling",
  );
  assert.equal(forced[0].extra.park_ceiling_ms, CEILING);
  assert.match(
    String(forced[0].extra.note),
    /deliberately accepted, not satisfied/,
    "the row says the spend bound was BYPASSED, not met — a forced resume accepts that risk on the record",
  );
});

test("the ceiling RE-ARMS: a long blind run forces repeatedly rather than once, and never runs unbounded-blind", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-rearm-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 5_000;
  let ticks = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 3_000;
    if (ticks >= 30) throw new Error("stop-the-loop");
  };

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: id, merged: false, costUsd: 0, verdict: "no_pr" }) as never,
      readUsage: () => undefined,
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  // THE DISCRIMINATOR IS THE PARK BETWEEN THE FORCES, not the count. Without re-arming, the clock
  // keeps running, `waitedMs` only grows, and every subsequent tick forces too — so a bare
  // "forced at least twice" assertion passes on the very defect it is meant to catch.
  const seq = lines
    .filter((l) => l.step === "daemon.headroom.degraded" || l.step === "daemon.headroom.park_ceiling_forced")
    .map((l) => (l.step === "daemon.headroom.degraded" ? "park" : "force"));
  const forced = lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced");
  assert.ok(forced.length >= 2, `expected the ceiling to re-arm and force again, saw ${forced.length}`);
  const firstForce = seq.indexOf("force");
  assert.ok(
    seq.slice(firstForce + 1).includes("park"),
    `after forcing, the fleet must PARK again before it can force again — saw ${seq.join(",")}`,
  );
  // Each forced tick is preceded by a fresh park: the clock restarted, so exposure is bounded at
  // one blind dispatch per ceiling rather than an unbounded blind run after minute thirty.
  for (const f of forced) {
    assert.ok(Number(f.extra.parked_ms) >= CEILING, "every force waited a FULL ceiling, not just the first");
  }
});

// ── THIRD TRAP: the readable path is untouched ──────────────────────────────

test("THIRD TRAP: a READABLE probe gates exactly as before — this must not quietly disable the governor", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-healthy-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let spawned = 0;
  const sleep: DaemonDeps["sleep"] = async () => {};

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => {
        spawned++;
        return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" } as never;
      },
      // A perfectly readable, well-under-limit probe.
      readUsage: () =>
        ({
          billingMode: "subscription",
          session: { percentUsed: 5, resetsAt: "3pm" },
          weekly: [{ label: "all models", percentUsed: 5, resetsAt: "Aug 20 at 12am" }],
        }) as never,
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { root, max: 1 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  assert.ok(spawned > 0, "a healthy governor still dispatches");
  assert.deepEqual(lines.filter((l) => l.step === "daemon.headroom.degraded"), [], "no park on a readable probe");
  assert.deepEqual(lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced"), [], "and nothing forced");
});

test("a RECOVERED probe clears the park clock — a later park waits the full ceiling again, not the old one", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-recover-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 10_000;
  let ticks = 0;
  // Unreadable long enough to PARK but not to force, then readable once, then unreadable again.
  // Without clearing the clock on recovery, the stale start time makes the SECOND park force
  // immediately; with it, the second park starts from zero and cannot.
  const readable = { billingMode: "subscription", session: { percentUsed: 5, resetsAt: "3pm" }, weekly: [] };
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 3_000;
    if (ticks >= 14) throw new Error("stop-the-loop");
  };
  let probes = 0;
  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: id, merged: false, costUsd: 0, verdict: "no_pr" }) as never,
      readUsage: () => {
        probes++;
        return probes === 6 ? (readable as never) : undefined; // one good read, mid-park
      },
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  // THE DISCRIMINATOR IS WHAT IMMEDIATELY FOLLOWS THE RECOVERY, not the waited_ms values — a
  // stale clock makes `waitedMs` LARGER, so "every force waited a full ceiling" passes on the
  // defect. With the clock cleared, the tick after a good read must PARK afresh; with it stale,
  // that same tick forces at once because the old start time is already past the ceiling.
  const seq = lines
    .filter((l) =>
      ["daemon.headroom", "daemon.headroom.degraded", "daemon.headroom.park_ceiling_forced"].includes(l.step),
    )
    .map((l) => (l.step === "daemon.headroom" ? "read" : l.step.endsWith("forced") ? "force" : "park"));
  const lastRead = seq.lastIndexOf("read");
  assert.ok(lastRead >= 0, "the probe really did recover once — the fixture exercises the reset");
  const after = seq.slice(lastRead + 1);
  assert.equal(after[0], "park", `the tick after a good read must park afresh, not force — saw ${seq.join(",")}`);
  const nextForce = after.indexOf("force");
  if (nextForce >= 0) {
    assert.ok(nextForce >= 2, `a fresh park must take several ticks to reach the ceiling, saw ${after.join(",")}`);
  }
});

// ── CROSS-BOOT DEDUP: the in-process guard cannot survive a restart, and a restart-looping
// daemon that stays blind would otherwise page once per boot. The episode key is "has the
// governor SEEN anything since we last paged?" — a blind stretch has no natural boundary the
// way a reserve breach's `resets_at` does, so its identity is the last readable probe. ───────

function escalateFixture(): { ledgerPath: string; calls: () => number; issues: { create: () => string } } {
  const dir = mkdtempSync(join(tmpdir(), "park-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let n = 0;
  return {
    ledgerPath,
    calls: () => n,
    issues: {
      create: () => {
        n++;
        return "https://github.com/o/r/issues/1";
      },
    },
  };
}
const INFO = { consecutiveUnreadable: 4, parkedMs: 30 * 60_000, ceilingMs: 30 * 60_000 };

test("the park escalation is deduped ACROSS BOOTS while the governor is still blind", () => {
  const f = escalateFixture();
  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "BOOT-1", issues: f.issues as never });
  assert.equal(f.calls(), 1, "the first blind stretch pages once");

  const marker = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .find((l) => l.step === "daemon.headroom.park_ceiling.escalated");
  assert.ok(marker, "a durable marker is written — the in-process guard alone cannot survive a restart");
  assert.equal(marker.blind_since, "never", "and records that the governor had never read successfully");

  // A FRESH PROCESS (a restart, or a crash-loop) re-observing the SAME blindness must stay quiet.
  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "BOOT-2", issues: f.issues as never });
  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "BOOT-3", issues: f.issues as never });
  assert.equal(f.calls(), 1, "still one page — a restart-looping blind daemon is not a pager");
});

test("a probe that RECOVERS ends the episode, so a LATER blind stretch pages again", () => {
  const f = escalateFixture();
  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "BOOT-1", issues: f.issues as never });
  assert.equal(f.calls(), 1);

  // The governor reads successfully — the row a readable probe writes, newer than the marker.
  appendFileSync(
    f.ledgerPath,
    JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), step: "daemon.headroom", window: "week" }) + "\n",
  );

  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "BOOT-2", issues: f.issues as never });
  assert.equal(f.calls(), 2, "a NEW blind stretch after a real recovery is a NEW episode and pages again");

  const markers = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.step === "daemon.headroom.park_ceiling.escalated");
  assert.equal(markers.length, 2);
  assert.notEqual(markers[1].blind_since, "never", "the second marker names the recovery it followed");
});

test("a THROWING gh gateway still writes the marker, so the next boot does not retry into a loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "park-escalate-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let attempts = 0;
  const boom = {
    create: () => {
      attempts++;
      throw new Error("gh unreachable");
    },
  };
  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath, runId: "BOOT-1", issues: boom as never });
  const marker = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .find((l) => l.step === "daemon.headroom.park_ceiling.escalated");
  assert.ok(marker, "the dedup marker is written whether or not DELIVERY succeeded");
  assert.equal(marker.delivered, false, "and says plainly that it was not delivered");

  escalateHeadroomParkCeiling(INFO, { owner: "o", repo: "r", ledgerPath, runId: "BOOT-2", issues: boom as never });
  assert.equal(attempts, 1, "a failed delivery is never retried into an unbounded relaunch loop");
});

/**
 * THE HOOK IS ONLY WORTH ANYTHING IF daemonCommand ACTUALLY SETS IT. Every test above drives
 * `escalateHeadroomParkCeiling` directly, which proves the escalator and proves nothing about the
 * wiring — the exact gap the W1-T356 sweepOrphans wiring test exists to close for its own dep, and
 * the shape this mirrors: capture the REAL `DaemonDeps`, then CALL the captured hook and assert on
 * the OUTCOME rather than on the identity of the closure.
 *
 * `PATH` IS STRIPPED AROUND THE CALL, DELIBERATELY. The production wiring passes no `issues`, so
 * the hook resolves `ghIssueGateway`, which shells `execFileSync("gh", ...)` by BARE NAME. With no
 * PATH there is no gh binary to find, the spawn fails ENOENT, `tryEscalate` catches it, and the
 * test can never create a live issue against the self-targeted repo. That is also the assertion:
 * `delivered: false` with the marker still written is precisely the gh-outage behaviour, so the
 * unreachable gateway is the fixture AND the thing under test rather than a mock standing in.
 */
test("wiring: the REAL daemonCommand sets DaemonDeps.onHeadroomParkCeiling to the production escalator — the CAPTURED hook writes a dedup marker into the daemon's OWN ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), "park-ceiling-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely

  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan: Plan, deps: DaemonDeps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    } as never);
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
    assert.equal(typeof captured!.onHeadroomParkCeiling, "function", "the ceiling hook must be SET, not left undefined -- an unset hook forces the ceiling silently and pages nobody");

    process.env.PATH = "";
    captured!.onHeadroomParkCeiling!({ consecutiveUnreadable: 41, parkedMs: 1_900_000, ceilingMs: HEADROOM_PARK_CEILING_MS });
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }

  const lines = readFileSync(ledgerPathFor({ root } as never), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "daemon.headroom.park_ceiling.escalated");
  assert.ok(marker, "the captured hook must reach the REAL escalator and land its marker in the ledger daemonCommand resolved, not some other path");
  assert.equal(marker.consecutive_unreadable, 41, "the info the hook was called with must survive the closure -- a wiring that drops it pages without the number that explains it");
  assert.equal(marker.delivered, false, "gh was unreachable by construction, and the marker says so rather than claiming a delivery it did not make");
});
