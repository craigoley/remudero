import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The cost came from a test asserting the pre-W1-T9060 verdict ('resolved') for a rung whose
// shared measurement is unmeasurable. The assertion now expects 'measuring'; this guard runs
// that exact test through a real node --test child so a regression to the old verdict (or an
// ordering/clock dependence) fails here with the child's output, not as a surprise fix round.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

test("W1-T9832: check:test:test/the-flow-gardener-files-a-remedy-for-the-costliest-unowned-blocker.test.ts:flaky is prevented, not retried", () => {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    "--test-name-pattern", "real process seams",
    "test/the-flow-gardener-files-a-remedy-for-the-costliest-unowned-blocker.test.ts"], { encoding: "utf8", timeout: 120_000, env: childEnv });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# tests 1$/m);
  assert.match(r.stdout, /^# pass 1$/m);
  assert.match(r.stdout, /^# fail 0$/m);
});
