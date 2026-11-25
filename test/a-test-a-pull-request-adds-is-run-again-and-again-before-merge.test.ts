import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// 2026-10-10: three main reds, each from a test a PR ADDED that passed the one time its PR ran it.
// scripts/flake-screen.mjs reruns every added test file before merge; these pin what it screens,
// how long, and that one failed run fails it. W1-T14633: the screen is its own `flake-screen` job,
// no longer a step of ci-shard (1/8).

const root = process.cwd();
const script = join(root, "scripts/flake-screen.mjs");
type RunResult = { ok: boolean; output: string };
type Screen = {
  addedTestFiles(base: string, opts?: { cwd?: string }): string[];
  screenBudgetMs(root?: string): number;
  jobSpentMs(startedMs: string | undefined, nowMs: number): number | undefined;
  screen(opts: { files: string[]; budgetMs: number; concurrency: number; runFile: (f: string) => Promise<RunResult>; now?: () => number }): Promise<{
    passes: Map<string, number>;
    failure?: { file: string; passesBefore: number; output: string };
  }>;
  main(argv: string[], deps?: Record<string, unknown>): Promise<number>;
};
const flake = (existsSync(script) ? await import(pathToFileURL(script).href) : {}) as Screen;

type CiStep = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type CiJob = { needs?: string[]; if?: string; "timeout-minutes"?: number; steps: CiStep[] };
/** The flake-screen job's screen step, exactly: the one screening runner (W1-T14633). */
const SCREEN_RUN = "node scripts/flake-screen.mjs --shard 1";

/** A repo whose `origin/main` holds two tests and whose HEAD adds, modifies and deletes around them. */
function addingBranch() {
  const repo = gitRepo({ kind: "flake-screen" });
  mkdirSync(join(repo.dir, "test", "helpers"), { recursive: true });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "test", "kept.test.ts"), "// kept\n");
  writeFileSync(join(repo.dir, "test", "gone.test.ts"), "// gone\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "test", "kept.test.ts"), "// kept, edited\n");
  rmSync(join(repo.dir, "test", "gone.test.ts"));
  writeFileSync(join(repo.dir, "test", "fresh.test.ts"), 'import { test } from "node:test";\ntest("fresh", () => {});\n');
  writeFileSync(join(repo.dir, "test", "helpers", "aid.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "src", "leaf.ts"), "export {};\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "pull request");
  return repo;
}

/** A clock each run advances by `stepMs`, and a runner whose `fails` set names the 1-based run of a file that fails. */
function fakeRuns(stepMs: number, fails: Record<string, number[]> = {}) {
  let clock = 0;
  const seen = new Map<string, number>();
  return {
    now: () => clock,
    runFile: async (file: string): Promise<RunResult> => {
      const n = (seen.get(file) ?? 0) + 1;
      seen.set(file, n);
      clock += stepMs;
      const bad = (fails[file] ?? []).includes(n);
      return { ok: !bad, output: bad ? `not ok 1 - ${file} run ${n}` : "ok 1" };
    },
  };
}

test("only a test file the pull request adds is screened, never a modified, deleted, helper or source file", () => {
  const repo = addingBranch();
  try {
    assert.deepEqual(flake.addedTestFiles("origin/main", { cwd: repo.dir }), ["test/fresh.test.ts"]);
    assert.throws(() => flake.addedTestFiles("origin/no-such-base", { cwd: repo.dir }), /git diff against origin\/no-such-base failed/);
  } finally {
    repo.cleanup();
  }
});

test("the screen repeats every added file until the budget is spent, and stops at the first failing run", async () => {
  const clean = fakeRuns(10);
  const spent = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 100, concurrency: 1, ...clean });
  assert.equal(spent.failure, undefined);
  assert.deepEqual([...spent.passes.values()], [5, 5], "100 ms of 10 ms runs, round-robin over two files");

  const once = fakeRuns(10);
  const zero = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 0, concurrency: 4, ...once });
  assert.deepEqual([...zero.passes.values()], [1, 1], "a spent budget still runs each file once");

  const flaky = fakeRuns(10, { "test/b.test.ts": [3] });
  const red = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 1_000, concurrency: 1, ...flaky });
  assert.deepEqual(red.failure, { file: "test/b.test.ts", passesBefore: 2, output: "not ok 1 - test/b.test.ts run 3" });
  assert.equal(red.passes.get("test/a.test.ts"), 3, "nothing new starts after a failure");
});

test("the budget is the predicted coverage makespan, never shorter than the heaviest file it packs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-flake-budget-"));
  try {
    mkdirSync(join(dir, "test"));
    mkdirSync(join(dir, "scripts"));
    const files: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(dir, "test", `f${i}.test.ts`), "");
      files[`test/f${i}.test.ts`] = 1_000;
    }
    files["test/f0.test.ts"] = 50_000;
    writeFileSync(join(dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files }));
    writeFileSync(join(dir, "scripts", "test-tier-coverage-manifest.json"), JSON.stringify({ files: { "test/f0.test.ts": 90_000 } }));
    assert.equal(flake.screenBudgetMs(dir), 90_000, "the instrumented heaviest file sets one shard's wall time");
    assert.ok(flake.screenBudgetMs(root) > 0, "the repository's own ledgers predict a real window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only shard 1 of a pull request screens, and one failed run fails it with a FLAKE-SCREEN line", async () => {
  const repo = addingBranch();
  const summary = join(repo.dir, "summary.md");
  try {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    assert.equal(await flake.main(["--shard", "1"], { env: {}, root: repo.dir, log }), 0);
    assert.match(lines.join("\n"), /no pull-request base/);
    lines.length = 0;
    assert.equal(await flake.main(["--list"], { env: {}, root: repo.dir, log }), 0);
    assert.equal(lines.length, 0, "a push lists nothing");
    const env = { GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary };
    assert.equal(await flake.main(["--list"], { env, root: repo.dir, log }), 0);
    assert.equal(lines.join("\n"), "test/fresh.test.ts");
    lines.length = 0;
    assert.equal(await flake.main(["--shard", "2"], { env, root: repo.dir, log }), 0);
    assert.match(lines.join("\n"), /shard 2 — 1 added test file\(s\); shard 1 screens them/);

    const pass = fakeRuns(10);
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, budgetMs: 50, concurrency: 1, ...pass }), 0);
    assert.match(lines.join("\n"), /test\/fresh\.test\.ts passed 5 run\(s\)/);

    const fail = fakeRuns(10, { "test/fresh.test.ts": [4] });
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, budgetMs: 1_000, concurrency: 1, ...fail }), 1);
    const flagged = "FLAKE-SCREEN: test/fresh.test.ts failed after 3 passing run(s) — a test this pull request adds is nondeterministic.";
    assert.ok(lines.includes(flagged));
    assert.equal(readFileSync(summary, "utf8"), `- ${flagged}\n`);
  } finally {
    repo.cleanup();
  }
});

test("the default runner really spawns node --test, and a really failing added file fails the screen", async () => {
  const repo = addingBranch();
  try {
    symlinkSync(join(root, "node_modules"), join(repo.dir, "node_modules"));
    mkdirSync(join(repo.dir, "test", "setup"), { recursive: true });
    writeFileSync(join(repo.dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    writeFileSync(join(repo.dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files: { "test/fresh.test.ts": 1 } }));
    const env = { GITHUB_BASE_REF: "main" };
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, concurrency: 1 }), 0, lines.join("\n"));
    assert.match(lines.join("\n"), /test\/fresh\.test\.ts passed [1-9]\d* run\(s\)/);

    writeFileSync(join(repo.dir, "test", "fresh.test.ts"), 'import { test } from "node:test";\ntest("red", () => { throw new Error("boom"); });\n');
    lines.length = 0;
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, concurrency: 1 }), 1);
    assert.match(lines.join("\n"), /not ok 1 - red[\s\S]*FLAKE-SCREEN: test\/fresh\.test\.ts failed after 0 passing run\(s\)/);
  } finally {
    repo.cleanup();
  }
});

test("the flake-screen job runs the screen after its own install, unskipped, and installs the browser an added suite may need", () => {
  const jobs = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")).jobs as Record<string, CiJob>;
  const job = jobs["flake-screen"]!;
  const at = job.steps.findIndex((s) => s.run?.trim() === SCREEN_RUN);
  assert.ok(at > job.steps.findIndex((s) => s.run?.trim() === "npm ci"), "the screen follows the job's install");
  assert.equal(job.steps[at]!.if, undefined, "a skipped screen would read as a passed one");
  const added = job.steps.find((s) => s.id === "added")!.run!;
  assert.match(added, /ADDED="\$\(node scripts\/flake-screen\.mjs --list 2>\/dev\/null \|\| echo unknown\)"/, "an unreadable list installs, fail-closed");
  assert.match(added, /if \[ -n "\$ADDED" \]; then\n\s*echo "setup=true"/);
  const browser = job.steps.find((s) => s.run?.trim() === "npx playwright install chromium")!;
  assert.equal(browser.if, "${{ steps.added.outputs.setup == 'true' }}");
});

test("the screen spends only what is left of the makespan after the job's earlier steps, and still runs each added file once", async () => {
  const repo = addingBranch();
  try {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    const runAt = (startedMs: string | undefined) => {
      const runs = fakeRuns(10);
      const env = { GITHUB_BASE_REF: "main", ...(startedMs === undefined ? {} : { RMD_JOB_STARTED_MS: startedMs }) };
      return flake.main(["--shard", "1"], { env, root: repo.dir, log, budgetMs: 50, concurrency: 1, runFile: runs.runFile, now: () => 1_000 + runs.now() });
    };
    assert.equal(await runAt("970"), 0);
    assert.match(lines.join("\n"), /less 0s this job already ran[\s\S]*test\/fresh\.test\.ts passed 2 run\(s\)/, "30 of 50 ms were spent before the screen");
    lines.length = 0;
    assert.equal(await runAt("900"), 0);
    assert.match(lines.join("\n"), /test\/fresh\.test\.ts passed 1 run\(s\)/, "a job already past the makespan still screens each added file once");
    lines.length = 0;
    assert.equal(await runAt(undefined), 0);
    assert.match(lines.join("\n"), /no RMD_JOB_STARTED_MS, so none of it is counted as spent[\s\S]*passed 5 run\(s\)/);
  } finally {
    repo.cleanup();
  }
});

test("an absent or unreadable job-start stamp reads as unknown, never as nothing spent", () => {
  for (const stamp of [undefined, "", "soon", "0", "-5"]) assert.equal(flake.jobSpentMs(stamp, 5_000), undefined, String(stamp));
  assert.equal(flake.jobSpentMs("4000", 5_000), 1_000);
  assert.equal(flake.jobSpentMs("6000", 5_000), 0, "a stamp ahead of this clock spends nothing, never a negative");
});

test("the flake-screen job stamps its start first, as a step output the screen reads", () => {
  const text = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = (parse(text).jobs as Record<string, CiJob>)["flake-screen"]!;
  const stamp = job.steps.findIndex((s) => s.id === "stamp");
  assert.equal(stamp, 0, "the window opens before checkout and install spend from it");
  assert.equal(job.steps[stamp]!.run!.trim(), `echo "started_ms=$(date +%s%3N)" >> "$GITHUB_OUTPUT"`);
  // A step OUTPUT, never GITHUB_ENV: the guard mutation replays step bodies inside a real job, and each
  // replay appended its own stamp to the job's GITHUB_ENV, so the screen read the last one (#11308).
  assert.doesNotMatch(text, /RMD_JOB_STARTED_MS=/, "no step writes the stamp where a later step can rewrite it");
  const screen = job.steps.findIndex((s) => s.run?.trim() === SCREEN_RUN);
  assert.equal(job.steps[screen]!.env?.RMD_JOB_STARTED_MS, "${{ steps.stamp.outputs.started_ms }}");
  assert.equal(screen, job.steps.length - 1, "the screen runs last, on what is left");
});

test("a repeat run starts only if the file's slowest run still fits in the budget", async () => {
  // #15638 (W1-T9795): ci-shard (1/8) was cancelled at the 35-minute job cap on both attempts. The screen
  // budgeted 1896 s and started a new run of a ~67 s suite whenever any budget was left, so the last wave
  // ran past the budget into the cancel. A first run of each file is still mandatory.
  const slow = fakeRuns(30);
  const fit = await flake.screen({ files: ["test/slow.test.ts"], budgetMs: 100, concurrency: 1, ...slow });
  assert.equal(fit.passes.get("test/slow.test.ts"), 3, "runs at 0, 30 and 60 ms end by 90; one at 90 would end at 120");
  assert.ok(slow.now() <= 100, `the screen ends inside its budget (${slow.now()} ms)`);
  const once = fakeRuns(500);
  const heavy = await flake.screen({ files: ["test/slow.test.ts"], budgetMs: 100, concurrency: 1, ...once });
  assert.equal(heavy.passes.get("test/slow.test.ts"), 1, "a file slower than the whole budget still runs once");
});

/** Two added files beside one modified one, under ledgers that predict a single 40 ms coverage shard. */
function addingTwo(addTests = true) {
  const repo = gitRepo({ kind: "flake-screen-job" });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, "test", "old.test.ts"), "// old\n");
  const durations = { "test/old.test.ts": 40, "test/a.test.ts": 1, "test/b.test.ts": 1 };
  writeFileSync(join(repo.dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files: durations }));
  writeFileSync(join(repo.dir, "scripts", "test-tier-coverage-manifest.json"), JSON.stringify({ files: durations }));
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "test", "old.test.ts"), "// old, edited\n");
  if (addTests) {
    writeFileSync(join(repo.dir, "test", "a.test.ts"), "// a\n");
    writeFileSync(join(repo.dir, "test", "b.test.ts"), "// b\n");
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "pull request");
  return repo;
}

test("W1-T14633: the flake-screen job keeps the screen's files, budget and repeats", async () => {
  // The argv the job really passes, read from ci.yml, never restated here.
  const jobs = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")).jobs as Record<string, CiJob>;
  const step = jobs["flake-screen"]!.steps.find((s) => s.run?.trim().startsWith("node scripts/flake-screen.mjs") && !s.run.includes("--list"))!;
  const argv = step.run!.trim().split(/\s+/).slice(2);
  assert.deepEqual(argv, ["--shard", "1"]);
  const repo = addingTwo();
  try {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    const env = { GITHUB_BASE_REF: "main", RMD_JOB_STARTED_MS: "990" };
    // Files: exactly what the job's --list step reads, the added tests and never the modified one.
    assert.equal(await flake.main(["--list"], { env, root: repo.dir, log }), 0);
    assert.deepEqual(lines, ["test/a.test.ts", "test/b.test.ts"]);
    lines.length = 0;
    // Budget: the predicted coverage makespan less this job's own elapsed time (10 ms of 40).
    assert.equal(flake.screenBudgetMs(repo.dir), 40, "the fixture's ledgers predict one 40 ms coverage shard");
    const runs = fakeRuns(5);
    assert.equal(await flake.main(argv, { env, root: repo.dir, log, concurrency: 1, runFile: runs.runFile, now: () => 1_000 + runs.now() }), 0);
    const text = lines.join("\n");
    assert.match(text, /2 added test file\(s\), 1 at a time, for 0s \(the predicted coverage makespan of 0s, less 0s this job already ran\)/);
    // Repeats: exactly what screen() gives for that 30 ms budget.
    const expected = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 30, concurrency: 1, ...fakeRuns(5) });
    assert.deepEqual([...expected.passes.values()], [3, 3]);
    for (const [file, n] of expected.passes) assert.ok(lines.includes(`flake-screen: ${file} passed ${n} run(s).`), `${file} ${n}`);
    // One failed run fails the job.
    lines.length = 0;
    const red = fakeRuns(5, { "test/b.test.ts": [2] });
    assert.equal(await flake.main(argv, { env, root: repo.dir, log, budgetMs: 1_000, concurrency: 1, ...red }), 1);
    assert.ok(lines.includes("FLAKE-SCREEN: test/b.test.ts failed after 1 passing run(s) — a test this pull request adds is nondeterministic."));
  } finally {
    repo.cleanup();
  }
  const none = addingTwo(false);
  try {
    const lines: string[] = [];
    const runs = fakeRuns(5);
    let ran = 0;
    const runFile = (f: string) => (ran++, runs.runFile(f));
    assert.equal(await flake.main(argv, { env: { GITHUB_BASE_REF: "main" }, root: none.dir, log: (l: string) => void lines.push(l), budgetMs: 1_000, runFile, now: runs.now }), 0);
    assert.equal(ran, 0, "a pull request that adds no test file screens nothing");
    assert.match(lines.join("\n"), /0 added test file\(s\)/);
  } finally {
    none.cleanup();
  }
});

test("W1-T14633: the flake-screen job needs only coverage-ledger and ci has no screen step", () => {
  const jobs = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")).jobs as Record<string, CiJob>;
  const job = jobs["flake-screen"]!;
  assert.deepEqual(job.needs, ["coverage-ledger"]);
  assert.deepEqual(job.needs, jobs["coverage-ratchet"]!.needs, "it starts when the coverage shards do");
  assert.equal(job.if, "github.event_name == 'pull_request'", "its only job condition is the pull_request guard");
  assert.doesNotMatch(JSON.stringify(job), /commitlint/, "the screen reads nothing commitlint produces");
  assert.equal(job.steps.filter((s) => s.run?.trim() === SCREEN_RUN).length, 1);
  for (const s of jobs.ci!.steps) assert.doesNotMatch(s.run ?? "", /flake-screen\.mjs/, `ci step ${s.name ?? s.id}`);
  assert.ok(jobs["ci-gate"]!.needs!.includes("flake-screen"), "ci.yml's ci-gate job waits for it");
  const gate = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci-gate.yml"), "utf8")).jobs["ci-gate"].env as Record<string, string>;
  assert.ok((JSON.parse(gate.REQUIRED!) as string[]).includes("flake-screen"), "ci-gate.yml REQUIRES it");
  assert.ok(jobs["coverage-ledger"]!["timeout-minutes"]! + job["timeout-minutes"]! < Number(gate.WAIT_CAP_SECONDS) / 60, "its path stays inside ci-gate's wait");
});
