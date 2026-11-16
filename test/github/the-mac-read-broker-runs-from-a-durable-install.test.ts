import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GH_BROKER_HEARTBEAT, ghBrokerDir, ghBrokerDirLive } from "#src/lib/gh-read-broker-client.js";
import { readBrokerHeartbeat } from "#src/lib/gh-read-broker-watch.js";
import { GH_BROKER_HEARTBEAT_INTERVAL_S } from "#src/lib/gh-read-broker.js";
import {
  agentProgram, brokerInstallWorld as world, brokerSource, executable, fileLines as lines, installBroker as install, lastServedFrom, launchctlCalls,
  MAC_BROKER_INSTALLER as INSTALLER, MAC_BROKER_LABEL as LABEL, nextBrokerVersion as nextVersion, snapshotTree as snapshot,
} from "#test/helpers/mac-read-broker-install-world.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12938 — the Mac read broker ran in place from a worktree; the worktree was retired on 2026-11-11 and
// every session of the account sat on the shared 180 s read floor for four days, with a refusal that never
// said a broker was installed and down. These tests drive the REAL installer and the REAL hook, both under
// /bin/bash (3.2 on a Mac, 5 in CI), against a fake HOME: a stub `launchctl` first on PATH records each call
// and, on bootstrap, runs the agent file's program once the way launchd would. No real launchd, no real
// ~/Library, no real broker, no network.

const HOOK = join(REPO_ROOT, "hooks/deny-floor.sh");
/** The interval the real broker declares in its heartbeat; a reader calls it stale at twice this. */
const BEAT_S = GH_BROKER_HEARTBEAT_INTERVAL_S;

test("W1-T12938 criterion 1: the agent runs a private versioned copy under Application Support, and the copy outlives the checkout it came from", (t) => {
  const w = world(t);
  const source = brokerSource(t);
  const sha = source.git("rev-parse", "HEAD");
  const done = install(w, source);
  assert.equal(done.status, 0, done.stderr);

  const copy = join(w.copies, sha);
  const program = agentProgram(w);
  assert.equal(program, join(copy, "bin/rmd"), "the agent's program is the copy named for the source sha");
  assert.ok(!program.startsWith(source.dir) && !realpathSync(program).startsWith(realpathSync(source.dir)), "never a path inside the checkout it was installed from");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), sha, "the serving sha is recorded beside the copy");
  assert.equal(statSync(copy).mode & 0o077, 0, "the copy is private to the account");
  assert.equal(existsSync(join(copy, "plan/policy.yaml")), true, "the committed tree came along, not only the launcher");
  assert.equal(existsSync(join(copy, "test")), false, "the test tree is left out");
  const modules = lstatSync(join(copy, "node_modules"));
  assert.ok(modules.isDirectory() && !modules.isSymbolicLink(), "the dependencies are a real directory in the copy, not a link back");
  assert.equal(lastServedFrom(w), realpathSync(copy), "launchd started the broker from the copy");
  assert.deepEqual(launchctlCalls(w).map((c) => c.split(" ")[0]), ["print-disabled", "bootout", "bootstrap"]);

  // Retire the checkout, as the janitor retired the worktree on 2026-11-11.
  rmSync(source.dir, { recursive: true, force: true });
  assert.equal(existsSync(source.dir), false);
  assert.equal(existsSync(program), true, "the agent's program path is still present");
  assert.ok((statSync(program).mode & 0o100) !== 0, "and still executable");
  rmSync(w.heartbeat);
  const restarted = spawnSync(program, ["gh-broker", "serve"], { encoding: "utf8", env: w.env });
  assert.equal(restarted.status, 0, `a restart with the checkout gone still serves: ${restarted.stderr}`);
  assert.equal(existsSync(w.heartbeat), true, "and writes its heartbeat again");
});

test("W1-T12938 criterion 2: a second install swaps the copy and the agent in one run, keeps the previous copy until the new agent has written a heartbeat, and --dry-run changes nothing", (t) => {
  const w = world(t);
  const source = brokerSource(t);
  const v1 = source.git("rev-parse", "HEAD");
  assert.equal(install(w, source).status, 0);

  const v2 = nextVersion(source, "v2");
  const second = install(w, source);
  assert.equal(second.status, 0, second.stderr);
  const atSecondStart = lines(join(w.state, "copies-at-bootstrap.2"));
  assert.ok(atSecondStart.includes(v1) && atSecondStart.includes(v2), `the previous copy was still there when the new agent started: ${atSecondStart.join(",")}`);
  assert.deepEqual(readdirSync(w.copies).sort(), ["current", v2].sort(), "one run later the previous copy is gone and only the new one is left");
  assert.equal(agentProgram(w), join(w.copies, v2, "bin/rmd"), "the same run moved the agent to the new copy");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), v2);
  assert.equal(lastServedFrom(w), realpathSync(join(w.copies, v2)));

  // --dry-run prints the copy and the agent and changes nothing: no file, no launchctl call.
  const v3 = nextVersion(source, "v3");
  const before = { home: snapshot(w.home), calls: launchctlCalls(w) };
  const dry = install(w, source, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(`<string>${join(w.copies, v3, "bin/rmd")}</string>`), "it prints the agent it would write, on the new copy");
  assert.ok(dry.stdout.includes(`to ${join(w.copies, v3)}`), "it prints the copy it would make");
  assert.ok(dry.stdout.includes(`would keep the previous copy ${join(w.copies, v2)} until the new agent has written a heartbeat`));
  assert.deepEqual({ home: snapshot(w.home), calls: launchctlCalls(w) }, before, "a dry run leaves every file and the agent as they were");

  // A build whose broker never writes a heartbeat: the previous copy and agent stay, and the exit names the log.
  const broken = nextVersion(source, "BROKEN v4");
  const failed = install(w, source, "--heartbeat-wait", "1");
  assert.notEqual(failed.status, 0, "an install with no heartbeat is a failure");
  assert.ok(failed.stderr.includes(join(w.home, "Library/Logs/remudero-gh-read-broker.err.log")), `the failure names the agent's log: ${failed.stderr}`);
  assert.equal(existsSync(join(w.copies, v2)), true, "the previous copy is still on disk");
  assert.equal(existsSync(join(w.copies, broken)), false, "the copy that never served is not left behind");
  assert.equal(agentProgram(w), join(w.copies, v2, "bin/rmd"), "the agent is back on the previous copy");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), v2, "and the recorded sha never moved");
  assert.equal(lastServedFrom(w), realpathSync(join(w.copies, v2)), "the previous agent was started again");
});

test("W1-T12938: installing the same commit again keeps the serving copy aside until the rebuilt one has a heartbeat, and puts it back when the start fails", (t) => {
  const w = world(t);
  const source = brokerSource(t);
  const sha = source.git("rev-parse", "HEAD");
  assert.equal(install(w, source).status, 0);
  const again = install(w, source);
  assert.equal(again.status, 0, again.stderr);
  const atStart = lines(join(w.state, "copies-at-bootstrap.2"));
  assert.ok(atStart.includes(sha) && atStart.some((name) => name.startsWith(".previous.") && name.endsWith(sha)), `the serving copy stepped aside: ${atStart.join(",")}`);
  assert.deepEqual(readdirSync(w.copies).sort(), ["current", sha].sort());

  writeFileSync(join(w.state, "bootstrap-fails"), "");
  const failed = install(w, source);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error/);
  assert.ok(failed.stderr.includes(`launchctl enable gui/${process.getuid?.()}/${LABEL}`), "an opaque bootstrap failure still names the enable command");
  assert.deepEqual(readdirSync(w.copies).sort(), ["current", sha].sort(), "the copy that was serving is back under its own name");
  assert.equal(agentProgram(w), join(w.copies, sha, "bin/rmd"));
  assert.equal(existsSync(join(w.copies, sha, "bin/rmd")), true);
});

test("W1-T12938: a service launchd holds disabled is named with the command that enables it, before anything is changed", (t) => {
  const w = world(t);
  const source = brokerSource(t);
  writeFileSync(join(w.state, "disabled"), `disabled services = {\n\t"com.remudero.janitor" => enabled\n\t"${LABEL}" => disabled\n}\n`);
  const refused = install(w, source);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`launchd has ${LABEL.replace(/\./g, "\\.")} DISABLED`));
  assert.ok(refused.stderr.includes(`launchctl enable gui/${process.getuid?.()}/${LABEL}`), refused.stderr);
  assert.equal(existsSync(join(w.home, "Library")), false, "no copy, no agent file, no log directory");
  assert.deepEqual(launchctlCalls(w).map((c) => c.split(" ")[0]), ["print-disabled"], "the agent was never stopped or started");

  // Enabled again, the same command installs.
  writeFileSync(join(w.state, "disabled"), `disabled services = {\n\t"${LABEL}" => enabled\n}\n`);
  assert.equal(install(w, source).status, 0);
});

test("W1-T12938: a source that is not a clean checkout is refused by name and nothing is installed", (t) => {
  const w = world(t);
  const source = brokerSource(t);
  writeFileSync(join(source.dir, "src/run-task.ts"), "// edited, not committed\n");
  const dirty = install(w, source);
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /refusing to install: .* has uncommitted changes to tracked files/);
  assert.match(dirty.stderr, /Changed: src\/run-task\.ts/, "the changed path is named");
  const dry = install(w, source, "--dry-run");
  assert.equal(dry.status, 0, "a dry run still shows the plan");
  assert.match(dry.stdout, /would refuse: .* has uncommitted changes to tracked files/);

  // An untracked file is not part of the commit and does not block the install of that commit.
  source.git("checkout", "--quiet", "--", "src/run-task.ts");
  writeFileSync(join(source.dir, "scratch-note.txt"), "untracked\n");
  // A launcher outside any checkout has no commit to copy.
  const loose = join(ownedFixtureDir(t, "broker-loose").dir, "tool", "bin", "rmd");
  executable(loose, "#!/bin/sh\n");
  const notCheckout = spawnSync("/bin/bash", [INSTALLER, "--rmd", loose, "--login", "octo"], { encoding: "utf8", env: w.env });
  assert.equal(notCheckout.status, 2);
  assert.match(notCheckout.stderr, /is not the root of a git checkout/);
  assert.equal(existsSync(join(w.home, "Library")), false, "neither refusal wrote anything under HOME");
  assert.deepEqual(launchctlCalls(w), [], "and launchctl was never called");
  assert.equal(install(w, source).status, 0, "the clean commit installs with the untracked file beside it");
});

/** Fire one PreToolUse call at the real hook, under /bin/bash, with an isolated cache root. */
function fireHook(command: string, cacheHome: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string } {
  const r = spawnSync("/bin/bash", [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, RMD_GH_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "", RMD_DENY_FLOOR_ONLY: "", ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

/** A broker directory whose heartbeat declares the broker's interval and was last written `ageS` seconds ago. */
function heartbeat(cacheHome: string, ageS: number): void {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cacheHome })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GH_BROKER_HEARTBEAT), `${BEAT_S}\n`);
  const at = Date.now() / 1000 - ageS;
  utimesSync(join(dir, GH_BROKER_HEARTBEAT), at, at);
}

/** The floor's refusal as origin/main prints it, with the measured age replaced by N. */
const FLOOR_REFUSAL = [
  "deny-floor: blocked - a read-shaped `gh` call Ns after the last one (floor 180s, W1-T3275).",
  "  The SECONDARY rate limit counts CADENCE, not volume: a run of cheap reads trips it while",
  "  `gh api rate_limit` still reads 5000/5000. Report what you already know and stop -- a wait",
  "  is the operator to schedule. Writes (create/merge/review/POST) are never refused, and",
  "  `gh api rate_limit` is exempt. Deliberate burst: RMD_GH_COOLDOWN_S=0, a choice on the record.",
  "",
].join("\n");
const withoutAge = (stderr: string): string => stderr.replace(/call \d+s after/, "call Ns after");

test("W1-T12938 criterion 3: with a broker directory whose heartbeat is stale, the floor's refusal names the broker as down, the heartbeat's age and the installer that restores it", (t) => {
  const installer = join(realpathSync(REPO_ROOT), "deploy/mac/install-gh-read-broker.sh");
  for (const [ageS, shown] of [[4 * 86_400 + 3 * 3_600 + 120, /4d 3h ago/], [90 * 60 + 20, /1h 30m ago/], [25, /2[5-9]s ago/]] as const) {
    const cache = ownedFixtureDir(t, "broker-down").dir;
    heartbeat(cache, ageS);
    assert.equal(readBrokerHeartbeat({ RMD_GH_CACHE_HOME: cache }, Date.now()).state, "stale", "the daemon's watch reads this fixture as a stale broker too");
    assert.equal(fireHook("gh pr view 5", cache).status, 0, "the first read takes the floor's one slot");
    const refused = fireHook("gh pr view 6", cache);
    assert.equal(refused.status, 2, "the floor holds while the broker is down");
    const down = refused.stderr.split("\n").filter((line) => line.includes("read broker"));
    assert.equal(down.length, 1, `exactly one line names the broker: ${refused.stderr}`);
    assert.match(down[0]!, /The read broker installed for this account is DOWN/);
    assert.match(down[0]!, shown, "it says how long ago the last heartbeat was");
    assert.ok(down[0]!.endsWith(`Restore it: bash ${installer}`), `it ends with the one command that restores it: ${down[0]}`);
    assert.ok(withoutAge(refused.stderr).startsWith(FLOOR_REFUSAL), "the floor's own text still comes first, unchanged");
    // The Codex wiring of the same floor reads the same line.
    assert.match(fireHook("gh pr view 7", cache, { RMD_DENY_FLOOR_ONLY: "gh-read" }).stderr, /read broker installed for this account is DOWN/);
  }
});

test("W1-T12938 criterion 4: invariant:floor-and-routing-unchanged, a live broker still routes a raw read, an account with no broker reads the floor's refusal as before, writes pass, and the floor is 180 s", (t) => {
  // A live broker: the raw read is routed to it, and nothing calls it down.
  const live = ownedFixtureDir(t, "broker-live").dir;
  heartbeat(live, 3);
  assert.ok(ghBrokerDirLive(ghBrokerDir({ RMD_GH_CACHE_HOME: live })!), "the client reads this heartbeat as live");
  const routed = fireHook("gh pr view 5 --json state", live);
  assert.equal(routed.status, 2);
  assert.match(routed.stderr, /deny-floor: routed - a live GitHub read broker serves this account \(W1-T10279\)\./);
  assert.match(routed.stderr, /Re-run the read as: rmd gh --class interactive -- <same gh args>/);
  assert.doesNotMatch(routed.stderr, /DOWN|install-gh-read-broker/);
  assert.equal(fireHook("rmd gh -- pr view 5 --json state", live).status, 0, "rmd gh is never floored while the broker is live");

  // An account that never had a broker: the floor's refusal, byte for byte, with no broker line.
  const none = ownedFixtureDir(t, "broker-none").dir;
  assert.equal(fireHook("gh pr view 5", none).status, 0, "the first read is allowed");
  const floored = fireHook("gh pr view 6", none);
  assert.equal(floored.status, 2);
  assert.equal(withoutAge(floored.stderr), FLOOR_REFUSAL, "exactly the text origin/main prints");
  assert.equal(existsSync(ghBrokerDir({ RMD_GH_CACHE_HOME: none })!), false, "the hook made no broker directory");

  // Writes are never refused: with no broker, with a stale one, with a live one.
  const stale = ownedFixtureDir(t, "broker-stale").dir;
  heartbeat(stale, 3_600);
  for (const cache of [none, stale, live]) {
    for (let i = 0; i < 3; i += 1) assert.equal(fireHook("gh pr comment 5 --body noted", cache).status, 0, "a write passes every time");
  }

  // The interval is 180 s: a read 170 s after the last is refused, one 190 s after is allowed.
  const stamp = join(none, "remudero", "gh-last-read");
  const age = (seconds: number): void => { const at = Date.now() / 1000 - seconds; utimesSync(stamp, at, at); };
  age(170);
  assert.match(fireHook("gh pr view 8", none).stderr, /call 17\ds after the last one \(floor 180s, W1-T3275\)/);
  age(190);
  assert.equal(fireHook("gh pr view 9", none).status, 0, "past 180 s the read is allowed again");
});
