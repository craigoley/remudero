// W1-T10762: a test file that a REAL nested `node --test` runner starts, under a parent holding the only slot of a
// private RMD_TEST_SLOT_DIR, inherits that live ancestor's claim instead of polling it until `wait_bound_exceeded`
// (45 minutes by default). #10197's guarantee stands: inside a test file, a claim on any OTHER slot directory, or one
// that fails a holder check, is never adopted and stays silent, so a fixture never borrows a real author's lease.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { acquireTestSlot, TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV, type TestSlotLease } from "#src/lib/test-slot.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A few seconds: a child that polls instead of inheriting reports `wait_bound_exceeded` inside the test's budget. */
const CHILD_WAIT_BOUND_MS = 3_000;
const TEST_SLOT_URL = pathToFileURL(join(REPO_ROOT, "src/lib/test-slot.ts")).href;

interface Observed {
  outcome: string;
  waitedMs: number;
  note: string;
  context: string | null;
  logs: { step: string; reason?: string }[];
}

function fixtureRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-nested-slot-10762-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** This process takes the only slot of `dir`, exactly as the parent in the operator's repro did. */
function holdOnlySlot(dir: string): { lease: TestSlotLease; claim: string; record: () => string } {
  const lease = acquireTestSlot("e5-parent", { dir, slots: 1, waitBoundMs: 0, log: () => {} });
  assert.equal(lease.outcome, "acquired", lease.note);
  const claim = lease.childEnvironment?.[TEST_SLOT_PARENT_ENV];
  assert.ok(claim, "the parent's lease names a claim its descendants may present");
  return { lease, claim, record: () => readFileSync(JSON.parse(claim).path, "utf8") };
}

/**
 * Starts a REAL nested `node --test` runner over one test file that acquires a slot in each of `dirs`, in order, and
 * returns what each acquisition observed. The runner, not this test, gives the file its NODE_TEST_CONTEXT.
 */
function nestedTestFile(root: string, slotEnvironment: Record<string, string>, dirs: string[]): Observed[] {
  const file = join(root, "nested.test.mjs"), out = join(root, "observed.json");
  rmSync(out, { force: true });
  writeFileSync(file, `
    import { writeFileSync } from "node:fs";
    import { test } from "node:test";
    import { acquireTestSlot } from ${JSON.stringify(TEST_SLOT_URL)};
    test("takes a slot from inside a node --test file", () => {
      const observed = ${JSON.stringify(dirs)}.map((dir) => {
        const logs = [];
        const lease = acquireTestSlot("e5-child", { dir, slots: 1, waitBoundMs: ${CHILD_WAIT_BOUND_MS}, pollMs: 100,
          log: (line) => logs.push(JSON.parse(line)) });
        lease.release();
        return { outcome: lease.outcome, waitedMs: lease.waitedMs, note: lease.note, logs,
          context: process.env.NODE_TEST_CONTEXT ?? null };
      });
      writeFileSync(${JSON.stringify(out)}, JSON.stringify(observed));
    });
  `);
  // A nested runner: its own NODE_TEST_CONTEXT, and no share of this process's coverage session.
  const env: NodeJS.ProcessEnv = { ...process.env, ...slotEnvironment, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined };
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", file],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^# pass 1$/m, "the nested runner really ran the file");
  assert.match(run.stdout, /^# fail 0$/m);
  const observed = JSON.parse(readFileSync(out, "utf8")) as Observed[];
  for (const seen of observed) assert.ok(seen.context, "each acquisition ran inside a node --test file child");
  return observed;
}

const rejectionsIn = (seen: Observed) => seen.logs.filter((row) => row.step === "test_slot.parent_rejected");

test("W1-T10762: a nested node --test child under a parent holding the only private slot inherits it without waiting", (t) => {
  const root = fixtureRoot(t);
  const dir = join(root, "slots");
  mkdirSync(dir);
  const parent = holdOnlySlot(dir);
  try {
    const before = parent.record();
    const [child] = nestedTestFile(root, { [TEST_SLOT_PARENT_ENV]: parent.claim, [TEST_SLOT_DIR_ENV]: dir }, [dir]);
    assert.equal(child!.outcome, "acquired", child!.note);
    assert.match(child!.note, /inherited live parent test slot/);
    assert.equal(child!.waitedMs, 0, "the child never polled its own parent's slot");
    assert.deepEqual(child!.logs, []);
    assert.equal(parent.record(), before, "the child's release leaves the parent's reservation untouched");
    assert.deepEqual(readdirSync(dir), ["slot-1.json"]);

    // Control: the same directory, but a claim whose nonce names no holder there, is still refused inside a test
    // file. The child polls the parent's slot to its bound, and says nothing about the claim, exactly as before.
    const forged = JSON.stringify({ ...JSON.parse(parent.claim), nonce: "not-the-holder" });
    const [control] = nestedTestFile(root, { [TEST_SLOT_PARENT_ENV]: forged, [TEST_SLOT_DIR_ENV]: dir }, [dir]);
    assert.equal(control!.outcome, "wait_bound_exceeded", control!.note);
    assert.doesNotMatch(control!.note, /inherited/);
    assert.deepEqual(rejectionsIn(control!), []);
    assert.equal(parent.record(), before);
  } finally {
    parent.lease.release();
  }
});

test("W1-T10762: a nested node --test child never inherits a claim from another slot directory", (t) => {
  const root = fixtureRoot(t);
  const claimed = join(root, "claimed"), own = join(root, "own");
  mkdirSync(claimed);
  mkdirSync(own);
  const parent = holdOnlySlot(claimed);
  try {
    const before = parent.record();
    // The live ancestor's claim names `claimed`; the child's own slot directory is `own`.
    const [onClaimed, onOwn] = nestedTestFile(root, { [TEST_SLOT_PARENT_ENV]: parent.claim, [TEST_SLOT_DIR_ENV]: own },
      [claimed, own]);
    // Asked for the claim's directory, the child still polls its holder: that directory is not its own.
    assert.equal(onClaimed!.outcome, "wait_bound_exceeded", onClaimed!.note);
    assert.doesNotMatch(onClaimed!.note, /inherited/);
    // In its own directory it takes a fresh slot of its own, never the parent's.
    assert.equal(onOwn!.outcome, "acquired", onOwn!.note);
    assert.doesNotMatch(onOwn!.note, /inherited/);
    assert.match(onOwn!.note, /host-wide test slot 1\/1/);
    for (const seen of [onClaimed!, onOwn!]) assert.deepEqual(rejectionsIn(seen), [], "a test file stays silent on a claim it cannot use");
    assert.equal(parent.record(), before, "the parent's reservation is untouched");
  } finally {
    parent.lease.release();
  }
});
