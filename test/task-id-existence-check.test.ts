import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// ── W1-T1048: TASK-ID EXISTENCE gate ────────────────────────────────────────────────────────
//
// #2251 cited an id as ITS OWN task id in shipped code -- two comments in
// deploy/recycle-container.sh, five references (three of them test names) in
// test/recycle-container.test.ts -- and named it three times in its PR body, yet no plan record
// ever declared it and no reservation ref ever held it: the hand lane's only id source,
// `rmd next-task-id`, prints an id and reserves NOTHING BY DESIGN (its own comment: "a process
// that exits microseconds later reserves nothing anyway"). Nothing noticed until a later mint
// handed the same number out as free and an open PR had to be renumbered.
//
// scripts/task-id-existence-check.mjs is the gate this suite proves ACTIVE, not merely present:
// an id cited under src/deploy that resolves to neither a reservation ref nor a declared plan
// record turns the CLI red and names it; a reservation-only id (no plan record) still resolves; a
// baseline entry with no written reason is rejected outright; the scan reads src/deploy and never
// test/ (excluded by construction, not exemption); the scan writes nothing and mints no id; and an
// unreachable reservation-ref read degrades to a stated UNKNOWN rather than failing closed. See
// ci.yml's `task-id-existence` job for the real call site.
//
// (scripts/task-id-existence-check.mjs is a plain .mjs file outside tsconfig's `include`, so it
// is exercised here only via its CLI surface, never imported -- same convention as
// test/claims-check.test.ts / test/no-hand-rolled-fetch-check.test.ts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `task-id-existence-${prefix}-`));
}

/** A bare remote with nothing reserved -- `git ls-remote` against it succeeds and returns
 *  nothing, the "reachable, no reservations" case every non-reservation test uses. */
function makeEmptyBareRemote(): string {
  const bare = mkTmp("bare");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  return bare;
}

/** A bare remote holding exactly one `refs/rmd-id/<id>` reservation ref, built the same way the
 *  real allocator does: a seed clone commits once, pushes to the bare, and the ref is created
 *  locally on the bare pointing at that same commit (mirrors test/triage-remote-reservation-
 *  timing.test.ts's `makeOrigin` shape). */
function makeBareRemoteWithReservation(id: string): string {
  const bare = mkTmp("bare-reserved");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkTmp("seed");
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "."], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "seed"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: GIT_ENV });
  const sha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8", env: GIT_ENV }).trim();
  execFileSync("git", ["-C", bare, "update-ref", `refs/rmd-id/${id}`, sha], { encoding: "utf8", env: GIT_ENV });
  return bare;
}

function writeBaseline(dir: string, entries: Array<{ id: string; reason: string }>): string {
  const path = join(dir, "baseline.json");
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return path;
}

/** A scratch fixture repo root with independent `src/`, `deploy/` and `test/` trees, each
 *  seedable with arbitrary file content -- the shape every scan/scope test below builds on. */
function mkFixtureRoot(): string {
  const root = mkTmp("fixture");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "# empty\n");
  return root;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

test("task-id-existence: an id in shipped source with no reservation and no plan record FAILS", () => {
  const root = mkFixtureRoot();
  const remote = makeEmptyBareRemote();
  try {
    writeFileSync(join(root, "src", "orphan.ts"), "// cites W1-T88001, never reserved, never filed\n");
    const baseline = writeBaseline(root, []);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", remote,
    ]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /FAILED/);
    assert.match(output, /W1-T88001/);
    assert.match(output, /orphan\.ts:1/);
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: a baseline entry with no recorded reason is rejected", () => {
  const root = mkFixtureRoot();
  const remote = makeEmptyBareRemote();
  try {
    // Nothing is even cited -- the baseline's own structure must be rejected before any scan.
    const baseline = writeBaseline(root, [{ id: "W1-T88002", reason: "" }]);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", remote,
    ]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /NO WRITTEN REASON/);
    assert.match(output, /W1-T88002/);
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: the scan reads src and deploy and never the test tree", () => {
  const root = mkFixtureRoot();
  const remote = makeEmptyBareRemote();
  try {
    // A real orphan under src/ (must be reported) alongside a DIFFERENT orphan under test/ (must
    // never be reported -- if it were, the check would drown in the fixture-corpus false
    // positives the shard's own population measurement found under test/).
    writeFileSync(join(root, "src", "real.ts"), "// cites W1-T88003\n");
    writeFileSync(join(root, "test", "fixture.test.ts"), "// cites W1-T88004, a synthetic fixture id\n");
    const baseline = writeBaseline(root, []);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", remote,
    ]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /W1-T88003/);
    assert.doesNotMatch(output, /W1-T88004/);
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: the scan is read-only and mints no id", () => {
  const root = mkFixtureRoot();
  const remote = makeBareRemoteWithReservation("W1-T88099"); // an unrelated pre-existing reservation
  try {
    const before = execFileSync("git", ["-C", remote, "for-each-ref", "--format=%(refname)", "refs/rmd-id/"], {
      encoding: "utf8",
    }).trim();

    // Run it against a fixture that WOULD fail (an unresolved orphan) -- even a FAILING run must
    // never write a ref or otherwise mutate the remote/local tree it scans.
    writeFileSync(join(root, "src", "orphan.ts"), "// cites W1-T88005, never reserved, never filed\n");
    const baseline = writeBaseline(root, []);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", remote,
    ]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr); // sanity: this run did fail

    const after = execFileSync("git", ["-C", remote, "for-each-ref", "--format=%(refname)", "refs/rmd-id/"], {
      encoding: "utf8",
    }).trim();
    assert.equal(after, before, "the reservation namespace must be byte-identical before and after a run");

    // And the fixture tree itself must be untouched -- read the file back verbatim.
    assert.equal(
      readFileSync(join(root, "src", "orphan.ts"), "utf8"),
      "// cites W1-T88005, never reserved, never filed\n",
    );
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: a fresh reservation with no plan record still resolves", () => {
  const root = mkFixtureRoot();
  const remote = makeBareRemoteWithReservation("W1-T88006");
  try {
    writeFileSync(join(root, "src", "fresh.ts"), "// cites W1-T88006, reserved but not yet filed\n");
    const baseline = writeBaseline(root, []);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", remote,
    ]);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /OK/);
    assert.doesNotMatch(output, /W1-T88006/); // resolved silently, never named as a failure
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: an unreachable reservation read degrades to a stated UNKNOWN, not a failure", () => {
  const root = mkFixtureRoot();
  const unreachable = join(root, "no-such-remote"); // never created -- `git ls-remote` must fail on it
  try {
    writeFileSync(join(root, "src", "maybe.ts"), "// cites W1-T88007 -- cannot be told apart from reserved\n");
    const baseline = writeBaseline(root, []);
    const result = runCli([
      "--cwd", root,
      "--baseline", baseline,
      "--remote", unreachable,
    ]);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output); // NOT a failure -- a network blip must not fail closed
    assert.match(output, /WARNING/);
    assert.match(output, /UNKNOWN/);
    assert.match(output, /W1-T88007/);
  } finally {
    cleanup(root);
  }
});

test("task-id-existence: an unconditional ci job runs the check on every pull request", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /^\s*task-id-existence:\s*$/m, "ci.yml must declare a task-id-existence job");
  assert.match(
    ciYml,
    /npm run --silent task-id-existence:check/,
    "ci.yml's task-id-existence job must actually invoke the checker",
  );

  // UNCONDITIONAL: the job carries the same PR-only `if:` every job in this file has (see the
  // `on:` block comment for why `ci` alone also runs on push) but no PATH filter -- extract just
  // this job's block and prove it has no `paths:`/`paths-ignore:` key, matching the claims/
  // no-hand-rolled-fetch precedent's own falsifier shape.
  const jobStart = ciYml.indexOf("\n  task-id-existence:\n");
  assert.notEqual(jobStart, -1, "task-id-existence job block not found");
  const nextJobMatch = /\n {2}[a-zA-Z0-9_-]+:\n/.exec(ciYml.slice(jobStart + 1));
  const jobBlock = nextJobMatch ? ciYml.slice(jobStart, jobStart + 1 + nextJobMatch.index) : ciYml.slice(jobStart);
  assert.doesNotMatch(jobBlock, /paths(-ignore)?:/, "task-id-existence must have no path filter (fail-closed shape)");

  // The real repo, scanned for real, must be clean today (proves the checked-in baseline is
  // honest and the gate is wired against the actual src/deploy trees, not a stub).
  const result = spawnSync(process.execPath, [SCRIPT, "--remote", "origin"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ── the refusal and empty-tree arms, driven through the exported functions ─────────────────────
//
// Every test above drives the CLI as a subprocess, which is the right shape for the gate's
// end-to-end behaviour and reaches none of the error arms below: a subprocess's coverage is not
// the parent run's, and the happy path never takes them anyway. These call the same module's
// exported functions directly. One test per arm rather than one "malformed input throws" case,
// which would pass while the rest stayed dead.
const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-task-id-existence-arms-"));
}

test("W1-T1048: scanCitedIds treats an absent directory as nothing to scan, not an error", () => {
  const root = scratch();
  assert.equal(mod.scanCitedIds(["does-not-exist"], root).size, 0);
});

test("W1-T1048: scanCitedIds treats a path that is a file rather than a directory the same way", () => {
  const root = scratch();
  writeFileSync(join(root, "not-a-dir"), "W1-T1 cited here\n");
  assert.equal(mod.scanCitedIds(["not-a-dir"], root).size, 0);
  // The positive control for both: the SAME call over a real directory does find an id, so the
  // zeros above are the absent/ENOTDIR arms and not a scanner that never matches anything.
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "// cites W1-T4242\n");
  assert.deepEqual([...mod.scanCitedIds(["src"], root).keys()], ["W1-T4242"]);
});

test("W1-T1048: scanDeclaredPlanIds tolerates an absent tasks file and an absent shard directory", () => {
  const root = scratch();
  const ids = mod.scanDeclaredPlanIds(root, { planTasksFile: "no-such.yaml", planTasksDir: "no-such.d" });
  assert.equal(ids.size, 0);
  // Positive control on the same call shape: a real file and a real shard dir both resolve.
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W1-T4243\n");
  writeFileSync(join(root, "plan", "tasks.d", "s.yaml"), "- id: W1-T4244\n");
  assert.deepEqual([...mod.scanDeclaredPlanIds(root)].sort(), ["W1-T4243", "W1-T4244"]);
});

test("W1-T1048: loadBaseline refuses an unreadable file, naming the path", () => {
  assert.throws(
    () => mod.loadBaseline(join(scratch(), "absent.json")),
    (e: Error) => /cannot read baseline file .*absent\.json/.test(e.message),
  );
});

test("W1-T1048: loadBaseline refuses a file that is not valid JSON", () => {
  const p = join(scratch(), "b.json");
  writeFileSync(p, "{not json");
  assert.throws(() => mod.loadBaseline(p), (e: Error) => /is not valid JSON/.test(e.message));
});

test("W1-T1048: loadBaseline refuses a JSON document that is not an array of entries", () => {
  const p = join(scratch(), "b.json");
  writeFileSync(p, JSON.stringify({ "W1-T1": "a map, not an array" }));
  assert.throws(() => mod.loadBaseline(p), (e: Error) => /must be a JSON array/.test(e.message));
});

test("W1-T1048: loadBaseline refuses an entry whose id is missing or not a W1-T id", () => {
  const p = join(scratch(), "b.json");
  for (const entry of [{ reason: "no id at all" }, { id: "T7", reason: "bare form" }, { id: 7, reason: "not a string" }]) {
    writeFileSync(p, JSON.stringify([entry]));
    assert.throws(() => mod.loadBaseline(p), (e: Error) => /has no valid "id"/.test(e.message));
  }
});

test("W1-T1048: loadBaseline refuses the same id listed twice", () => {
  const p = join(scratch(), "b.json");
  writeFileSync(p, JSON.stringify([{ id: "W1-T1", reason: "first" }, { id: "W1-T1", reason: "second" }]));
  assert.throws(() => mod.loadBaseline(p), (e: Error) => /lists W1-T1 more than once/.test(e.message));
  // Positive control: the same shape with distinct ids loads, so the refusals above are the
  // duplicate arm rather than loadBaseline rejecting every well-formed file.
  writeFileSync(p, JSON.stringify([{ id: "W1-T1", reason: "first" }, { id: "W1-T2", reason: "second" }]));
  assert.deepEqual([...mod.loadBaseline(p).keys()], ["W1-T1", "W1-T2"]);
});

// ── The doc-safe placeholder form (2026-08-25) ───────────────────────────────────────────────
//
// A literal in a PR body -- inside a code span -- burned the mint's ceiling and cost two
// reservation refs. The author backticked it and reasonably assumed that was enough. It is not:
// `mentionedTaskIds` extracts the same number from a bare literal, a code span and a fenced
// block alike. This gate already refuses an unresolvable literal in shipped source, and it caught
// a third attempt the same night when a source comment spelled the ids out -- but its refusal
// named only two exits, both of which assume the id was MEANT as a claim. The case that actually
// costs money is the third: an EXAMPLE. These tests pin the escape hatch so a later change to
// either reader cannot silently take it away.

test("task-id-existence: the placeholder form in shipped source does NOT trip the gate", () => {
  const root = mkFixtureRoot();
  const remote = makeEmptyBareRemote();
  try {
    // Every placeholder in one file, in the roles an author actually writes them in.
    writeFileSync(
      join(root, "src", "docs.ts"),
      [
        "// reserveTaskIdRemote(W1-T<n>) claims the id on origin",
        "// see also dispatchClaimRef(\"W1-T<id>\")",
        "// the ref is refs/rmd-id/W1-TNNNN",
      ].join("\n") + "\n",
    );
    const baseline = writeBaseline(root, []);
    const result = runCli(["--cwd", root, "--baseline", baseline, "--remote", remote]);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /FAILED/, "a placeholder is not a claim and must not be read as one");
  } finally {
    cleanup(root, remote);
  }
});

test("task-id-existence: the refusal NAMES the placeholder form, so an example author has a way out", () => {
  const root = mkFixtureRoot();
  const remote = makeEmptyBareRemote();
  try {
    // The exact shape that burned us: a literal inside a code span, in a comment.
    writeFileSync(join(root, "src", "example.ts"), "// see `dispatchClaimRef(\"W1-T88002\")` for the shape\n");
    const baseline = writeBaseline(root, []);
    const result = runCli(["--cwd", root, "--baseline", baseline, "--remote", remote]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /W1-T88002/, "sanity: the code span did not hide it from the scan either");
    assert.match(output, /placeholder form/, "the refusal must offer the example author the third exit");
    assert.match(output, /W1-T<n>/, "and must spell the form out");
    assert.match(output, /Backticks and fenced blocks do NOT help/, "and must say why the obvious guess fails");
  } finally {
    cleanup(root, remote);
  }
});

test("the placeholder forms are inert against BOTH readers, driven rather than reasoned about", async () => {
  // The mint's mention scan.
  const { mentionedTaskIds } = await import("../src/lib/task-id.js");
  for (const safe of ["W1-T<n>", "W1-T<id>", "W1-TNNNN", "W1-Txxxx", "W1-T…", "W1-T88003x"]) {
    assert.deepEqual(mentionedTaskIds(`dispatchClaimRef("${safe}")`), [], `${safe} must extract nothing`);
  }
  // CONTROL, in all three renderings the author might reach for: the literal is read identically.
  for (const unsafe of ['W1-T88004', '`W1-T88004`', "```\nW1-T88004\n```"]) {
    assert.deepEqual(mentionedTaskIds(unsafe), [88004], "a literal is read the same bare, spanned or fenced");
  }

  // The plan-history scan's own shape (`git log -p` added lines declaring an id). Mirrored here
  // rather than imported because ADDED_TASK_ID_RE is private to run-task.ts; the control below is
  // what proves the mirror is the right shape.
  const added = /^\+\s*(?:-\s*)?id:\s*["']?W1-T(\d+)/gm;
  const run = (line: string) => {
    added.lastIndex = 0;
    return [...line.matchAll(added)].map((m) => m[1]);
  };
  assert.deepEqual(run("+  - id: W1-T88005"), ["88005"], "control: a real declaration IS seen");
  for (const safe of ["+  - id: W1-T<n>", "+  - id: W1-T<id>", "+  - id: W1-TNNNN"]) {
    assert.deepEqual(run(safe), [], `${safe} must declare nothing`);
  }
});

// ── W1-T2324 (Q3 half): an ADDED id that already exists on the base is refused BEFORE the merge ──
//
// THREE COLLISIONS IN ONE DAY, ALL FROM ONE CAUSE. Each time the mint printed `DEGRADED: open-prs`
// because `gh pr list` was refused on an exhausted GraphQL bucket, so the ceiling came from three
// surfaces and the missing one was the only one holding ids that exist but are not yet on main.
// GIT DOES NOT CATCH IT: two differently-named shards declaring one id merge with no conflict.
// `lint-plan` catches it only AFTER the merge at exit 2, and `loadPlan` then refuses origin/main.
//
// THE PREDICATE IS PER-ID DECLARING FILE, HEAD VS BASE — not a duplicate-at-head scan, and this is
// the correction that made it work. Every real collision was authored on a branch BEHIND main, so
// locally each id appeared exactly once: replaying #2993's colliding head, a head-only duplicate
// scan finds nothing. What separates them is that the base declares the id from a DIFFERENT file.
//
// Driven through the real CLI as a subprocess against scratch git repos, never by importing the
// .mjs — the same convention the tests above use.
function planRepo(shards: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "t2324-plan-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, env });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, env });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  for (const [name, id] of Object.entries(shards)) {
    writeFileSync(join(dir, "plan", "tasks.d", name), `- id: ${id}\n  title: "t"\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir, env });
  return dir;
}
function runCheck(cwd: string, base: string) {
  return spawnSync(process.execPath, [SCRIPT, "--cwd", cwd, "--base", base, "--dir", "src", "--baseline", join(REPO_ROOT, "scripts", "task-id-existence-baseline.json")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

test("W1-T2324: an id the base declares from a DIFFERENT file is REFUSED, naming both sides", () => {
  const dir = planRepo({ "W1-T900-original.yaml": "W1-T900" });
  try {
    // The branch is BEHIND: it drops main's shard and adds its own carrying the same id — exactly
    // #2993's shape. Each id appears ONCE in this tree, so a duplicate-at-head scan sees nothing.
    rmSync(join(dir, "plan", "tasks.d", "W1-T900-original.yaml"));
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-reissued.yaml"), '- id: W1-T900\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 1, `expected a refusal, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ALREADY DECLARED/);
    assert.match(r.stderr, /W1-T900/);
    assert.match(r.stderr, /W1-T900-original\.yaml/, "names the file the BASE declares it in");
    assert.match(r.stderr, /W1-T900-reissued\.yaml/, "and the file THIS change declares it in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 CONTROL: a genuinely new id is SILENT — adding an id is the normal case", () => {
  const dir = planRepo({ "W1-T900-original.yaml": "W1-T900" });
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T901-new.yaml"), '- id: W1-T901\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 0, `a new id must not be refused: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ALREADY DECLARED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 CONTROL: a change that only CITES ids and declares nothing new is SILENT", () => {
  const dir = planRepo({ "W1-T900-original.yaml": "W1-T900" });
  try {
    // Citing is the normal case and what this gate already judged; touching a plan file is not
    // adding an id. A per-file scan reads every `- id:` in a touched file and would refuse here.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "// see W1-T900 for why\n");
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-original.yaml"), '- id: W1-T900\n  title: "edited"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 0, `citing must stay silent: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ALREADY DECLARED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324: an UNREADABLE base REFUSES rather than passing — the false zero is the whole defect", () => {
  const dir = planRepo({ "W1-T900-original.yaml": "W1-T900" });
  try {
    const r = runCheck(dir, "no-such-ref-xyzzy");
    assert.equal(r.status, 1, "an unreadable base must not be read as an empty one");
    assert.match(r.stderr, /could not read declared plan ids at base/);
    assert.match(r.stderr, /false zero/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 FALSIFIER: a duplicate-at-head scan alone would MISS every real collision", () => {
  const dir = planRepo({ "W1-T900-original.yaml": "W1-T900" });
  try {
    rmSync(join(dir, "plan", "tasks.d", "W1-T900-original.yaml"));
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-reissued.yaml"), '- id: W1-T900\n  title: "t"\n');
    // The head tree declares W1-T900 exactly ONCE. Anything keyed on head multiplicity is blind.
    const declared = readFileSync(join(dir, "plan", "tasks.d", "W1-T900-reissued.yaml"), "utf8");
    assert.equal((declared.match(/^- id: /gm) ?? []).length, 1, "one declaration at head");
    assert.equal(runCheck(dir, "main").status, 1, "and it is still refused, because the BASE is consulted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T2324: the id grammar is `W<n>-T<n>` with an OPTIONAL single-letter suffix, across
// workstreams. The first cut of the collision check matched `W1-T[0-9]+` anchored at end-of-line,
// which DROPPED 35 of the plan's 901 declared ids: 21 lettered siblings (W1-T1B, W1-T9a, W1-T12e …)
// and 14 outside W1 (W2-T1, W3-T3, W12-T1).
//
// DROPPED, NOT TRUNCATED — the distinction decides which direction the bug ran. `$` after `[0-9]+`
// means `- id: W1-T1B` matched NOTHING, so two lettered siblings never collapsed into one id; the
// gate simply could not SEE them, which is a hole rather than a false alarm. These tests pin both
// halves: siblings stay distinct, and a real re-issue of a lettered id is still refused.

test("W1-T2324 CONTROL: lettered siblings are DISTINCT ids — adding W1-T1B while W1-T1C exists is SILENT", () => {
  const dir = planRepo({ "W1-T1C-existing.yaml": "W1-T1C" });
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T1B-new.yaml"), '- id: W1-T1B\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 0, `W1-T1B and W1-T1C are different tasks: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ALREADY DECLARED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 CONTROL: a lettered id is not confused with its unlettered stem — W1-T1B beside W1-T1 is SILENT", () => {
  const dir = planRepo({ "W1-T1-stem.yaml": "W1-T1" });
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T1B-suffixed.yaml"), '- id: W1-T1B\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 0, `W1-T1B must not read as W1-T1: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324: a genuinely RE-ISSUED lettered id is still refused — the grammar widened, the gate did not soften", () => {
  const dir = planRepo({ "W1-T1B-original.yaml": "W1-T1B" });
  try {
    rmSync(join(dir, "plan", "tasks.d", "W1-T1B-original.yaml"));
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T1B-reissued.yaml"), '- id: W1-T1B\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 1, "a re-issued lettered id must be refused like any other");
    assert.match(r.stderr, /W1-T1B/);
    assert.match(r.stderr, /W1-T1B-original\.yaml/, "names the base's file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324: an id outside workstream 1 is seen at all — W3-T3 re-issued is refused", () => {
  const dir = planRepo({ "W3-T3-original.yaml": "W3-T3" });
  try {
    rmSync(join(dir, "plan", "tasks.d", "W3-T3-original.yaml"));
    writeFileSync(join(dir, "plan", "tasks.d", "W3-T3-reissued.yaml"), '- id: W3-T3\n  title: "t"\n');
    const r = runCheck(dir, "main");
    assert.equal(r.status, 1, "W2/W3/W12 ids are declared ids too");
    assert.match(r.stderr, /W3-T3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 FALSIFIER: the pre-fix pattern DROPPED these ids rather than truncating them", () => {
  const preFix = /^\s*-\s*id:\s*(W1-T[0-9]+)\s*$/;
  // The shipped grammar, mirrored here so this test states it rather than importing a private const.
  const DECLARED_ID_LINE_RE_FOR_TEST = /^\s*-\s*id:\s*(W[0-9]+-T[0-9]+[A-Za-z]?)\s*$/;
  for (const line of ["  - id: W1-T1B", "  - id: W1-T9a", "  - id: W3-T3"]) {
    assert.equal(preFix.exec(line), null, `${line} matched nothing before the fix — dropped, not truncated`);
  }
  // ...and matches now, which is what closed the hole.
  for (const [line, id] of [
    ["  - id: W1-T1B", "W1-T1B"],
    ["  - id: W1-T9a", "W1-T9a"],
    ["  - id: W3-T3", "W3-T3"],
  ] as const) {
    assert.equal(DECLARED_ID_LINE_RE_FOR_TEST.exec(line)?.[1], id);
  }
});
