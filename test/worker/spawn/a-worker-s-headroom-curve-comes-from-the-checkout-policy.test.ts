// W1-T14754: a worker's routing decision judges headroom with the checkout's plan/policy.yaml curve, the one the daemon
// loads, not config.root's absent policy (the host's workers logged worker.provider_headroom_policy_fallback ENOENT).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDefaultHeadroomPolicy, headroomPolicyFromCurve } from "#src/lib/headroom.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { workerHeadroomTiming } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-24T23:00:00Z");

/** The fallback lines a call writes to stderr. */
function fallbacks<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { value: run(), lines: lines.filter((line) => line.includes("worker.provider_headroom_policy_fallback")) };
  } finally {
    console.error = original;
  }
}

/** A checkout whose plan/policy.yaml is this repository's, with the given text in place of the curve's 100% rung. */
function checkoutWith(policyText: (committed: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}worker-headroom-`));
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "policy.yaml"), policyText(readFileSync(policyPath(REPO_ROOT), "utf8")));
  return root;
}

test("W1-T14754 a worker's headroom curve comes from the checkout's plan policy", () => {
  const committed = headroomPolicyFromCurve(loadPolicy(policyPath(REPO_ROOT)).values.headroom.curve);
  const own = fallbacks(() => workerHeadroomTiming(NOW));
  assert.deepEqual(own.value, { nowMs: NOW, policy: committed }, "by default the install's own checkout policy is read");
  assert.deepEqual(own.lines, [], "and nothing falls back");
  const root = checkoutWith((text) => text.replace("{ maxHoursToReset: 24, limitPct: 100 }", "{ maxHoursToReset: 24, limitPct: 77 }"));
  try {
    const edited = fallbacks(() => workerHeadroomTiming(NOW, undefined, root));
    assert.deepEqual(edited.lines, []);
    assert.notDeepEqual(edited.value.policy, buildDefaultHeadroomPolicy(), "a reviewed curve edit reaches the worker");
    assert.equal(edited.value.policy[0]?.limitPct, 77);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14754 an unloadable checkout policy still falls back to the default headroom curve", () => {
  const root = checkoutWith(() => "headroom: [this is not a policy\n");
  try {
    const broken = fallbacks(() => workerHeadroomTiming(NOW, undefined, root));
    assert.deepEqual(broken.value, { nowMs: NOW, policy: buildDefaultHeadroomPolicy() });
    assert.equal(broken.lines.length, 1, "the fallback says so on stderr");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
