import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { GitRepo } from "#test/helpers/git-repo.js";
import {
  agentProgram, brokerInstallWorld, brokerSource, fileLines, installBrokerWithin, lastServedFrom, launchctl, launchctlCalls, MAC_BROKER_LABEL,
  nextBrokerVersion, snapshotTree, STOP_TAKES_POLLS, type BrokerInstallWorld, type InstallerRun,
} from "#test/helpers/mac-read-broker-install-world.js";

// W1-T13171 — the first live reinstall over a running broker (operator Mac, 2026-11-16) failed with
// "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error": `launchctl bootout` returns before
// launchd has let go of the service, and the installer started the new agent in that window. W1-T12938's
// stand-in stopped a service instantly, so its suite could not see this. Here the same stand-in keeps the
// service LISTED after a stop, for a set number of `launchctl print` calls or for good, and refuses a start
// while it is listed. The REAL installer runs under /bin/bash against a fake HOME; no real launchd is touched.

const DOMAIN = `gui/${process.getuid?.()}`;
const SERVICE = `${DOMAIN}/${MAC_BROKER_LABEL}`;
/** No install here waits longer than a few seconds; one that waits without a bound is killed and reads as a null status. */
const INSTALL_BOUND_MS = 60_000;

const install = (w: BrokerInstallWorld, source: GitRepo, ...args: string[]): InstallerRun => installBrokerWithin(w, source, INSTALL_BOUND_MS, ...args);
/** The service-manager verbs called since call number `from`, in order. */
const verbsSince = (w: BrokerInstallWorld, from: number): string[] => launchctlCalls(w).slice(from).map((call) => call.split(" ")[0]!);
/** How a stopped service behaves from now on: one entry per stop, the last one for every later stop. */
const stopsTake = (w: BrokerInstallWorld, ...polls: Array<number | "never">): void => writeFileSync(join(w.state, STOP_TAKES_POLLS), `${polls.join("\n")}\n`);

/** An account whose broker is installed and loaded, serving from the copy of the fixture's first commit. */
function servingAccount(t: TestContext): { w: BrokerInstallWorld; source: GitRepo; v1: string; v1Program: string } {
  const w = brokerInstallWorld(t);
  const source = brokerSource(t);
  const v1 = source.git("rev-parse", "HEAD");
  const first = install(w, source);
  assert.equal(first.status, 0, first.stderr);
  return { w, source, v1, v1Program: join(w.copies, v1, "bin/rmd") };
}

/** The old agent is the one on disk: its agent file, its copy alone, and the recorded sha. */
function assertOldAgentOnDisk(w: BrokerInstallWorld, v1: string): void {
  assert.equal(agentProgram(w), join(w.copies, v1, "bin/rmd"), "the agent file still names the old copy");
  assert.deepEqual(readdirSync(w.copies).sort(), ["current", v1].sort(), "the old copy is the only copy: no new one, no staging directory");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), v1, "the recorded sha never moved");
}

test("W1-T13171 criterion 1: after it stops the old agent the installer starts the new one only once the service manager no longer lists the service, so a stop that returns early no longer ends in an input/output error", (t) => {
  const { w, source, v1 } = servingAccount(t);
  stopsTake(w, 2);

  // The stand-in itself, driven the way the installer drove launchd on 2026-11-16: the stop returns at once,
  // the service stays listed, and a start in that window fails. Only after a `print` has failed does it start.
  assert.equal(launchctl(w, "bootout", SERVICE).status, 0, "the stop returns at once");
  const early = launchctl(w, "bootstrap", DOMAIN, w.plist);
  assert.equal(early.status, 5, "a start straight after the stop is refused");
  assert.match(early.stderr, /Bootstrap failed: 5: Input\/output error/);
  assert.deepEqual([1, 2, 3].map(() => launchctl(w, "print", SERVICE).status), [0, 0, 113], "the service is listed for two more looks, then gone");
  assert.equal(launchctl(w, "bootstrap", DOMAIN, w.plist).status, 0, "once it is gone the same start succeeds");

  // The installer over that running agent.
  const v2 = nextBrokerVersion(source, "v2");
  const from = launchctlCalls(w).length;
  const done = install(w, source);
  assert.equal(done.status, 0, `the install succeeds the first time: ${done.stderr}`);
  assert.doesNotMatch(done.stderr, /Input\/output error/);
  assert.deepEqual(verbsSince(w, from), ["print-disabled", "bootout", "print", "print", "print", "bootstrap"], "it looked until the service was gone, and only then started the new agent, once");
  assert.equal(existsSync(join(w.state, "going")), false, "the start came after a look that found the service gone");
  const starts = launchctlCalls(w).filter((call) => call.startsWith("bootstrap ")).length;
  const atStart = fileLines(join(w.state, `copies-at-bootstrap.${starts}`));
  assert.ok(atStart.includes(v1) && atStart.includes(v2), `the previous copy was still there when the new agent started: ${atStart.join(",")}`);
  assert.equal(agentProgram(w), join(w.copies, v2, "bin/rmd"), "the agent runs the new copy");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), v2);
  assert.equal(lastServedFrom(w), realpathSync(join(w.copies, v2)), "and launchd started the broker from it");
  assert.deepEqual(readdirSync(w.copies).sort(), ["current", v2].sort(), "the previous copy went once the new agent had a heartbeat");
});

test("W1-T13171 criterion 2: the wait is bounded by the seconds given for the heartbeat wait, and an old agent that never goes away ends the install with the service named, nothing replaced and the old agent still the one on disk", (t) => {
  const { w, source, v1 } = servingAccount(t);
  stopsTake(w, "never");
  nextBrokerVersion(source, "v2");

  /** One install over the agent that never goes away: how many times it looked, and how long it took. */
  const refusedAfter = (seconds: number): { looks: number; elapsedMs: number } => {
    const before = snapshotTree(w.home);
    const from = launchctlCalls(w).length;
    const started = Date.now();
    const refused = install(w, source, "--heartbeat-wait", String(seconds));
    const elapsedMs = Date.now() - started;
    assert.notEqual(refused.status, null, `the wait ends by itself, inside the ${seconds}s it was given (killed after ${INSTALL_BOUND_MS} ms): ${refused.stderr}`);
    assert.equal(refused.status, 1, `an old agent that is still loaded fails the install: ${refused.stderr}`);
    assert.ok(refused.stderr.includes(SERVICE), `the failure names the service: ${refused.stderr}`);
    assert.match(refused.stderr, /the old agent is still loaded/);
    assert.deepEqual(snapshotTree(w.home), before, "nothing on disk was replaced, added or left behind");
    assertOldAgentOnDisk(w, v1);
    const verbs = verbsSince(w, from);
    assert.deepEqual(verbs.slice(0, 2), ["print-disabled", "bootout"]);
    assert.ok(verbs.slice(2).every((verb) => verb === "print"), `after the stop it only looked, and never started an agent: ${verbs.join(",")}`);
    return { looks: verbs.length - 2, elapsedMs };
  };

  const none = refusedAfter(0);
  const one = refusedAfter(1);
  const two = refusedAfter(2);
  assert.equal(none.looks, 1, "given no seconds it looks once and does not wait");
  assert.ok(one.looks > none.looks && two.looks > one.looks, `more seconds, more looks: ${none.looks}, ${one.looks}, ${two.looks}`);
  assert.ok(one.elapsedMs >= 1_000 && two.elapsedMs >= 2_000, `it waits the seconds it was given before giving up: ${one.elapsedMs} ms, ${two.elapsedMs} ms`);
});

test("W1-T13171 criterion 3: the roll-back waits the same way before it starts the previous agent again", (t) => {
  const { w, source, v1, v1Program } = servingAccount(t);
  stopsTake(w, 1);
  // A build whose broker never writes a heartbeat: the new agent is started, then stopped, and its stop returns early too.
  nextBrokerVersion(source, "BROKEN v2");
  const from = launchctlCalls(w).length;
  const failed = install(w, source, "--heartbeat-wait", "1");
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /the new agent wrote no heartbeat/);
  assert.deepEqual(
    verbsSince(w, from),
    ["print-disabled", "bootout", "print", "print", "bootstrap", "bootout", "print", "print", "bootstrap"],
    "each stop is followed by looks until the service is gone, before the next start",
  );
  assert.ok(failed.stderr.includes(`the previous agent is back, running ${v1Program}`), `the previous agent was started: ${failed.stderr}`);
  assert.doesNotMatch(failed.stderr, /would not start it|NOT running/);
  assert.deepEqual(fileLines(join(w.state, "served-from")), [realpathSync(join(w.copies, v1)), realpathSync(join(w.copies, v1))], "the previous copy served, and serves again");
  assert.equal(existsSync(join(w.state, "loaded")), true, "the service manager holds the previous agent loaded");
  assertOldAgentOnDisk(w, v1);
});

test("W1-T13171 criterion 4: invariant:an-install-never-leaves-the-account-without-a-broker, a failed install ends with the previous agent serving or with a line that says it is not and how to start it", (t) => {
  const start = (w: BrokerInstallWorld): string => `launchctl bootstrap ${DOMAIN} ${w.plist}`;

  // The old agent never goes away: nothing is replaced, and the last lines say the agent may not be serving.
  const stuck = servingAccount(t);
  stopsTake(stuck.w, "never");
  nextBrokerVersion(stuck.source, "v2");
  const refused = install(stuck.w, stuck.source, "--heartbeat-wait", "0");
  assert.equal(refused.status, 1, refused.stderr);
  const said = refused.stderr.split("\n").filter(Boolean);
  assert.ok(said.some((line) => line.includes(SERVICE) && /the old agent is still loaded/.test(line) && /nothing was replaced/.test(line)), refused.stderr);
  assert.ok(said.some((line) => line.includes(stuck.v1Program) && /may not be serving/.test(line)), `it says which agent may not be serving: ${refused.stderr}`);
  assert.ok(said.at(-1)!.includes(start(stuck.w)), `and ends with the command that starts it: ${refused.stderr}`);
  assertOldAgentOnDisk(stuck.w, stuck.v1);

  // The new agent never beats and then never goes away: the previous files are back, and the line says it is not running.
  const wedged = servingAccount(t);
  stopsTake(wedged.w, 0, "never");
  nextBrokerVersion(wedged.source, "BROKEN v2");
  const from = launchctlCalls(wedged.w).length;
  const notBack = install(wedged.w, wedged.source, "--heartbeat-wait", "1");
  assert.equal(notBack.status, 1, notBack.stderr);
  const verbs = verbsSince(wedged.w, from);
  assert.deepEqual(verbs.slice(0, 5), ["print-disabled", "bootout", "print", "bootstrap", "bootout"]);
  assert.ok(verbs.slice(5).filter((verb) => verb === "print").length > 1, `the roll-back looked for the seconds it was given: ${verbs.join(",")}`);
  const lines = notBack.stderr.split("\n").filter(Boolean);
  assert.ok(
    lines.some((line) => line.includes(wedged.v1Program) && line.includes(SERVICE) && /the previous agent is NOT running/.test(line)),
    `it says the previous agent is not running, and names the service: ${notBack.stderr}`,
  );
  assert.ok(lines.at(-1)!.includes(start(wedged.w)), `and ends with the command that starts it: ${notBack.stderr}`);
  assert.doesNotMatch(notBack.stderr, /the previous agent is back, running/);
  assertOldAgentOnDisk(wedged.w, wedged.v1);

  // A stop that ends at once, as before this task: the roll-back starts the previous agent, and says so.
  const plain = servingAccount(t);
  nextBrokerVersion(plain.source, "BROKEN v2");
  const rolledBack = install(plain.w, plain.source, "--heartbeat-wait", "1");
  assert.equal(rolledBack.status, 1, rolledBack.stderr);
  assert.ok(rolledBack.stderr.includes(`the previous agent is back, running ${plain.v1Program}`), rolledBack.stderr);
  assert.equal(lastServedFrom(plain.w), realpathSync(join(plain.w.copies, plain.v1)));
  assert.equal(fileLines(join(plain.w.state, "served-from")).length, 2, "the previous agent was started again");
  assertOldAgentOnDisk(plain.w, plain.v1);
});

test("W1-T13171 criterion 4: a dry run still changes nothing and says what it would wait for, and an install with no previous agent makes the calls it made before", (t) => {
  const w = brokerInstallWorld(t);
  const source = brokerSource(t);
  const v1 = source.git("rev-parse", "HEAD");
  // Every stop from here on would never end: an account with no agent has nothing to stop, so nothing to wait for.
  stopsTake(w, "never");

  const dryFirst = install(w, source, "--dry-run");
  assert.equal(dryFirst.status, 0, dryFirst.stderr);
  assert.match(dryFirst.stdout, /no previous agent: nothing to keep or remove/);
  assert.doesNotMatch(dryFirst.stdout, /would wait up to \d+s for launchd/, "no agent file, no wait to announce");
  assert.equal(existsSync(join(w.home, "Library")), false, "the dry run wrote nothing under HOME");
  assert.deepEqual(launchctlCalls(w), [], "and called the service manager for nothing");

  const first = install(w, source);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(verbsSince(w, 0), ["print-disabled", "bootout", "bootstrap"], "the first install's calls are the ones origin/main makes");
  assert.equal(lastServedFrom(w), realpathSync(join(w.copies, v1)));

  // Over the running agent a dry run prints the wait, between the stop and the start, and touches nothing.
  nextBrokerVersion(source, "v2");
  const before = { home: snapshotTree(w.home), calls: launchctlCalls(w) };
  const dry = install(w, source, "--dry-run", "--heartbeat-wait", "7");
  assert.equal(dry.status, 0, dry.stderr);
  const [stop, wait, begin] = [`would run: launchctl bootout ${SERVICE}`, `would wait up to 7s for launchd to stop listing ${SERVICE}`, `would run: launchctl bootstrap ${DOMAIN}`].map((line) => dry.stdout.indexOf(line));
  assert.ok(stop !== -1 && wait > stop && begin > wait, `the plan is stop, wait, start: ${dry.stdout.split("\n").filter((line) => line.startsWith("would")).join(" | ")}`);
  assert.deepEqual({ home: snapshotTree(w.home), calls: launchctlCalls(w) }, before, "a dry run leaves every file and the agent as they were, and never looks at launchd");
  assert.equal(existsSync(join(w.state, "loaded")), true, "the agent it would have stopped is still loaded");
});
