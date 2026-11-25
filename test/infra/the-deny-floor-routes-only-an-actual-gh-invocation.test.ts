import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14048 — THE DENY-FLOOR ROUTES ONLY AN ACTUAL GITHUB CLI INVOCATION.
//
// `invokes_gh` in hooks/deny-floor.sh gates rule 10 (the read broker's routing and the 180 s cadence
// floor) and rule 7 (the polling loop). It stripped quotes line by line with sed, so a heredoc body, a
// quoted message spanning lines and a `#` comment that merely NAME the CLI were judged as calls: a
// session writing a note about `gh pr view` was told to "re-run as rmd gh". Every case below spawns
// the ACTUAL hook with the real PreToolUse JSON contract, in both of rule 10's modes: a live broker
// (routing) and none (the cadence floor, with the stamp backdated so ONLY a real read is refused).

const HOOK_PATH = join(REPO_ROOT, "hooks", "deny-floor.sh");

type Fired = { status: number | null; stderr: string };

function fire(command: string, cacheHome: string): Fired {
  const input = JSON.stringify({ tool_input: { command } });
  const r = spawnSync("bash", [HOOK_PATH], {
    input,
    encoding: "utf8",
    env: { ...process.env, RMD_GH_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "" },
  });
  return { status: r.status, stderr: r.stderr };
}

/** A live broker: a heartbeat file stamped now, naming a 30 s interval. */
function withBroker(fn: (cacheHome: string) => void): void {
  const c = mkdtempSync(join(tmpdir(), "rmd-ghinvoke-broker-"));
  try {
    mkdirSync(join(c, "remudero", "gh-broker"), { recursive: true });
    writeFileSync(join(c, "remudero", "gh-broker", "heartbeat"), "30\n");
    fn(c);
  } finally {
    rmSync(c, { recursive: true, force: true });
  }
}

/** No broker, and the last read stamped a few seconds ago: any real read is inside the floor. */
function withHotFloor(fn: (cacheHome: string) => void): void {
  const c = mkdtempSync(join(tmpdir(), "rmd-ghinvoke-floor-"));
  try {
    mkdirSync(join(c, "remudero"), { recursive: true });
    const stamp = join(c, "remudero", "gh-last-read");
    writeFileSync(stamp, "");
    const when = new Date(Date.now() - 5000);
    utimesSync(stamp, when, when);
    fn(c);
  } finally {
    rmSync(c, { recursive: true, force: true });
  }
}

const NL = "\n";
const MENTIONS: Array<[string, string]> = [
  ["an unquoted heredoc body", `cat > notes.md <<EOF${NL}gh pr view 1${NL}EOF`],
  ["a quoted-delimiter heredoc body", `cat > notes.md <<'EOF'${NL}run gh pr view 1 later${NL}EOF`],
  ["a tab-stripped heredoc body", `cat > notes.md <<-EOF${NL}\tgh pr view 1${NL}\tEOF`],
  ["a heredoc with the redirect after it", `cat <<EOF > a${NL}foo gh pr view${NL}EOF`],
  [
    "a commit message heredoc inside a command substitution",
    `git commit -m "$(cat <<'EOF'${NL}fix: stop${NL}${NL}use gh pr view 1 here${NL}EOF${NL})"`,
  ],
  [
    "a commit message heredoc whose body carries a stray double quote",
    `git commit -m "$(cat <<'EOF'${NL}fix: say "hi${NL}gh pr view 1${NL}EOF${NL})"`,
  ],
  ["a double-quoted message spanning lines", `git commit -m "x${NL}gh pr view 1${NL}y"`],
  ["a single-quoted message spanning lines", `git commit -m 'x${NL}gh pr view 1${NL}y'`],
  ["a trailing comment", "echo hi # gh pr view 1"],
  ["a comment line", `# gh pr view 1${NL}echo hi`],
  ["a single-quoted substitution that never runs", "git commit -m 'use $(gh pr view 1)'"],
  ["a file's text echoed through grep", 'grep -n "gh pr view" notes.md'],
];

const INVOCATIONS: Array<[string, string]> = [
  ["a bare call", "gh pr view 1"],
  ["a call after a separator", "ls && gh pr view 1"],
  ["a call after cd", "cd x; gh pr view 1"],
  ["a call behind timeout", "timeout 5 gh pr view 1"],
  ["a call behind env", "env FOO=1 gh pr view 1"],
  ["a substitution assignment", "x=$(gh pr view 1)"],
  ["a substitution inside double quotes", 'git commit -m "a" -m "$(gh pr view 1)"'],
  ["a backtick substitution inside double quotes", 'echo "`gh pr view 1`"'],
  ["a call that feeds a heredoc", `gh pr view 1 <<EOF${NL}body${NL}EOF`],
  ["a call after a heredoc has ended", `cat > n <<'EOF'${NL}text${NL}EOF${NL}gh pr view 1`],
  ["a call after a multi-line quoted message", `echo "a${NL}b"${NL}gh pr view 1`],
  ["a substitution inside an UNQUOTED heredoc body (the shell expands it)", `cat <<EOF${NL}run $(gh pr view 1) now${NL}EOF`],
];

test("W1-T14048: a live broker routes an actual gh read and never a command that only names the CLI", () => {
  withBroker((c) => {
    for (const [what, cmd] of MENTIONS) {
      const r = fire(cmd, c);
      assert.equal(r.status, 0, `${what} only NAMES gh and must not be routed: ${JSON.stringify(cmd)}\n${r.stderr}`);
    }
    for (const [what, cmd] of INVOCATIONS) {
      const r = fire(cmd, c);
      assert.equal(r.status, 2, `${what} invokes gh and must be routed: ${JSON.stringify(cmd)}`);
      assert.match(r.stderr, /routed/, `${what}: the refusal must be the routing instruction`);
    }
  });
});

test("W1-T14048: the cadence floor refuses an actual gh read and never a command that only names the CLI", () => {
  withHotFloor((c) => {
    for (const [what, cmd] of MENTIONS) {
      const r = fire(cmd, c);
      assert.equal(r.status, 0, `${what} only NAMES gh and must not be paced: ${JSON.stringify(cmd)}\n${r.stderr}`);
    }
    for (const [what, cmd] of INVOCATIONS) {
      const r = fire(cmd, c);
      assert.equal(r.status, 2, `${what} invokes gh and must be paced: ${JSON.stringify(cmd)}`);
      assert.match(r.stderr, /read-shaped/, `${what}: the refusal must be the cadence floor`);
    }
  });
});

test("W1-T14048: the polling-loop rule reads executed text only, so a note about a poll is not a poll", () => {
  withHotFloor((c) => {
    const note = `cat > notes.md <<'EOF'${NL}for i in 1 2 3; do gh pr view 1; sleep 20; done${NL}EOF`;
    assert.equal(fire(note, c).status, 0, "a heredoc that DESCRIBES a poll is not one");
    const poll = `for i in 1 2 3; do gh pr view 1; sleep 20; done`;
    const r = fire(poll, c);
    assert.equal(r.status, 2, "an actual poll is still refused");
    assert.match(r.stderr, /inline polling loop/);
    const recorded = `until [ "$(gh run view 5 --json status)" = completed ]; do sleep 20; done`;
    assert.equal(fire(recorded, c).status, 2, "W1-T1066's recorded poll, a substitution inside quotes, is still refused");
  });
});
