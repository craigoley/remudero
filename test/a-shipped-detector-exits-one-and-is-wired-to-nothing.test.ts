import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T2732: A SHIPPED DETECTOR EXITS 1 AND IS WIRED TO NOTHING ─────────────────────────────
//
// W1-T2292 built scripts/coverage-session-blanking-check.mjs and its own falsifying unit test,
// and its own criterion 7 fenced it from touching a caller. Measured 2026-09-02: the script
// exited 1 (3 delete-is-noop defects, 16 unblanked-NODE_TEST_CONTEXT findings) and neither
// .github/workflows/ nor package.json referenced it anywhere. This suite is the acceptance proof
// for this task's successor work: the population is cleared, the script is wired as a REQUIRED
// CI gate, and neither the detector script nor its own W1-T2292 test lost the properties that
// made them correct.
//
// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import of the .mjs is a TS7016 --
// the same reason test/coverage-session-blanking.test.ts itself reaches the script through a
// runtime import rather than a typed one. A dynamic specifier is not statically resolved, so this
// loads the REAL module with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "coverage-session-blanking-check.mjs");
const CI_GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "coverage-session-blanking.yml");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  BLIND_SPOTS: string;
  scanRepo: (repoRoot: string) => {
    defects: Array<{ file: string; line: number; expr: string }>;
    suspects: Array<{ file: string; line: number; ident: string }>;
    filesScanned: number;
  };
  main: (opts?: {
    repoRoot?: string;
    log?: (s: string) => void;
    error?: (s: string) => void;
  }) => number;
};

function mkFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shipped-detector-wiring-fixture-`));
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  return root;
}

function gitAdd(root: string) {
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
}

/**
 * W1-T3058 — THE SHIPPING COMMIT, NOT THE CURRENT BRANCH. W1-T2732's two scope fences below were
 * written against `merge-base(HEAD, origin/main)`. That is the right answer WHILE a task's own
 * branch is open and the wrong one the moment it merges: from then on `HEAD` is every LATER
 * author's branch, and the fences read as claims about work that has nothing to do with W1-T2732.
 * The doc they replaced was careful about the RIGHT hazard (origin/main moving) and missed this
 * one entirely, which is why it survived review.
 *
 * MEASURED. #4419 merged this file at 2026-09-07T17:45:11Z. Within the hour, "no src/ path is
 * added to this diff" was failing on every open branch that touches `src/` -- #4462 and #4455 both
 * red on `ci-shard (2/4)` for it, and it reproduces on any new branch that edits one src file. The
 * suite passes on `main`, where the diff is empty, so the fence is green exactly where it is
 * looked at and red everywhere it is not.
 *
 * A SCOPE FENCE IS A CLAIM ABOUT ONE COMMIT. Re-pointing both fences at the commit that shipped the
 * task keeps the evidence -- the claim was true and stays checkable forever -- and removes the
 * landmine, because a fixed sha cannot move under a later author. Post-merge, scope belongs to the
 * reviewer (`scope_violation`, rule 15), never to a test in the permanent suite.
 */
const SHIPPING_COMMIT = "03a9a68a0";

/** The paths W1-T2732's own squash commit changed. A FIXED sha, so no later branch alters it. */
function shippedPaths(): string[] {
  const out = execFileSync("git", ["show", "--name-only", "--pretty=format:", SHIPPING_COMMIT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

// ── acceptance 1: "the check runs in CI as a required gate ... named by the same script path
// the repository already uses for its sibling gates" ────────────────────────────────────────

test("package.json names the check by the SAME script path convention as its sibling gates (unwired-gate:check, source-size-ratchet)", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts["coverage-session-blanking:check"],
    "node scripts/coverage-session-blanking-check.mjs",
    "the npm alias must run the real script by its real path, exactly the shape " +
      "`unwired-gate:check`/`source-size-ratchet` already use for their own scripts",
  );
});

test("a standalone workflow file registers a `coverage-session-blanking` job that runs the npm alias, unconditionally on every PR", () => {
  const doc = parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as {
    on?: { pull_request?: unknown };
    jobs?: Record<string, { name?: string; if?: unknown; steps?: Array<{ run?: string }> }>;
  };
  assert.ok(doc.on && "pull_request" in doc.on, "must fire on pull_request, the same trigger every sibling required gate uses");
  const job = doc.jobs?.["coverage-session-blanking"];
  assert.ok(job, "the workflow must define a `coverage-session-blanking` job");
  assert.equal(job!.if, undefined, "no job-level `if:` beyond the PR trigger -- a conditionally-skippable required check deadlocks merge forever");
  const runSteps = (job!.steps ?? []).map((s) => s.run).filter(Boolean) as string[];
  assert.ok(
    runSteps.some((r) => r.includes("coverage-session-blanking:check")),
    "a step must invoke the npm alias that runs the real script",
  );
});

test("ci-gate.yml's REQUIRED list names the job -- a required check, not decorative advisory-only wiring", () => {
  const doc = parseYaml(readFileSync(CI_GATE_PATH, "utf8")) as {
    jobs: { "ci-gate": { env: Record<string, string> } };
  };
  const required = JSON.parse(doc.jobs["ci-gate"].env.REQUIRED) as string[];
  assert.ok(
    required.includes("coverage-session-blanking"),
    "coverage-session-blanking must be REQUIRED, matching design's \"must be a REQUIRED check or it is decorative again\"",
  );
});

// ── acceptance 2: "every delete-is-noop site is converted to real blanking, so the form the
// scan calls a no-op no longer appears in any tracked test file" ────────────────────────────

test("no tracked test file contains a delete-is-noop defect", () => {
  const { defects } = mod.scanRepo(REPO_ROOT);
  assert.deepEqual(defects, [], `every delete-is-noop site must be converted to real blanking; still found:\n${JSON.stringify(defects, null, 2)}`);
});

// ── acceptance 3: "the check exits zero on the cleared tree, and a deliberately reintroduced
// violation makes it exit non-zero naming that file and line" ───────────────────────────────

test("the check exits 0 on the real, cleared repo tree", () => {
  const { defects, suspects, filesScanned } = mod.scanRepo(REPO_ROOT);
  assert.ok(filesScanned > 700, `sanity: the scan must have read a real corpus (got ${filesScanned})`);
  assert.deepEqual(defects, []);
  assert.deepEqual(suspects, []);
});

test("the CLI, run directly against the real repo, exits 0 and still prints the clean summary", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /coverage-session-blanking-check: clean/);
});

test("a deliberately reintroduced violation makes the check exit non-zero, naming that file and line", () => {
  const root = mkFixtureRepo();
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "test", "reintroduced-offender.test.ts"),
      ["const childEnv = { ...process.env };", "delete childEnv.NODE_V8_COVERAGE;"].join("\n"),
    );
    gitAdd(root);
    const errored: string[] = [];
    const code = mod.main({ repoRoot: root, log: () => assert.fail("must not log the clean message on a violation"), error: (s: string) => errored.push(s) });
    assert.equal(code, 1, "a reintroduced violation must make the check exit non-zero");
    const out = errored.join("\n");
    assert.match(out, /coverage-session-blanking-check: FAILED/);
    assert.match(out, /test\/reintroduced-offender\.test\.ts:2: delete childEnv\.NODE_V8_COVERAGE/, "the file and line must be named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 4: "the scan's own declared blind spots are unchanged -- no new shape is
// claimed to be covered and its refusal to prove absence still prints" ──────────────────────

test("BLIND_SPOTS is byte-identical to what W1-T2292 shipped -- no new shape is claimed covered", () => {
  assert.match(mod.BLIND_SPOTS, /proves PRESENCE of a defect; it never proves ABSENCE of one/);
  assert.match(mod.BLIND_SPOTS, /a spawn with NO `env` option at all/);
  assert.match(mod.BLIND_SPOTS, /an env object assembled at runtime, or spread out of a shared helper/);
  assert.match(mod.BLIND_SPOTS, /a spawn routed through a wrapper/);
  assert.match(mod.BLIND_SPOTS, /anything outside test\/\./);
});

test("both the clean run and a violation run still print the blind-spots statement", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Unreachable by this scan/);

  const root = mkFixtureRepo();
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "offender.test.ts"), ["const e = { ...process.env };", "delete e.NODE_V8_COVERAGE;"].join("\n"));
    gitAdd(root);
    const errored: string[] = [];
    mod.main({ repoRoot: root, log: () => {}, error: (s: string) => errored.push(s) });
    assert.match(errored.join("\n"), /Unreachable by this scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: "neither the detector script nor its W1-T2292 test is edited, and no src
// path is added to this diff" ────────────────────────────────────────────────────────────────
//
// The script itself, and the "no src/ path" fence, hold literally -- both are checked below
// against origin/main. test/coverage-session-blanking.test.ts is the ONE exception, and it is
// disclosed here rather than asserted false: getting the real repo to exit 0 (acceptance 3) is
// this task's own remit, and three of that file's own assertions hard-coded the PREVIOUS,
// unclean state as their expected value -- "the CLI ... exits 1 against the real repo",
// "still names test/base-blob-read-failure.test.ts's delete", and "the two named ... files are
// still present [as suspects], unedited by this task" (the last two are quotes of W1-T2292's OWN
// note, about ITS scope, not this one's). Each is now a live contradiction of acceptance 3 that
// keeping the file byte-for-byte would leave permanently red. All three were narrowed to their
// achievable, still-meaningful form (see that file's own "W1-T2732 UPDATE" comments) rather than
// deleted outright, and its full 25/25-passing suite is unaffected otherwise -- verified by
// running it, not merely asserted here.
test("W1-T2732 shipped without editing the detector script it wired", () => {
  assert.ok(
    !shippedPaths().includes("scripts/coverage-session-blanking-check.mjs"),
    "the task wired an EXISTING detector; editing it would have been a different task",
  );
});

test("W1-T2732 shipped with no src/ path riding along", () => {
  // The claim W1-T2732 made about ITSELF, still checked -- and now unable to fail on anyone else's
  // branch, which is the whole repair. The non-empty assertion is the positive control: without it
  // an unreadable sha would return [] and this would pass over an empty set.
  const paths = shippedPaths();
  assert.ok(paths.length > 0, `the shipping commit ${SHIPPING_COMMIT} must be readable, else this proves nothing`);
  assert.deepEqual(paths.filter((path) => path.startsWith("src/")), [], "no src/ path rode with that commit");
});

test("this check script contains none of the mutating fs calls -- it cannot edit any caller it scans (unaffected by this task)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  for (const call of ["writeFileSync(", "appendFileSync(", "rmSync(", "unlinkSync(", "cpSync(", "renameSync("]) {
    assert.ok(!src.includes(call), `${SCRIPT} must never call ${call}`);
  }
});
