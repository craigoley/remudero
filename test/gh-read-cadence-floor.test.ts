import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T3275 — THE SECONDARY RATE LIMIT COUNTS CADENCE, AND RULE 6 DOES NOT SEE IT.
//
// hooks/deny-floor.sh rule 6 (W1-T1066) refuses the SHAPE of a poll: one command carrying a loop
// keyword, a wait and `gh`. MEASURED 2026-09-09: a session tripped the secondary limit TWICE with
// no loop anywhere — a run of separate status reads seconds apart, each legal on its own. At the
// moment of the 403, `gh api rate_limit` read core 5000/5000, because the ceiling hit was the
// SECONDARY limit, which counts RATE, NOT VOLUME.
//
// These cases spawn the ACTUAL hook with the real PreToolUse JSON contract, never a
// re-implementation of its regex — the discipline test/deny-floor.test.ts already sets. The clock
// is moved by rewriting the stamp file's mtime rather than by waiting, so the suite is fast and
// deterministic; a sleep-based version would be both slow and flaky.

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));
const STAMP_REL = join("remudero", "gh-last-read");

type Fired = { status: number | null; stderr: string };

/** Fire one tool call at the hook with an isolated cache root. */
function fire(command: string, cacheHome: string): Fired {
  const input = JSON.stringify({ tool_input: { command } });
  const r = spawnSync("bash", [HOOK_PATH], {
    input,
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "" },
  });
  return { status: r.status, stderr: r.stderr };
}

/** Backdate the stamp so the floor sees a read `secondsAgo` in the past — no waiting. */
function backdate(cacheHome: string, secondsAgo: number): void {
  const stamp = join(cacheHome, STAMP_REL);
  mkdirSync(join(cacheHome, "remudero"), { recursive: true });
  writeFileSync(stamp, "");
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(stamp, when, when);
}

function withCache(fn: (cacheHome: string) => void): void {
  const c = mkdtempSync(join(tmpdir(), "rmd-ghcadence-"));
  try {
    fn(c);
  } finally {
    rmSync(c, { recursive: true, force: true });
  }
}

test("W1-T3275: a second read-shaped gh call inside the floor is refused, and the refusal names the cadence", () => {
  withCache((c) => {
    assert.equal(fire("gh pr checks 4849", c).status, 0, "the first read must always be allowed");

    const second = fire("gh pr view 4851 --json state", c);
    assert.equal(second.status, 2, "a read seconds after another read is the shape that burns the budget");
    assert.match(second.stderr, /read-shaped/, "the refusal must say what it refused");
    assert.match(second.stderr, /CADENCE, not volume/, "and why — a quota check reads healthy while this limit trips");
    assert.match(second.stderr, /RMD_GH_COOLDOWN_S=0/, "and how to override it deliberately");
  });
});

test("W1-T3275: WRITES are never refused, however close together — the productive path is untouched", () => {
  withCache((c) => {
    // A gate that blocked these would be routed around inside a week; this repo has said so about
    // its own advisory floors. Opening a PR, posting a review and arming a merge back to back is
    // exactly what a working session does.
    backdate(c, 0);
    for (const write of [
      "gh pr merge 4849 --squash --auto",
      "gh pr create --title x --body y",
      "gh api --method POST repos/o/r/pulls -f title=x",
      "gh pr comment 4849 --body hi",
      "gh run rerun 12345",
    ]) {
      assert.equal(fire(write, c).status, 0, `a write must never be refused: ${write}`);
    }
  });
});

test("W1-T3275: the back-off instruments stay reachable — rate_limit and auth status are exempt", () => {
  withCache((c) => {
    backdate(c, 0);
    // These cost no quota and are how a session finds out it must stop. A floor that blocked them
    // would leave a rate-limited session unable to discover when it may resume.
    assert.equal(fire("gh api rate_limit --jq .resources.core", c).status, 0);
    assert.equal(fire("gh auth status", c).status, 0);
    // And a command with no `gh` in it at all is never this rule's business.
    assert.equal(fire("git status --porcelain", c).status, 0);
    assert.equal(fire("node --test test/foo.test.ts", c).status, 0);
  });
});

test("W1-T3275: the window EXPIRES, and a refusal never extends its own window", () => {
  withCache((c) => {
    backdate(c, 200); // older than the 180s floor
    assert.equal(fire("gh pr checks 4852", c).status, 0, "a read outside the floor must be allowed");

    // THE LATCH BUG THIS PINS: if a refusal re-stamped, one burst would push the window forward on
    // every attempt and the floor would never open. The stamp must move only on an ALLOWED read.
    backdate(c, 10);
    const stamp = join(c, STAMP_REL);
    const before = statSync(stamp).mtimeMs;
    assert.equal(fire("gh pr checks 4853", c).status, 2, "10s after a read is inside the floor");
    assert.equal(statSync(stamp).mtimeMs, before, "a REFUSED call must not re-stamp");
  });
});

test("W1-T3275: an inline override is honoured, because an env-only one could never reach this hook", () => {
  withCache((c) => {
    backdate(c, 0);
    // A PreToolUse hook is spawned by the harness, so `RMD_GH_COOLDOWN_S=0 gh …` typed into a tool
    // call never reaches this process's environment. Reading it from the command is what makes the
    // documented escape hatch real rather than a no-op — and keeps it visible to a reviewer.
    assert.equal(fire("RMD_GH_COOLDOWN_S=0 gh pr checks 4851", c).status, 0, "an inline override must actually work");
    assert.equal(fire("gh pr checks 4851", c).status, 2, "and it must not persist to the next call");
  });
});

test("W1-T3275: the floor FAILS OPEN — an unusable cache root blocks nothing", () => {
  withCache((c) => {
    backdate(c, 0);
    // A cadence floor that errors must never stop work. /dev/null/x can never be created.
    const r = fire("gh pr checks 4849", "/dev/null/x");
    assert.equal(r.status, 0, "an unwritable state root must allow the call, not refuse it");
    assert.ok(!existsSync("/dev/null/x"), "and it must not have created anything");
  });
});

test("W1-T3275: a command that MENTIONS gh without invoking it is untouched — a floor that refuses a grep about itself gets disabled", () => {
  withCache((c) => {
    backdate(c, 0); // the floor is wide open; only the mention/invocation distinction is under test
    for (const mention of [
      'grep -n "a bare gh call is still allowed" test/deny-floor.test.ts',
      'echo "gh api is rate limited"',
      "cat docs/gh-notes.md",
      // The sharpest case: a grep whose SEARCH STRING is itself a poll.
      'grep -rn "while true; do gh pr view; sleep 5; done" docs/',
    ]) {
      assert.equal(fire(mention, c).status, 0, `a mention must not be refused: ${mention}`);
    }
  });
});

test("W1-T3275: a gh call inside a quoted command substitution IS an invocation, in both rules", () => {
  withCache((c) => {
    // THE REGRESSION THIS PINS, measured while building this rule: stripping quoted text to kill
    // the false positives above ALSO hid `"$(gh run view …)"` — W1-T1066's own recorded poll — and
    // silently turned rule 6 off for it. Every existing test still passed.
    backdate(c, 0);
    const poll = 'until [ "$(gh run view 123 --json status -q .status)" = "completed" ]; do sleep 20; done';
    assert.equal(fire(poll, c).status, 2, "rule 6 must still refuse the quoted-substitution poll");

    backdate(c, 200); // floor open, so what follows tests recognition rather than cadence
    assert.equal(fire('X=$(gh pr view 1 --json state)', c).status, 0, "the first read is allowed");
    assert.equal(fire('Y=$(gh pr view 2 --json state)', c).status, 2, "the next one is paced like any other read");
  });
});

test("W1-T3275: a poll that assembles the tool name indirectly is NOT caught — the limit is asserted, not papered over", () => {
  withCache((c) => {
    backdate(c, 0);
    // This is a TRIPWIRE, not a parser (hooks/deny-floor.sh's own header). Recording the hole is
    // what keeps a future reader from mistaking the floor for a boundary — the same discipline
    // test/pause-hold-is-attributable.test.ts applies to rule 7's indirect-refspec hole.
    const indirect = 'g=gh; $g pr view 1; $g pr view 2';
    assert.equal(fire(indirect, c).status, 0, "an indirectly-named invocation escapes this floor, by construction");
  });
});
