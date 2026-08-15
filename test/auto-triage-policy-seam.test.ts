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
import { decideAutoTriage } from "../src/lib/auto-triage.js";
import type { Config } from "../src/lib/config.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

/** W1-T475: the cadence-curve fields are GONE from the policy, so this fixture carries only the
 *  three rows that remain. `maxPerDay` defaults from the SHIPPED policy so a test that cares only
 *  about the floor cannot accidentally pin a cap value of its own invention. */
function policyFixture(autoTriage: {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay?: number;
}): Policy {
  return {
    ...SHIPPED,
    values: {
      ...SHIPPED.values,
      autoTriage: {
        enabled: autoTriage.enabled,
        minIntervalMinutes: autoTriage.minIntervalMinutes,
        maxPerDay: autoTriage.maxPerDay ?? SHIPPED.values.autoTriage.maxPerDay,
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
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
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
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
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
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 1, maxPerDay: 2 }),
    });
    assert.equal(capped.fire, false);
    assert.match(capped.reason, /daily cap reached \(2\/2/, "the INJECTED cap of 2 is the one enforced");

    const roomy = autoTriageCheck({
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
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
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
      config,
      now,
      policy: policyFixture({ enabled: true, minIntervalMinutes: 60, maxPerDay: 9 }),
    });
    assert.equal(tooSoon.fire, false);
    assert.match(tooSoon.reason, /minInterval 60m/, "the INJECTED interval is the one enforced");

    const longEnough = autoTriageCheck({
      deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
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
    const decision = hooks.checkAutoTriage({ deferralPending: true, dispatchCount: 1, laneBudget: 1 });

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

// ── W1-T475: the adaptive cadence curve is GONE; the floor and the cap are what remain ─────
//
// The curve (W1-T318) was deleted on the operator's ruling: it was a SECOND, WEAKER governor on
// the quantity `maxPerDay` already bounds exactly, and its input was uncorrelated with capacity in
// both directions — `depth` counted the recoverable backlog of tasks that CANNOT run, so a queue
// of purely colliding-but-eligible work read 0 and triaged at the FAST end while lanes sat empty.
//
// THESE THREE TESTS ARE THE FALSIFIERS THAT MATTER AFTER A BOUND IS REMOVED, and each pins a
// different way this change could have gone silently wrong:
//   1. the DAILY CAP still refuses — with the interval no longer throttling, it is the only bound
//      left, and a test asserting merely that the rung FIRES would not have caught its loss;
//   2. the FLOOR survives — `minIntervalMinutes` used to reach the decision ONLY through the
//      curve's `depth <= depthFloor` arm, so deleting the curve could have deleted it too and
//      left a rung free to fire on every idle tick;
//   3. the SKIP is still LOGGED WITH A REASON — a removed branch that stops emitting leaves the
//      next investigation blind, and this repo already has a rung whose "daemon is not idle"
//      reason is unreachable and appears 0 times in 1,214 skip rows.

/** Cap high enough not to interfere; floor wide enough that `sinceMin` can land on either side. */
function floorPolicy(maxPerDay = 1000) {
  return policyFixture({ enabled: true, minIntervalMinutes: 10, maxPerDay }).values.autoTriage;
}

function decideAfter(sinceMinutesAgo: number, opts: { maxPerDay?: number; extraFires?: string[] } = {}) {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const fires = [
    ...(opts.extraFires ?? []),
    new Date(now.getTime() - sinceMinutesAgo * 60_000).toISOString(),
  ];
  return decideAutoTriage({
    policy: floorPolicy(opts.maxPerDay),
    deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
    lockHeld: false,
    marker: { kind: "ok", marker: { fires } },
    now,
    candidates: ["fb-x"],
  });
}

test("W1-T475 FALSIFIER: the 25th fire in a rolling day is REFUSED — the cap is now the only spend bound", () => {
  // THE TRAP THIS EXISTS FOR. With the interval no longer throttling, `maxPerDay` is all that
  // stands between this rung and 1,440 idle ticks a day. Asserting the rung FIRES proves nothing;
  // this asserts the 25th attempt does NOT, at the SHIPPED cap of 24.
  const now = new Date("2026-08-04T12:00:00.000Z");
  const shipped = policyFixture({ enabled: true, minIntervalMinutes: 15 }).values.autoTriage;
  assert.equal(shipped.maxPerDay, 24, "this test is pinned to the shipped cap, not a fixture value");

  // 24 fires already inside the window, the newest old enough that the FLOOR is satisfied — so the
  // cap is provably the bound doing the refusing, not the interval.
  const twentyFour = Array.from({ length: 24 }, (_, k) =>
    new Date(now.getTime() - (60 + k) * 60_000).toISOString(),
  );
  const d = decideAutoTriage({
    policy: shipped,
    deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
    lockHeld: false,
    marker: { kind: "ok", marker: { fires: twentyFour } },
    now,
    candidates: ["fb-x"],
  });
  assert.equal(d.fire, false, "the 25th fire in a rolling 24h window must be refused");
  assert.match((d as { reason: string }).reason, /daily cap reached \(24\/24 in the last 24h\)/);

  // FALSIFIER FOR THE FALSIFIER: 23 in the window, same floor-satisfying gap, MUST fire — otherwise
  // this test would pass against a rung that refuses unconditionally.
  const twentyThree = twentyFour.slice(0, 23);
  const under = decideAutoTriage({
    policy: shipped,
    deferralPending: true,
    dispatchCount: 1,
    laneBudget: 1,
    lockHeld: false,
    marker: { kind: "ok", marker: { fires: twentyThree } },
    now,
    candidates: ["fb-x"],
  });
  assert.equal(under.fire, true, "23 fires in the window is UNDER the cap and must still fire");
});

test("W1-T475: the minimum-interval FLOOR survives the curve's deletion — two ticks inside it yield ONE fire", () => {
  // `minIntervalMinutes` used to be reachable ONLY through the deleted curve. If it had gone with
  // it, both ticks below would fire and the rung would run every poll.
  const inside = decideAfter(4); // 4m elapsed against a 10m floor
  assert.equal(inside.fire, false, "a tick INSIDE the floor must not fire");

  const alsoInside = decideAfter(9); // a second tick, still inside
  assert.equal(alsoInside.fire, false, "a second tick inside the same floor must not fire either");

  const outside = decideAfter(11); // past the floor
  assert.equal(outside.fire, true, "once the floor has elapsed the rung fires — the floor is a delay, not a block");
});

test("W1-T475: the interval skip is still LOGGED WITH A REASON naming the floor and the elapsed time", () => {
  // A removed branch that silently stops emitting is how a rung becomes unmeasurable. The reason
  // string is the ONLY record of this refusal.
  const d = decideAfter(4);
  assert.equal(d.fire, false);
  const reason = (d as { reason: string }).reason;
  assert.match(reason, /only 4\.0m since the last fire/, "the refusal must name how long it has been");
  assert.match(reason, /minInterval 10m/, "and the floor that refused it");
  // The curve's own vocabulary must be GONE, not merely unused — a stale "at depth N" would mean
  // some caller is still computing a census the policy no longer has.
  assert.doesNotMatch(reason, /at depth/, "no depth wording survives the curve's deletion");
});

test("W1-T475: minIntervalMinutes is still bounded policy data whose out-of-range value is refused at load", () => {
  // COVERAGE PRESERVED, REDIRECTED. The deleted curve tests included the only assertion that an
  // autoTriage row's declared bound is enforced (it named `depthCeiling`). That row is gone, but
  // the property must not go with it — and it matters MORE now, because `minIntervalMinutes` is
  // the sole remaining interval bound rather than one end of a curve. Read from the SHIPPED file,
  // never hardcoded, per this file's own convention.
  const raw = parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
  const autoTriageRaw = raw.autoTriage as Record<string, Record<string, unknown>>;
  const declaredMax = autoTriageRaw.minIntervalMinutes.max as number;
  autoTriageRaw.minIntervalMinutes = { ...autoTriageRaw.minIntervalMinutes, value: declaredMax + 1 };

  assert.throws(
    () => validatePolicy(raw),
    (err: unknown) =>
      err instanceof PolicyError &&
      /autoTriage\.minIntervalMinutes\.value.*out of its declared bound/.test(err.message),
    "an out-of-bounds floor must be refused at load, named by field",
  );
});

test("W1-T475: the deleted curve rows are absent from BOTH the policy file and the loaded shape", () => {
  // A removed field that plan/policy.yaml still declares is a surface documented to disagree with
  // the code — the seven-instance pattern this change exists not to repeat. Assert BOTH sides:
  // the file no longer declares the rows, and the loaded policy object no longer carries them.
  const raw = parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
  const autoTriageRaw = raw.autoTriage as Record<string, unknown>;
  for (const gone of ["maxIntervalMinutes", "depthFloor", "depthCeiling"]) {
    assert.equal(gone in autoTriageRaw, false, `plan/policy.yaml still declares autoTriage.${gone}`);
    assert.equal(gone in SHIPPED.values.autoTriage, false, `the loaded policy still carries ${gone}`);
  }
  // FALSIFIER: the rows that MUST remain are still both declared and loaded.
  for (const kept of ["enabled", "minIntervalMinutes", "maxPerDay"]) {
    assert.equal(kept in autoTriageRaw, true, `plan/policy.yaml lost autoTriage.${kept}`);
    assert.equal(kept in SHIPPED.values.autoTriage, true, `the loaded policy lost ${kept}`);
  }
});
