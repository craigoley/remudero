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

// ── W1-T3070: a mention is a suspicion, not a claim ───────────────────────────────────────────
//
// The six W1-T2324 assertions above are UNEDITED and still green, and that is this task's control:
// the fix narrows the gate on positive evidence rather than relaxing a pinned ruling. It stays
// green because `evaluateOpenPrIdCollisions` reaches confirmation only when handed a
// `confirmDeclares`, and because an unconfirmable answer keeps the refusal — those fixture rows
// carry no file evidence, so they remain collisions exactly as W1-T2324 pinned them.

/** A `gh` that answers the PR LIST and the PR FILES calls DIFFERENTLY, discriminated on the `/files`
 *  path. `fakeGh` above answers every call with one body, which cannot drive this seam at all. */
function fakeGhRouting(listJson: string, filesJson: string, filesCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fake-gh-routed-"));
  const p = join(dir, "gh");
  writeFileSync(
    p,
    `#!/bin/sh\ncase "$*" in\n  */files*) cat <<'EOF'\n${filesJson}\nEOF\n    exit ${filesCode} ;;\nesac\ncat <<'EOF'\n${listJson}\nEOF\nexit 0\n`,
  );
  chmodSync(p, 0o755);
  return dir;
}

const planFile = (patch: string) => ({ filename: "plan/tasks.d/W1-T4242-a-thing.yaml", patch });
const srcFile = (filename: string) => ({ filename, patch: "@@ -1 +1 @@\n+const x = 1;\n" });

// ── prDeclaredIdsFromFiles ────────────────────────────────────────────────────────────────────

test("W1-T3070: a changed plan file that ADDS an `- id:` line declares that id", () => {
  const r = mod.prDeclaredIdsFromFiles([planFile("@@ -0,0 +1,2 @@\n+- id: W1-T4242\n+  title: x\n")]);
  assert.equal(r.readable, true);
  assert.deepEqual([...r.ids], ["W1-T4242"]);
});

test("W1-T3070: a build PR touching only src/ and test/ declares nothing, and that is READABLE", () => {
  const r = mod.prDeclaredIdsFromFiles([srcFile("src/lib/status.ts"), srcFile("test/a-thing.test.ts")]);
  assert.equal(r.readable, true, "a non-plan file cannot declare an id, so it says nothing either way");
  assert.equal(r.ids.size, 0, "and THIS is the case the whole task exists for");
});

test("W1-T3070: a REMOVED id line is not a declaration, and a `+++` header is not one either", () => {
  const r = mod.prDeclaredIdsFromFiles([planFile("@@ -1,2 +0,0 @@\n-- id: W1-T4242\n-  title: x\n")]);
  assert.equal(r.readable, true);
  assert.equal(r.ids.size, 0, "deleting a shard does not claim its id");
  const hdr = mod.prDeclaredIdsFromFiles([planFile("+++ b/plan/tasks.d/W1-T4242-a-thing.yaml\n@@ -0,0 +1 @@\n+- id: W1-T4242\n")]);
  assert.deepEqual([...hdr.ids], ["W1-T4242"], "the header is skipped, the real add is still read");
});

test("W1-T3070: plan/tasks.yaml is a declaring surface too, and a nested or non-yaml path is not", () => {
  const top = mod.prDeclaredIdsFromFiles([{ filename: "plan/tasks.yaml", patch: "@@ -0,0 +1 @@\n+- id: W1-T4242\n" }]);
  assert.deepEqual([...top.ids], ["W1-T4242"], "the monolithic plan file declares");
  const doc = mod.prDeclaredIdsFromFiles([{ filename: "docs/plan/tasks.d/W1-T4242.yaml", patch: "@@ -0,0 +1 @@\n+- id: W1-T4242\n" }]);
  assert.equal(doc.ids.size, 0, "a lookalike path outside plan/ declares nothing");
  assert.equal(doc.readable, true);
});

test("W1-T3070: an id with a lettered suffix or another workstream is captured, not mismatched", () => {
  const r = mod.prDeclaredIdsFromFiles([planFile("@@ -0,0 +1,2 @@\n+- id: W1-T4242b\n+- id: W3-T3\n")]);
  assert.deepEqual([...r.ids].sort(), ["W1-T4242b", "W3-T3"], "DECLARED_ID_LINE_RE's whole-line match rides through");
});

test("W1-T3070: every unreadable SHAPE keeps the answer unreadable — never 'declares nothing'", () => {
  // Each arm is separate on purpose: one "malformed input" case would pass while the rest died.
  assert.equal(mod.prDeclaredIdsFromFiles(undefined).readable, false, "not an array at all");
  assert.equal(mod.prDeclaredIdsFromFiles({ files: [] }).readable, false, "an object, not an array");
  assert.equal(mod.prDeclaredIdsFromFiles([]).readable, false, "an empty list — every real PR changes a file");
  assert.equal(mod.prDeclaredIdsFromFiles([{ number: 7, title: "not a file row" }]).readable, false, "a row with no filename");
  assert.equal(mod.prDeclaredIdsFromFiles([{ filename: "plan/tasks.d/x.yaml" }]).readable, false, "a plan file whose patch is withheld");
  assert.equal(
    mod.prDeclaredIdsFromFiles(Array.from({ length: mod.PR_FILES_PAGE_CAP }, () => srcFile("src/a.ts"))).readable,
    false,
    "a list at the page cap may be truncated, and a truncated list under-reports declarations",
  );
  // THE POSITIVE CONTROL for the six arms above: one row under the cap reads fine.
  assert.equal(mod.prDeclaredIdsFromFiles([srcFile("src/a.ts")]).readable, true);
});

test("W1-T3070: an unreadable ROW does not blind the rest of the list", () => {
  const r = mod.prDeclaredIdsFromFiles([planFile("@@ -0,0 +1 @@\n+- id: W1-T4242\n"), { filename: "plan/tasks.d/y.yaml" }]);
  assert.equal(r.readable, false, "the withheld patch still makes the whole answer unreadable");
  assert.deepEqual([...r.ids], ["W1-T4242"], "and what WAS read is still reported, so the refusal names a real id");
});

// ── evaluateOpenPrIdCollisions, confirmed ─────────────────────────────────────────────────────

const suspectRow = row(2, "fix(status): a thing (W1-T4242)", "", "run-W1-T4242-build-1788812945000");

test("W1-T3070: a suspect that declares no plan record is CLEARED — the sibling build PR case", () => {
  const declaresNothing = () => ({ readable: true, ids: new Set<string>() });
  assert.deepEqual(
    mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine", declaresNothing),
    [],
    "the build PR is its filing's sibling, not a rival claimant",
  );
});

test("W1-T3070: a suspect that DOES declare the id is still refused — the real collision is untouched", () => {
  const declaresIt = () => ({ readable: true, ids: new Set(["W1-T4242"]) });
  const out = mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine", declaresIt);
  assert.equal(out.length, 1, "two PRs each adding a shard for one id is exactly what this gate exists to catch");
  assert.deepEqual(out[0].prs.map((p: { number: number }) => p.number), [2]);
});

test("W1-T3070: confirmation is ONE-WAY — an unreadable or absent verdict KEEPS the refusal", () => {
  const unreadable = () => ({ readable: false, ids: new Set<string>() });
  assert.equal(mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine", unreadable).length, 1, "unreadable");
  assert.equal(mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine", () => undefined).length, 1, "no verdict at all");
  assert.equal(mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine", () => ({ ids: new Set() })).length, 1, "readable absent");
  // AND THE OMITTED SEAM IS THE ORIGINAL BEHAVIOUR, stated rather than inferred from the arms above.
  assert.equal(mod.evaluateOpenPrIdCollisions(["W1-T4242"], [suspectRow], "mine").length, 1, "no confirmer: every mention is a claim");
});

test("W1-T3070: confirmation runs only on SUSPECTS, so a healthy board costs no files reads", () => {
  const calls: number[] = [];
  const confirm = (r: { number: number }) => {
    calls.push(r.number);
    return { readable: true, ids: new Set<string>() };
  };
  mod.evaluateOpenPrIdCollisions(["W1-T4242"], [row(9, "unrelated", "", "other"), suspectRow], "mine", confirm);
  assert.deepEqual(calls, [2], "the unrelated PR is never fetched — the mention scan stays the cheap prefilter");
});

// ── fetchPrChangedFiles ───────────────────────────────────────────────────────────────────────

test("W1-T3070: every fetchPrChangedFiles failure folds to unreadable, and the happy path does not", () => {
  const root = scratchRepo("https://github.com/acme/widgets.git");
  assert.equal(withPath(fakeGh("[]", 1), () => mod.fetchPrChangedFiles("acme", "widgets", 7, root)).readable, false, "gh exits non-zero");
  assert.equal(withPath(fakeGh("not json"), () => mod.fetchPrChangedFiles("acme", "widgets", 7, root)).readable, false, "unparsable");
  assert.equal(withPath(fakeGh('{"message":"Not Found"}'), () => mod.fetchPrChangedFiles("acme", "widgets", 7, root)).readable, false, "not an array");
  const ok = withPath(fakeGh('[{"filename":"src/a.ts","patch":"@@\\n+x\\n"}]'), () => mod.fetchPrChangedFiles("acme", "widgets", 7, root));
  assert.equal(ok.readable, true, "the POSITIVE control: the three arms above are arms, not a dead read");
  assert.equal(ok.files.length, 1);
});

// ── end to end, through main ──────────────────────────────────────────────────────────────────

test("W1-T3070: main CLEARS a sibling build PR and the gate passes — the deadlock is gone", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const list = JSON.stringify([
    { number: 4488, html_url: "https://example.test/4488", title: "fix(status): a thing (W1-T4242)", body: "", head: { ref: "run-W1-T4242-build-1" } },
  ]);
  const files = JSON.stringify([{ filename: "src/lib/status.ts", patch: "@@ -1 +1 @@\n+const x = 1;\n" }]);
  const r = withPath(fakeGhRouting(list, files), () => runMain(["--base", "base-ref", "--cwd", root, "--head-ref", "mine"]));
  const all = [...r.out, ...r.err].join("\n");
  assert.doesNotMatch(all, /ALREADY CLAIMED/, "a build PR that changes no plan file is not a claimant");
  assert.match(all, /PR #4488 mentions W1-T4242 but declares no plan record for it/, "and the clearing is ANNOUNCED, never silent");
  assert.notEqual(r.code, 1, "the filing PR can merge");
});

test("W1-T3070: main still REFUSES when the other PR really declares the id", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const list = JSON.stringify([
    { number: 4488, html_url: "https://example.test/4488", title: "also files W1-T4242", body: "", head: { ref: "theirs" } },
  ]);
  const files = JSON.stringify([{ filename: "plan/tasks.d/W1-T4242-theirs.yaml", patch: "@@ -0,0 +1 @@\n+- id: W1-T4242\n" }]);
  const r = withPath(fakeGhRouting(list, files), () => runMain(["--base", "base-ref", "--cwd", root, "--head-ref", "mine"]));
  const all = [...r.out, ...r.err].join("\n");
  assert.match(all, /ALREADY CLAIMED by another OPEN PR/, "the POSITIVE control for the test above");
  assert.equal(r.code, 1);
});

test("W1-T3070: main keeps the refusal when the files read FAILS — no false zero opens the gate", () => {
  const root = repoAddingAnId("https://github.com/acme/widgets.git");
  const list = JSON.stringify([
    { number: 4488, html_url: "https://example.test/4488", title: "claims W1-T4242", body: "", head: { ref: "theirs" } },
  ]);
  const r = withPath(fakeGhRouting(list, "[]", 1), () => runMain(["--base", "base-ref", "--cwd", root, "--head-ref", "mine"]));
  const all = [...r.out, ...r.err].join("\n");
  assert.match(all, /could not read PR #4488's changed files/, "the degrade is REPORTED in the script's own voice");
  assert.match(all, /ALREADY CLAIMED by another OPEN PR/, "and it refuses rather than passing");
  assert.equal(r.code, 1);
});
