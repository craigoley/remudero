import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T10311. REPRODUCED at origin/main 7dfbbc15b by piping the Bash tool's PreToolUse JSON into
// hooks/deny-floor.sh with a live broker heartbeat: `gh 'pr' 'comment' 1 -b x` was routed as a read (exit 2),
// a worker's `gh pr 'merge' 1` was routed instead of refused as a merge, `gh 'auth' 'logout'` was routed
// instead of refused as an auth mutation, a worker's `gh api -XPUT …/pulls/1/merge` and `-X 'PUT'` passed
// (exit 0), and `gh --version` and `gh pr view --help` were routed though they make no GitHub call. Rules 2, 5
// and 10 grepped the command text with its quotes still in it; gh never sees those quotes. Each case below is
// paired with its unquoted control, which must keep today's verdict.

const HOOK = join(REPO_ROOT, "hooks/deny-floor.sh");
const AUTH = "auth"; // assembled, so this file's own text never trips rule 2

function tmp(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-gh-argv-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A cache root whose broker heartbeat is fresh (interval 60 s, written 1 s ago), so the broker reads live. */
function liveCache(t: TestContext): string {
  const cache = tmp(t, "live");
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), "60\n");
  const at = (Date.now() - 1_000) / 1000;
  utimesSync(join(dir, "heartbeat"), at, at);
  return cache;
}

type Lane = "worker" | "operator";
interface Verdict { status: number | null; stderr: string; invalidations: string }

/** One Bash PreToolUse call at the real hook. The worker lane is `--confine-file-tools`, as settings/worker.json passes it. */
function hook(cache: string, lane: Lane, command: string): Verdict {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const inv = join(dir, "invalidations");
  if (existsSync(dir)) writeFileSync(inv, "");
  const r = spawnSync("bash", lane === "worker" ? [HOOK, "--confine-file-tools"] : [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, RMD_GH_CACHE_HOME: cache, XDG_CACHE_HOME: cache, RMD_GH_COOLDOWN_S: "" },
  });
  return { status: r.status, stderr: r.stderr, invalidations: existsSync(inv) ? readFileSync(inv, "utf8") : "" };
}

const ROUTED = /routed - a live GitHub read broker/;
const MERGE = /only the orchestrator may merge or arm it/;
const API_MERGE = /gh api PUT to a pull-request merge endpoint/;
const AUTH_MUT = /gh auth mutation/;

/** Runs every case and returns the ones whose verdict is wrong, so one assertion names them all. */
function judge(t: TestContext, cases: Array<{ lane: Lane; command: string; status: 0 | 2; stderr?: RegExp; inv?: string }>): string[] {
  const cache = liveCache(t);
  const wrong: string[] = [];
  for (const c of cases) {
    const r = hook(cache, c.lane, c.command);
    const ok = r.status === c.status
      && (c.stderr === undefined || c.stderr.test(r.stderr))
      && (c.inv === undefined || r.invalidations === c.inv);
    if (!ok) wrong.push(`${c.lane} exit ${r.status} inv=${JSON.stringify(r.invalidations)} ${r.stderr.trim().split("\n")[0] || "(allowed)"} | ${c.command}`);
  }
  assert.ok(cases.length >= 4, "the table is not empty");
  return wrong;
}

test("W1-T10311: a quoted porcelain verb is judged as gh reads it", (t) => {
  const wrong = judge(t, [
    { lane: "operator", command: "gh 'pr' 'comment' 1 -b x", status: 0, inv: "* 1\n" },
    { lane: "operator", command: "gh pr 'comment' 1 -R 'o/r' -b x", status: 0, inv: "o/r 1\n" },
    { lane: "operator", command: 'gh "issue" "close" 7 --repo=o/r', status: 0, inv: "o/r 7\n" },
    { lane: "operator", command: "gh pr 'edit' '#12' --body new", status: 0, inv: "* 12\n" },
    { lane: "operator", command: "./bin/rmd gh -- 'pr' 'comment' 3 -b x", status: 0, inv: "* 3\n" },
    { lane: "operator", command: "gh 'workflow' 'run' ci.yml", status: 0 },
    { lane: "operator", command: "gh 'api' 'rate_limit'", status: 0 },
    { lane: "operator", command: `gh '${AUTH}' 'status'`, status: 0 },
    // The controls: today's verdicts, unchanged.
    { lane: "operator", command: "gh pr comment 1 -b x", status: 0, inv: "* 1\n" },
    { lane: "operator", command: "gh pr edit 5 -R o/r --body new", status: 0, inv: "o/r 5\n" },
    { lane: "operator", command: "gh 'pr' 'view' 1", status: 2, stderr: ROUTED },
    { lane: "operator", command: "gh pr view 1", status: 2, stderr: ROUTED },
  ]);
  assert.deepEqual(wrong, []);
});

test("W1-T10311: a quoted verb cannot carry a worker merge", (t) => {
  const wrong = judge(t, [
    { lane: "worker", command: "gh pr 'merge' 1 --squash", status: 2, stderr: MERGE },
    { lane: "worker", command: "gh 'pr' 'merge' 1", status: 2, stderr: MERGE },
    { lane: "worker", command: 'gh "pr" merge 1 --auto', status: 2, stderr: MERGE },
    { lane: "worker", command: "gh pr -R 'o/r' 'merge' 1", status: 2, stderr: MERGE },
    { lane: "worker", command: "./bin/rmd gh -- pr 'merge' 1", status: 2, stderr: MERGE },
    { lane: "worker", command: "gh api -XPUT repos/o/r/pulls/1/merge", status: 2, stderr: API_MERGE },
    { lane: "worker", command: "gh api -X 'PUT' repos/o/r/pulls/1/merge", status: 2, stderr: API_MERGE },
    { lane: "worker", command: "gh api --method 'PUT' 'repos/o/r/pulls/1/merge' -f merge_method=squash", status: 2, stderr: API_MERGE },
    { lane: "worker", command: "gh 'api' -XPUT /repos/o/r/pulls/1/merge", status: 2, stderr: API_MERGE },
    // The controls: today's refusals, and the operator lane is never refused a merge (W1-T9643).
    { lane: "worker", command: "gh pr merge 1 --squash", status: 2, stderr: MERGE },
    { lane: "worker", command: "gh api -X PUT repos/o/r/pulls/1/merge", status: 2, stderr: API_MERGE },
    { lane: "worker", command: "gh api --method=PUT repos/o/r/pulls/1/merge", status: 2, stderr: API_MERGE },
    { lane: "worker", command: "gh pr 'view' 1", status: 2, stderr: ROUTED },
    { lane: "worker", command: "gh api repos/o/r/pulls/1/merge", status: 2, stderr: ROUTED },
    { lane: "operator", command: "gh pr 'merge' 1 --squash", status: 0, inv: "* 1\n" },
    { lane: "operator", command: "gh api -XPUT repos/o/r/pulls/1/merge", status: 0, inv: "o/r 1\n" },
  ]);
  assert.deepEqual(wrong, []);
});

test("W1-T10311: the auth refusal reads the gh argv", (t) => {
  const wrong = judge(t, [
    { lane: "operator", command: `gh '${AUTH}' 'logout'`, status: 2, stderr: AUTH_MUT },
    { lane: "operator", command: `gh ${AUTH} 'login' --with-token`, status: 2, stderr: AUTH_MUT },
    { lane: "operator", command: `gh "${AUTH}" refresh -s repo`, status: 2, stderr: AUTH_MUT },
    { lane: "worker", command: `./bin/rmd gh -- '${AUTH}' 'token'`, status: 2, stderr: AUTH_MUT },
    { lane: "worker", command: `gh '${AUTH}' setup-git`, status: 2, stderr: AUTH_MUT },
    // The controls: the unquoted mutation is still refused, and status is still the exempt probe.
    { lane: "operator", command: `gh ${AUTH} logout`, status: 2, stderr: AUTH_MUT },
    { lane: "operator", command: `gh ${AUTH} status`, status: 0 },
  ]);
  assert.deepEqual(wrong, []);
});

test("W1-T10311: a local gh command is not a read, and real reads still route", (t) => {
  const wrong = judge(t, [
    { lane: "operator", command: "gh --version", status: 0 },
    { lane: "operator", command: "gh version", status: 0 },
    { lane: "operator", command: "gh help pr", status: 0 },
    { lane: "operator", command: "gh pr view --help", status: 0 },
    { lane: "worker", command: "gh api --help | head -20", status: 0 },
    { lane: "operator", command: "gh --version && gh --help", status: 0 },
    // Real reads still route: a local gh beside a real one, a gh the argv cannot see, and a read after a heredoc.
    { lane: "operator", command: "gh --version && gh pr view 1", status: 2, stderr: ROUTED },
    { lane: "operator", command: 'echo "$(gh pr view 1)"; gh --version', status: 2, stderr: ROUTED },
    { lane: "operator", command: "/usr/local/bin/gh pr view 1; gh --version", status: 2, stderr: ROUTED },
    { lane: "operator", command: "cat <<'EOF' > /dev/null; gh pr view 1\nbody text\nEOF", status: 2, stderr: ROUTED },
    { lane: "operator", command: "gh pr view 1 -- --help", status: 2, stderr: ROUTED },
    // Rule 7 is unchanged: a polling loop is refused whatever gh it runs.
    { lane: "operator", command: "for i in 1 2 3; do gh pr view 1; sleep 20; done", status: 2, stderr: /inline polling loop/ },
    { lane: "operator", command: "while true; do gh --version; sleep 5; done", status: 2, stderr: /inline polling loop/ },
  ]);
  assert.deepEqual(wrong, []);

  // With no broker, a local gh command is not floored and does not stamp the floor; a real read still is.
  const cache = tmp(t, "floor");
  for (const command of ["gh --version", "gh pr view --help", "gh --version"]) {
    const r = hook(cache, "operator", command);
    assert.equal(r.status, 0, `${command} is never floored`);
  }
  assert.equal(existsSync(join(cache, "remudero", "gh-last-read")), false, "a local gh command spends no floor slot");
  assert.equal(hook(cache, "operator", "gh pr view 1").status, 0, "the first real read is allowed");
  const floored = hook(cache, "operator", "gh pr view 2");
  assert.equal(floored.status, 2, "the floor still holds for a real read");
  assert.match(floored.stderr, /floor 180s, W1-T3275/);
});
