import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// W1-T2324 (Q3, open-vs-open half) — the ERROR AND DEGRADATION ARMS of the open-PR collision
// check, driven through the module's own exported functions IN PROCESS.
//
// WHY IN PROCESS, AND WHY A SEPARATE FILE. test/task-id-existence-check.test.ts drives the CLI as
// a subprocess for the gate's end-to-end behaviour, and says in its own words why that is not
// enough here: "a subprocess's coverage is not the parent run's, and the happy path never takes
// them anyway". These arms are exactly the ones a happy-path subprocess run never reaches — an
// unparsable remote url, a detached HEAD, a `gh` that cannot run, a response that is not JSON,
// a response that is not an array. Each gets its own test rather than one "malformed input"
// case, which would pass while the rest stayed dead.
const REPO_ROOT = join(import.meta.dirname, "..");
const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

function scratchRepo(remoteUrl?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-open-pr-arms-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root, env });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root, env });
  if (remoteUrl !== undefined) execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: root, env });
  writeFileSync(join(root, "f.txt"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root, env });
  execFileSync("git", ["commit", "-qm", "c"], { cwd: root, env });
  return root;
}

/** A fake `gh` first on PATH that prints `stdout` and exits `code`. */
function fakeGh(stdout: string, code = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fake-gh-"));
  const p = join(dir, "gh");
  writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return dir;
}

function withPath<T>(dir: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

// ── resolveOwnerRepoFromGit ───────────────────────────────────────────────────────────────────

test("W1-T2324: resolveOwnerRepoFromGit parses owner/repo from the remote url", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  assert.deepEqual(mod.resolveOwnerRepoFromGit("origin", root), { owner: "acme", repo: "widgets" });
  // ssh form resolves identically — the same regex handles both separators
  const ssh = scratchRepo("git@github.com:acme/widgets.git");
  assert.deepEqual(mod.resolveOwnerRepoFromGit("origin", ssh), { owner: "acme", repo: "widgets" });
});

test("W1-T2324: an absent remote yields undefined, never a guessed owner/repo", () => {
  const root = scratchRepo(); // no remote at all -> `git config --get` exits non-zero
  assert.equal(mod.resolveOwnerRepoFromGit("origin", root), undefined);
  // and a remote whose url the pattern cannot parse is undefined too, not a partial guess
  const weird = scratchRepo("not-a-url");
  assert.equal(mod.resolveOwnerRepoFromGit("origin", weird), undefined);
});

// ── currentBranch ─────────────────────────────────────────────────────────────────────────────

test("W1-T2324: currentBranch reads the checked-out branch, and is undefined on a detached HEAD", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  assert.equal(mod.currentBranch(root), "main");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "--detach", sha], { cwd: root, env });
  assert.equal(mod.currentBranch(root), undefined, "a PR checkout in CI is detached — never guessed");
});

// ── fetchOpenPrRows ───────────────────────────────────────────────────────────────────────────

test("W1-T2324: fetchOpenPrRows returns reachable:false when gh cannot run at all", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  // An empty PATH dir shadows nothing, but `gh` is absent in this environment anyway — the arm
  // under test is "spawn failed / non-zero exit", which is exactly CI's condition (no GH_TOKEN).
  const res = mod.fetchOpenPrRows("acme", "widgets", root);
  assert.equal(res.reachable, false);
  assert.deepEqual(res.rows, [], "never degrades to rows that would read as 'no other PR claims it'");
});

test("W1-T2324: a gh that exits non-zero is reachable:false, not an empty board", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  const res = withPath(fakeGh("boom", 1), () => mod.fetchOpenPrRows("acme", "widgets", root));
  assert.equal(res.reachable, false);
});

test("W1-T2324: output that is not JSON is reachable:false — the parse arm", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  const res = withPath(fakeGh("not json at all"), () => mod.fetchOpenPrRows("acme", "widgets", root));
  assert.equal(res.reachable, false);
});

test("W1-T2324: valid JSON that is not an array is reachable:false — the shape arm", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  const res = withPath(fakeGh('{"message":"Not Found"}'), () => mod.fetchOpenPrRows("acme", "widgets", root));
  assert.equal(res.reachable, false, "a REST error object must not be read as a board");
});

test("W1-T2324: a real array is reachable:true and carries the rows through", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  const body = JSON.stringify([{ number: 7, html_url: "u7", title: "t", body: "b", head: { ref: "r" } }]);
  const res = withPath(fakeGh(body), () => mod.fetchOpenPrRows("acme", "widgets", root));
  assert.equal(res.reachable, true, "the POSITIVE control: the four false arms above are arms, not a dead read");
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].number, 7);
});

// ── evaluateOpenPrIdCollisions (and mentionedIds, through it) ─────────────────────────────────

const row = (number: number, title: string, body: string, ref: string) => ({
  number,
  html_url: `https://example.test/${number}`,
  title,
  body,
  head: { ref },
});

test("W1-T2324: an id claimed by another open PR's title, body or head ref is a collision", () => {
  const rows = [
    row(1, "adds W1-T4242", "", "mine"),
    row(2, "unrelated", "mentions W1-T4242 in the body", "theirs-body"),
    row(3, "unrelated", "", "run-W1-T4242-123"),
  ];
  const byBody = mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, "mine");
  assert.equal(byBody.length, 1);
  assert.deepEqual(byBody[0].prs.map((p: { number: number }) => p.number).sort(), [2, 3], "title, body AND head ref all scan");
});

test("W1-T2324: the PR's own row is excluded, so an added id never collides with itself", () => {
  const rows = [row(1, "adds W1-T4242", "", "mine")];
  assert.deepEqual(mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, "mine"), []);
  // ...and an unresolvable own head ref excludes nothing — the fail-open direction, which can only
  // ever flag a PR against itself (visible immediately), never miss a real cross-PR collision.
  assert.equal(mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, undefined).length, 1);
});

test("W1-T2324: no claimant means no collision, and results are sorted by id", () => {
  const rows = [row(2, "nothing here", "", "other")];
  assert.deepEqual(mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, "mine"), []);
  const many = [row(2, "W1-T9 and W1-T10 and W1-T100", "", "other")];
  const out = mod.evaluateOpenPrIdCollisions(["W1-T100", "W1-T10", "W1-T9"], many, "mine");
  assert.deepEqual(out.map((c: { id: string }) => c.id), ["W1-T10", "W1-T100", "W1-T9"], "localeCompare order, stated");
});

test("W1-T2324: a bare id substring does not match — the mention scan is word-bounded", () => {
  const rows = [row(2, "adds W1-T42421", "", "other")];
  assert.deepEqual(
    mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, "mine"),
    [],
    "W1-T4242 must not match inside W1-T42421",
  );
});

test("W1-T2324: rows with absent title/body/head survive the scan without throwing", () => {
  const rows = [{ number: 5, html_url: "u5" }, { number: 6, html_url: "u6", head: {} }];
  assert.deepEqual(mod.evaluateOpenPrIdCollisions(["W1-T4242"], rows, "mine"), []);
});

// ── addedIdsAtHead ────────────────────────────────────────────────────────────────────────────

test("W1-T2324: addedIdsAtHead propagates an unreadable base rather than guessing an empty add set", () => {
  const occ = new Map([["W1-T1", [{ file: "plan/tasks.d/a.yaml" }]]]);
  assert.deepEqual(mod.addedIdsAtHead(occ, { readable: false, byId: new Map() }), { readable: false, ids: [] });
});

test("W1-T2324: an id whose declaring file is unchanged from base is carried along, not added", () => {
  const occ = new Map([
    ["W1-T1", [{ file: "plan/tasks.d/a.yaml" }]],
    ["W1-T2", [{ file: "plan/tasks.d/b.yaml" }]],
  ]);
  const base = { readable: true, byId: new Map([["W1-T1", new Set(["plan/tasks.d/a.yaml"])]]) };
  assert.deepEqual(mod.addedIdsAtHead(occ, base), { readable: true, ids: ["W1-T2"] });
});

// ── main's open-PR wiring, IN PROCESS ─────────────────────────────────────────────────────────
//
// The block below is the only part of the open-vs-open half that lives in `main` rather than in
// an exported helper, so a subprocess run — which is how the gate's end-to-end suite drives it —
// leaves it uncovered by construction. Driven here in process instead. `main` communicates
// through `process.exitCode`, so it is saved and restored around every call.

function runMain(argv: string[]): { code: number | undefined; out: string[]; err: string[] } {
  const savedCode = process.exitCode;
  const out: string[] = [];
  const err: string[] = [];
  const so = console.log;
  const se = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    process.exitCode = undefined;
    mod.main(argv);
    return { code: process.exitCode as number | undefined, out, err };
  } finally {
    console.log = so;
    console.error = se;
    process.exitCode = savedCode;
  }
}

/** A scratch repo with a plan shard on `main` and a second shard added on a branch — the shape
 *  that makes `addedIdsAtHead` non-empty, which is what opens the open-PR block. */
function repoAddingAnId(remoteUrl: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-main-wiring-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remoteUrl);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W1-T1\n  title: base\n");
  writeFileSync(join(root, "src", "a.ts"), "// no ids cited here\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "-q", "base-ref");
  writeFileSync(join(root, "plan", "tasks.d", "W1-T4242-added.yaml"), "- id: W1-T4242\n  title: added\n");
  git("add", ".");
  git("commit", "-qm", "adds an id");
  return root;
}

test("W1-T2324: main SKIPS the open-PR check, loudly, when gh cannot be reached", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const r = runMain(["--base", "base-ref", "--cwd", root]);
  const all = [...r.out, ...r.err].join("\n");
  assert.match(all, /open-PR collision check SKIPPED/, "a stated skip, never a silent pass");
  assert.match(all, /acme\/widgets/, "and it names the repo it could not read");
  assert.notEqual(r.code, 1, "an unreachable open-PR read must not fail the gate closed");
});

test("W1-T2324: main SKIPS when owner/repo cannot be resolved from the remote", () => {
  const root = repoAddingAnId("not-a-parsable-url");
  const r = runMain(["--base", "base-ref", "--cwd", root]);
  const all = [...r.out, ...r.err].join("\n");
  assert.match(all, /could not resolve owner\/repo/, "the other skip arm, named distinctly");
  assert.notEqual(r.code, 1);
});

test("W1-T2324: main REFUSES when another open PR already claims an added id", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const rows = JSON.stringify([
    { number: 99, html_url: "https://example.test/99", title: "already claims W1-T4242", body: "", head: { ref: "theirs" } },
  ]);
  const r = withPath(fakeGh(rows), () => runMain(["--base", "base-ref", "--cwd", root, "--head-ref", "mine"]));
  const all = [...r.out, ...r.err].join("\n");
  assert.match(all, /ALREADY CLAIMED by another OPEN PR/);
  assert.match(all, /W1-T4242/);
  assert.match(all, /example\.test\/99/, "the claimant is named so the author can act");
  assert.equal(r.code, 1, "and it actually fails the gate");
});

test("W1-T2324: main stays silent when the board carries no competing claim", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const rows = JSON.stringify([{ number: 98, html_url: "u98", title: "unrelated", body: "", head: { ref: "other" } }]);
  const r = withPath(fakeGh(rows), () => runMain(["--base", "base-ref", "--cwd", root, "--head-ref", "mine"]));
  const all = [...r.out, ...r.err].join("\n");
  assert.doesNotMatch(all, /ALREADY CLAIMED/, "the POSITIVE control's counterpart: a healthy board is silent");
  assert.notEqual(r.code, 1);
});
