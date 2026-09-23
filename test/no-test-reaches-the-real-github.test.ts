/**
 * test/no-test-reaches-the-real-github.test.ts — proof for W1-T4119.
 *
 * `test/policy.test.ts` made a real `gh api repos/craigoley/remudero/pulls/6698/files` call — a
 * live PR number — and hung until it was killed; `test/review-command-plan-filing-provenance.test.ts`
 * (W1-T3115) was red on clean main for the same reason. The fix lives in
 * test/setup/tmp-hygiene.ts (`--import`ed by every `node --test` invocation — see its own module
 * comment): it prepends a per-process directory holding a `gh` stub onto PATH, ahead of the real
 * `gh` binary, so a test that shells out without its own stub is refused instead of reaching the
 * network.
 *
 * These tests observe the effect from OUTSIDE the setup module — actually shelling out to `gh`,
 * exactly like a production call site would — not the module's own internals. Every `node --test`
 * file this suite runs is itself started with the real `--import ./test/setup/tmp-hygiene.ts`
 * flag (see package.json's `test`/`test:ci` scripts), so by the time this file's tests run, the
 * shared stub is already on PATH — no separate child process needed to observe it.
 *
 * DISCRIMINATION. "The call threw" is NOT evidence of the shared setup: on a machine with no `gh`
 * (ENOENT) or an unauthenticated one, a bare shell-out throws WITHOUT this task's change. So each
 * claim asserts the shared stub's own refusal text — `test setup REFUSED` — which only
 * test/setup/tmp-hygiene.ts prints.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { ghShim } from "./helpers/gh-shim.js";

const LIVE_CALL = ["api", "repos/craigoley/remudero/pulls/6698/files"];
const SHARED_REFUSAL = /test setup REFUSED/;

/** Shell out to `gh` with `env`, returning its stderr on a non-zero exit (the call MUST fail). */
function refusedStderr(env: NodeJS.ProcessEnv = process.env): string {
  try {
    execFileSync("gh", LIVE_CALL, { stdio: "pipe", env });
  } catch (err) {
    return String((err as { stderr?: Buffer | string }).stderr ?? "");
  }
  return assert.fail("the shell-out to gh exited 0 — nothing refused it");
}

test("W1-T4119 claim 1: a test that shells out to gh without its own stub is refused by the shared setup", () => {
  assert.match(
    refusedStderr(),
    SHARED_REFUSAL,
    "the call must be refused BY THE SHARED SETUP's stub — not merely fail because gh is absent or unauthenticated",
  );
});

test("W1-T4119 claim 2: a test's own gh stub still takes precedence over the shared one", () => {
  // The existing convention (test/helpers/gh-shim.ts): prepend the test's own shim dir onto the
  // CURRENT PATH, which already carries the shared refusal stub installed at import time.
  const shim = ghShim([{ when: "api", stdout: "OWN-STUB-ANSWERED" }], { kind: "gh-own-stub" });
  const originalPath = process.env.PATH ?? "";
  // The shared one must really be there, behind it — otherwise "precedence over the shared one" is
  // vacuous (the own stub would simply be the only gh, as it is without this task's change).
  assert.match(refusedStderr({ ...process.env, PATH: originalPath }), SHARED_REFUSAL, "the shared refusal stub is on PATH");
  const out = execFileSync("gh", LIVE_CALL, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim.dir}:${originalPath}` },
  });
  assert.match(out, /OWN-STUB-ANSWERED/, "the test's own stub, prepended ahead of the shared one, answers first");
  assert.deepEqual(shim.calls(), [LIVE_CALL.join(" ")], "the own stub recorded exactly the one call");
});

test("W1-T4119 claim 3: the shared gh refusal names the argv it refused", () => {
  const stderr = refusedStderr();
  assert.match(stderr, /REFUSED/, "names that this is a refusal, not an ordinary failure");
  assert.match(
    stderr,
    /argv: gh api repos\/craigoley\/remudero\/pulls\/6698\/files/,
    "names the exact argv it refused, so the accidental call names itself",
  );
});
