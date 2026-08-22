// test/pr-create-rest-transport.test.ts — W1-T1202.
//
// THE DEFECT THIS TASK REMOVES: every harness-opened PR (implement/retro/triage/plan) opened
// with `gh pr create --fill`, which is GraphQL. W1-T372's incident: a GraphQL exhaustion nobody's
// lane caused threw at exactly this push boundary and discarded a COMPLETED, risk:high run —
// re-dispatched from scratch against a REST bucket that was 97% free at the same minute.
//
// THE FIX: `ghPrCreateFillCommand` (src/run-task.ts) now builds a `gh api --method POST
// repos/{owner}/{repo}/pulls` argv instead, `fillDerivedBody` reproduces `--fill`'s own
// body-derivation LOCALLY (git log over origin/main..HEAD), and `runGhPrCreate` executes that
// argv and reads `html_url`/`number` off the parsed response — never a stdout regex-scrape.
//
// Every claim below is an assertion over an INJECTED exec seam and a fixture git history, with
// no operator present (verify:auto) — never a spawned real `gh`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  fillDerivedBody,
  ghPrCreateFillCommand,
  lastCommitSubject,
  runGhPrCreate,
} from "../src/run-task.js";
import { LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A throwaway repo with `origin/main` seeded, and the WORKING tree left on `main` at that same
 *  commit — callers add branch-local commits on top before reading `fillDerivedBody`. Mirrors
 *  every other fixture in this suite: a real git repo, never a mock of git's own output. */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-create-rest-fixture-"));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed");
  // `fillDerivedBody`/`ghPrCreateFillCommand` read `origin/main..HEAD` — a local repo has no
  // real remote, so a `refs/remotes/origin/main` ref is faked to point at the seed commit,
  // exactly like `git fetch` would have left it.
  const seedSha = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "update-ref", "refs/remotes/origin/main", seedSha);
  return dir;
}

function commit(dir: string, file: string, subject: string, body?: string): void {
  writeFileSync(join(dir, file), `${file} content\n`);
  git(dir, "add", "-A");
  const message = body ? `${subject}\n\n${body}` : subject;
  git(dir, "commit", "-q", "-m", message);
}

// ── acceptance 1: created over REST, no `gh pr create` is ever issued ───────────────────────

test("ghPrCreateFillCommand: the argv is the REST create — `api --method POST repos/{owner}/{repo}/pulls` — never `pr create`", () => {
  const dir = makeFixtureRepo();
  try {
    const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "acme", "remudero", "run-T1-1"));
    assert.deepEqual(built.args.slice(0, 4), ["api", "--method", "POST", "repos/acme/remudero/pulls"]);
    assert.ok(!built.args.includes("pr"), "no `pr` subcommand token anywhere in the argv");
    assert.ok(!built.args.includes("create"), "no `create` subcommand token anywhere in the argv");
    assert.ok(!built.args.includes("--fill"), "`--fill` is a `gh pr create` flag — REST has no such flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGhPrCreate: executes EXACTLY the argv ghPrCreateFillCommand built — the exec seam never sees a `pr create` invocation", () => {
  const dir = makeFixtureRepo();
  try {
    const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "acme", "remudero", "run-T1-1", "feat(x): a title"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = (command: string, args: string[]): string => {
      calls.push({ command, args });
      return JSON.stringify({ html_url: "https://github.com/acme/remudero/pull/1", number: 1 });
    };
    runGhPrCreate(built, "run-T1-1", () => {}, () => {}, exec);
    assert.equal(calls.length, 1, "exactly one gh invocation");
    assert.equal(calls[0].command, "gh");
    assert.deepEqual(calls[0].args, built.args, "runGhPrCreate executes the builder's own argv verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 2: the url comes from the parsed response, never a stdout scrape ─────────────

test("runGhPrCreate: the PR url comes from the response's `html_url` field, not a regex over stdout", () => {
  const built = { command: "gh" as const, args: ["api"], options: { cwd: "/tmp", encoding: "utf8" as const } };
  const exec = () => JSON.stringify({ html_url: "https://github.com/acme/remudero/pull/42", number: 42 });
  const result = runGhPrCreate(built, "run-T1-1", () => {}, () => {}, exec);
  assert.equal(result.prUrl, "https://github.com/acme/remudero/pull/42");
  assert.equal(result.prNumber, 42);
});

test("runGhPrCreate: FALSIFIER — a github-url-shaped SUBSTRING in non-JSON stdout is NEVER picked up (proves this is a parse, not a scrape)", () => {
  const built = { command: "gh" as const, args: ["api"], options: { cwd: "/tmp", encoding: "utf8" as const } };
  // The exact shape the OLD code's `/https:\/\/github\.com\/[^\s]+\/pull\/\d+/` regex would have
  // matched — plain human text, not JSON. A REST reader must find NOTHING here.
  const exec = () => "opening PR https://github.com/acme/remudero/pull/999 for you\n";
  const result = runGhPrCreate(built, "run-T1-1", () => {}, () => {}, exec);
  assert.equal(result.prUrl, undefined, "unparseable stdout yields no url, even though a url-shaped substring is right there");
});

test("runGhPrCreate: a response that parses but carries no html_url yields undefined — the existing 'no PR opened' meaning, unchanged (design v)", () => {
  const built = { command: "gh" as const, args: ["api"], options: { cwd: "/tmp", encoding: "utf8" as const } };
  const exec = () => JSON.stringify({ message: "validation failed" });
  const result = runGhPrCreate(built, "run-T1-1", () => {}, () => {}, exec);
  assert.equal(result.prUrl, undefined);
  assert.equal(result.prNumber, undefined);
});

// ── acceptance 3: the body is a LOCAL derivation over origin/main..HEAD, never invented, and
//    an unreadable git history yields "" rather than a throw ───────────────────────────────

test("fillDerivedBody: a single commit ahead of origin/main yields THAT commit's own body", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): one commit", "the real commit body text");
    assert.equal(fillDerivedBody(dir), "the real commit body text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillDerivedBody: a single commit with NO body at all yields an empty string, not a throw", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): one commit, no body");
    assert.equal(fillDerivedBody(dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillDerivedBody: several commits ahead of origin/main yields the list of commit SUBJECTS, oldest first", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): first change");
    commit(dir, "b.txt", "fix(y): second change");
    const body = fillDerivedBody(dir);
    const firstIdx = body.indexOf("first change");
    const secondIdx = body.indexOf("second change");
    assert.ok(firstIdx >= 0 && secondIdx >= 0, "both commit subjects must appear");
    assert.ok(firstIdx < secondIdx, "oldest commit's subject appears first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillDerivedBody: zero commits ahead of origin/main (HEAD == origin/main) yields an empty string", () => {
  const dir = makeFixtureRepo();
  try {
    assert.equal(fillDerivedBody(dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillDerivedBody: AN UNREADABLE GIT HISTORY (not a repo at all) yields an empty string, NEVER a throw — design (iii)'s own contract", () => {
  assert.doesNotThrow(() => {
    assert.equal(fillDerivedBody("/no/such/path/at/all"), "");
  });
  const notARepo = mkdtempSync(join(tmpdir(), "pr-create-rest-notarepo-"));
  try {
    assert.doesNotThrow(() => {
      assert.equal(fillDerivedBody(notARepo), "");
    });
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("ghPrCreateFillCommand: the body field in the built argv IS fillDerivedBody's own output — never invented separately", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): the real change", "the real body");
    const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "acme", "remudero", "run-T1-1", "feat(x): the real change"));
    assert.ok(built.args.includes("body=the real body"), "the argv's body= field is the local derivation, verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 4: the authored title still reaches the created PR, at every call site ───────

test("ghPrCreateFillCommand: a given title is passed through VERBATIM, never overridden by the derived body/subject", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): the commit's own subject", "some body");
    const title = "feat(serve): the AUTHORED title (W1-T157)";
    const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "acme", "remudero", "run-T1-1", title));
    assert.ok(built.args.includes(`title=${title}`), "the given title reaches the argv unchanged");
    assert.ok(!built.args.includes("title=feat(x): the commit's own subject"), "the commit's own subject never substitutes for a given title");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ghPrCreateFillCommand: no title given falls back to lastCommitSubject, then to the branch name — and states that fallback in the body", () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, "a.txt", "feat(x): read back as the fallback title");
    const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "acme", "remudero", "run-T1-1"));
    assert.equal(lastCommitSubject(dir), "feat(x): read back as the fallback title");
    assert.ok(built.args.includes("title=feat(x): read back as the fallback title"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Neither a title NOR a readable commit subject: falls back to the branch name, and SAYS so.
  const built = withLiveWritesAllowed(() => ghPrCreateFillCommand("/no/such/path", "acme", "remudero", "run-T1-branch-fallback"));
  assert.ok(built.args.includes("title=run-T1-branch-fallback"), "last-resort fallback is the branch name");
  const bodyField = built.args.find((a) => a.startsWith("body="));
  assert.match(bodyField ?? "", /run-T1-branch-fallback/, "the branch-name fallback is STATED in the body (design iv), never silent");
});

test("STRUCTURAL: every one of the four run-task.ts call sites still passes an explicit title into ghPrCreateFillCommand", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  // The title position must be one of the two authored sources (W1-T327): the worktree's own
  // last-commit subject (implement/retro) or the harness-shaped commit header (triage/plan) —
  // never a bare literal and never omitted, which is what this pattern enforces structurally.
  const callSites = [
    ...src.matchAll(
      /ghPrCreateFillCommand\(worktreePath,\s*owner,\s*(?:task\.repo|repo),\s*branch,\s*(lastCommitSubject\(worktreePath\)|commitMessage\.split\("\\n"\)\[0\])\)/g,
    ),
  ];
  assert.equal(callSites.length, 4, "exactly implement, retro, triage and plan build a create argv");
});

// ── acceptance 5: the live-write guard still refuses at the builder, under the SAME key ─────

test("ghPrCreateFillCommand: REFUSES under the SAME live-write key ('gh-pr-create') the pre-REST builder used — no argv produced", () => {
  let caught: unknown;
  let built: unknown;
  try {
    built = ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-1");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError);
  assert.match(String((caught as Error).message), /gh-pr-create/);
  assert.equal(built, undefined, "no argv leaks out of a refused builder");

  // Exempted, the SAME call succeeds — the guard, not the transport, decides reachability.
  const ok = withLiveWritesAllowed(() => ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-1"));
  assert.equal(ok.command, "gh");
});

// ── acceptance 6: a rate-limited create surfaces as THROTTLED, naming the already-pushed branch ─

test("runGhPrCreate: a rate-limited gh failure is classified via isGhRateLimitError, logs+says naming the branch, then rethrows — no retry is built", () => {
  const built = { command: "gh" as const, args: ["api"], options: { cwd: "/tmp", encoding: "utf8" as const } };
  const rateLimited = Object.assign(new Error("Command failed: gh api ..."), {
    status: 1,
    stderr: "gh: API rate limit exceeded for user ID 4397075 (HTTP 403)",
  });
  const exec = () => {
    throw rateLimited;
  };
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra });
  const say = (msg: string) => said.push(msg);

  assert.throws(
    () => runGhPrCreate(built, "run-T1-branch-under-test", log, say, exec),
    (err) => err === rateLimited,
    "rethrows the SAME error — no retry, no wrapping, legibility only",
  );

  assert.equal(logged.length, 1, "exactly one ledger line for the rate-limited create");
  assert.match(logged[0].step, /rate_limited/);
  assert.equal(logged[0].extra?.branch, "run-T1-branch-under-test", "the ledger line names the branch");

  assert.equal(said.length, 1, "exactly one console line said aloud");
  assert.match(said[0], /RATE LIMITED|THROTTLED/i, "the message reads as throttled, not a bare command failure");
  assert.match(said[0], /run-T1-branch-under-test/, "the said message NAMES the already-pushed branch");
});

test("runGhPrCreate: a NON-rate-limit failure rethrows with NO log/say — no second classifier is built (design vi)", () => {
  const built = { command: "gh" as const, args: ["api"], options: { cwd: "/tmp", encoding: "utf8" as const } };
  const authFailure = Object.assign(new Error("Command failed: gh api ..."), {
    status: 1,
    stderr: "gh: authentication required, run `gh auth login`",
  });
  const exec = () => {
    throw authFailure;
  };
  const logged: unknown[] = [];
  const said: unknown[] = [];
  assert.throws(
    () => runGhPrCreate(built, "run-T1-1", (s, e) => logged.push({ s, e }), (m) => said.push(m), exec),
    (err) => err === authFailure,
    "rethrows the SAME error, unclassified",
  );
  assert.equal(logged.length, 0, "an auth failure is not classified as rate-limited — no throttled ledger line");
  assert.equal(said.length, 0, "and nothing is said aloud for it either — this task builds no second classifier");
});
