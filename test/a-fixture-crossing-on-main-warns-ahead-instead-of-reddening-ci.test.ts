import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// W1-T5826 — A FIXTURE CROSSING ON MAIN WARNS AHEAD INSTEAD OF REDDENING CI.
//
// LIVE 2026-10-05: ci-shard 1's push-to-main lane went red at 13b9379c because an untouched stamp
// (test/auto-merge-blocked-codeql-review-thread.test.ts:166) came within 7 days of sweep.staleDays.
// No push planted it -- the calendar did -- yet the strict main reading (W1-T3655) charged it to
// main, and the daemon held plan-scoped rounds on the red base until #9259 hot-fixed it. The
// operator's design (2026-10-05) reverses that for crossings no push planted: the main lane now
// attributes each crossing against the push's parent, exactly as the PR lane does against its base.
//
// `scripts/**` sits OUTSIDE tsconfig's `include`, so the REAL module is loaded through a dynamic
// specifier, as test/the-census-watches-its-own-base.test.ts does.
const REPO_ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = joinPath(REPO_ROOT, "scripts", "expiring-fixture-census.mjs");
const CI_YAML_PATH = joinPath(REPO_ROOT, ".github", "workflows", "ci.yml");

const { CENSUS_MAIN_BRANCH_RUN, emitCiReport, main } = (await import(pathToFileURL(SCRIPT).href)) as {
  CENSUS_MAIN_BRANCH_RUN: string;
  emitCiReport: (
    tool: string,
    report: string,
    opts: {
      blocked: boolean;
      warnings?: Array<{ file: string; line: number; field: string; threshold: string; stamp: string; expiresAt: number }>;
      env?: NodeJS.ProcessEnv;
      log?: (line: string) => void;
      append?: (path: string, text: string) => void;
    },
  ) => boolean;
  main: (o?: {
    execFile?: (cmd: string, args: string[], opts: { encoding: "utf8" }) => string;
    readFile?: (p: string) => string;
    now?: () => number;
    log?: (message: string) => void;
    assertAged?: () => void;
    assertComplete?: () => void;
    recordedPopulationByFile?: Record<string, number>;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    append?: (path: string, text: string) => void;
  }) => number;
};

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-05T06:00:00Z");
const THRESHOLD = 14;
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const FILE = "test/a.test.ts";
/** Line 2 of the fixture file: inside the 7-day margin, goes red 2026-10-06. */
const CROSSING_STAMP = at(-13 * DAY);
const CROSSING_FILE = `// fixture\n  lastActivityAt: "${CROSSING_STAMP}",\n`;
const CROSSING_DAY = new Date(Date.parse(CROSSING_STAMP) + THRESHOLD * DAY).toISOString().slice(0, 10);

/** The main lane exactly as ci.yml invokes it: the flag, the CI-report opt-in, and the parent. */
const MAIN_LANE = { [CENSUS_MAIN_BRANCH_RUN]: "1", RMD_CI_REPORT: "1", GITHUB_STEP_SUMMARY: "/summary.md" };
const PARENT_ARGV = ["--base", "HEAD^"];

/** `main`'s git/node seams. `parent` is what `git show HEAD^:<path>` returns (undefined = absent);
 *  `parentReadable: false` makes the `HEAD^` probe fail the way a root commit or shallow clone does. */
function seams(parent: string | undefined, { parentReadable = true } = {}) {
  const calls: string[] = [];
  const execFile = (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "node") return JSON.stringify({ staleDays: THRESHOLD });
    if (args[0] === "ls-files") return `${FILE}\n`;
    if (args[0] === "rev-parse") {
      if (!parentReadable || args[2] !== "HEAD^^{commit}") throw new Error("fatal: Needed a single revision");
      return "c0ffee\n";
    }
    if (args[0] === "show") {
      if (args[1] !== `HEAD^:${FILE}` || parent === undefined) throw new Error(`fatal: path does not exist: ${args[1]}`);
      return parent;
    }
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
  return { execFile, calls };
}

function runMainLane(parent: string | undefined, opts: { parentReadable?: boolean; recorded?: Record<string, number>; current?: string } = {}) {
  const { execFile, calls } = seams(parent, opts);
  const output: string[] = [];
  const summary: string[] = [];
  const code = main({
    execFile,
    readFile: () => opts.current ?? CROSSING_FILE,
    now: () => NOW,
    log: (m) => output.push(m),
    assertAged: () => undefined,
    assertComplete: () => undefined,
    recordedPopulationByFile: opts.recorded ?? { [FILE]: 1 },
    argv: PARENT_ARGV,
    env: MAIN_LANE,
    append: (_path, text) => summary.push(text),
  });
  return { code, output, summary, calls };
}

test("W1-T5826: an inherited crossing on the main lane exits 0 with a warning naming file, line, threshold and crossing date", () => {
  const { code, output, summary, calls } = runMainLane(CROSSING_FILE);

  assert.equal(code, 0, "a crossing already on the push's parent is the calendar's, not this push's -- main stays green");
  assert.ok(calls.includes(`git show HEAD^:${FILE}`), "the main lane attributes against the push's parent, never origin/main");
  assert.ok(!calls.some((c) => c.includes("origin/main")), "origin/main IS the commit under test on this lane");

  const warnings = output.filter((l) => l.startsWith("::warning "));
  assert.equal(warnings.length, 1, `exactly one warning annotation per inherited crossing, got: ${JSON.stringify(output)}`);
  const warning = warnings[0]!;
  assert.ok(warning.startsWith(`::warning file=${FILE},line=2,`), `the annotation is anchored to the file and line: ${warning}`);
  assert.match(warning, /test\/a\.test\.ts:2/, "the message names file:line");
  assert.match(warning, /sweep\.staleDays/, "the message names the threshold");
  assert.ok(warning.includes(`goes red ${CROSSING_DAY}`), `the message names the crossing date ${CROSSING_DAY}: ${warning}`);
  assert.ok(!output.some((l) => l.startsWith("::error")), "an inherited-only run publishes no error annotation");

  const text = summary.join("");
  assert.ok(text.includes(`${FILE}:2`) && text.includes(`goes red ${CROSSING_DAY}`), "the step summary carries the warning line too");
  assert.match(text, /sweep\.staleDays/);
});

test("W1-T5826: a crossing introduced or moved by the pushed commit exits non-zero on the main lane", () => {
  const absent = runMainLane(undefined);
  assert.equal(absent.code, 1, "a stamp in a file the parent lacks was planted by this push");

  const moved = runMainLane(`// fixture\n  lastActivityAt: "${at(-400 * DAY)}",\n`);
  assert.equal(moved.code, 1, "a stamp this push moved into the margin is this push's");
  assert.match(moved.output.join("\n"), /BLOCKED -- 1 fixture/);
  assert.ok(moved.output.some((l) => l.startsWith("::error ")), "a blocking push still publishes its error annotation");
  assert.ok(!moved.output.some((l) => l.startsWith("::warning ")), "a charged crossing is not downgraded to a warning");
});

test("W1-T5826: a population drop still blocks the main lane even when every crossing is inherited", () => {
  const { code, output } = runMainLane(CROSSING_FILE, { recorded: { [FILE]: 1, "test/gone.test.ts": 2 } });
  assert.equal(code, 1, "a fixture moved behind a helper is not a calendar event");
  assert.match(output.join("\n"), /dropped below the recorded fixture population/);
});

test("W1-T5826: an unreadable HEAD^ keeps the main lane strict", () => {
  const { code, output } = runMainLane(CROSSING_FILE, { parentReadable: false });
  assert.equal(code, 1, "no readable parent means no evidence the crossing was inherited -- it blocks, as before");
  assert.doesNotMatch(output.join("\n"), /inherited from the base/);
  assert.ok(!output.some((l) => l.startsWith("::warning ")));
});

test("W1-T5826: the main lane without an explicit parent stays strict and never probes a base", () => {
  const { execFile, calls } = seams(CROSSING_FILE);
  const code = main({
    execFile,
    readFile: () => CROSSING_FILE,
    now: () => NOW,
    log: () => undefined,
    assertAged: () => undefined,
    assertComplete: () => undefined,
    recordedPopulationByFile: { [FILE]: 1 },
    env: { [CENSUS_MAIN_BRANCH_RUN]: "1" },
  });
  assert.equal(code, 1);
  assert.ok(!calls.some((c) => c.startsWith("git rev-parse") || c.startsWith("git show")));
});

test("W1-T5826: warnings are emitted only behind the CI-report opt-in", () => {
  const logged: string[] = [];
  const warning = { file: FILE, line: 2, field: "lastActivityAt", threshold: "sweep.staleDays", stamp: CROSSING_STAMP, expiresAt: NOW + DAY };
  const emitted = emitCiReport("expiring-fixture-census", "report", { blocked: false, warnings: [warning], env: {}, log: (l) => logged.push(l) });
  assert.equal(emitted, false);
  assert.deepEqual(logged, [], "a local or nested run never manufactures an annotation");
});

test("W1-T5826: ci.yml's main lane passes the push's parent to the fixture-date check", () => {
  const doc = parseYaml(readFileSync(CI_YAML_PATH, "utf8")) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
  const script = (doc.jobs.ci?.steps ?? []).find((s) => s.name === "Test")?.run ?? "";
  const guardIndex = script.search(/\$\{GITHUB_EVENT_NAME\}"\s*=\s*"push"/);
  const invocation = /CENSUS_MAIN_BRANCH_RUN=1[^\n]*node scripts\/expiring-fixture-census\.mjs --base HEAD\^/.exec(script);
  assert.ok(invocation, "the push lane must hand the census its parent commit as the base to attribute against");
  assert.ok(guardIndex >= 0 && invocation!.index > guardIndex, "and only behind the push-only guard");
});
