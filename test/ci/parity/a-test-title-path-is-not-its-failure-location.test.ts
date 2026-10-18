import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ciFailureLedgerEntry, ciFailureSignature, ciFrictionCauseKey, ciFrictionRoundsFromLedger,
  gitCiFrictionOwnerSearch, RED_WITH_NO_FAILING_TEST,
} from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "#src/lib/ci-friction-remedy.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const MENTIONED = "test/classify.test.ts";
const ACTUAL = "test/mutation-trigger-covers-its-own-command.test.ts";
// Literal title/location pair from PR12703's CI6 log, not a guessed source owner.
const TITLE = "W1-T108/R-42: positive control -- the real command really does name more than test/classify.test.ts";
const HEAD = "abc123456789012345678901234567890123456789";
const tap = (title = TITLE, file = ACTUAL, extra: readonly string[] = []) => [
  `# Subtest: ${title}`, `not ok 1 - ${title}`, "  ---", "  duration_ms: 1.18911",
  "  type: 'test'", `  location: '/home/runner/work/remudero/remudero/${file}:1:1759'`,
  "  failureType: 'testCodeFailure'", ...extra, "  ...",
].join("\n");
const unknown = (text: string) => {
  const signature = ciFailureSignature(text);
  assert.equal(typeof signature, "string", "a reported failure is not a passing/absent result");
  assert.match(signature!, /unknown|unavailable|ambiguous/i, "missing binding is explicit");
  assert.doesNotMatch(signature!, /test\/[\w./-]+\.test\.[mc]?[jt]s/, "no title path can become an owner hint");
  return signature!;
};
const rows = (entry: ReturnType<typeof ciFailureLedgerEntry>): LedgerRecord[] => [
  { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 12703, head_sha: HEAD, ts: "2026-10-18T07:47:00Z" },
  { step: "fix.dispatch", run_id: "DAEMON-1", mode: "ci-log", round: "resume", head_sha: HEAD,
    elapsed_ms: 600_000, ci_failures: [entry], ts: "2026-10-18T07:49:00Z" },
] as LedgerRecord[];

function ownerFixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "failure-location-owner" });
  // Fixture imports resolve within the disposable repository, independent of this suite's folder.
  const importSource = (file: string, target: string) => `import ${JSON.stringify(posix.relative(posix.dirname(file), target))};\n`;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put(ACTUAL, readFileSync(new URL("../../mutation-trigger-covers-its-own-command.test.ts", import.meta.url), "utf8"));
  put("scripts/mutation-ratchet.mjs", readFileSync(new URL("../../../scripts/mutation-ratchet.mjs", import.meta.url), "utf8"));
  put(MENTIONED, importSource(MENTIONED, "src/lib/classify.js"));
  put("src/lib/classify.ts", "export const classify = () => true;\n");
  put("test/real-product.test.ts", importSource("test/real-product.test.ts", "src/lib/real-product.js"));
  put("src/lib/real-product.ts", "export const product = () => true;\n");
  put(".github/workflows/ci.yml", "jobs:\n  test:\n    name: ci-shard\n");
  repo.git("add", "."); repo.git("commit", "-qm", "fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo, put, search: gitCiFrictionOwnerSearch(args => repo.git(...args)) };
}

test("a title path cannot override the same failure diagnostic location", () => {
  for (const title of [TITLE, "a neutral title", `a title quotes '${MENTIONED}' and another path test/elsewhere.test.ts`]) {
    assert.equal(ciFailureSignature(tap(title)), ACTUAL, title);
  }
});

test("runner location survives the actual friction ledger and cause consumers", t => {
  const f = ownerFixture(t);
  for (const title of [TITLE, "a neutral title"]) {
    const entry = ciFailureLedgerEntry({ name: "ci-shard (6/8)", logTail: tap(title), tailSource: "log" });
    const input = rows(entry), before = structuredClone(input);
    const [round] = ciFrictionRoundsFromLedger(input);
    assert.equal(entry.signature, ACTUAL);
    assert.deepEqual(entry.tests, [title]);
    assert.equal(entry.tail_source, "log");
    assert.match(entry.excerpt!, /location:/);
    assert.equal(round!.cause.name, `test:${ACTUAL}`);
    assert.equal(round!.minutes, 10);
    assert.deepEqual(round!.evidence![0]!.tests, [title]);
    const owner = locateCiFrictionOwner(ciFrictionCauseKey(round!.cause), [round!.detail!], f.search);
    assert.equal(owner?.failingTest, ACTUAL);
    assert.ok(owner?.files.includes(ACTUAL));
    assert.ok(!owner?.files.includes("src/lib/classify.ts"), "a configuration census is not a classify implementation failure");
    assert.deepEqual(input, before, "pricing and ownership never rewrite the original receipt");
  }
});

test("ambiguous runner locations retain unknown evidence without guessed owners", t => {
  const f = ownerFixture(t);
  const cases = [
    tap(TITLE, ACTUAL, [`  location: '/workspace/test/conflicting.test.ts:9:1'`]),
    tap().replace(/  location:.*\n/, ""),
    tap().replace(/  \.\.\.$/, ""),
    `not ok 1 - ${TITLE}\n# Subtest: next\nok 2 - test/passing.test.ts\n  ---\n  location: '/workspace/test/passing.test.ts:2:1'\n  ...`,
  ];
  for (const text of cases) {
    unknown(text);
    const entry = ciFailureLedgerEntry({ name: "ci-shard (6/8)", logTail: text, tailSource: "log" });
    const [round] = ciFrictionRoundsFromLedger(rows(entry));
    assert.ok(!round!.cause.name.startsWith("test:"));
    const owner = locateCiFrictionOwner(ciFrictionCauseKey(round!.cause), [round!.detail!], f.search);
    assert.equal(owner?.failingTest, undefined, "round.detail must not launder the title into a failing-test claim");
    assert.ok(!owner?.files.includes("src/lib/classify.ts"));
    assert.ok(entry.tests.includes(TITLE), "the original title stays evidence, not authority");
  }
});

test("failure location attribution is load-bearing without rewriting history", () => {
  const old = ciFailureLedgerEntry({ name: "ci-shard (6/8)", logTail: "not ok 1 - test/legacy.test.ts", tailSource: "log" });
  old.signature = MENTIONED;
  old.tests = [TITLE];
  const history = rows(old), before = JSON.stringify(history);
  Object.freeze(old.tests); Object.freeze(old); Object.freeze(history[1]!.ci_failures); Object.freeze(history[1]);
  const legacyRounds = ciFrictionRoundsFromLedger(history);
  assert.equal(legacyRounds[0]!.cause.name, `test:${MENTIONED}`, "legacy bytes are not retroactively certified or rewritten");
  const current = ciFailureLedgerEntry({ name: "ci-shard (6/8)", logTail: tap(), tailSource: "log" });
  assert.equal(current.signature, ACTUAL, "deleting the actual correction must fail this assertion");
  assert.equal(JSON.stringify(history), before);
});

test("a known direct-source owner remains independently discoverable", t => {
  const f = ownerFixture(t);
  const [round] = ciFrictionRoundsFromLedger(rows(ciFailureLedgerEntry({ name: "ci-shard (6/8)",
    logTail: tap(TITLE, "test/real-product.test.ts") })));
  const owner = locateCiFrictionOwner(ciFrictionCauseKey(round!.cause), [round!.detail!], f.search);
  assert.deepEqual(owner?.files, ["src/lib/real-product.ts", "test/real-product.test.ts"]);
});

test("a first failure never borrows a neighboring failure's diagnostic or title path", () => {
  unknown([`not ok 1 - ${TITLE}`, "# Subtest: later", tap("later", "test/later.test.ts")].join("\n"));
  unknown([`not ok 1 - ${TITLE}`, "ok 2 - passing", "  ---", "  location: '/workspace/test/passing.test.ts:8:1'", "  ..."].join("\n"));
});

test("assertion values and error-message paths are not runner locations", () => {
  const diagnostic = ["  error: |-", `    expected '${MENTIONED}'`, `    location: '/workspace/test/forged.test.ts:3:1'`,
    `  expected: '${MENTIONED}'`, "  actual: 'test/actual-value.test.ts'"];
  assert.equal(ciFailureSignature(tap("neutral", ACTUAL, diagnostic)), ACTUAL);
  unknown(tap(TITLE, ACTUAL, diagnostic).replace(/  location:.*\n/, ""));
});

test("nested TAP chooses the leaf's own location, not the later parent wrapper", () => {
  const child = tap().split("\n").map(l => "    " + l).join("\n");
  const text = ["# Subtest: suite", child, "    1..1", "not ok 1 - suite", "  ---",
    "  location: '/workspace/test/parent.test.ts:1:1'", "  failureType: 'subtestsFailed'", "  ..."].join("\n");
  assert.equal(ciFailureSignature(text), ACTUAL);
});

test("quoted, absolute and file-URL locations retain the same repository test path", () => {
  for (const location of [`'file:///workspace/${ACTUAL}:9:1'`, `"/workspace/${ACTUAL}:9:1"`, `${ACTUAL}:9:1`]) {
    assert.equal(ciFailureSignature(tap().replace(/'\/home\/runner\/work\/remudero\/remudero\/.*:1:1759'/, location)), ACTUAL);
  }
});

test("actual file-wrapper failures and legacy direct stack frames remain supported", () => {
  assert.equal(ciFailureSignature("not ok 2 - test/wrapper.test.ts"), "test/wrapper.test.ts");
  assert.equal(ciFailureSignature("not ok 2 - '/workspace/test/wrapper.test.ts'"), "test/wrapper.test.ts");
  const frame = "    at TestContext.<anonymous> (file:///workspace/test/stack.test.ts:88:3)";
  assert.equal(ciFailureSignature("not ok 7 - buildSweepHook builds once\n" + frame), "test/stack.test.ts");
  assert.equal(ciFailureSignature("not ok 7 - buildSweepHook builds once"), "buildSweepHook builds once");
});

test("spec's repeated failure summary binds its test-at header to that same title", () => {
  const spec = (title: string) => [`✖ ${title} (1.23ms)`, "ℹ tests 1", "ℹ fail 1", "✖ failing tests:", "",
    `test at /workspace/${ACTUAL}:1:1759`, `✖ ${title} (1.23ms)`, "  AssertionError: deliberate fixture failure"].join("\n");
  assert.equal(ciFailureSignature(spec(TITLE)), ACTUAL);
  assert.equal(ciFailureSignature(spec("neutral")), ACTUAL);
  unknown(spec(TITLE) + `\n\ntest at /workspace/test/other.test.ts:3:1\n✖ ${TITLE} (1.23ms)\n  AssertionError: another`);
});

test("healthy TAP and timestamped passing output never supply a failure location", () => {
  for (const prefix of ["", "coverage-shard (6/8)\tTest\t2026-10-18T07:48:13.456Z "]) {
    const text = ["# Subtest: healthy", "ok 1 - healthy", `# expected error mentions ${MENTIONED}`,
      `# 2026-10-18T07:48:13.456Z not ok 1 - ${MENTIONED}`, "# tests 1", "# pass 1", "# fail 0"].map(l => prefix + l).join("\n");
    assert.equal(ciFailureSignature(text), RED_WITH_NO_FAILING_TEST);
  }
  const prefixed = tap().split("\n").map(l => `ci-shard\tTest\t2026-10-18T07:48:13.456Z ${l}`).join("\n");
  assert.equal(ciFailureSignature(prefixed), ACTUAL);
});

test("real pinned Node TAP and spec reporter diagnostics defeat the misleading title", t => {
  const f = gitRepo({ scope: t, kind: "failure-location-native-reporter" });
  const file = join(f.dir, "test", "runner-fixture.test.mjs");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';\ntest(${JSON.stringify(TITLE)},()=>assert.equal('actual','expected'));\n`);
  for (const reporter of ["tap", "spec"]) {
    const r = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, "--test-concurrency=1", file],
      { cwd: f.dir, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" } });
    assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 1, "the controlled child really failed");
    assert.match(r.stdout, /runner-fixture\.test\.mjs/);
    assert.equal(ciFailureSignature(r.stdout), "test/runner-fixture.test.mjs", `${reporter}: ${r.stdout}`);
  }
});

test("a real failing file wrapper is not attributed to a path in its exception", t => {
  const f = gitRepo({ scope: t, kind: "failure-location-native-wrapper" });
  const file = join(f.dir, "test", "wrapper-fixture.test.mjs");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `throw new Error(${JSON.stringify("not the owner " + MENTIONED)});\n`);
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { cwd: f.dir, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" } });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 1);
  assert.equal(ciFailureSignature(r.stdout), "test/wrapper-fixture.test.mjs");
});

test("malformed, traversing and non-test diagnostic locations remain unknown", () => {
  for (const location of ["'test/../other.test.ts:3:1'", "'test/./other.test.ts:3:1'", "'test/other.test.ts:0:1'",
    "'/workspace/src/product.ts:3:1'", "'file://foreign/test/other.test.ts:3:1'", "'test/other.test.ts:3:1"]) {
    unknown(tap().replace(/  location:.*\n/, `  location: ${location}\n`));
  }
  assert.equal(ciFailureSignature(tap().replace(/  location:.*\n/, "  location: '/test/root.test.ts:3:1'\n")), "test/root.test.ts");
  unknown(tap().replace("  ---", "    ---"));
  unknown(tap().replace("  ...", "    ..."));
});

test("only a complete same-failure stack can supply a missing TAP location", () => {
  const frame = "    TestContext.<anonymous> (file:///workspace/test/stack.test.ts:8:3)";
  const base = tap().replace(/  location:.*\n/, "");
  const own = base.replace("  ...", `  stack: |-\n${frame}\n    at file:///workspace/test/stack.test.ts:9:3\n  ...`);
  assert.equal(ciFailureSignature(own), "test/stack.test.ts");
  unknown(own.replace("test/stack.test.ts:9:3", "test/different.test.ts:9:3"));
  unknown(base.replace("  ...", `  error: |-\n${frame}\n  expected: 'irrelevant'\n  ...`));
  unknown(`not ok 1 - ${TITLE}\n${frame}\n    at file:///workspace/test/different.test.ts:9:3`);
  unknown(`not ok 1 - ${TITLE}\n  AssertionError: title path\n${frame}`);
});

test("spec headers require the same repeated title and a valid unambiguous location", () => {
  const spec = [`✖ neutral (1ms)`, "✖ failing tests:", "test at /workspace/test/a.test.ts:2:1", "✖ neutral (1ms)"].join("\n");
  assert.equal(ciFailureSignature(spec), "test/a.test.ts");
  for (const text of [spec.replace("✖ neutral (1ms)\n✖ failing", "✖ different (1ms)\n✖ failing"),
    spec.replace("test/a.test.ts:2:1", "src/a.ts:2:1"), spec.replace(/\n✖ neutral \(1ms\)$/, ""),
    spec + "\ntest at /workspace/test/b.test.ts:2:1\n✖ neutral (1ms)"]) unknown(text);
  assert.equal(ciFailureSignature("✖ test/wrapper.test.ts (1ms)"), "test/wrapper.test.ts");
  assert.equal(ciFailureSignature("✖ neutral (1ms)"), "neutral", "legacy bare names remain non-file signatures");
});

test("printed reporter notices cannot become failures and pool attribution uses the same bound block", () => {
  assert.equal(ciFailureSignature("ok 1 - healthy\n# COVERAGE-REPORT-FAILED: deliberately printed\n# tests 1\n# fail 0"), RED_WITH_NO_FAILING_TEST);
  const pool = "\npure-test-pool: the pool of 2 file(s) failed\npure-test-pool: every pooled file passes isolated";
  assert.equal(ciFailureSignature(tap() + pool), `pool failure: ${ACTUAL} fails pooled, passes isolated`);
  const missing = tap().replace(/  location:.*\n/, "") + pool;
  assert.match(ciFailureSignature(missing)!, /^pool failure: unknown runner failure location /);
  assert.doesNotMatch(ciFailureSignature(missing)!, /test\/classify/);
  assert.equal(ciFailureSignature("# tests 0\n# fail 0"), RED_WITH_NO_FAILING_TEST);
});
