import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURED_STDERR_HEADING, captureConsoleError } from "./helpers/captured-console.js";

// W1-T2812 — the falsifier for "a suppressed-stderr red cannot name its own reason".
//
// The bar is RETENTION, not capture: a test asserting the buffer is non-empty proves
// the stub works and says nothing about whether a FAILING assertion surfaces that
// buffer to whoever reads the run. Every test below therefore breaks an expectation
// on purpose and reads the message the reader would actually get.

/** The reason a subject prints and a black-hole stub throws away. */
const REASON = "wipe-test refused: --repo remudero is not a sandbox repository";

/** Run `fn`, expect it to throw, and hand back the message a reader would see. */
function messageFromFailure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the assertion to fail, but it passed — this falsifier proves nothing if it cannot fail");
}

test("a failing assertion names the reason the subject printed, instead of only a bare disagreement", () => {
  const cap = captureConsoleError();
  console.error(REASON);
  cap.restore();

  const message = messageFromFailure(() => cap.explains(() => assert.equal(1, 2)));

  assert.ok(message.includes(REASON), `the red must carry the subject's own explanation; got:\n${message}`);
  assert.ok(message.includes(CAPTURED_STDERR_HEADING), `the captured block must be labelled; got:\n${message}`);
});

test("the augmented message keeps node's own generated value disagreement, so the reason costs no diff", () => {
  const cap = captureConsoleError();
  console.error(REASON);
  cap.restore();

  const bare = messageFromFailure(() => assert.equal(1, 2));
  const augmented = messageFromFailure(() => cap.explains(() => assert.equal(1, 2)));

  // Every line node generated for the bare failure must survive in the augmented one.
  for (const line of bare.split("\n").filter((l) => l.trim() !== "")) {
    assert.ok(augmented.includes(line), `augmenting dropped node's own text ${JSON.stringify(line)}; got:\n${augmented}`);
  }
  assert.ok(augmented.includes(REASON), "and it must still carry the reason");
  assert.ok(augmented.length > bare.length, "the augmented message must add to the bare one, never replace it");
});

test("a passing assertion prints nothing at all and returns its value, so suppression still holds", () => {
  const writes: string[] = [];
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const realOutWrite = process.stdout.write.bind(process.stdout);
  let returned: string | undefined;

  process.stderr.write = ((c: unknown) => { writes.push(String(c)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((c: unknown) => { writes.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    const cap = captureConsoleError();
    console.error(REASON);
    console.error("a second line the subject printed");
    cap.restore();
    returned = cap.explains(() => {
      assert.equal(2, 2);
      return "the assertion's own value";
    });
  } finally {
    process.stderr.write = realErrWrite;
    process.stdout.write = realOutWrite;
  }

  assert.deepEqual(writes, [], `a green run must gain no output; it wrote:\n${writes.join("")}`);
  assert.equal(returned, "the assertion's own value", "explains must be transparent to a passing assertion");
});

test("deleting the dump loses the reason and returns the bare numeric failure", () => {
  const cap = captureConsoleError();
  console.error(REASON);
  cap.restore();

  // The identical assertion, once through the dump and once with the dump DELETED.
  const withDump = messageFromFailure(() => cap.explains(() => assert.equal(1, 2)));
  const withoutDump = messageFromFailure(() => assert.equal(1, 2));

  assert.ok(withDump.includes(REASON), "with the dump, the red names the reason");
  assert.ok(!withoutDump.includes(REASON), `without it the reason must be GONE; got:\n${withoutDump}`);
  assert.ok(!withoutDump.includes(CAPTURED_STDERR_HEADING), "and no captured block should appear");
  assert.ok(withoutDump.includes("1 !== 2"), `the bare failure is the numeric disagreement alone; got:\n${withoutDump}`);
});

test("the capture suppresses during its window and restores the real console.error after it", () => {
  const before = console.error;
  const cap = captureConsoleError();

  assert.notEqual(console.error, before, "console.error must be stubbed inside the window");
  console.error(REASON);
  assert.deepEqual([...cap.lines], [REASON], "the subject's line is retained rather than discarded");

  cap.restore();
  assert.equal(console.error, before, "the real console.error must be back");
  cap.restore();
  assert.equal(console.error, before, "restore must be idempotent");
});
