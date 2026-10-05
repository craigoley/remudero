import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can intercept real fs calls
// (named bindings off `node:fs` are non-configurable); see the same note atop retro-marker-atomic.test.ts.
import fsDefault from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateRetroTrigger, resolveMarkerForGather, type RetroMarker, type RetroTriggerDecision } from "../src/lib/retro.js";
import { configPath } from "../src/lib/config.js";
import { retroCommand } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { runDaemon } from "../src/lib/daemon.js";
// W1-T2981 — the retro is DETACHED, so `runDaemon` returns while it is still in flight. A test
// asserting on what the retro DID must drain that action first; the assertions are unchanged.
import { drainDetachedSweepActions } from "../src/lib/sweep.js";
import type { Plan } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";
import { REPO_ROOT_FOR_FIXTURES, setupFakeRetroFixture } from "./helpers/retro-fake-fixture.js";

/**
 * W1-T5902 — the REAL-RUN half of the retro marker suite. Every test here drives the real
 * `retroCommand` (a real git worktree, a PATH-shimmed `gh`, injected spawns) and none of them reads
 * the plan: the fixture lives in test/helpers/retro-fake-fixture.ts and the daemon's plan is an empty
 * literal, so this suite is NOT a plan-reading candidate and a plan-only diff never waits on it.
 * The cheap marker assertions stay in test/retro-marker-atomic.test.ts. Every assertion that used to
 * sit in that one file survives in one of the two.
 *
 * ONE offline gateway for every `retroCommand` call in this file; shared rather than per-test so
 * `calls` accumulates and one assertion can prove the production path consulted it.
 */
const offlineGh = offlineGithub();

// A cheap, standalone `--dry-run` pass: builds the SAME gather the success-path test below
// drives all the way through a real PR, but exits right after printing the report -- no
// worktree, no gh, no spawn. Kept here (not folded into the corrupt-marker test above)
// because it needs an ABSENT marker (genuine first-ever-retro), the opposite precondition
// from the corrupt-marker test.
test("retroCommand: --dry-run builds the gather and returns 0 without ever touching a worker", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-dryrun-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-dryrun-root-"));

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");

  const logSpy = t.mock.method(console, "log", () => {});
  try {
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh })));
    assert.equal(exitCode, 0, "--dry-run never fails a genuinely-first-ever retro");
    assert.ok(
      logSpy.mock.calls.some((c) => String(c.arguments[0]).includes("Retro gather")),
      "--dry-run must print the deterministic gather report",
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
// ── W1-T242 round 2: retroCommand's SUCCESS path reaches the atomic marker-advance ──
//
// The corrupt-marker test above proves the fail-closed branch. The tests below prove the
// OTHER half stays correct: a clean retro run still reaches `saveMarker` at the tail of the
// real success path -- the exact call site round 1 made atomic -- and actually lands a real,
// valid marker on disk. Every git/gh boundary is a REAL local git repo or a PATH-shimmed `gh`
// script (never a reimplementation of retroCommand's own logic); only the Architect spawn
// itself is injected (retroCommand's `opts.spawn`, mirroring runTask's existing
// `opts.spawn` DI). `setupFakeRetroFixture` is the shared scaffolding three variant tests
// below drive through DIFFERENT branches of the same success path (a valid PRE-EXISTING
// marker; an ownership mismatch; a diff that touches code) without re-authoring the whole
// fixture per branch.

// W1-T968 — retro's gated report answers about the PULL REQUEST, not the call. Every other variant
// here stops at a red CI poll, so retro's gated tail was reached by no test at all. This one lets
// CI read green and seeds a standing REVIEW-lane arm on the fixture's head; the review this run
// makes refuses and its withdrawal fails (the fake `gh` refuses every `pr merge`), and this lane's
// own arm is refused. The old phrase, a function of that last outcome alone, printed "NOT armed".
test("W1-T968: a retro PR reports a standing prior arm as armed although its own arm was refused", async (t) => {
  const fx = setupFakeRetroFixture(t, { ciGreen: true, priorArm: true });
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    const said = (console.log as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls.map((c) =>
      c.arguments.map(String).join(" "),
    );
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const steps = JSON.stringify(ledgerLines.map((l) => l.step));

    assert.ok(!ledgerLines.some((l) => l.step === "retro.error"), `the run must reach its gate; steps=${steps}`);
    assert.ok(ledgerLines.some((l) => l.step === "automerge.disarm_skipped"), `the withdrawal failed, so the arm stands; steps=${steps}`);
    const ownArm = ledgerLines.filter((l) => l.lane === "operator" && String(l.step).startsWith("automerge."));
    assert.ok(ownArm.length > 0 && ownArm.every((l) => l.step !== "automerge.armed"), `this lane's own arm armed nothing; steps=${steps}`);

    const gated = said.filter((line) => line.includes("retro PR gated — "));
    assert.equal(gated.length, 1, `exactly one gated report line; console=${JSON.stringify(said)}`);
    assert.match(gated[0], /retro PR gated — armed \(/, "the pull request is armed, whatever this lane's own call returned");
  });
});

test("retroCommand: a clean run advances its marker without an index artifact", async (t) => {
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    // ci went "red" on the first poll (fake gh above) -> retroCommand returns 1 right
    // after the marker-advance line, without ever reaching reviewCommand/armAutoMerge.
    assert.equal(exitCode, 1, "a red ci gate leaves the PR open (exit 1) -- but ONLY after the marker already advanced");

    const markerRaw = readFileSync(join(fx.root, "state", "last-retro.json"), "utf8");
    const marker = JSON.parse(markerRaw) as RetroMarker;
    assert.ok(marker.ts, "the REAL saveMarker call (run-task.ts's success-path call site) must have landed a valid marker");
    assert.equal(marker.runs_seen, 0, "an empty ledger's gather sees zero runs -- this run itself is not ledger-recorded");

    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      ledgerLines.some((l) => l.step === "retro.marker.advanced"),
      "retro.marker.advanced must be ledgered once the marker is actually saved",
    );
    assert.ok(!ledgerLines.some((l) => String(l.step).startsWith("plan_index.")), "retro no longer regenerates or commits an index artifact");
    assert.equal(fsDefault.existsSync(join(fx.root, "repos", "remudero", "plan", "plan-index.json")), false);
    const preflightIndex = ledgerLines.findIndex((l) => l.step === "retro.preflight_passed");
    const openedIndex = ledgerLines.findIndex((l) => l.step === "pr.opened");
    const markerIndex = ledgerLines.findIndex((l) => l.step === "retro.marker.advanced");
    assert.ok(preflightIndex >= 0, "the production retro path must call the prepublish preflight");
    assert.ok(preflightIndex < openedIndex, "preflight must pass before pr.opened is emitted");
    assert.ok(preflightIndex < markerIndex, "preflight must pass before the retro marker advances");
  });
});

// Driven for BOTH open-weight spellings, and W1-T3607 is why. This case existed to catch exactly
// the leak that rename introduced, and it did not: it pinned the literal `openweight`, so when the
// canonical id became `cash` the case went on guarding a spelling production normalises away and
// passed while `cash` flowed straight into the provenance shape. A test that names one id guards
// one id; `WorkerProviderId` admits both, so both are named here.
for (const openWeightId of ["cash", "openweight"] as const) {
  test(`retroCommand: a ${openWeightId} worker result is omitted from the Claude/Codex-only prepublish provenance`, async (t) => {
    const fx = setupFakeRetroFixture(t, { workerProvider: openWeightId });
    await fx.run(async () => {
      const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
        spawn: fx.fakeSpawn,
        github: offlineGh,
        prepublishPreflight: fx.prepublishPreflight,
      }));
      assert.equal(exitCode, 1, "the fixture's red CI exits only after the prepublish boundary is crossed");
      const rows = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const preflight = rows.find((row) => row.step === "retro.preflight_passed");
      assert.equal(
        Object.hasOwn(preflight, "provider"),
        false,
        `${openWeightId} must not enter retro's historical Claude/Codex provenance shape`,
      );
    });
  });
}

test("retroCommand: a claude worker result DOES reach the prepublish provenance", async (t) => {
  // The positive control for the pair above. Without it the two cases are satisfied by a boundary
  // that drops EVERY provider -- including the two it is supposed to keep -- and the assertion
  // "provider is absent" cannot tell a working allow-list from a broken one.
  const fx = setupFakeRetroFixture(t, { workerProvider: "claude" });
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    const rows = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const preflight = rows.find((row) => row.step === "retro.preflight_passed");
    assert.equal(preflight.provider, "claude", "an allowed provider must still be recorded");
  });
});

test("retroCommand: a clean run with a PRE-EXISTING valid marker still resolves it 'ok' and scopes the gather to it", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 2, runs_seen: 3 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker really advanced past the seeded one");
  });
});

test("retroCommand: the one repair resumes the producing session and reruns preflight", async (t) => {
  const fx = setupFakeRetroFixture(t, { preflightExercisesRepair: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture's public CI is red only after the repaired prepublish passes");
    const repairSpawns = fx.spawnArgs.filter((args) => args.resumeSessionId !== undefined);
    assert.equal(repairSpawns.length, 1, "promotion judges are fresh; exactly one spawn resumes a session");
    assert.equal(repairSpawns[0].resumeSessionId, "s-retro-fixture", "the repair resumes the producing session");
    assert.deepEqual(
      repairSpawns[0].config?.workerProviders?.enabled,
      ["claude"],
      "the per-call config pins the resume to the producing backend without mutating host config",
    );
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      ledgerLines.filter((l) => l.step === "retro.preflight_failed" || l.step === "retro.preflight_passed").map((l) => l.step),
      ["retro.preflight_failed", "retro.preflight_passed"],
    );
    const repair = ledgerLines.find((l) => l.step === "retro.preflight_repair");
    assert.equal(repair?.provider, "claude");
    assert.equal(repair?.resumed_session_id, "s-retro-fixture");
  });
});

test("retroCommand: a repair worker that changes identity, provider, or returns an error fails closed before publication", async (t) => {
  const variants: Array<{ name: string; result: Partial<WorkerResult> }> = [
    { name: "session identity", result: { sessionId: "different-session" } },
    { name: "provider", result: { provider: "codex" } },
    { name: "worker outcome", result: { isError: true, subtype: "error_during_execution" } },
  ];

  for (const variant of variants) {
    await t.test(variant.name, async (t) => {
      const fx = setupFakeRetroFixture(t, {
        preflightExercisesRepair: true,
        repairWorkerResult: variant.result,
      });
      await fx.run(async () => {
        const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
          spawn: fx.fakeSpawn,
          github: offlineGh,
          prepublishPreflight: fx.prepublishPreflight,
        }));
        assert.equal(exitCode, 1, "a rejected repair cannot publish or advance the marker");
        assert.equal(existsSync(join(fx.root, "state", "last-retro.json")), false);
      });
    });
  }
});

// ── W1-T160: the INTEGRITY GATE — a HARD precondition INSIDE the automated
// (daemon-triggered) path only. `opts.automated` claims the TRIGGER observed real
// merge activity since the marker; this fixture's ledger/gh evidence is empty, so
// buildGather's real `shippedSince` naturally credits ZERO -- exactly the R8-class
// mismatch (trigger saw merges, the real gather found none) the gate exists to catch.

test(
  "retroCommand: the INTEGRITY GATE aborts an AUTOMATED run when the trigger saw real merges but the " +
    "real gather credits ZERO -- no PR, no marker advance, no follow-up harvest, Architect never spawned",
  async (t) => {
    const fx = setupFakeRetroFixture(t, {
      seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
    });
    await fx.run(async () => {
      let spawnCalls = 0;
      const spawn = async () => {
        spawnCalls++;
        return fx.fakeSpawn();
      };
      const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
        spawn,
        automated: { reason: "merges", mergesSinceMarker: 5, daysSinceMarker: 1 },
        startTokenRefresh: ({ log }) => {
          log?.("github_app.token_refreshed", { source: "retro-test" });
          return { armed: true, ready: Promise.resolve() };
        },
      }));
      assert.equal(exitCode, 1);
      assert.equal(spawnCalls, 0, "the integrity gate must abort BEFORE the Architect is ever spawned");

      const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
      assert.equal(marker.ts, "2026-01-01T00:00:00.000Z", "the marker must NOT advance past the seeded one");

      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const abortLine = ledgerLines.find((l) => l.step === "retro_aborted_integrity");
      assert.ok(ledgerLines.some((l) => l.step === "github_app.token_refreshed" && l.lane === "retro"),
        "the automated child records its own token refresh before the integrity gate");
      assert.ok(abortLine, "a loud retro_aborted_integrity ledger line must be written");
      assert.equal(abortLine.merges_since_marker, 5);
      assert.equal(abortLine.gather_shipped, 0);
      assert.equal(abortLine.trigger_reason, "merges");
      assert.equal(ledgerLines.some((l) => l.step === "pr.opened"), false, "no PR may open on an integrity-gate abort");
      assert.equal(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        false,
        "the marker must never advance on an integrity-gate abort",
      );
    });
  },
);

test("retroCommand: an OPERATOR-run retro (opts.automated absent) is NOT integrity-gated -- a zero-credit gather still proceeds exactly as before", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })); // no `automated` -- same shape as every other test in this file
    assert.equal(exitCode, 1, "same red-ci exit as the ordinary success path -- unaffected by the integrity gate");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(
      new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(),
      "an operator-run retro still advances the marker even though the gather credited zero -- a human is watching",
    );
  });
});

test("retroCommand: an automated run whose gather DOES credit merges passes the integrity gate and proceeds", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
      spawn: fx.fakeSpawn,
      automated: { reason: "days", mergesSinceMarker: 0, daysSinceMarker: 8 },
      startTokenRefresh: () => ({ armed: false }),
      prepublishPreflight: fx.prepublishPreflight,
    }));
    // mergesSinceMarker: 0 -> checkRetroIntegrity's `priorMergesSinceMarker > 0` guard
    // never trips, regardless of what the real gather credits -- same red-ci exit 1 as
    // every other success-path variant, but reached THROUGH the gate, not around it.
    assert.equal(exitCode, 1);
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker advanced -- the gate passed");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.some((l) => l.step === "retro_aborted_integrity"), false);
  });
});

/** A trivial empty plan for `runDaemon` — nothing is ever runnable, so the retro-trigger
 *  branch (checked BEFORE task dispatch, W1-T160) owns every tick in the test below,
 *  never racing a real task dispatch. */
function minimalDaemonPlan(): Plan {
  return { tasks: [], byId: new Map() };
}

// ── W1-T160 FULL INTEGRATION: the daemon's own scheduling contract driving the REAL
// retroCommand (W1-T136's mergeable-PR path), not a stand-in. The two halves of
// criterion 3 — "runs end to end ... and advances the marker" AND "a second poll does
// not re-fire" — are proven TOGETHER, in ONE pass, against the SAME on-disk marker:
// `runDaemon`'s `checkRetroTrigger`/`runRetroTrigger` hooks are wired to the real
// `evaluateRetroTrigger` (over the real marker file) and the real `retroCommand`
// (over `setupFakeRetroFixture`'s real git/gh fixture) respectively — exactly the
// wiring run-task.ts's `daemonCommand`/`retroTriggerCheck` use in production, not a
// fake `runRetroTrigger` standing in for it.

test(
  "W1-T160 INTEGRATION: runDaemon fires the retro trigger, runs the REAL retroCommand (W1-T136's " +
    "mergeable-PR path) through to a real pr.opened + marker advance, and does NOT re-fire on the very next poll",
  async (t) => {
    const fx = setupFakeRetroFixture(t); // fresh fixture, NO seeded marker -- absent marker fires via reason=days (Infinity)
    await fx.run(async () => {
      const markerPath = join(fx.root, "state", "last-retro.json");
      const plan = minimalDaemonPlan();
      // merges effectively disabled (this fixture's ledger/gh evidence is empty anyway);
      // ANY elapsed time fires via "days" -- the absent-marker case is Infinity days.
      const policy = { mergesThreshold: 999999, daysThreshold: 1 };

      const checkRetroTrigger = (): RetroTriggerDecision => {
        const resolution = resolveMarkerForGather(markerPath);
        const marker = resolution.kind === "ok" ? resolution.marker : undefined;
        return evaluateRetroTrigger(0, marker?.ts, new Date(), policy);
      };

      let retroRuns = 0;
      const runRetroTrigger = async (decision: Extract<RetroTriggerDecision, { fire: true }>) => {
        retroRuns++;
        // THE REAL retroCommand -- W1-T136's mergeable-PR path (Architect spawn -> push
        // -> gh pr create -> ownership assert -> pr.opened -> marker save), gated by
        // opts.automated exactly as the real daemon wiring (run-task.ts's daemonCommand
        // / retroTriggerCheck) invokes it in production. Never a stand-in.
        await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, automated: decision,
          startTokenRefresh: () => ({ armed: false }), github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
      };

      const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
      let stopChecks = 0;
      const summary = await runDaemon(plan, {
        refreshMerged: () => () => true, // nothing to dispatch -- the retro-trigger branch owns every tick
        runOne: async (id) => {
          throw new Error(`runOne must never be called in this fixture (task ${id})`);
        },
        checkStop: () => {
          stopChecks++;
          return stopChecks > 2 ? "test bound reached" : undefined;
        },
        sleep: async () => {},
        checkRetroTrigger,
        runRetroTrigger,
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      });

      await drainDetachedSweepActions({ boundMs: 20000 });
  assert.equal(summary.stopReason, "stopped");
      assert.equal(retroRuns, 1, "the REAL retroCommand ran exactly once across the two evaluated ticks");

      const fired = lines.filter((l) => l.step === "retro_triggered");
      assert.equal(fired.length, 1, "retro_triggered ledgered exactly once, naming the fire");
      assert.equal(fired[0].extra.reason, "days");

      // W1-T136's mergeable-PR path: a REAL PR opened (never a stub), plan-only-asserted.
      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(
        ledgerLines.some((l) => l.step === "pr.opened" && l.plan_only === true),
        "the retro reached a real, plan-only, opened PR -- W1-T136's mergeable-PR path",
      );
      assert.ok(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        "the marker advance is the retro's own real saveMarker call, not asserted-away",
      );
      assert.equal(
        ledgerLines.some((l) => l.step === "retro_aborted_integrity"),
        false,
        "the integrity gate passed -- an integrity-passing gather never aborts",
      );

      const markerAfter = JSON.parse(readFileSync(markerPath, "utf8")) as RetroMarker;
      assert.ok(markerAfter.ts, "state/last-retro.json now holds a real, valid, advanced marker");

      // The SECOND poll: re-derived FRESH off the marker THIS run just wrote to disk --
      // not a mock returning a canned "don't fire" answer.
      const secondDecision = checkRetroTrigger();
      assert.equal(secondDecision.fire, false, "the advanced marker's own re-derived state does not cross either threshold again");
    });
  },
);

test("retroCommand: an ownership mismatch (claimed PR head branch != this run's own branch) fails CLOSED before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { headRefName: () => "some-other-branch-entirely" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "pr_attribution_failed is a fail-closed exit 1, same as any other refused retro");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an ownership mismatch must NEVER advance the marker");
  });
});

test("retroCommand: a terminal second prepublish failure preserves the diagnostic branch and posts no PR, marker, review, or merge arm", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    preflightResult: { ok: false, attempts: 2, suiteCount: 158, repaired: true },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1);
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a second failure must leave the marker unchanged");
    assert.ok(fsDefault.existsSync(join(fx.root, "worktrees", fx.branch)), "the committed diagnostic worktree/branch stays available");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.filter((l) => l.step === "retro.preflight_failed").length, 2);
    for (const forbidden of ["pr.opened", "review.posted", "automerge.armed", "retro.marker.advanced"]) {
      assert.equal(ledgerLines.some((l) => l.step === forbidden), false, `${forbidden} must not occur after terminal preflight failure`);
    }
  });
});

test("retroCommand: a diff that touches src/ fails the plan-only guard before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    diff: "diff --git a/src/lib/retro.ts b/src/lib/retro.ts\n--- a/src/lib/retro.ts\n+++ b/src/lib/retro.ts\n+// not plan-only\n",
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "a code-touching retro PR is left OPEN for inspection -- exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a plan-only violation must NEVER advance the marker");
  });
});

test("retroCommand: a PR body missing an Acceptance block gets the harness-side repair pass (W1-T136)", async (t) => {
  // No `## Acceptance` block -- only the trailer -- so ensureTaskTrailer's own check is
  // still satisfied but the acceptance-repair pass's `parseAcceptanceBlock(...).length === 0`
  // branch fires and `gh pr edit` is invoked to fix it up (our fake `gh` accepts any `edit`).
  const fx = setupFakeRetroFixture(t, { body: "Remudero-Task: RETRO\n" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants -- the repair itself never blocks the retro");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the repair pass is best-effort -- it must never prevent the marker from advancing");
  });
});

test("retroCommand: a transient `gh pr diff` failure is caught by the outer catch, logged, and rethrown -- the marker never advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { diffFails: true });
  await fx.run(async () => {
    await assert.rejects(
      () => withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })),
      /transient failure/,
      "the outer catch re-throws (never swallows) an unexpected mid-flight gh failure",
    );
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a mid-flight failure must NEVER leave a half-advanced marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.error"), "the outer catch must ledger retro.error before rethrowing");
  });
});

test("retroCommand: no PR_URL in the Architect's report falls back to `gh pr create --fill` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-pr-create-fill fallback must still reach the real saveMarker call");
  });
});

test("retroCommand: an exact-head PR omitted from the report is recovered and reused before preflight", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, existingPrWithoutReport: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture reaches its intentional red public-CI gate");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const recovered = ledgerLines.find((l) => l.step === "retro.pr.recovered");
    assert.equal(recovered?.pr_url, "https://github.com/craigoley/remudero/pull/434343");
    assert.equal(recovered?.head_branch, fx.branch);
    assert.equal(
      ledgerLines.find((l) => l.step === "retro.preflight_passed")?.remote_pr_existed,
      true,
      "preflight telemetry records that publication had already happened",
    );
    assert.equal(
      ledgerLines.find((l) => l.step === "pr.opened")?.pr_url,
      "https://github.com/craigoley/remudero/pull/434343",
      "the same exact-head PR survives validation and publication; no replacement is created",
    );
  });
});

test("retroCommand: an UNRESOLVED head ref (gh cannot say what branch the PR is on) fails CLOSED, distinctly from a resolved-but-wrong one", async (t) => {
  const fx = setupFakeRetroFixture(t, { unresolvedHeadRef: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "an unresolved head ref is treated as NOT owned -- fail closed, same as a resolved mismatch");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an unresolved head ref must NEVER advance the marker");
  });
});

test("retroCommand: the removed plan-index generator is not required to advance the marker", async (t) => {
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the marker advances without invoking a plan-index generator");
    assert.equal(fsDefault.existsSync(join(fx.root, "repos", "remudero", "plan", "plan-index.json")), false);
  });
});

test("retroCommand: a malformed plan/tasks.yaml degrades the best-effort 'next runnable task' lookup gracefully and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { badPlan: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a best-effort next-task lookup failure must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "orientation.next_task.error"), "the malformed plan must be ledgered, not silently swallowed");
  });
});

test("retroCommand: a PR body with NO body field at all (not merely empty) still gets trailer-stamped and repaired", async (t) => {
  const fx = setupFakeRetroFixture(t, { omitBody: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a missing body field is best-effort (ensureTaskTrailer/the repair pass) -- never blocks the marker advance");
  });
});

test("retroCommand: repoDir absent triggers a REAL `gh repo clone` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { missingRepoDir: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-repo-clone fallback must still reach the real saveMarker call");
    assert.ok(fsDefault.existsSync(join(fx.root, "repos", "remudero", ".git")), "gh repo clone must have actually materialized repoDir");
  });
});

test("retroCommand: a transient `gh pr edit` failure during the acceptance-repair pass is caught by ITS OWN best-effort catch, not the outer one", async (t) => {
  // No Acceptance block (forces the repair attempt) AND the repair's own `gh pr edit`
  // fails -- distinct from `diffFails` (which fails a DIFFERENT gh call, caught by the
  // outer catch and rethrown instead).
  const fx = setupFakeRetroFixture(t, {
    body: "Remudero-Task: RETRO\n",
    repairEditFails: true,
    diff: [
      "diff --git a/plan/retro-proof.txt b/plan/retro-proof.txt",
      "--- /dev/null",
      "+++ b/plan/retro-proof.txt",
      "@@ -0,0 +1 @@",
      "+fixture repair edit failure",
      "",
    ].join("\n"),
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "the repair failure is best-effort -- it must NOT propagate as an uncaught rejection");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a failed repair attempt must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "acceptance.repair.error"), "the repair failure must be ledgered by its OWN catch");
  });
});

test("retroCommand: the Architect commits NOTHING when no PR_URL and no MASTER-PLAN are available -- marker stays untouched", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, missingMasterPlan: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "0 commits ahead of origin/main means nothing to PR -- retro.no_op, exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a no-op retro (nothing committed) must NEVER advance the marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.no_op"), "the no-op path must be ledgered");
  });
});

test("retroCommand: a stale lockless leftover worktree is force-removed by pruneStaleRuns before this run's own worktree is added", async (t) => {
  const fx = setupFakeRetroFixture(t, { staleWorktree: true });
  const stalePath = join(fx.root, "worktrees", "run-STALE-leftover");
  assert.ok(fsDefault.existsSync(stalePath), "sanity: the stale worktree must exist BEFORE retroCommand runs");
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "pruning a stale sibling worktree must never prevent THIS run's own marker advance");
    assert.ok(!fsDefault.existsSync(stalePath), "the stale worktree must actually be gone -- pruneStaleRuns really ran, not just logged");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "worktree.prune"), "the prune must be ledgered");
  });
});

// THE FAKE MUST BE REACHED. A dep injected into a path that ignores it looks exactly like one that
// works — both go green — so this is the assertion that discriminates them.
//
// SELF-CONTAINED ON PURPOSE. An earlier revision asserted on the SHARED `offlineGh`'s accumulated
// calls, which passed in a full-file run and FAILED under `--test-name-pattern` — the reviewer's own
// proof executor runs exactly that way, so the guard would have been red at review while green
// locally. It now drives its own retroCommand with its own fake and depends on no sibling test.
test("the injected offline gateway is consulted by retroCommand, so no real one is opened", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
  t.mock.method(console, "log", () => {});
  const github = offlineGithub();
  try {
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github })));
    assert.equal(exitCode, 0, "--dry-run never fails a genuinely-first-ever retro");
    assert.ok(
      github.calls.length > 0,
      `the production path must consult the injected gateway; recorded ${github.calls.length} calls`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("retroCommand: a real retro spawns no learnings promotion judge (retired 2026-09-29)", async (t) => {
  // The pass re-judged the same four learnings 352 times in 14 days and nothing read its output.
  // Each judge was a fresh spawn with an EMPTY tool list; the Architect's own spawn never is.
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.ok(fx.spawnArgs.length > 0, "the Architect itself was spawned, so an empty count below is not vacuous");
    const judgeSpawns = fx.spawnArgs.filter((args) => Array.isArray(args.tools) && args.tools.length === 0);
    assert.equal(judgeSpawns.length, 0, "no tool-less promotion judge is spawned");
  });
});
