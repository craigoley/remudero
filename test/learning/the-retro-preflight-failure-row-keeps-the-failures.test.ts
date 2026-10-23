import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RETRO_PREFLIGHT_CAPTURE_BYTES, runRetroPrepublishPreflight } from "#src/lib/retro-preflight.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

async function retained(t: TestContext, stdout: string, stderr = "", error?: Error) {
  const { dir } = ownedFixtureDir(t, "retro-failing-excerpt");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  let attempts = 0;
  const result = await runRetroPrepublishPreflight({
    worktreePath: dir,
    provenance: { provider: "codex", model: "frontier", effort: "high", sessionId: "excerpt-fixture" },
    remotePrExisted: false,
    repair: async (prompt) => { prompts.push(prompt); },
    regenerateHarnessArtifacts: () => {},
    log: (step, extra) => { rows.push({ step, extra }); },
    deps: {
      changedFiles: async () => ({ unreadable: "fixture deliberately exercises broad selection" }),
      run: (_command, args) => args.includes("--list-plan-reading-suites")
        ? { status: 0, signal: null, stdout: "test/plan.test.ts\n", stderr: "" }
        : ++attempts === 1
          ? { status: 1, signal: null, stdout, stderr, ...(error ? { error } : {}) }
          : { status: 0, signal: null, stdout: "# tests 1\n# pass 1\n", stderr: "" },
      testSlot: { dir: join(dir, "slots"), slots: 1,
        load: () => ({ cores: 8, load1: 0 }), memoryHeadroom: () => undefined,
        binaryExists: () => false, log: () => {} },
    },
  });
  const failure = rows.find((row) => row.step === "retro.preflight_failed")!.extra;
  const out = String(failure.stdout_excerpt), err = String(failure.stderr_excerpt);
  assert.ok(Buffer.byteLength(out) + Buffer.byteLength(err) <= RETRO_PREFLIGHT_CAPTURE_BYTES);
  return { result, rows, prompts, failure, out, err };
}

const prelude = "# successful passing suite\n".repeat(12_000);
const block = (n: number, name: string, detail = `distinct-error-${name}`) =>
  `not ok ${n} - ${name}\n  ---\n  failureType: testCodeFailure\n  error: '${detail}'\n  stack: |-\n    stack-${name}\n  ...\n`;
const summary = "1..5\n# tests 5\n# pass 3\n# fail 2\n# cancelled 0\n# skipped 0\n# todo 0\n";

test("W1-T10298: the preflight excerpt keeps the failing blocks and the tail, not the first passing suites", async (t) => {
  const { out, prompts, failure, result } = await retained(t,
    prelude + block(2, "first-late-error") + prelude + block(4, "second-late-error") + prelude + summary);
  for (const name of ["first-late-error", "second-late-error"]) {
    assert.ok(out.includes(block(name === "first-late-error" ? 2 : 4, name)));
    assert.ok(prompts[0].includes(`distinct-error-${name}`));
  }
  assert.ok(out.endsWith(summary));
  assert.equal(failure.output_truncated, true);
  assert.deepEqual(failure.failing_tests, ["first-late-error", "second-late-error"]);
  assert.equal(result.repaired, true);
});

test("W1-T10298: an oversized failing block is cut with a marker inside the excerpt budget", async (t) => {
  const huge = block(2, "oversized", "large-error " + "x".repeat(40_000));
  const { out, prompts } = await retained(t, prelude + huge + block(4, "later-small") + summary);
  assert.match(out, /not ok 2 - oversized/);
  assert.match(out, /large-error/);
  assert.match(out, /\[\.\.\. failure block omitted \.\.\.\]/);
  assert.match(out, /distinct-error-later-small/);
  assert.ok(out.endsWith(summary));
  assert.match(prompts[0], /large-error/);
});

test("retro excerpt shares the unchanged stderr budget and excludes cancelled blocks", async (t) => {
  const cancelled = "not ok 1 - cancelled-only\n  ---\n  failureType: cancelledByParent\n  ...\n";
  const { out, err, prompts, failure } = await retained(t, cancelled + prelude + block(2, "stdout-error") + summary,
    prelude + block(3, "stderr-error") + summary);
  assert.match(out, /distinct-error-stdout-error/);
  assert.match(err, /distinct-error-stderr-error/);
  assert.ok(Buffer.byteLength(err) <= Math.floor(RETRO_PREFLIGHT_CAPTURE_BYTES / 3));
  assert.doesNotMatch(out, /cancelled-only/);
  assert.deepEqual(failure.cancelled_tests, ["cancelled-only"]);
  assert.match(prompts[0], /distinct-error-stderr-error/);
});

test("retro excerpt preserves small output and bound stand-down without repair", async (t) => {
  const stdout = block(1, "ordinary");
  const { out, err, prompts, failure, result } = await retained(t, stdout, "short stderr",
    Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }));
  assert.equal(out, stdout);
  assert.equal(err, "short stderr");
  assert.equal(failure.output_truncated, false);
  assert.equal(failure.exit_class, "process_timeout");
  assert.deepEqual(prompts, []);
  assert.deepEqual(result, { ok: false, attempts: 1, suiteCount: 1, repaired: false });
});

test("retro excerpt keeps UTF-8 boundaries for failure blocks and a no-assertion fallback", async (t) => {
  const a = await retained(t, prelude + block(1, "unicode", "🙂".repeat(20_000)) + summary, "stderr");
  assert.doesNotMatch(a.out + a.err, /\uFFFD/);
  assert.match(a.out, /not ok 1 - unicode/);
  const b = await retained(t, "🙂".repeat(RETRO_PREFLIGHT_CAPTURE_BYTES), "err",
    Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }));
  assert.doesNotMatch(b.out + b.err, /\uFFFD/);
  assert.deepEqual(b.prompts, []);
});

test("retro excerpt retains every bounded named failure before the summary", async (t) => {
  const names = Array.from({ length: 20 }, (_, i) => `failure-${i}`);
  const { out, failure } = await retained(t, prelude + names.map((name, i) => block(i + 1, name)).join("") + summary);
  assert.deepEqual(failure.failing_tests, names);
  for (const name of names) assert.ok(out.includes(`distinct-error-${name}`));
  assert.ok(out.endsWith(summary));
});

test("retro excerpt deduplicates repeated names and retains bounded long-name evidence", async (t) => {
  const longName = "long-name-" + "x".repeat(400);
  const { out, failure } = await retained(t, prelude + block(1, "repeated") + block(1, "repeated") + block(2, longName) + summary);
  assert.deepEqual(failure.failing_tests, ["repeated", longName.slice(0, 300)]);
  assert.equal([...out.matchAll(/^not ok 1 - repeated$/gm)].length, 1);
  assert.ok(out.includes(`distinct-error-${longName}`));
  assert.ok(out.endsWith(summary));
});

test("retro excerpt trims an oversized untrusted UTF-8 summary without splitting characters", async (t) => {
  const comment = `# duration_ms ${"🙂".repeat(700)}\n`;
  const { out } = await retained(t, prelude + block(1, "summary-unicode") + comment + summary);
  assert.match(out, /distinct-error-summary-unicode/);
  assert.doesNotMatch(out, /\uFFFD/);
  assert.ok(out.endsWith(summary));
});

test("retro excerpt never aliases a cancelled prefix sibling and keeps byte-capped UTF-8 names", async (t) => {
  const name = "é".repeat(149) + "🙂-long-name";
  const cancelled = "not ok 1 - prefix-cancelled\n  ---\n  failureType: cancelledByParent\n  ...\n";
  const { out, failure } = await retained(t, cancelled + prelude + block(2, "prefix") + block(3, name) + summary);
  assert.deepEqual(failure.failing_tests, ["prefix", Buffer.from(name).subarray(0, 300).toString("utf8")]);
  assert.doesNotMatch(out, /prefix-cancelled/);
  assert.match(out, /distinct-error-prefix/);
  assert.ok(out.includes(`distinct-error-${name}`));
});

test("retro excerpt never shortens complete failing blocks that fit together", async (t) => {
  const large = block(1, "large-but-fitting", "x".repeat(12_000));
  const small = block(2, "small-and-fitting");
  const { out } = await retained(t, prelude + large + small + summary);
  assert.ok(out.includes(large));
  assert.ok(out.includes(small));
  assert.doesNotMatch(out, /failure block omitted/);
  assert.ok(out.endsWith(summary));
});
