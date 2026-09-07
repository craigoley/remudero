import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// ── W1-T3055: A GATE THAT CANNOT SEE MUST NOT REPORT OK ─────────────────────────────────────
//
// W1-T2324 (Q3) built the open-vs-open id collision check: `evaluateOpenPrIdCollisions` refuses a
// newly ADDED shard id that another still-open PR already claims, and names that PR by url. It is
// wired into ci.yml's `task-id-existence` job and required on every pull request.
//
// IT HAD NEVER ONCE EXECUTED, AND THAT WAS KNOWN WHEN IT SHIPPED. `fetchOpenPrRows`'s own docblock
// records it: "MEASURED: CI's `task-id-existence` job carries no `GH_TOKEN` today, so `gh api`
// fails fast". W1-T2324 chose to degrade rather than refuse -- defensible for a best-effort read,
// which is why the degraded path is preserved byte for byte here -- but the token was never
// supplied, so the half answered nothing on every PR of its life. MEASURED again on run
// 34118136551, job 101729656513, head eb907a0b, a PR that ADDED three shards and so reached the
// half by construction:
//
//   task-id-existence: open-PR collision check SKIPPED -- could not read the open-PR list ...
//   task-id-existence: OK -- ... and no declared id collides with "origin/main".
//
// Job conclusion `success`: a green check whose own log says it could not perform the check. That
// is the collision nobody could see -- W1-T2996 read "free on main" while an open run-W1-T2996-*
// head already held it, which is precisely and only what this half answers.
//
// This suite pins BOTH halves of the remedy, and the second is what makes the first honest:
//   - REQUIRED (`--require-open-prs`, passed per-STEP in ci.yml alongside GH_TOKEN): an unreadable
//     surface REFUSES and names what it could not read.
//   - NOT REQUIRED (the default, and every local invocation): the skip text is unchanged BYTE FOR
//     BYTE and the exit code is still 0. `ci-parity` runs the npm entry, and W1-T2203 records a
//     whole class of lane with no working `gh`; refusing those would be a bound firing on a
//     healthy condition.
//
// The pure-function arms and the end-to-end CLI arms are both here on purpose: a subprocess's
// coverage is not the parent run's, and a suite that only drove the classifier would leave the
// wiring in `main` unproven -- the exact shape that let this check ship mute.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");

const mod = await import(pathToFileURL(SCRIPT).href);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

// The EXACT strings origin/main emitted before this change. Hard-coded rather than derived, so a
// later edit to the degraded path has to come through this assertion: the whole risk of making a
// check fail-closed is silently making it fail-closed everywhere, including on the lanes that
// legitimately cannot read the surface.
const SKIP_OWNER_REPO_BEFORE =
  'task-id-existence: open-PR collision check SKIPPED -- could not resolve owner/repo from remote "origin"\'s url. ' +
  "Pass --owner/--repo to enable it.";
const SKIP_OPEN_PR_LIST_BEFORE =
  "task-id-existence: open-PR collision check SKIPPED -- could not read the open-PR list for craigoley/remudero " +
  "(network blip, or `gh` has no credentials in this environment). An id claimed only by another still-open PR " +
  "cannot be checked until this read succeeds; the base-collision check above already ran and is unaffected.";

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-blind-gate-${prefix}-`));
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/**
 * A fixture repo whose BASE commit declares one shard and whose WORKING TREE adds a second — the
 * only shape that reaches the open-PR half at all, since `addedIdsAtHead` takes a set difference
 * against the base and an empty added set skips the half for a legitimate reason.
 */
function mkRepoAddingOneId(baseId: string, addedId: string): { root: string; base: string } {
  const root = mkTmp("repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "# empty\n");
  writeFileSync(join(root, "plan", "tasks.d", `${baseId}.yaml`), `- id: ${baseId}\n  title: "base"\n`);
  execFileSync("git", ["init", "--quiet", "-b", "main", root], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", root, "add", "."], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "base"], { encoding: "utf8", env: GIT_ENV });
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: GIT_ENV }).trim();
  writeFileSync(join(root, "plan", "tasks.d", `${addedId}.yaml`), `- id: ${addedId}\n  title: "added"\n`);
  return { root, base };
}

function writeBaseline(dir: string): string {
  const path = join(dir, "baseline.json");
  writeFileSync(path, "[]");
  return path;
}

/** Drive the real CLI. `noGh` PREPENDS a directory holding a `gh` that exits non-zero, so the
 *  open-PR list is unreadable DETERMINISTICALLY — on a host with a working `gh` (a CI runner) and
 *  on one with none (an agent container) alike. Deliberately not an emptied PATH: `git` is on the
 *  same PATH, and removing it makes the BASE unreadable too, which fails the run for a different
 *  reason and would have proved nothing about the open-PR half. */
function runCli(args: string[], opts: { noGh?: boolean } = {}) {
  let env: NodeJS.ProcessEnv = GIT_ENV;
  if (opts.noGh) {
    const shimDir = mkTmp("gh-fails");
    writeFileSync(join(shimDir, "gh"), "#!/bin/sh\necho 'gh: no credentials' >&2\nexit 1\n", { mode: 0o755 });
    env = { ...GIT_ENV, PATH: `${shimDir}:${process.env.PATH ?? ""}` };
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

// ── the decision layer, both arms, driven directly ──────────────────────────────────────────

test("W1-T3055: REQUIRED — an unreadable open-PR list refuses and names the repo it could not read", () => {
  const v = mod.classifyUnreadableOpenPrSurface("open-pr-list", { owner: "craigoley", repo: "remudero" }, true);
  assert.equal(v.refuse, true);
  assert.match(v.message, /FAILED/);
  assert.match(v.message, /craigoley\/remudero/, "the refusal must name the surface it could not read");
  assert.match(v.message, /GH_TOKEN/, "and must name the concrete remedy, not just the symptom");
  assert.doesNotMatch(v.message, /SKIPPED/);
});

test("W1-T3055: REQUIRED — an unresolvable owner/repo refuses and names the remote", () => {
  const v = mod.classifyUnreadableOpenPrSurface("owner-repo", { remote: "weird" }, true);
  assert.equal(v.refuse, true);
  assert.match(v.message, /FAILED/);
  assert.match(v.message, /"weird"/, "the refusal must name the remote whose url would not parse");
});

test("W1-T3055: REQUIRED — no readable base refuses, so a missing --base cannot mute the half silently", () => {
  const v = mod.classifyUnreadableOpenPrSurface("no-base", {}, true);
  assert.equal(v.refuse, true);
  assert.match(v.message, /FAILED/);
  assert.match(v.message, /no readable base/);
});

test("W1-T3055: NOT REQUIRED — every arm still SKIPs, and the two live texts are byte-identical to before", () => {
  const list = mod.classifyUnreadableOpenPrSurface("open-pr-list", { owner: "craigoley", repo: "remudero" }, false);
  assert.equal(list.refuse, false);
  assert.equal(list.message, SKIP_OPEN_PR_LIST_BEFORE, "the degraded text must not drift for lanes that rely on it");

  const ownerRepo = mod.classifyUnreadableOpenPrSurface("owner-repo", { remote: "origin" }, false);
  assert.equal(ownerRepo.refuse, false);
  assert.equal(ownerRepo.message, SKIP_OWNER_REPO_BEFORE);

  const noBase = mod.classifyUnreadableOpenPrSurface("no-base", {}, false);
  assert.equal(noBase.refuse, false);
  assert.match(noBase.message, /SKIPPED/);
});

test("W1-T3055: the flag is what decides, and it decides the DISPOSITION rather than the diagnosis", () => {
  // The same unreadable surface under both flags: the message must say the same thing happened
  // (the repo could not be read) while only the consequence changes. A refusal that reported a
  // DIFFERENT cause under the flag would be a second diagnosis to keep in sync.
  const ctx = { owner: "craigoley", repo: "remudero" };
  const skipped = mod.classifyUnreadableOpenPrSurface("open-pr-list", ctx, false);
  const refused = mod.classifyUnreadableOpenPrSurface("open-pr-list", ctx, true);
  assert.notEqual(skipped.refuse, refused.refuse);
  for (const m of [skipped.message, refused.message]) {
    assert.match(m, /could not read the open-PR list for craigoley\/remudero/);
  }
  // Positive control on the discriminator itself: `required` is read as a strict boolean, so an
  // absent flag (undefined) is the PERMISSIVE case and never accidentally the refusing one.
  assert.equal(mod.classifyUnreadableOpenPrSurface("open-pr-list", ctx, undefined).refuse, false);
});

test("W1-T3055: every declared failure kind is classified — no kind falls through to a default", () => {
  // A `kind` the classifier does not know must not silently render as the open-PR-list text, which
  // would attribute a failure to the wrong surface. Drive the declared list rather than a literal.
  assert.deepEqual(mod.OPEN_PR_SURFACE_FAILURES, ["owner-repo", "open-pr-list", "no-base"]);
  const messages = new Set(
    mod.OPEN_PR_SURFACE_FAILURES.map(
      (k: string) => mod.classifyUnreadableOpenPrSurface(k, { remote: "r", owner: "o", repo: "p" }, true).message,
    ),
  );
  assert.equal(messages.size, mod.OPEN_PR_SURFACE_FAILURES.length, "each kind must produce a distinct message");
});

// ── the same behaviour end-to-end, through the real CLI and a real exit code ─────────────────

test("W1-T3055: CLI — an unreadable open-PR list REFUSES with a non-zero exit when required", () => {
  const { root, base } = mkRepoAddingOneId("W1-T90001", "W1-T90002");
  try {
    const r = runCli(
      ["--cwd", root, "--baseline", writeBaseline(root), "--dir", "src", "--base", base,
       "--owner", "craigoley", "--repo", "remudero", "--head-ref", "some-branch", "--require-open-prs"],
      { noGh: true },
    );
    assert.notEqual(r.status, 0, `expected a refusal, got exit ${r.status}:\n${r.all}`);
    assert.match(r.all, /FAILED -- the open-PR collision check was REQUIRED/);
    assert.match(r.all, /craigoley\/remudero/);
  } finally {
    cleanup(root);
  }
});

test("W1-T3055: CLI — THE REGRESSION ITSELF: the same run without the flag still exits 0 and still SKIPs", () => {
  // This is the arm that must NOT change. It is the pre-fix behaviour, and it stays the behaviour
  // for every lane that has no working `gh` — W1-T2203's 403 lanes and `preflight --ci-parity`.
  const { root, base } = mkRepoAddingOneId("W1-T90003", "W1-T90004");
  try {
    const r = runCli(
      ["--cwd", root, "--baseline", writeBaseline(root), "--dir", "src", "--base", base,
       "--owner", "craigoley", "--repo", "remudero", "--head-ref", "some-branch"],
      { noGh: true },
    );
    assert.equal(r.status, 0, `expected a clean skip, got exit ${r.status}:\n${r.all}`);
    assert.match(r.all, /open-PR collision check SKIPPED -- could not read the open-PR list/);
    assert.doesNotMatch(r.all, /the open-PR collision check was REQUIRED/);
  } finally {
    cleanup(root);
  }
});

test("W1-T3055: CLI — a readable surface naming no collision passes WITH the flag, so the refusal turns on the READ", () => {
  // Without this the suite would pass over an implementation that refused whenever the flag was
  // set, which is a gate that blocks every PR rather than one that checks anything.
  const { root, base } = mkRepoAddingOneId("W1-T90005", "W1-T90006");
  const binDir = mkTmp("fake-gh");
  try {
    // A `gh` that really is on PATH and really returns an empty open-PR list. Not an injected
    // seam: the CLI resolves and executes this exactly as it would the real binary.
    const gh = join(binDir, "gh");
    writeFileSync(gh, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--cwd", root, "--baseline", writeBaseline(root), "--dir", "src", "--base", base,
       "--owner", "craigoley", "--repo", "remudero", "--head-ref", "some-branch", "--require-open-prs"],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...GIT_ENV, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
    );
    const all = r.stdout + r.stderr;
    assert.equal(r.status, 0, `a readable surface with no collision must pass:\n${all}`);
    assert.doesNotMatch(all, /SKIPPED -- could not read the open-PR list/);
    assert.doesNotMatch(all, /the open-PR collision check was REQUIRED/);
  } finally {
    cleanup(root, binDir);
  }
});

test("W1-T3055: CLI — a real collision on an open PR is still REFUSED, and still names that PR", () => {
  // The behaviour W1-T2324 built and W1-T3016 asked for, proved end-to-end now that the surface is
  // actually readable. Without this the fix could wire a token to a check that no longer refuses.
  const { root, base } = mkRepoAddingOneId("W1-T90007", "W1-T90008");
  const binDir = mkTmp("fake-gh-collide");
  try {
    const rows = JSON.stringify([
      { number: 4242, html_url: "https://github.com/craigoley/remudero/pull/4242",
        title: "feat: something (W1-T90008)", body: "", head: { ref: "run-W1-T90008-1" } },
    ]);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh\ncat <<'EOF'\n${rows}\nEOF\n`, { mode: 0o755 });
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--cwd", root, "--baseline", writeBaseline(root), "--dir", "src", "--base", base,
       "--owner", "craigoley", "--repo", "remudero", "--head-ref", "mine", "--require-open-prs"],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...GIT_ENV, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
    );
    const all = r.stdout + r.stderr;
    assert.notEqual(r.status, 0, `a real open-PR collision must refuse:\n${all}`);
    assert.match(all, /ALREADY CLAIMED by another OPEN PR/);
    assert.match(all, /pull\/4242/, "the refusal must name the claiming PR");
  } finally {
    cleanup(root, binDir);
  }
});

// ── the wiring, without which none of the above ever runs ────────────────────────────────────

test("W1-T3055: the ci.yml step supplies a token AND requires the read — the wiring the docblock measured as absent", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

  // Extract THIS job's block, the same way the W1-T1048 falsifier does, so a GH_TOKEN belonging to
  // some other job (commitlint has had one all along) cannot satisfy this assertion.
  const jobStart = ciYml.indexOf("\n  task-id-existence:\n");
  assert.notEqual(jobStart, -1, "task-id-existence job block not found");
  const nextJob = /\n {2}[a-zA-Z0-9_-]+:\n/.exec(ciYml.slice(jobStart + 1));
  const jobBlock = nextJob ? ciYml.slice(jobStart, jobStart + 1 + nextJob.index) : ciYml.slice(jobStart);

  assert.match(jobBlock, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, "the job must pass a token; `gh api` is unauthenticated without one");
  assert.match(jobBlock, /--require-open-prs/, "and must require the read, or an outage silently reports OK again");

  // POSITIVE CONTROL on the extraction itself: the slice must be this job and not the whole file,
  // or both assertions above would pass on commitlint's token 700 lines away.
  assert.match(jobBlock, /task-id-existence:check/);
  assert.doesNotMatch(jobBlock, /commitlint/);
});

test("W1-T3055: the npm entry stays PERMISSIVE, so ci-parity does not refuse a lane for its environment", async () => {
  // `ci-parity` registers this job as npmScriptEntry("task-id-existence", "task-id-existence:check")
  // and therefore runs the NPM ENTRY, not the workflow's `run:` line. If the flag migrated into
  // package.json, every local `rmd preflight --ci-parity` on a host without `gh` would fail — the
  // bound-firing-on-a-healthy-condition defect, aimed straight at W1-T2203's 403 lanes.
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const entry: string = pkg.scripts["task-id-existence:check"];
  assert.ok(entry, "the npm entry must exist — ci.yml and ci-parity both resolve the job through it");
  assert.doesNotMatch(entry, /--require-open-prs/, "the requirement belongs to the ci.yml STEP, never the shared entry");
  assert.match(entry, /--base origin\/main/, "and the base-collision half must still be wired there");
});
