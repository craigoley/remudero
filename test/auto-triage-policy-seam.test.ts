// test/auto-triage-policy-seam.test.ts — the `opts.policy` injection seam on `autoTriageCheck`.
//
// WHY THIS SEAM EXISTS, measured rather than asserted. Before it, `autoTriageCheck`'s only policy
// source was the CHECKED-IN `plan/policy.yaml`, resolved through `repoRoot` — which derives from the
// running process's own cwd. So a test driving this function read the REPO's policy no matter what
// fixture it had built. That is exactly how `test/auto-triage-wiring.test.ts` came to assert an
// unconditional refusal under a title claiming the flag was ABSENT: its fixture wrote no policy file
// at all, and it was really pinning "the shipped default is false". It passed by coincidence of that
// value until the flag was genuinely flipped (#1093).
//
// An audit of the whole policy surface — perturbing all thirteen numeric values to sentinels and
// flipping both booleans, then re-running every suite that touches policy — found 13 coupled tests.
// Ten are deliberate (there is a whole file, test/policy-consumers.test.ts, whose purpose is to pin
// consumers to the policy file, plus a drift lock). `autoTriageCheck` was the only un-injectable
// reader whose DECISION OUTPUT tests assert on, which is what made it the one that could silently
// pass while claiming otherwise. This file makes that impossible: it proves the injected policy — not
// the checked-in one — governs, in both directions.
//
// The seam mirrors `retroTriggerCheck`'s `deps.policy` exactly, including this file's fixture shape:
// spread the real shipped policy so every OTHER row stays schema-valid, and override only the row
// under test.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { autoTriageCheck, buildAutoTriageDaemonHooks } from "../src/run-task.js";
import { loadPolicy, policyPath, validatePolicy, PolicyError, type Policy } from "../src/lib/policy.js";
import { decideAutoTriage, type AutoTriageCensus } from "../src/lib/auto-triage.js";
import type { Config } from "../src/lib/config.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

/** W1-T318: the new cadence-curve fields (`maxIntervalMinutes`/`depthFloor`/`depthCeiling`) are
 *  OPTIONAL here and default from the SHIPPED policy — every pre-existing call below still passes
 *  only `enabled`/`minIntervalMinutes`/`maxPerDay` and is completely unaffected; new tests that
 *  care about the curve pass the extra fields explicitly. */
function policyFixture(autoTriage: {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
  maxIntervalMinutes?: number;
  depthFloor?: number;
  depthCeiling?: number;
}): Policy {
  return {
    ...SHIPPED,
    values: {
      ...SHIPPED.values,
      autoTriage: {
        enabled: autoTriage.enabled,
        minIntervalMinutes: autoTriage.minIntervalMinutes,
        maxIntervalMinutes: autoTriage.maxIntervalMinutes ?? SHIPPED.values.autoTriage.maxIntervalMinutes,
        depthFloor: autoTriage.depthFloor ?? SHIPPED.values.autoTriage.depthFloor,
        depthCeiling: autoTriage.depthCeiling ?? SHIPPED.values.autoTriage.depthCeiling,
        maxPerDay: autoTriage.maxPerDay,
      },
    },
  };
}

/** A throwaway config root, so the marker/lock reads land somewhere disposable rather than on the
 *  live fleet's state directory. */
function tmpConfig(): { config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-auto-triage-seam-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    config: { root, claudeBin: "/bin/true" } as unknown as Config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("an injected disabled policy governs, whatever the checked-in policy says", () => {
  const { config, cleanup } = tmpConfig();
  try {
    const decision = autoTriageCheck({
      config,
      policy: policyFixture({ enabled: false, minIntervalMinutes: 60, maxPerDay: 4 }),
    });

    assert.equal(decision.fire, false);
    assert.match(decision.reason, /disabled/, "the INJECTED flag is why, not the shipped one");
  } finally {
    cleanup();
  }
});

test("an injected enabled policy is not refused for being disabled", () => {
  // The other direction, and the one that matters: with the seam absent, this assertion's outcome
  // would be decided by the checked-in file rather than the fixture. It may still refuse for a
  // legitimate local reason — an empty candidate list on a throwaway root — but never for the flag.
  const { config, cleanup } = tmpConfig();
  try {
    const decision = autoTriageCheck({
      config,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 60, maxPerDay: 4 }),
    });

    assert.doesNotMatch(
      (decision as { reason: string }).reason,
      /disabled/,
      "an injected enabled policy must never produce the disabled refusal",
    );
  } finally {
    cleanup();
  }
});

test("the injected maxPerDay bound is the one enforced", () => {
  // A bound, not just the flag — so the seam is proven to carry the whole row rather than one field.
  // Marker pre-seeded with two fires inside the window; a cap of 2 must refuse and a cap of 9 must
  // not, off the SAME state, with only the injected policy differing.
  const { config, cleanup } = tmpConfig();
  try {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const recent = [
      new Date(now.getTime() - 5 * 60_000).toISOString(),
      new Date(now.getTime() - 10 * 60_000).toISOString(),
    ];
    writeFileSync(join(config.root, "state", "last-auto-triage.json"), JSON.stringify({ fires: recent }));

    const capped = autoTriageCheck({
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 1, maxPerDay: 2 }),
    });
    assert.equal(capped.fire, false);
    assert.match(capped.reason, /daily cap reached \(2\/2/, "the INJECTED cap of 2 is the one enforced");

    const roomy = autoTriageCheck({
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 1, maxPerDay: 9 }),
    });
    assert.doesNotMatch((roomy as { reason: string }).reason, /daily cap/, "a cap of 9 clears the same two fires");
  } finally {
    cleanup();
  }
});

test("the injected minIntervalMinutes bound is the one enforced", () => {
  const { config, cleanup } = tmpConfig();
  try {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000).toISOString();
    writeFileSync(join(config.root, "state", "last-auto-triage.json"), JSON.stringify({ fires: [tenMinutesAgo] }));

    const tooSoon = autoTriageCheck({
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 60, maxPerDay: 9 }),
    });
    assert.equal(tooSoon.fire, false);
    assert.match(tooSoon.reason, /minInterval 60m/, "the INJECTED interval is the one enforced");

    const longEnough = autoTriageCheck({
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 5, maxPerDay: 9 }),
    });
    assert.doesNotMatch((longEnough as { reason: string }).reason, /minInterval/, "5m clears a 10m-old fire");
  } finally {
    cleanup();
  }
});

test("the daemon hook builder forwards an injected policy to the check it wires", () => {
  // The seam is only useful if it survives the layer the daemon actually consumes. Without the
  // forward in buildAutoTriageDaemonHooks, an injected policy would be silently dropped and the
  // wired hook would fall back to the checked-in file — the original defect, one level up.
  const { config, cleanup } = tmpConfig();
  try {
    const hooks = buildAutoTriageDaemonHooks({
      config,
      policy: policyFixture({ enabled: false, minIntervalMinutes: 60, maxPerDay: 4 }),
    });
    const decision = hooks.checkAutoTriage();

    assert.equal(decision.fire, false);
    assert.match(decision.reason, /disabled/, "the injected policy reached the wired hook");
  } finally {
    cleanup();
  }
});

test("production passes no policy, so the checked-in file still governs", () => {
  // The seam must not change what the fleet does. With nothing injected the decision is derived from
  // the repo's own plan/policy.yaml exactly as before — asserted by agreeing with that file rather
  // than with a number, so this test cannot itself become the coupling it was written to remove.
  const { config, cleanup } = tmpConfig();
  try {
    const decision = autoTriageCheck({ config });
    const shipped = loadPolicy(policyPath(REPO_ROOT)).values.autoTriage;

    if (!shipped.enabled) {
      assert.equal(decision.fire, false);
      assert.match(decision.reason, /disabled/);
    } else {
      assert.doesNotMatch((decision as { reason: string }).reason, /disabled/);
    }
  } finally {
    cleanup();
  }
});

// ── W1-T318: the adaptive cadence curve ─────────────────────────────────────────────────────
//
// The four tests below drive the PURE `decideAutoTriage` directly (never a filesystem, never a
// clock) — the census is exactly the shape `daemon.ts` computes off the SAME idle_reasons tally
// it already logs (see `src/lib/auto-triage.ts`'s `AutoTriageCensus` doc), so these pin the curve
// at the one seam that matters without re-deriving what "runnable" means.

/** A policy whose curve is wide enough that `sinceMin` below can land on either side of it,
 *  and whose `maxPerDay` is high enough that the daily cap never interferes — these tests are
 *  about the INTERVAL, not the cap (that falsifier gets its own test further down). */
function cadencePolicy() {
  return policyFixture({
    enabled: true,
    minIntervalMinutes: 10,
    maxIntervalMinutes: 100,
    depthFloor: 0,
    depthCeiling: 10,
    maxPerDay: 1000,
  }).values.autoTriage;
}

function decideAt(census: AutoTriageCensus, sinceMinutesAgo: number) {
  const now = new Date("2026-08-04T12:00:00.000Z");
  return decideAutoTriage({
    policy: cadencePolicy(),
    idle: true,
    lockHeld: false,
    marker: { kind: "ok", marker: { fires: [new Date(now.getTime() - sinceMinutesAgo * 60_000).toISOString()] } },
    now,
    candidates: ["fb-x"],
    census,
  });
}

test("the interval shortens toward minIntervalMinutes as depth approaches the floor", () => {
  // 60 minutes since the last fire. At the floor (depth 0) the curve's fastest point,
  // minIntervalMinutes 10m, has long since elapsed — it must fire.
  const d = decideAt({ depth: 0, allMerged: false }, 60);
  assert.equal(d.fire, true, "depth at the floor must use the SHORT interval and clear a 60m gap");
});

test("the interval lengthens toward maxIntervalMinutes as depth recovers toward the ceiling", () => {
  // Same 60-minute gap, but depth is now at the ceiling (10): the curve's slowest point,
  // maxIntervalMinutes 100m, has NOT elapsed — it must refuse, naming the interval and the depth.
  const d = decideAt({ depth: 10, allMerged: false }, 60);
  assert.equal(d.fire, false, "depth at the ceiling must use the LONG interval and refuse a 60m gap");
  assert.match(
    (d as { reason: string }).reason,
    /interval 100\.0m at depth 10/,
    "the refusal must name the lengthened interval and the depth that produced it",
  );
});

test("depth between the floor and the ceiling interpolates strictly between the two intervals", () => {
  // Depth 5 of a [0,10] span is the curve's midpoint: 10 + 0.5*(100-10) = 55m. A 60m gap clears
  // it (unlike the ceiling case just above) — proving the curve is a continuum, not a step from
  // "fast" straight to "slow".
  const mid = decideAt({ depth: 5, allMerged: false }, 60);
  assert.equal(mid.fire, true, "the interpolated 55m interval must clear a 60m gap");

  // A tighter gap (50m) falls short of that same 55m midpoint interval and must refuse — pinning
  // the interpolated NUMBER, not just its sign.
  const midTight = decideAt({ depth: 5, allMerged: false }, 50);
  assert.equal(midTight.fire, false, "50m must not clear the interpolated 55m interval");
  assert.match((midTight as { reason: string }).reason, /interval 55\.0m at depth 5/);
});

test("adaptive cadence never exceeds the daily cap — at the cap with zero depth nothing fires", () => {
  // THE FALSIFIER (design clause v). depth 0 is the curve's most urgent point — minIntervalMinutes
  // alone would fire immediately — but the daily cap is a SEPARATE, unconditional bound the curve
  // never touches. Two fires already inside the 24h window at a cap of 2 must still refuse.
  const now = new Date("2026-08-04T12:00:00.000Z");
  const recentFires = [
    new Date(now.getTime() - 30 * 60_000).toISOString(),
    new Date(now.getTime() - 20 * 60_000).toISOString(),
  ];
  const policy = policyFixture({
    enabled: true,
    minIntervalMinutes: 1,
    maxIntervalMinutes: 5,
    depthFloor: 0,
    depthCeiling: 10,
    maxPerDay: 2,
  }).values.autoTriage;

  const d = decideAutoTriage({
    policy,
    idle: true,
    lockHeld: false,
    marker: { kind: "ok", marker: { fires: recentFires } },
    now,
    candidates: ["fb-x"],
    census: { depth: 0, allMerged: false }, // most urgent point on the curve
  });

  assert.equal(d.fire, false, "the daily cap must refuse even at the curve's fastest, most urgent point");
  assert.match((d as { reason: string }).reason, /daily cap reached \(2\/2/);
});

test("a plan whose every task is already merged is DONE and does not accelerate triage", () => {
  // Design clause iv. Depth 0 is IDENTICAL in both branches below — only `allMerged` differs —
  // so this isolates the one bit that must override the "near-empty, go fast" reading.
  const thin = decideAt({ depth: 0, allMerged: false }, 30);
  assert.equal(thin.fire, true, "a genuinely thin (but not all-merged) queue at depth 0 fires on a 30m gap");

  const done = decideAt({ depth: 0, allMerged: true }, 30);
  assert.equal(done.fire, false, "an all-merged plan must NOT accelerate — same depth, opposite outcome");
  assert.match(
    (done as { reason: string }).reason,
    /all-merged/,
    "the refusal must name WHY: DONE, not starved, never a reason to accelerate",
  );
});

test("the cadence curve is bounded policy data whose out-of-range value is refused at load", () => {
  // Read from the SHIPPED file, never hardcoded — this file's own convention (see the module doc
  // above). Push depthCeiling past its own declared max and prove validatePolicy refuses it by
  // name, exactly like every other bounded numeric row.
  const raw = parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
  const autoTriageRaw = raw.autoTriage as Record<string, Record<string, unknown>>;
  const depthCeilingMax = autoTriageRaw.depthCeiling.max as number;
  autoTriageRaw.depthCeiling = { ...autoTriageRaw.depthCeiling, value: depthCeilingMax + 1 };

  assert.throws(
    () => validatePolicy(raw),
    (err: unknown) =>
      err instanceof PolicyError && /autoTriage\.depthCeiling\.value.*out of its declared bound/.test(err.message),
    "an out-of-bounds cadence value must be refused at load, named by field",
  );
});
