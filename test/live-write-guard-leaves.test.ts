import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ghPrMergeSquash } from "../src/lib/worker.js";
import { ghPrCreateFillCommand, lastCommitSubject } from "../src/run-task.js";
import { ghIssueGateway } from "../src/lib/escalate.js";
import { defaultGitCapture, defaultPushExec, gitPushRunBranch } from "../src/lib/git-push.js";
import { LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// W1-T327: drives the emitted title through the REAL commitlint CLI, the same subprocess
// shape test/commit-message.test.ts already uses — never a hand-rolled regex approximating
// commitlint.config.mjs's rules.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const COMMITLINT_CONFIG = join(REPO_ROOT, "commitlint.config.mjs");
function lintHeader(header: string) {
  return spawnSync(process.execPath, [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", COMMITLINT_CONFIG], {
    cwd: REPO_ROOT,
    input: `${header}\n`,
    encoding: "utf8",
  });
}

// ── LEAF-LEVEL GUARD PROOFS ──────────────────────────────────────────────────────────
// PR #954 guards 18 outward-effect sites. A structural test asserts each site EXISTS; until
// this file, nothing asserted that a LEAF actually FIRES. A guard that is present but unproven
// is a guard nobody has shown works.
//
// impl-AX's leaf inventory found that three of the four outward operations already guard at a
// shared leaf, and `git-push` has NO leaf at all (nine inlined execFileSync calls across seven
// top-level functions). These tests cover the leaves that exist and lacked a refusal proof.
//
// EACH test asserts the OBSERVABLE REFUSAL, never merely that the line executed:
//   1. the error is thrown AND names its own boundary;
//   2. the outward command is NOT run — proven by a PATH-shimmed binary that appends every
//      invocation to a log, so "no call happened" is evidence on disk, not an assumption;
//   3. a WOULD-HAVE-FIRED control re-runs the same call inside `withLiveWritesAllowed` and
//      shows the command DOES reach the shim. Without (3), an empty log could equally mean the
//      test never reached the call site — which is the coverage theatre impl-AW demonstrated.
//
// Its own file, never appended to test/run-task.test.ts: that file crashes at the FILE level
// under --experimental-test-coverage often enough to zero a coverage-load-bearing record.

/** A shimmed executable on PATH that appends each invocation's argv to `log`, then exits 0. */
function shimBin(dir: string, name: string, log: string): void {
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    { mode: 0o755 },
  );
}

function callsIn(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function withShimmedPath<T>(name: string, fn: (log: string) => T): T {
  const bin = mkdtempSync(join(tmpdir(), `rmd-leaf-${name}-`));
  const log = join(bin, "calls.log");
  shimBin(bin, name, log);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn(log);
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

// ── LEAF: worker.ts ghPrMergeSquash — boundary "gh-pr-merge" ──────────────────────────
test("LEAF GUARD gh-pr-merge: ghPrMergeSquash REFUSES under the test runner and gh is never invoked", () => {
  withShimmedPath("gh", (log) => {
    let caught: unknown;
    try {
      ghPrMergeSquash("https://github.com/acme/remudero/pull/7");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
    assert.match(String((caught as Error).message), /gh-pr-merge/, "the error names its own boundary");
    assert.deepEqual(callsIn(log), [], "gh was never invoked — the merge did not happen");

    // WOULD-HAVE-FIRED control: exempted, the identical call DOES reach gh.
    withLiveWritesAllowed(() => ghPrMergeSquash("https://github.com/acme/remudero/pull/7"));
    const calls = callsIn(log);
    assert.equal(calls.length, 1, "exempted, the same call reaches gh exactly once");
    assert.match(calls[0], /pr merge .*--squash/, "and it is the squash-merge that was refused");
  });
});

// ── LEAF: run-task.ts ghPrCreateFillCommand — boundary "gh-pr-create" ─────────────────
// This leaf is a BUILDER: it returns an argv rather than executing it, and four executors
// route through it (run-task.ts:3545/:5147/:8390/:8601), so refusing here covers all four.
// The observable refusal is therefore the throw plus the ABSENCE of a returned command —
// a caller that cannot get an argv cannot open a PR.
//
// W1-T1202: the builder moved from `gh pr create --fill` (GraphQL) to `gh api --method
// POST repos/{owner}/{repo}/pulls` (REST) — same guard, same key, different argv shape.
test("LEAF GUARD gh-pr-create: the ghPrCreateFillCommand builder REFUSES, so its four executors get no argv to run", () => {
  let caught: unknown;
  let built: unknown;
  try {
    built = ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError, "the builder refused with LiveWriteBlockedError");
  assert.match(String((caught as Error).message), /gh-pr-create/, "the error names its own boundary");
  assert.equal(built, undefined, "no argv was produced — an executor has nothing to run");

  // WOULD-HAVE-FIRED control: exempted, the builder yields the real REST-create argv.
  const ok = withLiveWritesAllowed(() => ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123"));
  assert.equal(ok.command, "gh");
  assert.deepEqual(ok.args.slice(0, 4), ["api", "--method", "POST", "repos/acme/remudero/pulls"]);
  assert.ok(!ok.args.includes("pr"), "no `gh pr create` subcommand — GraphQL is never issued");
  assert.ok(!ok.args.includes("create"), "no `gh pr create` subcommand — GraphQL is never issued");
});

// W1-T327: `--fill` alone let `gh pr create` invent a title from the branch/commits, and
// nothing in this repo can repair one afterwards (the three `gh pr edit` sites all pass
// `--body` only) — a non-conventional title then fails the REQUIRED `commitlint` check on a
// PR whose commits are individually clean. The fix authors the title instead of inheriting
// one: ghPrCreateFillCommand takes an explicit `title` and emits it as `-f title=<title>`
// (W1-T1202: the REST equivalent of the old `--title` flag).
test("LEAF GUARD gh-pr-create: an explicit title is emitted as -f title=<title> and passes the REAL commitlint gate", () => {
  const title = "feat(serve): add fuzzy search to the board (W1-T157)";
  const ok = withLiveWritesAllowed(() =>
    ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123", title),
  );

  // REGRESSION LOCK: if the authored title is ever dropped from the argv again, this
  // fails — the whole point of W1-T327 is that an un-authored title is what lets a
  // non-conventional title through uncontested.
  const titleIdx = ok.args.indexOf(`title=${title}`);
  assert.notEqual(titleIdx, -1, "the argv must carry a title=<title> field — an omitted title is the W1-T327 defect");
  assert.equal(ok.args[titleIdx - 1], "-f", "title is carried as a -f field, the REST create's mechanism");

  const lint = lintHeader(title);
  assert.equal(lint.status, 0, `the emitted title must pass the real commitlint CLI:\n${lint.stdout}${lint.stderr}`);
});

test("LEAF GUARD gh-pr-create: a branch-shaped, non-conventional title is what commitlint actually rejects", () => {
  // OBSERVED 2026-08-04 on #1249: `--fill` derived `run W1 T313 1785801110471` from the
  // branch name and commitlint failed subject-empty + type-empty. Pinned here so the
  // FALSIFIER above (title supplied → passes) has a paired proof that an un-authored
  // title (the pre-fix shape) genuinely fails the same real gate.
  const lint = lintHeader("run W1 T313 1785801110471");
  assert.notEqual(lint.status, 0, "a branch-shaped title must be rejected by the real gate");
  assert.match(lint.stdout + lint.stderr, /subject-empty|type-empty/);
});

test("LEAF GUARD gh-pr-create: an omitted title (and unreadable git history) falls back to the branch name — the documented no-title decision", () => {
  // "/tmp/wt" is not a real git repo, so lastCommitSubject's own read fails too (design
  // iv's SECOND fallback tier) — the builder must still produce a usable title rather
  // than refuse, falling back to the branch name (the LAST tier), and it must say so in
  // the body rather than silently substituting it.
  const ok = withLiveWritesAllowed(() => ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123"));
  assert.ok(ok.args.includes("title=run-T1-123"), "no title anywhere => falls back to the branch name");
  const bodyField = ok.args.find((a) => a.startsWith("body="));
  assert.match(
    bodyField ?? "",
    /run-T1-123/,
    "the branch-name fallback is STATED in the body, never a silent substitution (design iv)",
  );
});

// lastCommitSubject feeds the title into the implement/retro call sites (the two paths whose
// commit is worker-authored, so there is no harness-computed subject variable to reuse) — it
// reads the ACTUAL committed subject back from git, never a second derivation.
test("lastCommitSubject: reads back the real last-commit subject from a worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-last-commit-subject-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8" });
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "feat(x): the real committed subject"]);
    assert.equal(lastCommitSubject(dir), "feat(x): the real committed subject");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastCommitSubject: a git failure (no commit / not a repo) returns undefined, never throws — the no-title fallback path", () => {
  // A directory that is not a git repo at all: `git -C <dir> log -1 --format=%s` fails, which
  // is the exact "no title available" case ghPrCreateFillCommand's doc comment decides —
  // undefined here is what makes a call site fall back to --fill alone.
  const dir = mkdtempSync(join(tmpdir(), "rmd-last-commit-subject-fail-"));
  try {
    assert.equal(lastCommitSubject(dir), undefined, "no repo at all => undefined, not a throw");
    assert.equal(lastCommitSubject("/no/such/path/at/all"), undefined, "a nonexistent path => undefined too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── LEAF: escalate.ts ghIssueGateway().create — boundary "gh-issue-create" ────────────
// This leaf takes an injectable `exec`, so the un-made call is observable directly: the
// injected exec records every invocation and must record none.
test("LEAF GUARD gh-issue-create: ghIssueGateway create REFUSES and its injected exec is never called", () => {
  const seen: string[][] = [];
  const gateway = ghIssueGateway("acme", "remudero", {
    exec: (args) => {
      seen.push(args);
      return "https://github.com/acme/remudero/issues/1\n";
    },
  });

  let caught: unknown;
  try {
    gateway.create("[BLOCKED] leaf guard probe", "body", []);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
  assert.match(String((caught as Error).message), /gh-issue-create/, "the error names its own boundary");
  assert.equal(seen.length, 0, "the injected exec was never reached — no issue was filed");

  // WOULD-HAVE-FIRED control: exempted, the identical call reaches the exec exactly once.
  withLiveWritesAllowed(() => gateway.create("[BLOCKED] leaf guard probe", "body", []));
  assert.equal(seen.length, 1, "exempted, the same call reaches the exec exactly once");
  assert.deepEqual(seen[0].slice(0, 4), ["issue", "create", "--repo", "acme/remudero"]);
});

// ── LEAF: lib/git-push.ts gitPushRunBranch — boundary "git-push" ─────────────────────
// Extracted by impl-BA. Nine inlined execFileSync calls across seven top-level functions in
// two files now route through this one helper, so the guard is at the leaf like the other
// three operations. The `exec` seam is what makes it testable at all: six of those nine
// sites sat after a spawnWorker call inside commands with no injectable deps.
test("LEAF GUARD git-push: gitPushRunBranch REFUSES and the injected exec is never reached", () => {
  const seen: Array<{ file: string; args: string[] }> = [];
  const rec = (file: string, args: string[]) => {
    seen.push({ file, args });
  };

  let caught: unknown;
  try {
    gitPushRunBranch("/tmp/wt", { exec: rec });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
  assert.match(String((caught as Error).message), /git-push/, "the error names its own boundary");
  assert.equal(seen.length, 0, "the injected exec was never reached — nothing was pushed");

  // WOULD-HAVE-FIRED control: exempted, the identical call reaches the exec exactly once
  // with the argv every former call site used. Without this, an empty log could equally
  // mean the test never arrived at the boundary.
  withLiveWritesAllowed(() => gitPushRunBranch("/tmp/wt", { exec: rec }));
  assert.equal(seen.length, 1, "exempted, the same call reaches the exec exactly once");
  assert.equal(seen[0].file, "git");
  assert.deepEqual(seen[0].args, ["-C", "/tmp/wt", "push", "origin", "HEAD"]);
});

// The two best-effort sites (run-task.ts fix rungs) SWALLOW a thrown refusal in their own
// `try/catch`, so for them `assert.throws` would pass vacuously. The observable there is the
// UN-MADE CALL, which this pins directly: the refusal propagates out of the helper, and the
// caller's catch is what discards it — so the push still never happens.
test("LEAF GUARD git-push: a swallowed best-effort caller still makes no push — the refusal is what it swallows", () => {
  const seen: string[][] = [];
  const rec = (_file: string, args: string[]) => {
    seen.push(args);
  };
  // Exactly the shape of run-task.ts's fix-rung push closure.
  const bestEffortPush = (wt: string) => {
    try {
      gitPushRunBranch(wt, { stdio: "ignore", exec: rec });
    } catch {
      /* best-effort — mirrors the real caller */
    }
  };

  assert.doesNotThrow(() => bestEffortPush("/tmp/wt"), "the caller swallows it, so nothing propagates");
  assert.equal(seen.length, 0, "and NO push was made — the un-made call is the only observable here");

  withLiveWritesAllowed(() => bestEffortPush("/tmp/wt"));
  assert.equal(seen.length, 1, "exempted, the same best-effort caller does push");
  assert.deepEqual(seen[0], ["-C", "/tmp/wt", "push", "origin", "HEAD"]);
});

// spike.ts's push-fallback used `push -u`. It was the ONE argv divergence, and it is a
// parameter rather than a second implementation. It was also UNGUARDED before this change.
test("LEAF GUARD git-push: the setUpstream variant refuses too, and builds push -u when exempted", () => {
  const seen: string[][] = [];
  const rec = (_f: string, args: string[]) => {
    seen.push(args);
  };
  assert.throws(() => gitPushRunBranch("/tmp/wt", { setUpstream: true, exec: rec }), LiveWriteBlockedError);
  assert.equal(seen.length, 0, "no push was made");
  withLiveWritesAllowed(() => gitPushRunBranch("/tmp/wt", { setUpstream: true, exec: rec }));
  assert.deepEqual(seen[0], ["-C", "/tmp/wt", "push", "-u", "origin", "HEAD"], "the -u divergence is preserved exactly");
});

// The default exec is the real `execFileSync` indirection the leaf falls back to when no
// exec is injected. Driven with harmless binaries — never git, never a push — so the
// indirection is proven to actually shell out rather than being an untested passthrough.
test("git-push leaf: defaultGitCapture really shells out and RETURNS stdout — the plumbing reads the empty-commit remedy makes", () => {
  // Sibling of the defaultPushExec test below, and covered the same way: a real exec of a
  // harmless command, no repo and no remote. This is the seam gitPushEmptyCommit reads
  // rev-parse/commit-tree through, so "it really shells out" is the property that matters.
  assert.equal(defaultGitCapture("echo", ["hello-leaf"]).trim(), "hello-leaf", "stdout is returned, not swallowed");
  assert.throws(() => defaultGitCapture("false", []), "a failing command throws rather than returning empty");
});

test("git-push leaf: defaultPushExec really shells out — a clean command succeeds and a failing one throws", () => {
  assert.doesNotThrow(() => defaultPushExec("true", [], { stdio: "ignore" }), "a clean command runs");
  assert.throws(
    () => defaultPushExec("false", [], { stdio: "ignore" }),
    "a failing command propagates — proving the call really reached execFileSync",
  );
});
