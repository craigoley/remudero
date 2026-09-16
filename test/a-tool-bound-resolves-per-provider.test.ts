/**
 * `resolveDispatchLaneToolBound` — THE SAME LANE, THE EQUIVALENT CAPABILITY PER PROVIDER (W1-T3656).
 *
 * WHY THIS FILE EXISTS. `OPENWEIGHT_CHECKS` shipped six entries and W1-T3572's ruling asked for
 * exactly that surface, but `grep -rn '"RunCheck"' src/` outside the adapter returned ZERO on
 * origin/main: the check-runner was built, merged and dead. The cause was a type mismatch —
 * Claude implements `Bash` and no `RunCheck`; the open-weight adapter implements `RunCheck` and
 * THROWS on a declared `Bash` — so a lane with ONE FLAT LIST is pinned to whichever provider that
 * list happens to fit. recon's `Bash` was honest and therefore pinned it to the subscription.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPATCH_LANE_TOOL_BOUNDS, resolveDispatchLaneToolBound } from "../src/lib/worker.js";
import { OPENWEIGHT_FUNCTIONS } from "../src/lib/worker-provider.js";
import { renderReconPrompt } from "../src/lib/prompt-render.js";

test("a command-running lane resolves Bash on claude and RunCheck on openweight", () => {
  const claude = resolveDispatchLaneToolBound("recon", "claude");
  const openweight = resolveDispatchLaneToolBound("recon", "openweight");

  assert.ok(claude.includes("Bash"), "recon still declares Bash on Claude — W1-T3616's honesty guard");
  assert.ok(!claude.includes("RunCheck"), "Claude has no RunCheck tool, so declaring it would be a lie");

  assert.ok(openweight.includes("RunCheck"), "openweight gets the allowlisted check-runner instead");
  assert.ok(!openweight.includes("Bash"), "openweight REFUSES a declared Bash, so it must not appear");

  // NOT A NARROWING: the read surface is IDENTICAL on both, only the command tool differs. If this
  // were W1-T3616's forbidden narrowing the open-weight list would be strictly smaller in kind.
  const readOnly = (t: readonly string[]) => t.filter((x) => x !== "Bash" && x !== "RunCheck");
  assert.deepEqual(readOnly(openweight), readOnly(claude), "only the command tool may differ between providers");
});

test("every openweight lane bound is a subset of what the adapter implements", () => {
  // THE CENSUS THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. A lane declaring a tool the adapter does
  // not implement does not fail here today — it throws at SPAWN, in production, on the first
  // routed run. Asserting it at test time is what makes routing a lane safe to decide.
  const lanes = Object.entries(DISPATCH_LANE_TOOL_BOUNDS);
  assert.ok(lanes.length > 0, "control: there must be lanes to census");

  let censused = 0;
  for (const [lane, byProvider] of lanes) {
    const ow = (byProvider as { openweight?: readonly string[] }).openweight;
    if (ow === undefined) continue; // Claude-only by ruling — alert_fix commits and pushes.
    censused += 1;
    for (const tool of ow) {
      assert.ok(
        OPENWEIGHT_FUNCTIONS[tool] !== undefined,
        `${lane} declares '${tool}' for openweight, which the adapter does not implement — the spawn would throw`,
      );
    }
  }
  // POSITIVE CONTROL: if no lane declared an openweight bound the loop above would be vacuous and
  // would keep passing after someone added an unimplemented tool.
  assert.ok(censused > 0, "at least one lane must declare an openweight bound, or this census proves nothing");
});

test("an unknown provider refuses rather than inheriting a default bound", () => {
  // FAIL CLOSED ON THE PROVIDER AXIS, the same contract the lane axis already carries. Borrowing
  // another provider's list would route a lane whose surface the adapter cannot honour; borrowing
  // a SMALLER one would be W1-T3616's narrowing by the back door.
  assert.throws(() => resolveDispatchLaneToolBound("recon", "codex"), /declares no tool bound for provider/);
  assert.throws(() => resolveDispatchLaneToolBound("recon", ""), /declares no tool bound for provider/);

  // alert_fix is the LIVE example: it commits and pushes, which the check-runner deliberately
  // cannot do, so it has no openweight entry and must refuse rather than be quietly routed.
  assert.throws(() => resolveDispatchLaneToolBound("alert_fix", "openweight"), /declares no tool bound for provider/);
  assert.ok(resolveDispatchLaneToolBound("alert_fix", "claude").includes("Bash"), "but it still resolves on Claude");

  // An unknown LANE still refuses too — the original W1-T3616 contract is unchanged.
  assert.throws(() => resolveDispatchLaneToolBound("not-a-lane", "claude"), /no declared tool bound for dispatch lane/);
});

test("the recon prompt names no shell binary", () => {
  // The prompt used to say "git remote -v, git log --oneline -5, ls" — three shell commands BY
  // NAME, which a worker holding run_check cannot follow literally. It now names what to OBSERVE.
  const prompt = renderReconPrompt("PLAN INDEX", "", { id: "W1-T1", title: "a task" }, "plan/x.yaml");

  const shellish = prompt.match(/\bgit (remote|log|status|diff)\b|\bls\b|\bbash\b/g) ?? [];
  assert.deepEqual(shellish, [], `the prompt must not name a shell binary, found: ${shellish.join(", ")}`);

  // And it must still ask for the SAME observations, or this is a narrowing dressed as neutrality.
  assert.match(prompt, /remote/i, "it must still ask for the remote");
  assert.match(prompt, /recent commit history/i, "and recent history");
  assert.match(prompt, /working tree/i, "and the shape of the tree");
  assert.match(prompt, /do not assume a shell/i, "and must say not to assume a shell");
});
