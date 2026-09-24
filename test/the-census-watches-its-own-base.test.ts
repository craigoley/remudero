import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// W1-T3655 — THE CENSUS WATCHES ITS OWN BASE.
//
// MEASURED 2026-09-16: three `lastActivityAt` stamps in
// test/an-open-pr-does-not-rot-while-it-waits.test.ts crossed the census's 7-day margin on clean
// origin/main. Within ninety minutes six open pull requests were red on it -- #5725, #5733, #5734,
// #5736, #5738, #5739 -- every one with byte-identical output and no diff of its own involved. THE
// GATE CANNOT SEE MAIN: `expiring-fixture-census` only ever ran inside `comment-load-ratchet`, a
// `pull_request`-only job (W1-T1033), so the one branch that OWNS the fixture is the one branch the
// census never read.
//
// `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC import of the .mjs is a TS7016 and
// fails typecheck -- the same reason test/expiring-fixture-census.test.ts loads it this way. A
// dynamic specifier is not statically resolved, so this loads the REAL module with no shadow copy
// that could drift from it.
const REPO_ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = joinPath(REPO_ROOT, "scripts", "expiring-fixture-census.mjs");
const CI_YAML_PATH = joinPath(REPO_ROOT, ".github", "workflows", "ci.yml");

const { CENSUS_MAIN_BRANCH_RUN, main } = (await import(pathToFileURL(SCRIPT).href)) as {
  CENSUS_MAIN_BRANCH_RUN: string;
  main: (o?: {
    execFile?: (cmd: string, args: string[], opts: { encoding: "utf8" }) => string;
    readFile?: (p: string) => string;
    now?: () => number;
    log?: (message: string) => void;
    assertAged?: () => void;
    recordedPopulationByFile?: Record<string, number>;
    baseRefOverride?: string;
    env?: NodeJS.ProcessEnv;
  }) => number;
};

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-16T09:00:00Z");
const THRESHOLD = 14;
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

/** A stamp inside the census's 7-day margin -- the exact shape MEASURED 2026-09-16 in the
 *  rationale: three of these on origin/main took six open PRs red within ninety minutes. */
const CROSSING_LINE = `  lastActivityAt: "${at(-13 * DAY)}",\n`;

/** `main`'s three CLI seams (`git ls-files`, the policy loader `node`, and the base-ref probe),
 *  wired the way `test/expiring-fixture-census.test.ts` wires them, with per-arg overrides for the
 *  base-probe half so each test only has to state what it needs to. */
function seamExecFile(over: Partial<Record<string, () => string>> = {}) {
  return (cmd: string, args: string[]) => {
    if (cmd === "node") return JSON.stringify({ staleDays: THRESHOLD });
    const handler = over[args[0] ?? ""];
    if (handler) return handler();
    if (args[0] === "ls-files") return "test/a.test.ts\n";
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

// ── acceptance 1 & falsifier half A: the base's own run goes red for a stamp sitting on main ────

test("W1-T3655: on the base's own run, a stamp inside the margin blocks -- the run that owns main goes red", () => {
  const output: string[] = [];
  const code = main({
    execFile: seamExecFile(),
    readFile: () => CROSSING_LINE,
    now: () => NOW,
    log: (m) => output.push(m),
    assertAged: () => undefined,
    recordedPopulationByFile: { "test/a.test.ts": 1 },
    env: { [CENSUS_MAIN_BRANCH_RUN]: "1" },
  });

  assert.equal(code, 1, "the base's own run must go red for a stamp crossing on main itself");
  assert.match(output.join("\n"), /BLOCKED -- 1 fixture/);
  assert.doesNotMatch(output.join("\n"), /inherited from the base/, "main has no earlier base to inherit a crossing from");
});

test("W1-T3655: CENSUS_MAIN_BRANCH_RUN skips the base probe entirely -- an explicit flag decides the arm, not a rev-parse that could coincidentally match HEAD", () => {
  const calls: string[] = [];
  main({
    execFile: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return seamExecFile({
        "rev-parse": () => "deadbeef\n",
        show: () => CROSSING_LINE, // if this were ever read it would (wrongly) look inherited
      })(cmd, args);
    },
    readFile: () => CROSSING_LINE,
    now: () => NOW,
    log: () => undefined,
    assertAged: () => undefined,
    recordedPopulationByFile: { "test/a.test.ts": 1 },
    env: { [CENSUS_MAIN_BRANCH_RUN]: "1" },
  });

  assert.ok(
    !calls.some((c) => c.startsWith("git rev-parse") || c.startsWith("git show")),
    "the strict arm must not even ask whether a base is readable -- CENSUS_MAIN_BRANCH_RUN decides it up front",
  );
});

// ── falsifier half B, verbatim: "Point the base ref at the commit under test and the strict- ────
// reading arm must refuse, or a main run excuses its own bomb."

test("W1-T3655 falsifier: a base ref that resolves to the commit under test still refuses, never excuses", () => {
  // Without CENSUS_MAIN_BRANCH_RUN, a base ref that happens to equal HEAD -- exactly the shape a
  // push-triggered checkout produces, since `origin/main` IS the commit just pushed -- would read
  // its OWN fixture back as "the base" and mark every crossing inherited. This is the arm the
  // task's design calls "the one most likely to be got wrong, since it fails open and looks green."
  const output: string[] = [];
  const code = main({
    execFile: seamExecFile({
      "rev-parse": () => "deadbeef\n",
      show: () => CROSSING_LINE, // the "base" IS this diff -- byte-identical content, same stamp
    }),
    readFile: () => CROSSING_LINE,
    now: () => NOW,
    log: (m) => output.push(m),
    assertAged: () => undefined,
    recordedPopulationByFile: { "test/a.test.ts": 1 },
    env: { [CENSUS_MAIN_BRANCH_RUN]: "1" },
  });

  assert.equal(code, 1, "the base-equals-HEAD case must still refuse -- CENSUS_MAIN_BRANCH_RUN overrides the probe, not merely races it");
});

// ── acceptance 3 & falsifier half C: an inherited crossing is reported but no longer blocks ─────

test("W1-T3655: an inherited crossing is reported and NAMED, but no longer decides the pull request's exit code", () => {
  // Reconstructs the falsifier's PR side: "a PR that touches nothing near it... must go green with
  // the crossing NAMED."
  const output: string[] = [];
  const code = main({
    execFile: seamExecFile({
      "rev-parse": () => "deadbeef\n",
      show: () => CROSSING_LINE, // the SAME stamp already sits on origin/main
    }),
    readFile: () => CROSSING_LINE,
    now: () => NOW,
    log: (m) => output.push(m),
    assertAged: () => undefined,
    recordedPopulationByFile: { "test/a.test.ts": 1 },
    env: {}, // an ordinary pull_request run -- no CENSUS_MAIN_BRANCH_RUN
  });

  assert.equal(code, 0, "a PR that touches nothing near the crossing must go green");
  assert.match(output.join("\n"), /goes red/, "the crossing must still be NAMED, never hidden");
  assert.match(output.join("\n"), /inherited from the base -- NOT this diff/);
});

test("W1-T3655: a crossing this diff itself introduces still blocks, even with a base reader present", () => {
  const output: string[] = [];
  const code = main({
    execFile: seamExecFile({
      "rev-parse": () => "deadbeef\n",
      show: () => `  lastActivityAt: "${at(-400 * DAY)}",\n`, // a DIFFERENT, already-expired stamp
    }),
    readFile: () => CROSSING_LINE,
    now: () => NOW,
    log: (m) => output.push(m),
    assertAged: () => undefined,
    recordedPopulationByFile: { "test/a.test.ts": 1 },
    env: {},
  });

  assert.equal(code, 1, "a crossing this diff planted itself is still charged to it, not excused by an unrelated base stamp");
});

// ── the workflow half: a run that owns main actually exists ──────────────────────────────────
//
// Falsifier, verbatim: "Then delete the base run and the second assertion must fail -- that is the
// arm that turns this from attribution into an excuse." This is that second assertion: it reads
// the REAL ci.yml, so removing (or event-ungating) the push-lane invocation this task adds is
// exactly the mutation that turns it red.

test("W1-T3655: ci.yml's push-to-main lane actually invokes the census, strictly, behind the push guard", () => {
  const raw = readFileSync(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as {
    jobs: Record<string, { if?: string; steps?: Array<{ name?: string; run?: string }> }>;
  };

  const ci = doc.jobs.ci;
  assert.ok(ci, "ci.yml must still declare the `ci` job");
  assert.equal(ci!.if, undefined, "the `ci` job must stay ungated -- it is the one job that runs on a push to main (test/push-ci-on-main.test.ts pins this too)");

  const testStep = (ci!.steps ?? []).find((s) => s.name === "Test");
  assert.ok(testStep?.run, "the `ci` job must carry a Test step");
  const script = testStep!.run!;

  assert.match(
    script,
    /CENSUS_MAIN_BRANCH_RUN=1[^\n]*node scripts\/expiring-fixture-census\.mjs/,
    "the push lane must run the census with CENSUS_MAIN_BRANCH_RUN set -- the strict arm, not an ordinary base-attributed read",
  );

  // The census invocation must sit behind the SAME push-only guard the pre-existing main-ceiling
  // gates (learnings-budget-ratchet, claude-md-budget-ratchet, comment-load-signal, W1-T3068)
  // already use, never run unconditionally on a pull_request event too.
  const guardIndex = script.search(/\$\{GITHUB_EVENT_NAME\}"\s*=\s*"push"/);
  const censusIndex = script.indexOf("CENSUS_MAIN_BRANCH_RUN=1");
  assert.ok(guardIndex >= 0, "the push-only guard must still be present");
  assert.ok(censusIndex > guardIndex, "the census invocation must sit inside (after) the push-only guard");

  // Sanity: comment-load-ratchet's own PR-side step must stay untouched -- W1-T1033's job-level
  // guard there stays exactly PR-only (test/fast-lane-classifier.test.ts pins the literal string),
  // so the ONLY route for the census to see a push is the one this test reads.
  //
  // W1-T4399: comment-load-ratchet's real PR-side work now runs as a step of the `commitlint`
  // job (its own ci.yml job key stays registered but permanently skipped, if: false), so the
  // PR-only guard is read off `commitlint` instead.
  const ratchetJob = doc.jobs["commitlint"];
  assert.equal(
    ratchetJob?.if,
    "github.event_name == 'pull_request'",
    "commitlint (comment-load-ratchet's new home) must stay PR-only -- the census reaches main through `ci`, not by relaxing this job",
  );
});

test("W1-T3655: CENSUS_MAIN_BRANCH_RUN is a marker the source actually checks, not just a name in a comment", () => {
  const raw = readFileSync(joinPath(REPO_ROOT, "scripts", "expiring-fixture-census.mjs"), "utf8");
  assert.match(raw, /export const CENSUS_MAIN_BRANCH_RUN/, "grep proof: the constant must be present in the census script");
  assert.match(raw, /env\[CENSUS_MAIN_BRANCH_RUN\]/, "and it must actually gate the base probe, not merely be exported and unread");
});
