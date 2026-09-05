import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

// ── W1-T2735: A GATE-SHAPED INSTRUMENT THAT NOTHING INVOKES ──────────────────────────────────
//
// THE PROPERTY: a gate-shaped instrument that nothing invokes is not a gate. It reads like
// enforcement to every later session, answers correctly when a human runs it by hand, and refuses
// nothing. Measured at origin/main on 2026-09-02: 38 tracked `scripts/` executables, 30 wired to a
// workflow or an npm script, 8 to neither -- and FOUR of the eight were gate-shaped, among them
// `credit-surface-gate.mjs`, which exists to refuse an implementation PR credited on neither
// surface and was unwired on the very day #3704 reached review with a bare `Task:` trailer.
//
// This suite proves scripts/unwired-gate-check.mjs ACTIVELY refuses that shape (a planted unwired
// gate-shaped script is named by path and the run exits 1), correctly accepts the shapes that are
// NOT the hazard (wired by either surface alone; never gate-shaped at all), holds the recorded
// allowance to shrink-only, and -- the criterion that keeps this guard from being the defect it
// names -- that the check is itself invoked by the same npm script and CI step it demands of every
// other gate.
//
// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static import of the
// .mjs is a TS7016 -- the same reason test/tracked-source-write-guard.test.ts and
// test/clock-sweep.test.ts reach their scripts through a runtime import. A dynamic specifier is
// not statically resolved, so this loads the REAL module with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "unwired-gate-check.mjs");

type Stale = { script: string; why: string };
type Scan = { unwired: string[]; stale: Stale[]; gateShaped: string[]; scanned: number };
/** The narrow shape {@link listTrackedScripts} actually calls its injected `spawn` through --
 *  not the full overloaded `typeof spawnSync`, so a fixture can hand a plain function literal
 *  without fighting spawnSync's option-dependent return-type overloads. */
type GitSpawn = (command: string, args: string[], options: { cwd: string; encoding: "utf8" }) => { status: number | null; stdout: string; stderr: string };
type NpmStale = { npmScript: string; why: string };
type NpmScan = { unwired: string[]; stale: NpmStale[]; checkShaped: string[]; scanned: number };
/** A stub {@link NpmScan} result -- old fixtures built before {@link mod.scanNpmScripts} existed
 *  never intended to exercise the npm-script-name classifier (see `drive`'s doc below). */
const EMPTY_NPM_SCAN: NpmScan = { unwired: [], stale: [], checkShaped: [], scanned: 0 };

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  GATE_SHAPED_RE: RegExp;
  EXECUTABLE_RE: RegExp;
  EXECUTING_KEYS: Set<string>;
  ALLOWANCE: Array<{ script: string; reason: string }>;
  NPM_CHECK_SHAPED_RE: RegExp;
  NPM_SCRIPT_ALLOWANCE: Array<{ npmScript: string; reason: string }>;
  listTrackedScripts: (repoRoot: string, spawn?: GitSpawn) => string[];
  isGateShaped: (relPath: string) => boolean;
  isNpmScriptCheckShaped: (name: string) => boolean;
  listNpmScriptNames: (repoRoot: string) => string[];
  isNpmScriptWired: (name: string, wiringText: string) => boolean;
  collectExecutingStrings: (node: unknown, out?: string[]) => string[];
  collectWiringText: (repoRoot: string) => string;
  isWired: (relPath: string, wiringText: string) => boolean;
  scanRepo: (repoRoot: string, opts?: { allowance?: Array<{ script: string; reason: string }>; scripts?: string[]; wiringText?: string }) => Scan;
  scanNpmScripts: (repoRoot: string, opts?: { allowance?: Array<{ npmScript: string; reason: string }>; scripts?: string[]; wiringText?: string }) => NpmScan;
  main: (opts?: {
    repoRoot?: string;
    scan?: (root: string) => Scan;
    scanNpm?: (root: string) => NpmScan;
    log?: (s: string) => void;
    error?: (s: string) => void;
  }) => number;
};

/** A throwaway git repo holding exactly the `scripts/`, workflow and package.json content a case
 *  needs. `git add` is enough for `git ls-files` -- no commit, so no author identity is required
 *  and the fixture cannot fail on a runner that has none configured (the #1971 shape). */
function fixtureRepo(opts: { scripts?: Record<string, string>; workflows?: Record<string, string>; pkgScripts?: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-unwired-gate-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const [name, body] of Object.entries(opts.scripts ?? {})) writeFileSync(join(root, "scripts", name), body);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(opts.workflows ?? {})) writeFileSync(join(root, ".github", "workflows", name), body);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: opts.pkgScripts ?? {} }, null, 2));
  execFileSync("git", ["add", "-A"], { cwd: root, env });
  return root;
}

function withFixture(opts: Parameters<typeof fixtureRepo>[0], fn: (root: string) => void): void {
  const root = fixtureRepo(opts);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A minimal workflow whose single step really runs `cmd`. */
const workflowRunning = (cmd: string) => `name: fixture\non: [pull_request]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: step\n        run: ${cmd}\n`;

/** Drive the real `main` over a fixture tree. A fixture starts from an EMPTY allowance: the
 *  shipped `ALLOWANCE` names four real repository scripts, and inheriting it into a temp tree
 *  reports all four as "no longer tracked" -- which is the guard behaving correctly, and noise
 *  here. The shipped allowance is exercised against the REAL repo by its own tests below.
 *
 *  `scanNpm` is stubbed to {@link EMPTY_NPM_SCAN} -- these fixtures predate the npm-script-name
 *  classifier (R-46) and were built to exercise ONLY the file-basename scanner; several of them
 *  incidentally name a `pkgScripts` key like `solo:check`, which the widened classifier would
 *  otherwise judge on its own terms and turn a `code: 0` expectation into a false failure. The
 *  npm-script-name classifier gets its own dedicated fixtures and its own `driveNpm` below. */
function drive(root: string, allowance: Array<{ script: string; reason: string }> = []): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = mod.main({
    repoRoot: root,
    scan: (r) => mod.scanRepo(r, { allowance }),
    scanNpm: () => EMPTY_NPM_SCAN,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  });
  return { code, out, err };
}

/** The `scanNpmScripts` sibling of `drive` -- stubs the FILE-basename scanner to a clean result
 *  so these cases exercise only the npm-script-name classifier. */
function driveNpm(root: string, allowance: Array<{ npmScript: string; reason: string }> = []): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = mod.main({
    repoRoot: root,
    scan: () => ({ unwired: [], stale: [], gateShaped: [], scanned: 0 }),
    scanNpm: (r) => mod.scanNpmScripts(r, { allowance }),
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  });
  return { code, out, err };
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2735: a gate-shaped script no workflow and no npm script invokes is named by path and refused", () => {
  withFixture(
    {
      scripts: { "orphan-check.mjs": "// nothing invokes me\n" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test" },
    },
    (root) => {
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(scan.unwired, ["scripts/orphan-check.mjs"], "the planted orphan is the only violation");

      const { code, err } = drive(root);
      assert.equal(code, 1, "an unwired gate-shaped script must make the check exit non-zero");
      assert.ok(
        err.some((l) => l.includes("scripts/orphan-check.mjs")),
        `the offending PATH must be named; got:\n${err.join("\n")}`,
      );
    },
  );
});

test("W1-T2735: both gate suffixes are refused, and the suffix must be hyphenated", () => {
  withFixture(
    {
      scripts: { "alpha-check.mjs": "", "beta-gate.mjs": "", "check.mjs": "", "gate.mjs": "" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test" },
    },
    (root) => {
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(
        scan.unwired.sort(),
        ["scripts/alpha-check.mjs", "scripts/beta-gate.mjs"],
        "`-check` and `-gate` are gate-shaped; bare `check.mjs`/`gate.mjs` (the repo's own aggregate runner shape) are not",
      );
    },
  );
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2735: a script wired by the workflow surface ALONE is accepted", () => {
  withFixture(
    {
      scripts: { "solo-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("node scripts/solo-check.mjs") },
      pkgScripts: {},
    },
    (root) => {
      const { code, err } = drive(root);
      assert.equal(code, 0, `a workflow run: step alone is wiring; got:\n${err.join("\n")}`);
    },
  );
});

test("W1-T2735: a script wired by the npm-script surface ALONE is accepted", () => {
  withFixture(
    {
      scripts: { "solo-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test", "solo:check": "node scripts/solo-check.mjs" },
    },
    (root) => {
      const { code, err } = drive(root);
      assert.equal(code, 0, `an npm script alone is wiring; got:\n${err.join("\n")}`);
    },
  );
});

test("W1-T2735: a non-gate-shaped script is never reported, wired or not", () => {
  withFixture(
    {
      scripts: { "mount-headroom-sweep.mjs": "", "plan-state-claims.mjs": "", "host-parity.ts": "", "shell-screenshot.mjs": "" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test" },
    },
    (root) => {
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(scan.unwired, [], "the predicate is the NAME, not the directory -- an unwired analysis tool is not a defect");
      assert.deepEqual(scan.gateShaped, [], "none of the four claimed to be a gate");
    },
  );
});

test("W1-T2735: an npm script KEY that merely names the script does not credit it -- only the value runs", () => {
  withFixture(
    {
      scripts: { "state-citation-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test", "state-citation-check.mjs": "node scripts/something-else.mjs" },
    },
    (root) => {
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(scan.unwired, ["scripts/state-citation-check.mjs"], "a key naming the script while its body runs something else must not credit it");
    },
  );
});

test("W1-T2735: a longer sibling's mention never credits the shorter script", () => {
  withFixture(
    {
      scripts: { "foo-check.mjs": "", "bar-foo-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("node scripts/bar-foo-check.mjs") },
      pkgScripts: {},
    },
    (root) => {
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(scan.unwired, ["scripts/foo-check.mjs"], "`foo-check.mjs` must not be credited by a mention of `bar-foo-check.mjs`");
    },
  );
});

// ── A COMMENT IS NOT AN INVOCATION (found while building this guard) ─────────────────────────
//
// The first draft searched the workflow files as TEXT. This guard's own CI job comment names three
// sibling scripts, and the text form credited `credit-surface-gate.mjs` as newly wired on that
// basis alone -- a false WIRED, which is the silent direction. Parsing drops comments and
// commented-out steps outright, and excludes `name:` fields, which are prose.

test("W1-T2735: a script named only in a workflow COMMENT is not credited as wired", () => {
  withFixture(
    {
      scripts: { "ghost-check.mjs": "" },
      workflows: {
        "ci.yml":
          "name: fixture\non: [pull_request]\njobs:\n  j:\n    # see scripts/ghost-check.mjs for the shape this generalises\n    runs-on: ubuntu-latest\n    steps:\n      # - run: node scripts/ghost-check.mjs\n      - name: run scripts/ghost-check.mjs one day\n        run: npm test\n",
      },
      pkgScripts: { test: "node --test" },
    },
    (root) => {
      const raw = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
      assert.ok(raw.includes("scripts/ghost-check.mjs"), "control: the basename really is present in the raw file text, three times over");
      const scan = mod.scanRepo(root, { allowance: [] });
      assert.deepEqual(
        scan.unwired,
        ["scripts/ghost-check.mjs"],
        "a comment, a commented-out step and a step NAME are all prose -- none of them runs the script",
      );
    },
  );
});

test("W1-T2735: collectExecutingStrings takes run/uses/entrypoint/args/cmd and never `name`", () => {
  const doc = parseYaml(
    "jobs:\n  j:\n    name: node scripts/named-check.mjs\n    steps:\n      - name: prose\n        run: node scripts/ran-check.mjs\n      - uses: ./.github/actions/used-check\n        args: [node, scripts/array-check.mjs]\n",
  );
  const strings = mod.collectExecutingStrings(doc);
  assert.ok(strings.some((s) => s.includes("ran-check.mjs")), "a `run:` value is executable");
  assert.ok(strings.some((s) => s.includes("used-check")), "a `uses:` value is executable");
  assert.ok(strings.some((s) => s.includes("array-check.mjs")), "an array-valued executable key contributes each string argument");
  assert.ok(!strings.some((s) => s.includes("named-check.mjs")), "a `name:` value is prose");
  assert.deepEqual([...mod.EXECUTING_KEYS].sort(), ["args", "cmd", "entrypoint", "run", "uses"]);
});

// ── criterion 3: the recorded allowance, and the real tree ───────────────────────────────────

test("W1-T2735: every ALLOWANCE entry names a real tracked script and carries a written reason", () => {
  const tracked = new Set(mod.listTrackedScripts(REPO_ROOT));
  assert.ok(mod.ALLOWANCE.length > 0, "the allowance records the gates whose wiring is owned elsewhere");
  for (const entry of mod.ALLOWANCE) {
    assert.ok(tracked.has(entry.script), `${entry.script} must be a tracked scripts/ executable`);
    assert.ok(mod.isGateShaped(entry.script), `${entry.script} must be gate-shaped -- nothing else belongs in this allowance`);
    assert.ok(entry.reason.trim().length >= 40, `${entry.script} needs a written reason, not a placeholder`);
  }
});

test("W1-T2735: the check reads clean on the REAL repository, so it is green on the tree it lands in", () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = mod.main({ log: (s) => out.push(s), error: (s) => err.push(s) });
  assert.equal(code, 0, `the shipped tree must be clean; got:\n${err.join("\n")}`);
  assert.ok(out.join("\n").includes("clean"), out.join("\n"));
});

// ── criterion 4 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2735: a NEWLY added gate-shaped script enters at zero allowance and is refused at once", () => {
  withFixture(
    {
      scripts: { "recorded-check.mjs": "", "brand-new-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("npm test") },
      pkgScripts: { test: "node --test" },
    },
    (root) => {
      const allowance = [{ script: "scripts/recorded-check.mjs", reason: "x".repeat(40) }];
      const scan = mod.scanRepo(root, { allowance });
      assert.deepEqual(
        scan.unwired,
        ["scripts/brand-new-check.mjs"],
        "an unrecorded newcomer is refused while the recorded one is tolerated -- there is no verb that appends a row",
      );
    },
  );
});

// ── criterion 5: shrink-only ─────────────────────────────────────────────────────────────────

test("W1-T2735: a recorded entry whose script has since been WIRED is itself reported", () => {
  withFixture(
    {
      scripts: { "drained-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("node scripts/drained-check.mjs") },
      pkgScripts: {},
    },
    (root) => {
      const allowance = [{ script: "scripts/drained-check.mjs", reason: "x".repeat(40) }];
      const scan = mod.scanRepo(root, { allowance });
      assert.deepEqual(scan.unwired, [], "it is wired, so it is not an unwired violation");
      assert.equal(scan.stale.length, 1, "but the row is now stale -- a ratchet that only grows has stopped ratcheting");
      assert.match(scan.stale[0].why, /now wired/);
    },
  );
});

test("W1-T2735: a recorded entry naming a script that no longer exists is reported", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm test") }, pkgScripts: { test: "node --test" } },
    (root) => {
      const allowance = [{ script: "scripts/deleted-check.mjs", reason: "x".repeat(40) }];
      const scan = mod.scanRepo(root, { allowance });
      assert.equal(scan.stale.length, 1);
      assert.match(scan.stale[0].why, /no longer tracked/);
    },
  );
});

test("W1-T2735: a stale row alone makes the check exit non-zero and name the row", () => {
  withFixture(
    {
      scripts: { "drained-check.mjs": "" },
      workflows: { "ci.yml": workflowRunning("node scripts/drained-check.mjs") },
      pkgScripts: {},
    },
    (root) => {
      const allowance = [{ script: "scripts/drained-check.mjs", reason: "x".repeat(40) }];
      const out: string[] = [];
      const err: string[] = [];
      const code = mod.main({ repoRoot: root, scan: (r) => mod.scanRepo(r, { allowance }), log: (s) => out.push(s), error: (s) => err.push(s) });
      assert.equal(code, 1, "a stale row is a violation in its own right, with no unwired script present");
      assert.ok(err.some((l) => l.includes("scripts/drained-check.mjs") && l.includes("ALLOWANCE")), err.join("\n"));
    },
  );
});

// ── criterion 6: it wires itself ─────────────────────────────────────────────────────────────

test("W1-T2735: the check is itself invoked by an npm script AND a workflow run step", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const npmEntry = Object.entries(pkg.scripts).find(([, v]) => v.includes("scripts/unwired-gate-check.mjs"));
  assert.ok(npmEntry, "package.json must carry an npm script that runs the check");

  // Scanned across EVERY workflow file, not `ci.yml` alone: a new ci.yml job needs a
  // CI_PARITY_TABLE entry that is refused in every ordering (before the job and after it by
  // test/preflight-ci-parity.test.ts's two directions, with it by Rule 25), so this gate lives in
  // its own file -- and an assertion naming one workflow would have to be rewritten for the next
  // gate that does the same.
  const wfDir = join(REPO_ROOT, ".github", "workflows");
  const executing: string[] = [];
  for (const name of readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    executing.push(...mod.collectExecutingStrings(parseYaml(readFileSync(join(wfDir, name), "utf8"))));
  }
  assert.ok(
    executing.some((s) => s.includes(npmEntry![0]) || s.includes("scripts/unwired-gate-check.mjs")),
    "a workflow must RUN it -- a comment naming it is exactly the shape this guard refuses",
  );
});

test("W1-T2735: strip the wiring and the check reports ITSELF -- it cannot be the defect it names", () => {
  assert.ok(mod.isGateShaped("scripts/unwired-gate-check.mjs"), "the guard is gate-shaped by its own predicate");
  const tracked = mod.listTrackedScripts(REPO_ROOT);
  assert.ok(tracked.includes("scripts/unwired-gate-check.mjs"), "and it is tracked");

  // The falsifier: the real tracked list, judged against a wiring text with every mention removed.
  const scan = mod.scanRepo(REPO_ROOT, { scripts: tracked, wiringText: "", allowance: mod.ALLOWANCE });
  assert.ok(
    scan.unwired.includes("scripts/unwired-gate-check.mjs"),
    `unwiring it must make it report itself; got ${JSON.stringify(scan.unwired)}`,
  );
});

// ── real defaults and error arms (every seam a fake would otherwise hide) ────────────────────

test("W1-T2735: listTrackedScripts really shells git and returns only executables", () => {
  const tracked = mod.listTrackedScripts(REPO_ROOT);
  assert.ok(tracked.length > 10, `expected the real scripts/ corpus; got ${tracked.length}`);
  assert.ok(tracked.every((f) => f.startsWith("scripts/")), "every entry is under scripts/");
  assert.ok(tracked.every((f) => mod.EXECUTABLE_RE.test(f)), "data files (*.json) are not executables");
  const control = execFileSync("git", ["ls-files", "scripts/"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.ok(control.includes("scripts/coverage-baseline.json"), "control: git DOES list the json data files");
  assert.ok(!tracked.includes("scripts/coverage-baseline.json"), "and the filter drops them");
});

test("W1-T2735: listTrackedScripts throws, rather than reporting an empty corpus, when git fails", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "rmd-unwired-gate-nogit-"));
  try {
    assert.throws(() => mod.listTrackedScripts(notARepo), /git ls-files/, "a silent empty list would report every gate as absent");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("W1-T2735: listTrackedScripts retries a TRANSIENT git failure before giving up, and still returns the real corpus", () => {
  let calls = 0;
  const flaky: GitSpawn = (command, args, options) => {
    calls += 1;
    if (calls < 2) return { status: 1, stdout: "", stderr: "fatal: index.lock exists" };
    return spawnSync(command, args, options);
  };
  const tracked = mod.listTrackedScripts(REPO_ROOT, flaky);
  assert.ok(calls >= 2, "the wrapper's first, failing call must actually have been retried");
  assert.ok(tracked.length > 10, "once the transient failure clears, the real corpus is still returned");
});

test("W1-T2735: listTrackedScripts gives up and throws after repeated failures, not silently forever", () => {
  let calls = 0;
  const alwaysFlaky: GitSpawn = () => {
    calls += 1;
    return { status: 1, stdout: "", stderr: "fatal: index.lock exists" };
  };
  assert.throws(() => mod.listTrackedScripts(REPO_ROOT, alwaysFlaky), /git ls-files/, "a PERSISTENT failure must still throw, never retry forever");
  assert.equal(calls, 3, "bounded retries -- not zero (a transient race deserves a second chance) and not unbounded");
});

test("W1-T2735: collectWiringText tolerates a missing workflows dir and an unreadable package.json", () => {
  const bare = mkdtempSync(join(tmpdir(), "rmd-unwired-gate-bare-"));
  try {
    assert.equal(mod.collectWiringText(bare).trim(), "", "no workflows dir and no package.json yields no wiring, not a throw");
    writeFileSync(join(bare, "package.json"), "{ not json");
    assert.equal(mod.collectWiringText(bare).trim(), "", "an unparseable package.json is tolerated the same way");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("W1-T2735: an unparseable workflow THROWS naming the file", () => {
  withFixture({ scripts: {}, workflows: { "broken.yml": "a:\n  - b\n c: [unclosed\n" }, pkgScripts: {} }, (root) => {
    assert.throws(() => mod.collectWiringText(root), /broken\.yml/, "a parse failure must name the file, not silently contribute nothing");
  });
});

test("W1-T2735: the real CLI, run as a subprocess, exits 0 and prints its census line", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /unwired-gate-check: clean -- \d+ gate-shaped of \d+ tracked/);
  assert.match(res.stdout, /\d+ check-shaped of \d+ package\.json scripts/, "R-46: the npm-script-name census must print alongside the file-basename one");
});

// ── R-46 (docs/audits/recon-2026-09-05.md): the SAME hazard, one level up ────────────────────
//
// GATE_SHAPED_RE judges a tracked scripts/ FILE's basename and is blind to `docs-index:check-
// paths`: its file, scripts/generate-docs-index.mjs, does not end `-check.mjs`. The claim to be a
// gate lives in the npm alias name instead. These tests prove the sibling classifier
// (NPM_CHECK_SHAPED_RE / isNpmScriptCheckShaped / isNpmScriptWired / scanNpmScripts) the same way
// the suite above proves the file-basename one: an unwired check-shaped npm script is named and
// refused, one wired by either surface alone is accepted, a longer sibling's mention never credits
// a shorter script name, the bare `"check"` aggregate script is excluded, and the allowance is
// shrink-only.

test("R-46: an npm script named like a gate that no workflow and no other npm script invokes is named by key and refused", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm test") }, pkgScripts: { test: "node --test", "orphan:check": "node scripts/orphan.mjs" } },
    (root) => {
      const scan = mod.scanNpmScripts(root, { allowance: [] });
      assert.deepEqual(scan.unwired, ["orphan:check"], "the planted unwired npm-script name is the only violation");

      const { code, err } = driveNpm(root);
      assert.equal(code, 1, "an unwired check-shaped npm script must make the check exit non-zero");
      assert.ok(err.some((l) => l.includes("orphan:check")), `the offending SCRIPT NAME must be named; got:\n${err.join("\n")}`);
    },
  );
});

test("R-46: both `-check` and `:check`/`:check-<suffix>` npm-script shapes are refused; the bare aggregate `check` script is not", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm test") }, pkgScripts: { test: "node --test", check: "node scripts/check.mjs", "alpha-check": "node scripts/a.mjs", "beta:check": "node scripts/b.mjs", "gamma:check-paths": "node scripts/c.mjs" } },
    (root) => {
      const scan = mod.scanNpmScripts(root, { allowance: [] });
      assert.deepEqual(
        scan.unwired.sort(),
        ["alpha-check", "beta:check", "gamma:check-paths"],
        "hyphenated, colon-suffixed and `-<suffix>`-extended check names are all gate-shaped; the bare aggregate `check` script (this repo's own `node scripts/check.mjs`) is not",
      );
    },
  );
});

test("R-46: an npm script wired by the WORKFLOW surface alone is accepted", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm run --silent solo:check") }, pkgScripts: { "solo:check": "node scripts/solo.mjs" } },
    (root) => {
      const { code, err } = driveNpm(root);
      assert.equal(code, 0, `a workflow run: step naming the npm script alone is wiring; got:\n${err.join("\n")}`);
    },
  );
});

test("R-46: an npm script wired by ANOTHER npm script's value alone is accepted", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm test") }, pkgScripts: { test: "node --test", full: "npm run solo:check && node scripts/other.mjs", "solo:check": "node scripts/solo.mjs" } },
    (root) => {
      const { code, err } = driveNpm(root);
      assert.equal(code, 0, `a sibling npm script's own value naming this one is wiring; got:\n${err.join("\n")}`);
    },
  );
});

test("R-46: a shorter check-shaped npm script is never credited by a longer sibling's mention (the `:check` vs. `:check-paths` prefix hazard)", () => {
  withFixture(
    {
      scripts: {},
      workflows: { "ci.yml": workflowRunning("npm run --silent docs-index:check-paths") },
      pkgScripts: { "docs-index:check": "node scripts/g.mjs --check", "docs-index:check-paths": "node scripts/g.mjs --check-paths" },
    },
    (root) => {
      const scan = mod.scanNpmScripts(root, { allowance: [] });
      assert.deepEqual(
        scan.unwired,
        ["docs-index:check"],
        "`docs-index:check` is a PREFIX of the wired `docs-index:check-paths` string and must not be credited by it",
      );
    },
  );
});

test("R-46: NPM_CHECK_SHAPED_RE / isNpmScriptCheckShaped agree, and isNpmScriptWired is two-sided (prefix AND suffix mentions both fail to credit)", () => {
  assert.equal(mod.isNpmScriptCheckShaped("docs-index:check"), true);
  assert.equal(mod.isNpmScriptCheckShaped("docs-index:check-paths"), true);
  assert.equal(mod.isNpmScriptCheckShaped("mkdtemp-callsite-check"), true);
  assert.equal(mod.isNpmScriptCheckShaped("check"), false, "the bare aggregate script must not be swept in");
  assert.equal(mod.isNpmScriptCheckShaped("test:ci"), false);

  // suffix mention (the file-basename hazard's exact shape, reused for npm names)
  assert.equal(mod.isNpmScriptWired("foo-check", "run: node scripts/bar-foo-check.mjs"), false);
  // prefix mention (the NEW hazard this predicate exists for)
  assert.equal(mod.isNpmScriptWired("docs-index:check", "run: npm run docs-index:check-paths"), false);
  // a real, isolated mention is still credited
  assert.equal(mod.isNpmScriptWired("docs-index:check", "run: npm run --silent docs-index:check"), true);
});

test("R-46: every NPM_SCRIPT_ALLOWANCE entry names a real package.json script and carries a written reason", () => {
  const names = new Set(mod.listNpmScriptNames(REPO_ROOT));
  assert.ok(mod.NPM_SCRIPT_ALLOWANCE.length > 0, "the allowance records the check-shaped npm scripts whose wiring is owned elsewhere");
  for (const entry of mod.NPM_SCRIPT_ALLOWANCE) {
    assert.ok(names.has(entry.npmScript), `${entry.npmScript} must be a real package.json scripts entry`);
    assert.ok(mod.isNpmScriptCheckShaped(entry.npmScript), `${entry.npmScript} must be check-shaped -- nothing else belongs in this allowance`);
    assert.ok(entry.reason.trim().length >= 40, `${entry.npmScript} needs a written reason, not a placeholder`);
  }
});

test("R-46: a recorded npm-script allowance entry whose script has since been wired is itself reported (shrink-only)", () => {
  withFixture(
    { scripts: {}, workflows: { "ci.yml": workflowRunning("npm run --silent drained:check") }, pkgScripts: { "drained:check": "node scripts/d.mjs" } },
    (root) => {
      const allowance = [{ npmScript: "drained:check", reason: "x".repeat(40) }];
      const scan = mod.scanNpmScripts(root, { allowance });
      assert.deepEqual(scan.unwired, [], "it is wired, so it is not an unwired violation");
      assert.equal(scan.stale.length, 1, "but the row is now stale");
      assert.match(scan.stale[0].why, /now wired/);
    },
  );
});

// The pre-existing "the check reads clean on the REAL repository" test above already calls
// `mod.main` with no overrides, so it exercises BOTH classifiers against the real tree -- no
// separate real-repo assertion is needed here.
