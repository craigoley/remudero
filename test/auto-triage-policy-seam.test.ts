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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { autoTriageCheck, buildAutoTriageDaemonHooks } from "../src/run-task.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import type { Config } from "../src/lib/config.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED: Policy = loadPolicy(policyPath(REPO_ROOT));

function policyFixture(autoTriage: { enabled: boolean; minIntervalMinutes: number; maxPerDay: number }): Policy {
  return { ...SHIPPED, values: { ...SHIPPED.values, autoTriage } };
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
