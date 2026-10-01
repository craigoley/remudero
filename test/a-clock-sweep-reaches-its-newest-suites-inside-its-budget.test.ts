import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

// `scripts/**` is outside tsconfig's `include`, so the module loads through a dynamic specifier
// (the same reason test/clock-sweep.test.ts does).
const SWEEP_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clock-sweep.mjs"),
).href;

type RunResult = { failed: boolean; output?: string };
const mod = (await import(SWEEP_URL)) as {
  SWEEP_BUDGET_MS: number;
  deriveCandidates: (testDir?: string) => string[];
  readTouchedAt: (cwd?: string) => Map<string, number>;
  main: (opts?: {
    argv?: string[];
    run?: (suite: string, days: number) => RunResult;
    derive?: () => string[];
    touchedAt?: () => Map<string, number>;
    now?: () => number;
    ceiling?: number;
    recorded?: string[];
    log?: (m: string) => void;
    write?: (m: string) => void;
  }) => number;
};
const { SWEEP_BUDGET_MS, deriveCandidates, readTouchedAt, main } = mod;

const MIN = 60_000;

/** Drive `main` with a fake clock that each suite run advances by `perSuiteMs`. */
function drive(opts: {
  suites: string[];
  touched: () => Map<string, number>;
  perSuiteMs: number;
}) {
  let t = 0;
  const order: string[] = [];
  const lines: string[] = [];
  const code = main({
    argv: [],
    derive: () => opts.suites,
    touchedAt: opts.touched,
    now: () => t,
    run: (suite) => {
      order.push(suite);
      t += opts.perSuiteMs;
      return { failed: false, output: "" };
    },
    ceiling: 0,
    recorded: [],
    log: (m) => lines.push(m),
    write: (m) => lines.push(m),
  });
  return { code, order, text: lines.join("\n") };
}

test("W1-T5027: the newest-touched suite is swept first", () => {
  const r = drive({
    suites: ["alpha", "bravo", "charlie", "delta"],
    touched: () => new Map([["charlie", 300], ["alpha", 100], ["delta", 300]]),
    perSuiteMs: MIN,
  });
  // charlie and delta tie on time (name order), then alpha, then bravo whose file has no history.
  assert.deepEqual(r.order, ["charlie", "delta", "alpha", "bravo"]);
  assert.match(r.text, /order: newest-touched first/);
  assert.equal(r.code, 0);
});

test("W1-T5027: a sweep that exhausts its budget names the suites it did not reach and fails", () => {
  const suites = Array.from({ length: 14 }, (_, i) => `suite-${String(i).padStart(2, "0")}`);
  // Each suite costs 10 minutes: three run (0, 10, 20), the fourth starts at 30 >= 27.
  const r = drive({
    suites,
    touched: () => new Map(suites.map((s, i) => [s, 1000 - i] as [string, number])),
    perSuiteMs: 10 * MIN,
  });
  assert.deepEqual(r.order, suites.slice(0, 3));
  assert.equal(r.code, 1);
  assert.match(r.text, /UNREACHED — 11 suite\(s\) not run inside the 27-minute budget \(oldest-touched last\)/);
  // The first ten unreached are named, the eleventh is counted.
  for (const s of suites.slice(3, 13)) assert.ok(r.text.includes(s), `${s} must be named`);
  assert.match(r.text, /\+ 1 more/);
  assert.ok(!/PASS —/.test(r.text), "an incomplete sweep must not report PASS");
});

test("W1-T5027: a sweep inside its budget reaches every suite and reports none unreached", () => {
  const r = drive({
    suites: ["alpha", "bravo", "charlie"],
    touched: () => new Map([["alpha", 3], ["bravo", 2], ["charlie", 1]]),
    perSuiteMs: 5 * MIN,
  });
  assert.deepEqual(r.order, ["alpha", "bravo", "charlie"]);
  assert.equal(r.code, 0);
  assert.ok(!/UNREACHED/.test(r.text));
  assert.match(r.text, /PASS — 3 suite\(s\) immune/);
  assert.equal(SWEEP_BUDGET_MS, 27 * MIN);
});

test("W1-T5027: unreadable git history falls back to name order and says so", () => {
  const r = drive({
    suites: ["charlie", "alpha", "bravo"],
    touched: () => {
      throw new Error("not a git repository");
    },
    perSuiteMs: MIN,
  });
  assert.deepEqual(r.order, ["alpha", "bravo", "charlie"]);
  assert.match(r.text, /order: name \(git history unreadable\)/);
  assert.ok(!/order: newest-touched first/.test(r.text));
  assert.equal(r.code, 0);
  // The default seam itself throws outside a repository, which is the arm `main` reports.
  const bare = mkdtempSync(join(tmpdir(), "rmd-clock-sweep-nogit-"));
  try {
    assert.throws(() => readTouchedAt(bare));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("W1-T5027: a named-constant date fixture is in the derived population", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-clock-sweep-derive-"));
  try {
    writeFileSync(
      join(dir, "named-constant.test.ts"),
      'const RECENT = "2026-09-16T18:50:00Z";\nconst row = { lastActivityAt: RECENT };\n',
    );
    writeFileSync(join(dir, "no-age-surface.test.ts"), 'const D = "2026-09-16";\n');
    assert.deepEqual(deriveCandidates(dir), ["named-constant"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5027: the default touched-at seam reads real git history", () => {
  const repo = gitRepo({ kind: "clock-sweep-touched", seedCommit: false });
  try {
    mkdirSync(join(repo.dir, "test"));
    const commit = (file: string, when: string): void => {
      writeFileSync(join(repo.dir, "test", file), `// ${file}\n`);
      repo.git("add", "test");
      execFileSync("git", ["-C", repo.dir, "commit", "--quiet", "-m", `add ${file}`], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
          GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
          GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
          GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_DATE: when,
        },
      });
    };
    commit("zulu.test.ts", "2026-01-01T00:00:00Z");
    commit("alpha.test.ts", "2026-02-01T00:00:00Z");
    const touched = readTouchedAt(repo.dir);
    assert.equal(touched.get("zulu"), Date.parse("2026-01-01T00:00:00Z") / 1000);
    assert.equal(touched.get("alpha"), Date.parse("2026-02-01T00:00:00Z") / 1000);
    assert.equal(touched.size, 2);
  } finally {
    repo.cleanup();
  }
});
