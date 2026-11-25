import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14048 — THE DENY-FLOOR ROUTES ONLY AN ACTUAL GITHUB CLI INVOCATION, NOT THE CLI'S NAME IN TEXT.
//
// `invokes_gh` in hooks/deny-floor.sh gates rule 10 (the read broker's routing and the 180 s floor) and rule 7
// (the polling loop). It now judges the executable words `gh_exec_words` reads off `hr_tokens`: a heredoc body,
// a quoted commit message or a file's text that only NAMES the CLI is data, while every real invocation, and the
// `bash -c`, `sh -c`, `eval`, `<<<` and absolute-path forms base let through, is routed. Every case spawns the
// REAL hook with the PreToolUse JSON contract (as test/gh-read-cadence-floor.test.ts does), a temp HOME and a
// temp RMD_GH_CACHE_HOME: a fresh gh-broker/heartbeat for routing, or none (the 180 s floor).

const HOOK = join(REPO_ROOT, "hooks", "deny-floor.sh");
const NL = "\n";
const ROUTED_HEAD = "deny-floor: routed - a live GitHub read broker serves this account (W1-T10279).";
const RERUN = "  Re-run the read as: rmd gh --class interactive -- <same gh args>";
const FLOOR = /deny-floor: blocked - a read-shaped `gh` call \d+s after the last one \(floor 180s, W1-T3275\)/;
const POLL = /deny-floor: blocked — inline polling loop against gh \(W1-T1066\)/;
const RMD = "/opt/remudero/bin/rmd";

type Fired = { status: number | null; stderr: string };

function scratch(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-ghcli-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One Bash PreToolUse call at the real hook, with only PATH, a temp HOME and the cache root in its env. */
function fire(t: TestContext, cache: string, command: string): Fired {
  const home = scratch(t, "home");
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, RMD_GH_CACHE_HOME: cache, XDG_CACHE_HOME: cache, RMD_GH_COOLDOWN_S: "" },
  });
  return { status: r.status, stderr: r.stderr };
}

/** A live broker: gh-broker/heartbeat written now, naming a 30 s interval. */
function liveBroker(t: TestContext): string {
  const cache = scratch(t, "broker");
  mkdirSync(join(cache, "remudero", "gh-broker"), { recursive: true });
  writeFileSync(join(cache, "remudero", "gh-broker", "heartbeat"), "30\n");
  return cache;
}

/** No broker, and the last read stamped 5 s ago: a real read is inside the 180 s floor. */
function hotFloor(t: TestContext): string {
  const cache = scratch(t, "floor");
  mkdirSync(join(cache, "remudero"), { recursive: true });
  const stamp = join(cache, "remudero", "gh-last-read");
  writeFileSync(stamp, "");
  const when = new Date(Date.now() - 5000);
  utimesSync(stamp, when, when);
  return cache;
}

/** Runs each case and returns every wrong verdict, so one assertion names them all. */
function judge(t: TestContext, cache: string, cases: Array<[string, string]>, want: "allowed" | "routed" | "floored" | "poll"): string[] {
  const wrong: string[] = [];
  for (const [what, command] of cases) {
    const r = fire(t, cache, command);
    let ok: boolean;
    if (want === "allowed") ok = r.status === 0;
    else if (want === "routed") ok = r.status === 2 && r.stderr.includes(ROUTED_HEAD) && r.stderr.includes(RERUN);
    else if (want === "floored") ok = r.status === 2 && FLOOR.test(r.stderr);
    else ok = r.status === 2 && POLL.test(r.stderr);
    if (!ok) wrong.push(`${what}: want ${want}, got exit ${r.status} ${r.stderr.trim().split("\n")[0] || "(allowed)"} | ${JSON.stringify(command)}`);
  }
  assert.ok(cases.length >= 4, "the table is not empty");
  return wrong;
}

// Criterion 1: the commands the hook routed on 2026-11-20 though they run no GitHub CLI, the two W1-T9281
// reproductions, the other text-only shapes, and the broker route through a variable.
const TEXT_ONLY: Array<[string, string]> = [
  ["a cat heredoc writing markdown whose body says gh api",
    "cat > docs/notes.md <<'EOF'" + NL + "# Reading GitHub" + NL + NL + "Run `gh api repos/o/r/pulls/1` through the broker;" + NL + "gh api rate_limit is exempt." + NL + "EOF"],
  ["an unquoted-delimiter markdown heredoc naming gh api", "cat > notes.md <<EOF" + NL + "gh api repos/o/r/pulls/1 is served by the broker" + NL + "EOF"],
  ["a python3 - heredoc whose comments say gh child",
    "python3 - <<'EOF'" + NL + "import subprocess" + NL + "# spawn the gh child and read its stdout" + NL + "# for each pull request, sleep between gh child calls" + NL + "print('gh child')" + NL + "EOF"],
  ["git add <paths> && git commit -q -F - with a heredoc message saying gh child",
    "git add hooks/deny-floor.sh test/x.test.ts && git commit -q -F - <<'EOF'" + NL + "fix(deny-floor): judge the gh child, not its name" + NL + NL + "The gh child runs only when gh is the command." + NL + "EOF"],
  ["W1-T9281: echo the gh read floor", "echo the gh read floor"],
  ["W1-T9281: a multi-line git commit -m naming the gh read floor", 'git commit -m "fix: pace reads' + NL + NL + 'the gh read floor refuses a second read"'],
  ["W1-T9281: a cat heredoc inside the -m quotes", 'git commit -m "$(cat <<\'EOF\'' + NL + "fix: pace reads" + NL + "the gh read floor refuses a second read" + NL + "EOF" + NL + ')"'],
  ["a heredoc body carrying a stray double quote", 'git commit -m "$(cat <<\'EOF\'' + NL + 'fix: say "hi' + NL + "gh pr view 1" + NL + "EOF" + NL + ')"'],
  ["a tab-stripped heredoc body", "cat > notes.md <<-EOF" + NL + "\tgh pr view 1" + NL + "\tEOF"],
  ["a single-quoted message spanning lines", "git commit -m 'x" + NL + "gh pr view 1" + NL + "y'"],
  ["a trailing comment", "echo hi # gh pr view 1"],
  ["a comment line", "# gh pr view 1" + NL + "echo hi"],
  ["a single-quoted substitution that never runs", "git commit -m 'use $(gh pr view 1)'"],
  ["a file's text searched by grep", 'grep -n "gh pr view" notes.md'],
  ["an unquoted argument word", "printf '%s\\n' gh pr view"],
];
// The broker route written through a variable: rmd's gh verb, so it is not routed (and is floored with no broker).
const RMD_ROUTE: Array<[string, string]> = [
  ["R=<path>/bin/rmd; $R gh --class agent -- <args>", `R=${RMD}; $R gh --class agent -- pr view 1 --json state`],
  ["the same route in a for loop", `R=${RMD}; for n in 1 2 3; do $R gh --class agent -- pr view $n --json state; done`],
  ['"$R" gh', `R="${RMD}"; "$R" gh --class agent -- pr view 1`],
  ["${R} gh", `R=${RMD}; \${R} gh --class agent -- api repos/o/r/pulls/1`],
];

test("W1-T14048 criterion 1: a command that only names the GitHub CLI, and $R gh, are allowed with a live broker", (t) => {
  const cache = liveBroker(t);
  assert.deepEqual(judge(t, cache, [...TEXT_ONLY, ...RMD_ROUTE], "allowed"), []);
  // The paired controls: the same shapes with a real raw read beside them are still routed.
  assert.deepEqual(judge(t, cache, [
    ["a raw read after the R assignment", `R=${RMD}; gh pr view 1`],
    ["a raw read beside $R gh", `R=${RMD}; $R gh -- pr view 1 && gh pr view 2`],
    ["a raw read after the markdown heredoc", "cat > notes.md <<'EOF'" + NL + "gh api x" + NL + "EOF" + NL + "gh pr view 1"],
    ["a raw read after the multi-line message", 'git commit -m "a' + NL + 'b"' + NL + "gh pr view 1"],
    ["a $VAR that is not an rmd path stays a raw read", "R=/usr/bin/env; $R gh pr view 1"],
  ], "routed"), []);
  // And with no broker the text-only commands spend no floor slot.
  assert.deepEqual(judge(t, hotFloor(t), TEXT_ONLY, "allowed"), []);
  // The variable route is rmd's gh verb, so with no broker it is floored exactly as a literal rmd gh is.
  assert.deepEqual(judge(t, hotFloor(t), RMD_ROUTE, "floored"), []);
});

// Criterion 2: every invocation base refuses is still refused, with the same message.
const INVOCATIONS: Array<[string, string]> = [
  ["program position", "gh pr view 1"],
  ["after another assignment", "FOO=1 gh pr view 1"],
  ["after env", "env FOO=1 gh pr view 1"],
  ["after nice -n", "nice -n 5 gh pr view 1"],
  ["after timeout", "timeout 5 gh pr view 1"],
  ["after command", "command gh pr view 1"],
  ["after &&", "ls && gh pr view 1"],
  ["after a pipe", "echo 1 | gh pr view 1"],
  ["via xargs", "echo 1 | xargs gh pr view"],
  ["in a bare $(...)", "x=$(gh pr view 1)"],
  ["in $(...) inside double quotes", 'echo "$(gh pr view 1)"'],
  ["in $(...) inside a -m message", 'git commit -m "a" -m "$(gh pr view 1)"'],
  ["an assignment from a substitution before gh", 'TOKEN="$(cat tok)" gh pr view 1'],
  ["in backticks", "x=`gh pr view 1`"],
  ["in backticks inside double quotes", 'echo "`gh pr view 1`"'],
  ["in a subshell", "(cd /tmp && gh pr view 1)"],
  ["in a do-loop body", "for n in 1 2; do gh pr view $n; done"],
  ["in a heredoc fed to bash", "bash <<'EOF'" + NL + "gh pr view 1" + NL + "EOF"],
  ["in a heredoc fed to ssh host bash -s", "ssh build-host bash -s <<'EOF'" + NL + "gh pr view 1" + NL + "EOF"],
  ["in an unquoted-delimiter heredoc body as $(gh ...)", "cat <<EOF" + NL + "run $(gh pr view 1) now" + NL + "EOF"],
  ["on a data heredoc's opening line after a semicolon", "cat <<'EOF' > /dev/null; gh pr view 1" + NL + "body text" + NL + "EOF"],
  ["a call that feeds a heredoc", "gh pr view 1 <<EOF" + NL + "body" + NL + "EOF"],
  ["a call after a heredoc has ended", "cat > n <<'EOF'" + NL + "text" + NL + "EOF" + NL + "gh pr view 1"],
  ["gh-read-cadence-floor: a quoted substitution read", "Y=$(gh pr view 2 --json state)"],
  ["argv suite: quoted porcelain words", "gh 'pr' 'view' 1"],
  ["argv suite: an absolute path beside a local gh", "/usr/local/bin/gh pr view 1; gh --version"],
  ["argv suite: a substitution beside a local gh", 'echo "$(gh pr view 1)"; gh --version'],
  ["argv suite: a merge endpoint read", "gh api repos/o/r/pulls/1/merge"],
  ["broker suite: a raw gh beside an rmd gh", "rmd gh -- pr view 5 && gh pr view 6"],
];

test("W1-T14048 criterion 2: every invocation refused at base is still refused with the same message", (t) => {
  assert.deepEqual(judge(t, liveBroker(t), [...INVOCATIONS, ["after GH_TOKEN=", "GH_TOKEN=ghs_x gh pr view 1"]], "routed"), []);
  // With no broker each is the 180 s floor (GH_TOKEN= paces on its own app stamp, W1-T4085, so it is left out).
  assert.deepEqual(judge(t, hotFloor(t), INVOCATIONS, "floored"), []);
});

// Criterion 3: reads base let through (each exited 0 there).
const ESCAPED_AT_BASE: Array<[string, string]> = [
  ["bash -c", "bash -c 'gh pr view 1'"],
  ["sh -c with a double-quoted body", 'sh -c "gh pr view 1"'],
  ["eval", "eval 'gh pr view 1'"],
  ["bash <<<", "bash <<< 'gh pr view 1'"],
  ["an absolute path alone", "/usr/local/bin/gh pr view 1"],
];

test("W1-T14048 criterion 3: a GitHub CLI read that escaped the routing at base is routed", (t) => {
  assert.deepEqual(judge(t, liveBroker(t), ESCAPED_AT_BASE, "routed"), []);
  assert.deepEqual(judge(t, hotFloor(t), ESCAPED_AT_BASE, "floored"), []);
});

test("W1-T14048 criterion 4: refusals and routes are unchanged, and an unfinished text is judged as at base", (t) => {
  const live = liveBroker(t);
  // The routed refusal, its Re-run line and exit 2.
  const raw = fire(t, live, "gh pr view 5 --json state");
  assert.equal(raw.status, 2);
  assert.equal(raw.stderr.split("\n")[0], ROUTED_HEAD);
  assert.equal(raw.stderr.split("\n")[1], RERUN);
  // The broker route: rmd gh and ./bin/rmd gh are not routed, and a write is never refused.
  assert.deepEqual(judge(t, live, [
    ["rmd gh", "rmd gh -- pr view 5 --json state"],
    ["rmd gh again", "rmd gh -- pr view 5 --json state"],
    ["./bin/rmd gh", "./bin/rmd gh --class agent --fresh -- api repos/o/r/pulls/5"],
    ["a write", "gh pr comment 1 -b x"],
    ["the g=gh escape", "g=gh; $g pr view 1; $g pr view 2"],
  ], "allowed"), []);
  // Rule 7 refuses a polling loop around raw gh, rmd gh or $R gh.
  const polls: Array<[string, string]> = [
    ["raw gh", "for i in 1 2 3; do gh pr view 1; sleep 20; done"],
    ["rmd gh", "for i in 1 2 3; do rmd gh -- pr view 5; sleep 30; done"],
    ["$R gh", `R=${RMD}; for i in 1 2 3; do $R gh --class agent -- pr view 5; sleep 30; done`],
    ["W1-T1066's recorded poll", 'until [ "$(gh run view 5 --json status)" = completed ]; do sleep 20; done'],
  ];
  assert.deepEqual(judge(t, live, polls, "poll"), []);
  assert.deepEqual(judge(t, hotFloor(t), polls, "poll"), []);
  // The 180 s floor with no live broker: the first read passes, the next is floored, rmd gh included.
  const fresh = scratch(t, "fresh");
  assert.equal(fire(t, fresh, "rmd gh -- pr view 5").status, 0, "the first read is allowed");
  const floored = fire(t, fresh, "gh pr view 6");
  assert.equal(floored.status, 2);
  assert.match(floored.stderr, FLOOR);
  assert.match(fire(t, fresh, "rmd gh -- pr view 7").stderr, FLOOR, "rmd gh is floored like gh with no broker");
  assert.equal(fire(t, fresh, "g=gh; $g pr view 1; $g pr view 2").status, 0, "the asserted escape still escapes the floor");
  // A text the tokenizer cannot finish is judged by base's whole-text match, so it is refused where base refuses it.
  assert.deepEqual(judge(t, live, [
    ["an unterminated double quote", 'echo "unterminated; gh pr view 1'],
    ["an unterminated single quote after a call", "gh pr view 1 'oops"],
    ["an unterminated heredoc", "gh pr view 1 <<EOF" + NL + "no terminator"],
    ["an unterminated substitution", "x=$(gh pr view 1"],
    ["an unterminated message whose later line names gh", 'git commit -m "fix' + NL + "gh pr view 1"],
  ], "routed"), []);
});
