/**
 * THE PRE-PUSH CENSUS PRECHECK RUNS THE ADMITTED CENSUS SUITES — W1-T5617.
 *
 * `CENSUS_ADMITTED_MEMBERS` (src/lib/ci-parity.ts) names seven suites measured under the fast-gate
 * census bound, and only `rmd preflight` ran them — which no worker has run since W1-T464. So
 * hooks/pre-push passed diffs these suites refuse in CI (#8961 #8970 #9066 #9077 #9079).
 * scripts/census-precheck.mjs now runs every admitted suite whose `walks` population the diff joins,
 * once, in one child, and names each failing suite with its npm script.
 *
 * The pure cases drive `evaluateAdmittedCensusSuites` with injected members and runners. The
 * real-shell-out cases run the default child over a fixture repository holding a small census of
 * its own, and the default member listing over this repository's own table.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CENSUS_ADMITTED_MEMBERS } from "../src/lib/ci-parity.js";
import { censusPushRefusal } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { unwrapLowPriority } from "../src/lib/test-slot.js";
import { gitRepo } from "./helpers/git-repo.js";
// A NAMESPACE import, so a tree without these exports fails each test below rather than the load.
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Member = { testFile: string; script: string; walks: string[] };
type Found = { violations: string[]; unmeasured: string | null };
type RunResult = { status?: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };

const BOUNDS: Member = { testFile: "test/bounds-census.test.ts", script: "census:bounds", walks: ["src/"] };
const WORKFLOWS: Member = { testFile: "test/workflow-census.test.ts", script: "census:workflow", walks: ["src/", ".github/"] };
const TESTS: Member = { testFile: "test/test-census.test.ts", script: "census:test", walks: ["test/"] };

function evaluate(changed: string[], members: Member[], runSuites: (files: string[]) => string[]): Found {
  return precheck.evaluateAdmittedCensusSuites({ changed, loadMembers: () => members, runSuites }) as Found;
}

const TAP_HEAD = "TAP version 13\n";
const tapSummary = (tests: number, fail: number) => `1..${tests}\n# tests ${tests}\n# pass ${tests - fail}\n# fail ${fail}\n`;
const notOk = (n: number, name: string, location: string) =>
  `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  duration_ms: 1\n  location: '${location}:3:1'\n  error: 'boom'\n  ...\n`;
const ok = (n: number, name: string) => `# Subtest: ${name}\nok ${n} - ${name}\n  ---\n  duration_ms: 1\n  ...\n`;

/** Runs the child seam over an injected spawn result, capturing what it was asked to spawn. */
function viaChild(result: RunResult, files = [BOUNDS.testFile, TESTS.testFile]) {
  const calls: { cmd: string; args: string[]; opts: { cwd: string; timeout: number; env: Record<string, string | undefined> } }[] = [];
  const failing = () =>
    precheck.runCensusSuitesViaChild({
      root: "/repo",
      files,
      run: (cmd: string, args: string[], opts: never) => {
        calls.push({ cmd, args, opts });
        return result;
      },
    }) as string[];
  return { failing, calls };
}

test("W1-T5617: a diff that grows a census-admitted suite's population is refused with the suite and its npm script named", () => {
  const ran: string[][] = [];
  const found = evaluate(["src/lib/a.ts", "plan/x.yaml"], [BOUNDS, WORKFLOWS, TESTS], (files) => {
    ran.push(files);
    return [BOUNDS.testFile];
  });
  assert.deepEqual(ran, [[BOUNDS.testFile, WORKFLOWS.testFile]], "ONE child, for exactly the suites whose walks the diff joins");
  assert.equal(found.unmeasured, null);
  assert.deepEqual(found.violations, [`census-suite: ${BOUNDS.testFile} fails — run npm run census:bounds`]);
  // The row keeps the shape src/run-task.ts censusPushRefusal reads, so a fix round sees the census.
  const header = "census-precheck: this branch grows 1 census count(s) CI will refuse:";
  assert.deepEqual(censusPushRefusal(new Error(`${header}\n  ${found.violations[0]}`))?.censuses, ["census-suite"]);
  // Control: the same diff with every selected suite passing is clean.
  assert.deepEqual(evaluate(["src/lib/a.ts"], [BOUNDS, WORKFLOWS, TESTS], () => []), { violations: [], unmeasured: null });
});

test("W1-T5617: an untouched population starts no child", () => {
  let runs = 0;
  let loads = 0;
  const runSuites = (files: string[]) => {
    runs++;
    return files;
  };
  // W1-T5693: a plan/tasks.d shard now joins the citation-anchor census, so it is no longer an untouched path.
  const found = evaluate(["plan/x.yaml", "docs/src/readme.md", "DECISIONS.md"], [BOUNDS, WORKFLOWS, TESTS], runSuites);
  assert.deepEqual(found, { violations: [], unmeasured: null });
  assert.equal(runs, 0, "no suite runs for a diff no admitted suite walks");
  // An empty diff does not even read the admission table.
  const empty = precheck.evaluateAdmittedCensusSuites({
    changed: [],
    loadMembers: () => {
      loads++;
      return [BOUNDS];
    },
    runSuites,
  }) as Found;
  assert.deepEqual(empty, { violations: [], unmeasured: null });
  assert.deepEqual([loads, runs], [0, 0]);
  // Control: a joined population IS run through the same seam.
  assert.equal(evaluate([".github/workflows/ci.yml"], [BOUNDS, WORKFLOWS], runSuites).violations.length, 1);
  assert.equal(runs, 1);
});

test("W1-T5617: a child that cannot finish reads as not measured, never as a clean tree", () => {
  const cases: [RunResult, RegExp][] = [
    [{ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }) }, /could not run to completion: spawnSync node ETIMEDOUT/],
    [{ status: null, signal: "SIGKILL", stdout: TAP_HEAD }, /ended by SIGKILL/],
    [{ status: 1, stdout: TAP_HEAD, stderr: "Could not find '/repo/test/x.test.ts'" }, /no `# tests` summary/],
    [{ status: 0, stdout: TAP_HEAD + tapSummary(0, 0) }, /ran 0 tests/],
    [{ status: 1, stdout: TAP_HEAD + ok(1, "a") + tapSummary(1, 0) }, /exited 1 but its TAP names no failing suite/],
    [{ status: 1, stdout: TAP_HEAD + notOk(1, "a", "/elsewhere/test/other.test.ts") + tapSummary(1, 1) }, /attributes to no suite it was given/],
  ];
  for (const [result, reason] of cases) {
    assert.throws(viaChild(result).failing, reason);
    const found = evaluate(["src/a.ts"], [BOUNDS], viaChild(result).failing);
    assert.deepEqual(found.violations, [], String(reason));
    assert.match(found.unmeasured ?? "", reason);
  }
  // An admission table that cannot be read is not measured either, and an empty one is not a clean set.
  const unreadable = precheck.evaluateAdmittedCensusSuites({
    changed: ["src/a.ts"],
    loadMembers: () => {
      throw new Error("the table child exited 1");
    },
    runSuites: () => [],
  }) as Found;
  assert.deepEqual(unreadable, { violations: [], unmeasured: "the table child exited 1" });
});

test("W1-T5617: the child reads each failing suite from its TAP, top-level only, and spawns with GIT_* stripped and a bound", () => {
  const prior = { GIT_DIR: process.env.GIT_DIR, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, RMD_SELF_SYNC_DONE: process.env.RMD_SELF_SYNC_DONE };
  process.env.GIT_DIR = "/somewhere/.git";
  process.env.RMD_SELF_SYNC_DONE = "1";
  try {
    const tap =
      TAP_HEAD +
      ok(1, "a passing test") +
      notOk(2, "a failing test", `/repo/${BOUNDS.testFile}`) +
      // A nested failure is indented; only its top-level parent names the suite.
      `# Subtest: parent\n    not ok 1 - child\n      ---\n      location: '/repo/${TESTS.testFile}:9:1'\n      ...\n` +
      `ok 3 - parent\n  ---\n  duration_ms: 1\n  ...\n` +
      notOk(4, BOUNDS.testFile, `/repo/${BOUNDS.testFile}`) +
      tapSummary(4, 2);
    const { failing, calls } = viaChild({ status: 1, stdout: tap });
    assert.deepEqual(failing(), [BOUNDS.testFile]);
    const [wrapped] = calls;
    // W1-T6090: the child starts niced with an explicit concurrency; unwrap to read the node argv itself.
    const inner = wrapped && unwrapLowPriority(wrapped.cmd, wrapped.args);
    const call = wrapped && inner && { cmd: inner.file, args: inner.args.filter((a) => !a.startsWith("--test-concurrency=")), opts: wrapped.opts };
    assert.equal(call?.cmd, process.execPath);
    assert.deepEqual(call?.args.slice(0, 2), ["--test", "--test-reporter=tap"]);
    assert.deepEqual(call?.args.slice(-2), [BOUNDS.testFile, TESTS.testFile]);
    assert.ok(call?.args.some((a) => a.endsWith("test/setup/tmp-hygiene.ts")), call?.args.join(" "));
    assert.equal(call?.opts.cwd, "/repo");
    assert.equal(call?.opts.timeout, 60_000);
    assert.equal(call?.opts.env.GIT_DIR, undefined, "a hook's GIT_DIR never reaches the suites");
    assert.equal(call?.opts.env.NODE_TEST_CONTEXT, undefined, "a parent runner's context never reformats the child's TAP");
    assert.equal(call?.opts.env.RMD_SELF_SYNC_DONE, undefined, "the lanes' read-only escape never makes the setup refuse");
    assert.equal(call?.opts.env.PATH, process.env.PATH);
    // Control: a passing run reads no failure.
    assert.deepEqual(viaChild({ status: 0, stdout: TAP_HEAD + ok(1, "a") + tapSummary(1, 0) }).failing(), []);
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/** A census of the fixture's own, over its own `lib/` population: every `_MS` constant must declare BACKSTOP. */
const FIXTURE_MEMBER: Member = { testFile: "test/bounds-census.test.ts", script: "census:bounds", walks: ["lib/"] };
const FIXTURE_CENSUS = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { readFileSync } from "node:fs";',
  'test("every bound declares its kind", () => {',
  '  const lines = readFileSync("lib/bounds.ts", "utf8").split("\\n").filter((l) => /_MS =/.test(l));',
  '  assert.deepEqual(lines.filter((l) => !l.includes("BACKSTOP")), []);',
  "});",
  "",
].join("\n");
const DECLARED = "export const A_MS = 1; // BACKSTOP\n";

/** A fixture repo whose `work` branch commits `change` over a base carrying the fixture census. */
function fixtureRepo(change: Record<string, string>): string {
  const repo = gitRepo({ kind: "admitted-census-suites" });
  const write = (tree: Record<string, string>) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
  };
  write({ [FIXTURE_MEMBER.testFile]: FIXTURE_CENSUS, "lib/bounds.ts": DECLARED });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  write(change);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  return repo.dir;
}

function capture(t: { mock: { method: (o: object, k: string, f: (...a: unknown[]) => void) => unknown } }) {
  const err: string[] = [];
  const out: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  return { err, out };
}

test("W1-T5617: the CLI on a real fixture repository runs the real suite child — refuses a grown population, passes a clean one", (t) => {
  const io = capture(t);
  const admitted = () => [FIXTURE_MEMBER];
  const grown = fixtureRepo({ "lib/bounds.ts": `${DECLARED}export const B_MS = 2;\n` });
  assert.equal(precheck.main(["--root", grown, "--base", "main"], { admitted }), 1, io.err.join("\n"));
  assert.ok(io.err.includes(`  census-suite: ${FIXTURE_MEMBER.testFile} fails — run npm run census:bounds`), io.err.join("\n"));
  assert.deepEqual(censusPushRefusal(new Error(io.err.join("\n")))?.censuses, ["census-suite"]);
  io.err.length = 0;
  const clean = fixtureRepo({ "lib/bounds.ts": `${DECLARED}export const B_MS = 2; // BACKSTOP\n` });
  assert.equal(precheck.main(["--root", clean, "--base", "main"], { admitted }), 0, io.err.join("\n"));
  assert.ok(io.out.some((l) => /^census-precheck: OK/.test(l)), io.out.join("\n"));
});

test("W1-T5617: a suite child stopped on its bound makes the CLI exit 2, never 0 and never an OK line", (t) => {
  const io = capture(t);
  const repo = fixtureRepo({ "lib/bounds.ts": `${DECLARED}export const B_MS = 2; // BACKSTOP\n` });
  const timedOut = () => {
    throw new Error("the census suite child could not run to completion: spawnSync node ETIMEDOUT");
  };
  assert.equal(precheck.main(["--root", repo, "--base", "main"], { admitted: () => [FIXTURE_MEMBER], runSuites: timedOut }), 2);
  assert.ok(io.err.some((l) => /^census-precheck: census suites NOT MEASURED - .*ETIMEDOUT$/.test(l)), io.err.join("\n"));
  assert.ok(!io.out.some((l) => /census-precheck: OK/.test(l)), "never an OK line");
});

test("W1-T5617: the default listing reads this repository's admission table, and a tree without one has no admitted suites", () => {
  const listed = precheck.listAdmittedCensusMembers(ROOT) as Member[];
  assert.deepEqual(
    listed,
    CENSUS_ADMITTED_MEMBERS.map((m) => ({ testFile: m.testFile, script: m.script, walks: [...(m.walks ?? [])] })),
  );
  assert.ok(listed.length >= 7, `the table must be read, saw ${listed.length}`);
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}admitted-census-no-table-`));
  assert.deepEqual(precheck.listAdmittedCensusMembers(bare), []);
  // A table the child cannot list, or lists as something other than members, is not measured.
  assert.throws(() => precheck.listAdmittedCensusMembers(ROOT, () => ({ status: 1, stdout: "", stderr: "boom" })), /exited 1: boom/);
  assert.throws(() => precheck.listAdmittedCensusMembers(ROOT, () => ({ status: 0, stdout: "[]" })), /no admitted member/);
  assert.throws(() => precheck.listAdmittedCensusMembers(ROOT, () => ({ status: 0, stdout: '[{"testFile":1}]' })), /not a list of/);
  assert.throws(() => precheck.listAdmittedCensusMembers(ROOT, () => ({ status: 0, stdout: "nope" })), /not JSON/);
  assert.throws(() => precheck.listAdmittedCensusMembers(ROOT, () => ({ status: null, signal: "SIGKILL" })), /ended by SIGKILL/);
});

test("W1-T5617: every admitted suite is run by census-precheck under its own npm script, and has left the CI-only baseline", () => {
  const parity = precheck.PRECHECK_PARITY as Record<string, { run?: string }>;
  const runs = Object.entries(parity)
    .filter(([, e]) => typeof e.run === "string")
    .map(([testFile, e]) => [testFile, e.run]);
  // W1-T5692: the literal-triggered suites are run under their own npm scripts too. Along with explicitly
  // registered extras, these are the only run entries beyond the admitted members.
  const triggered = precheck.PRECHECK_TRIGGERED_SUITES as { testFile: string; script: string }[];
  const additional = precheck.PRECHECK_ADDITIONAL_RUNS as { testFile: string; script: string }[];
  const expected = [...CENSUS_ADMITTED_MEMBERS, ...triggered, ...additional].map((m) => [m.testFile, m.script]);
  assert.deepEqual(runs.sort(), expected.sort());
  const baseline = (JSON.parse(readFileSync(join(ROOT, precheck.PRECHECK_PARITY_BASELINE), "utf8")) as { ciOnly: string[] }).ciOnly;
  assert.ok(baseline.length > 0, "the baseline must be read");
  for (const m of [...CENSUS_ADMITTED_MEMBERS, ...triggered, ...additional]) {
    assert.ok(!baseline.includes(m.testFile), `${m.testFile} is run, so it is not CI-only`);
  }
});
