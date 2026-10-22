import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import {
  brokerGhReadAs, ghBrokerCommand, ghBrokerLoginStatus, ghCommand, GhReadBroker, GhSharedPace, isGhPaceLogin, serveGhReadBroker,
  summariseGhBrokerLog,
  type GhUpstreamExec, type GhUpstreamResult,
} from "#src/lib/gh-read-broker.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T10302 — Codex sessions read GitHub as the same user as the Claude sessions, around the broker. These
// tests drive the real hooks/deny-floor.sh with a Codex-shaped payload, and two real GhReadBroker instances
// (two Mac accounts) with an injected `gh` executor, an injected clock and temp directories standing in for
// two accounts' homes plus the shared pace directory. No real gh, Codex or network.

const HOOK = join(REPO_ROOT, "hooks/deny-floor.sh");
const INSTALLER = join(REPO_ROOT, "deploy/mac/install-gh-read-broker.sh");
const LOGIN = "octo";

function tmp(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-codex-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function virtualClock(start = 1_800_000_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); },
  };
}

const ok = (stdout: string): GhUpstreamResult => ({ stdout, stderr: "", exitCode: 0 });
const http = (status: string, headers: string[], body: string) => ok(`${["HTTP/2.0 " + status, ...headers].join("\r\n")}\r\n\r\n${body}`);

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), `timed out waiting for ${what}`);
}

/** A codex-cli 0.163.0 `pre-tool-use.command.input` for a shell call: the fields its schema requires, with the
 *  command under tool_input. (Read from the installed binary's embedded schema; tool_input itself is free-form.) */
function codexPayload(command: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "019a0000-0000-7000-8000-000000000001", turn_id: "turn-1", transcript_path: null, cwd: REPO_ROOT,
    hook_event_name: "PreToolUse", model: "gpt-5-codex", permission_mode: "default",
    tool_name: "Bash", tool_input: { command }, tool_use_id: "call_1", ...over,
  };
}

function fireCodexHook(payload: Record<string, unknown>, cacheHome: string, floorOnly: string | null = "gh-read"): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_GH_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "" };
  if (floorOnly === null) delete env.RMD_DENY_FLOOR_ONLY;
  else env.RMD_DENY_FLOOR_ONLY = floorOnly;
  const r = spawnSync("bash", [HOOK], { input: JSON.stringify(payload), encoding: "utf8", env });
  return { status: r.status, stderr: r.stderr };
}

function heartbeat(cacheHome: string, intervalS: number, ageS: number): void {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cacheHome })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), `${intervalS}\n`);
  const at = (Date.now() - ageS * 1000) / 1000;
  utimesSync(join(dir, "heartbeat"), at, at);
}

test("W1-T10302: the repo wires Codex to the gh-read rule through a project hook", () => {
  const toml = readFileSync(join(REPO_ROOT, ".codex/config.toml"), "utf8");
  assert.match(toml, /^\[\[hooks\.PreToolUse\.hooks\]\]$/m);
  assert.match(toml, /^command = ".*RMD_DENY_FLOOR_ONLY=gh-read.*hooks\/deny-floor\.sh/m, "the hook command sets the floor to gh-read inline");
});

test("W1-T10302: a Codex shell payload is routed by the gh-read rule alone", (t) => {
  const live = tmp(t, "hook-live");
  heartbeat(live, 10, 3);
  const routed = fireCodexHook(codexPayload("gh pr view 5 --json state"), live);
  assert.equal(routed.status, 2, "a raw read from Codex is refused while the broker is live");
  assert.match(routed.stderr, /rmd gh --class interactive --client codex -- <same gh args>/, "the instruction names the client");

  // exec_command carries `cmd`, and a tool_input that is not an object must not crash the hook.
  const viaCmd = fireCodexHook(codexPayload("", { tool_name: "exec_command", tool_input: { cmd: "gh api repos/o/r/pulls/5" } }), live);
  assert.equal(viaCmd.status, 2);
  assert.equal(fireCodexHook(codexPayload("", { tool_input: "just a string" }), live).status, 0);

  // rmd gh is paced by the broker, with or without the client flag; a polling loop around it is still refused.
  assert.equal(fireCodexHook(codexPayload("rmd gh --class interactive --client codex -- pr view 5"), live).status, 0);
  assert.equal(fireCodexHook(codexPayload("rmd gh -- pr view 5 && gh pr view 6"), live).status, 2, "a raw gh beside an rmd gh is still routed");
  assert.equal(fireCodexHook(codexPayload("gh api rate_limit"), live).status, 0, "the budget probe stays exempt");
  assert.equal(
    fireCodexHook(codexPayload("for i in 1 2 3; do rmd gh --client codex -- pr view 5; sleep 30; done"), live).status, 2,
    "rule 7 still refuses a polling loop around rmd gh",
  );
  // A file tool's payload may merely mention a read command.
  assert.equal(
    fireCodexHook(codexPayload("*** Begin Patch\n+run gh pr view 5\n", { tool_name: "apply_patch" }), live).status, 0,
    "a patch that mentions a read is not a shell call",
  );

  // THE OTHER RULES ARE NOT CODEX'S HERE: a push to main is refused by the whole floor and allowed by gh-read alone.
  const push = codexPayload("git push origin main");
  assert.equal(fireCodexHook(push, live).status, 0, "gh-read evaluates rule 10 alone");
  const whole = fireCodexHook(push, live, null);
  assert.equal(whole.status, 2, "control: the whole floor refuses that same command");
  assert.match(whole.stderr, /default branch|main/i);

  // With no live broker rule 10's own fallback applies: a first read is allowed, one right after it is refused.
  const dead = tmp(t, "hook-dead");
  assert.equal(fireCodexHook(codexPayload("gh pr view 5"), dead).status, 0);
  const floored = fireCodexHook(codexPayload("gh pr view 6"), dead);
  assert.equal(floored.status, 2);
  assert.match(floored.stderr, /read-shaped `gh` call/);
});

/** An executor with a per-test script. `api user` (the login lookup) answers itself. */
function scriptedExec(clock: { now: () => number }, onCall: (args: string[], startedMs: number) => GhUpstreamResult | Promise<GhUpstreamResult>) {
  const starts: Array<{ args: string[]; startedMs: number }> = [];
  const exec: GhUpstreamExec = async (args) => {
    if (args[1] === "user") return ok(`${LOGIN}\n`);
    starts.push({ args, startedMs: clock.now() });
    return onCall(args, clock.now());
  };
  return { exec, starts };
}

function accountBroker(t: TestContext, name: string, shared: string | null, clock: ReturnType<typeof virtualClock>, exec: GhUpstreamExec): GhReadBroker {
  const home = tmp(t, name);
  return new GhReadBroker(join(home, "gh-broker"), exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12, { sharedPaceRoot: shared, account: name });
}

const read = (broker: GhReadBroker, n: number, client?: "claude" | "codex" | "agent") =>
  broker.read({ op: "read", args: ["api", `repos/o/r/pulls/${n}`], class: "interactive", caller: `s${n}`, ...(client ? { client } : {}) } as Parameters<GhReadBroker["read"]>[0]);

test("W1-T10302: two Mac accounts reading as one login back off together", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  const clock = virtualClock();
  const refusal = { ...http("403 Forbidden", ["Retry-After: 45"], '{"message":"You have exceeded a secondary rate limit"}'), exitCode: 1 };
  let refused = false;
  const a = scriptedExec(clock, () => { refused = true; return refusal; });
  const b = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const claude = accountBroker(t, "claude-acct", shared, clock, a.exec);
  const codex = accountBroker(t, "codex-acct", shared, clock, b.exec);

  assert.equal((await read(claude, 1, "claude")).outcome, "upstream-error");
  assert.ok(refused);
  const refusedAt = clock.now();
  assert.equal((await read(codex, 2, "codex")).outcome, "upstream-200");
  assert.equal(b.starts.length, 1);
  assert.ok(b.starts[0].startedMs - refusedAt >= 45_000, `the second account's start waited out the first's hold (${b.starts[0].startedMs - refusedAt} ms)`);
  const gap = (codex.status() as { limiters: { core: { gap_ms: number } } }).limiters.core.gap_ms;
  assert.equal(gap, 3_000 - 150, "the shared gap the first account doubled, narrowed by the second's success");
  assert.equal((codex.status() as { pacer: string }).pacer, "shared");

  // The state is timing and counts only, and names which account's broker saw the refusal.
  const state = readFileSync(join(shared, LOGIN, "state-core.json"), "utf8");
  assert.doesNotMatch(state, /secondary rate limit|HTTP\/2|octo-token/i, "no response text is shared");
  assert.deepEqual(Object.keys(JSON.parse(state).seen), ["claude-acct"]);

  // CONTROL: the same two reads with a per-account pacer start the second one inside the first's hold.
  const clock2 = virtualClock();
  const a2 = scriptedExec(clock2, () => refusal);
  const b2 = scriptedExec(clock2, () => http("200 OK", [], "{}"));
  const solo1 = accountBroker(t, "solo-1", null, clock2, a2.exec);
  const solo2 = accountBroker(t, "solo-2", null, clock2, b2.exec);
  await read(solo1, 1);
  const before = clock2.now();
  await read(solo2, 2);
  assert.ok(b2.starts[0].startedMs - before < 45_000, "control: without sharing the second broker is blind to the first's hold");
  assert.match((solo1.status() as { pacer: string }).pacer, /disabled/);
});

test("W1-T10302: one login is serial across accounts and caches stay per account", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  const clock = virtualClock();
  let active = 0;
  let maxActive = 0;
  const pending: Array<() => void> = [];
  const exec = scriptedExec(clock, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return http("200 OK", ["Cache-Control: max-age=60", 'ETag: "x"'], '{"ok":true}');
  });
  const one = accountBroker(t, "acct-one", shared, clock, exec.exec);
  const two = accountBroker(t, "acct-two", shared, clock, exec.exec);

  const first = read(one, 1);
  const second = read(two, 2);
  await until(() => pending.length === 1, "the first upstream start");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pending.length, 1, "the second account does not start while the first holds the login's lock");
  assert.equal(existsSync(join(shared, LOGIN, "lock-core")), true);
  pending.shift()!();
  await until(() => pending.length === 1, "the second upstream start, after the first finished");
  pending.shift()!();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1, "upstream calls for one limiter never overlapped across the two brokers");
  assert.equal(existsSync(join(shared, LOGIN, "lock-core")), false, "the lock is released");

  // Nothing but timing state crosses accounts: each cache holds only what its own broker read.
  assert.deepEqual(readdirSync(join(shared, LOGIN)).filter((n) => !/^state-[a-z]+\.json$/.test(n)), [], "the shared directory holds no cache");
  const cached = (b: GhReadBroker) => readdirSync(join(b.dir, "cache")).filter((n) => n.endsWith(".json")).length;
  assert.equal(cached(one), 1);
  assert.equal(cached(two), 1);
  const hit = read(two, 1);
  await until(() => pending.length === 1, "account two's own upstream read of account one's pull request");
  pending.shift()!();
  assert.equal((await hit).outcome, "upstream-200", "account one's cache entry is not served to account two");
  assert.equal(cached(two), 2);
  assert.equal(maxActive, 1);
});

test("W1-T10302: an unusable shared pacer falls back to the account pacer", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  mkdirSync(join(shared, LOGIN, "state-core.json")); // a directory where the state file belongs: reads and replaces fail
  const clock = virtualClock();
  const exec = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const broker = accountBroker(t, "acct", shared, clock, exec.exec);
  const result = await read(broker, 1);
  assert.equal(result.outcome, "upstream-200", "the read is served, never stopped by the shared state");
  const pacer = (broker.status() as { pacer: string }).pacer;
  assert.match(pacer, /^account \(fallback: shared pacer unusable: /, "status names the fallback");
  assert.equal((broker.status() as { limiters: { core: { gap_ms: number } } }).limiters.core.gap_ms, 1_350, "the per-account pacer paced it");

  // No directory for the login at all: also per account, and status says what to run.
  const none = tmp(t, "no-dir");
  const lone = accountBroker(t, "lone", none, clock, exec.exec);
  await read(lone, 3);
  assert.match((lone.status() as { pacer: string }).pacer, /no shared pace directory for octo/);

  // A login is a path component under the pace root: anything else is never joined, and never escapes the root.
  assert.deepEqual(["octo", "octo-2", "A1"].map(isGhPaceLogin), [true, true, true]);
  assert.deepEqual(["", "../etc", "a/b", ".", "-x", "a b"].map(isGhPaceLogin), [false, false, false, false, false, false]);
  const evilExec = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const evil = new GhReadBroker(join(tmp(t, "evil"), "gh-broker"), async (args, o) => (args[1] === "user" ? ok("../etc\n") : evilExec.exec(args, o)), clockFromMillisFn(clock.now), clock.sleep, () => 1e12, { sharedPaceRoot: none, account: "evil" });
  assert.equal((await read(evil, 5)).outcome, "upstream-200");
  assert.match((evil.status() as { pacer: string }).pacer, /names no shared pace directory/);

  // A torn state file is not a pace either: the read is still served, per account.
  const odd = tmp(t, "odd");
  mkdirSync(join(odd, LOGIN));
  writeFileSync(join(odd, LOGIN, "state-core.json"), "{not json");
  const torn = accountBroker(t, "torn", odd, clock, exec.exec);
  assert.equal((await read(torn, 4)).outcome, "upstream-200");
  assert.match((torn.status() as { pacer: string }).pacer, /fallback/);
});

test("W1-T10302: a lock left by a dead process is reclaimed", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN, "lock-core"), { recursive: true });
  writeFileSync(join(shared, LOGIN, "lock-core", "owner"), `${2 ** 22 + 12345} 0\n`); // no such pid
  const clock = virtualClock();
  const exec = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const broker = accountBroker(t, "acct", shared, clock, exec.exec);
  assert.equal((await read(broker, 1)).outcome, "upstream-200");
  assert.equal((broker.status() as { pacer: string }).pacer, "shared");
  assert.equal(existsSync(join(shared, LOGIN, "lock-core")), false);
});

test("W1-T10302: the request log names the client and status counts per login", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  const cache = tmp(t, "cache");
  const clock = virtualClock();
  const refusal = { ...http("403 Forbidden", ["Retry-After: 5"], "{}"), exitCode: 1 };
  const answers = [http("200 OK", [], "{}"), refusal, http("200 OK", [], "{}")];
  const exec = scriptedExec(clock, () => answers.shift()!);
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const broker = new GhReadBroker(dir, exec.exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12, { sharedPaceRoot: shared, account: "craigoley" });
  heartbeat(cache, 10, 1);

  // `rmd gh --client codex` reaches the broker as client=codex; an unnamed read takes its client from its class.
  const env = { ...process.env, RMD_GH_CACHE_HOME: cache, RMD_GH_CLASS: "", RMD_GH_CLIENT: "" };
  const viaBroker: Parameters<typeof ghCommand>[3] = async (_socket, args, opts) => broker.read({
    op: "read", args: [...args], class: opts?.class ?? "background", caller: opts?.caller ?? "c", client: opts?.client, cwd: opts?.cwd, repo: opts?.repo,
  } as Parameters<GhReadBroker["read"]>[0]);
  const out: string[] = [];
  const run = (flags: string[], n: number) => ghCommand([...flags, "--", "api", `repos/o/r/pulls/${n}`], env, () => 1, viaBroker, (_s, text) => void out.push(text));
  assert.equal(await run(["--class", "interactive", "--client", "codex"], 1), 0, out.join(""));
  assert.equal(await run(["--class", "agent"], 2), 1, "the refused read is gh's own answer");
  assert.equal(await run(["--class", "interactive"], 3), 0);
  assert.equal(await ghCommand(["--client", "emacs", "--", "api", "x"], env, () => 1, viaBroker, () => undefined), 2, "an unknown client is a usage error");

  const log = summariseGhBrokerLog(dir, 0) as { by_client: Record<string, number>; refusals_by_limiter: Record<string, number>; reads: number };
  assert.deepEqual(log.by_client, { codex: 1, agent: 1, claude: 1 });
  assert.deepEqual(log.refusals_by_limiter, { core: 1 });
  assert.equal(log.reads, 3, "a refusal row is an upstream answer, not a read");

  const view = ghBrokerLoginStatus(dir, 0, { login: LOGIN, account: "craigoley", env: { RMD_GH_PACE_ROOT: shared } }) as {
    login: string; accounts: string[]; shared_pace_dir: string; by_account: Record<string, { requests_by_client: Record<string, number> }>;
    shared_refusals_by_account: Record<string, Record<string, number>>;
  };
  assert.equal(view.login, LOGIN);
  assert.equal(view.shared_pace_dir, join(shared, LOGIN));
  assert.deepEqual(view.by_account.craigoley.requests_by_client, { codex: 1, agent: 1, claude: 1 });
  assert.deepEqual(view.shared_refusals_by_account, { craigoley: { core: 1 } }, "which account's broker saw each refusal");

  // The CLI prints it: `status` appends login_status through the injected helper.
  const printed: string[] = [];
  const request = (async () => ({ ...broker.status() })) as unknown as Parameters<typeof ghBrokerCommand>[5];
  assert.equal(
    await ghBrokerCommand(
      ["status", "--since", "1d"], async () => { throw new Error("status never serves"); }, env, (text) => void printed.push(text),
      (d, since, login) => ghBrokerLoginStatus(d, since, { login, account: "craigoley", env }), request,
    ),
    0,
  );
  const shown = JSON.parse(printed.join("")) as { login_status: { login: string }; pacer: string; account: string };
  assert.equal(shown.login_status.login, LOGIN);
  assert.equal(shown.pacer, "shared");
  assert.equal(shown.account, "craigoley");
});

test("W1-T10302: the installer joins a second account to the login's shared pace directory", (t) => {
  const home = tmp(t, "install");
  const pace = join(tmp(t, "pace-root"), "gh-pace");
  const rmd = join(home, "rmd");
  writeFileSync(rmd, "#!/bin/sh\n");
  chmodSync(rmd, 0o755);
  const env = { ...process.env, HOME: home, REMUDERO_GH_PACE_ROOT: pace };
  const first = spawnSync("bash", [INSTALLER, "--dry-run", "--rmd", rmd, "--login", LOGIN], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /would create the shared pace directory .*gh-pace\/octo \(mode 0700, ACL: user:\S+ allow /);
  assert.match(first.stdout, new RegExp(`login: ${LOGIN}; account: \\S+; codex-cli: `));
  assert.doesNotMatch(first.stdout, /world|a\+w|o\+w|777/, "never world-writable");
  mkdirSync(join(pace, LOGIN), { recursive: true });
  const second = spawnSync("bash", [INSTALLER, "--dry-run", "--rmd", rmd, "--login", LOGIN], { encoding: "utf8", env });
  assert.match(second.stdout, /would join the shared pace directory .*gh-pace\/octo \(add to its ACL: user:/);
  assert.equal(existsSync(join(home, "Library")), false, "a dry run still creates nothing under HOME");
  assert.equal(spawnSync("bash", [INSTALLER, "--dry-run", "--rmd", rmd, "--login", "../etc"], { encoding: "utf8", env }).status, 2, "a login is a path component, validated");
});

/** Wraps one GhSharedPace method for the length of a test, so a test can fail the shared directory at a chosen step. */
function patchPace(t: TestContext, name: "tryLock" | "write", impl: (this: GhSharedPace, orig: (...a: unknown[]) => unknown, ...a: unknown[]) => unknown): void {
  const proto = GhSharedPace.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto[name];
  proto[name] = function patched(this: GhSharedPace, ...a: unknown[]) { return impl.call(this, orig, ...a); };
  t.after(() => { proto[name] = orig; });
}

const holdFile = (holdUntilMs: number) => ({ gapMs: 1_500, holdUntilMs, lastStartMs: null, secondaryRefusals: 0, primary: null, seen: {} });

test("W1-T10302: a start that loses the race for the login's lock waits out the hold the winner set", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  const clock = virtualClock();
  const exec = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const broker = accountBroker(t, "late", shared, clock, exec.exec);
  let raced = false;
  const t0 = clock.now();
  // The other account's broker finishes a refused call between our first look at the state and taking the lock.
  patchPace(t, "tryLock", function (orig, ...a) {
    if (!raced) {
      raced = true;
      this.write("core", holdFile(t0 + 10_000));
    }
    return orig.apply(this, a);
  });
  assert.equal((await read(broker, 1)).outcome, "upstream-200");
  assert.ok(raced);
  assert.ok(exec.starts[0].startedMs - t0 >= 10_000, `the start waited out the hold seen after the lock (${exec.starts[0].startedMs - t0} ms)`);
  assert.equal(existsSync(join(shared, LOGIN, "lock-core")), false, "the lock taken for the lost race was released");
  assert.equal((broker.status() as { pacer: string }).pacer, "shared");
});

test("W1-T10302: a shared directory that fails while the lock is taken or after the call falls back and releases the lock", async (t) => {
  const clock = virtualClock();

  // The lock itself cannot be taken: nothing is held, the read is served on the account pacer.
  const noLock = tmp(t, "no-lock");
  mkdirSync(join(noLock, LOGIN));
  const execA = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const a = accountBroker(t, "no-lock", noLock, clock, execA.exec);
  let mode: "lock-throws" | "state-torn-after-lock" | "write-throws" = "lock-throws";
  patchPace(t, "tryLock", function (orig, ...a2) {
    if (mode === "lock-throws") throw new Error("EACCES: lock directory");
    const got = orig.apply(this, a2);
    if (mode === "state-torn-after-lock") writeFileSync(join(this.dir, "state-core.json"), "{torn");
    return got;
  });
  assert.equal((await read(a, 1)).outcome, "upstream-200");
  assert.match((a.status() as { pacer: string }).pacer, /fallback: shared pacer unusable: EACCES: lock directory/);

  // The lock is taken, then the state read after it is torn: the lock is let go before the read goes on.
  mode = "state-torn-after-lock";
  const torn = tmp(t, "torn-after-lock");
  mkdirSync(join(torn, LOGIN));
  const execB = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const b = accountBroker(t, "torn", torn, clock, execB.exec);
  assert.equal((await read(b, 2)).outcome, "upstream-200");
  assert.match((b.status() as { pacer: string }).pacer, /fallback: shared pacer unusable: /);
  assert.equal(existsSync(join(torn, LOGIN, "lock-core")), false, "the lock taken before the failure is released");
});

test("W1-T10302: a shared directory that cannot take the outcome falls back after the call and frees the lock", async (t) => {
  const shared = tmp(t, "pace");
  mkdirSync(join(shared, LOGIN));
  const clock = virtualClock();
  const exec = scriptedExec(clock, () => http("200 OK", [], "{}"));
  const broker = accountBroker(t, "full", shared, clock, exec.exec);
  patchPace(t, "write", () => { throw new Error("ENOSPC: no space left"); });
  assert.equal((await read(broker, 1)).outcome, "upstream-200", "the read that ran is still answered");
  assert.match((broker.status() as { pacer: string }).pacer, /fallback: shared pacer unusable: ENOSPC/);
  assert.equal(existsSync(join(shared, LOGIN, "lock-core")), false, "the lock is released even when the outcome could not be published");
});

test("W1-T10302: the default client read sends the client to the broker and returns gh's answer", async (t) => {
  const cache = tmp(t, "cache");
  const clock = virtualClock();
  const exec = scriptedExec(clock, () => http("200 OK", [], '{"n":1}'));
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const broker = new GhReadBroker(dir, exec.exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12, { sharedPaceRoot: null, account: "craigoley" });
  const server = await serveGhReadBroker({ dir, broker });
  t.after(() => server.close());
  const named = await brokerGhReadAs(server.socketPath, ["api", "repos/o/r/pulls/1"], { class: "interactive", caller: "codex-1", client: "codex", cwd: REPO_ROOT, repo: "o/r" });
  assert.equal(named.exitCode, 0);
  assert.equal(named.outcome, "upstream-200");
  assert.equal(named.stdout, '{"n":1}');
  // Every option left out takes its default: a background read from this process, named by no client.
  const bare = await brokerGhReadAs(server.socketPath, ["api", "repos/o/r/pulls/2"]);
  assert.equal(bare.exitCode, 0);
  const log = summariseGhBrokerLog(dir, 0) as { by_client: Record<string, number> };
  assert.deepEqual(log.by_client, { codex: 1, claude: 1 }, "the named client reached the log; an unnamed background read is a Claude session's");
});

test("W1-T10302: the registered `rmd gh-broker` handler serves, reports the login view and stops", async (t) => {
  const { HANDLERS } = await import("#src/run-task.js");
  const handler = HANDLERS.get("gh-broker");
  assert.ok(handler, "gh-broker is a registered command");
  const cache = tmp(t, "cli-cache");
  const pace = tmp(t, "cli-pace");
  const saved = { cache: process.env.RMD_GH_CACHE_HOME, pace: process.env.RMD_GH_PACE_ROOT };
  process.env.RMD_GH_CACHE_HOME = cache;
  process.env.RMD_GH_PACE_ROOT = pace;
  t.after(() => {
    for (const [key, value] of [["RMD_GH_CACHE_HOME", saved.cache], ["RMD_GH_PACE_ROOT", saved.pace]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Only the handler's own string output is captured. Everything else the process writes (the test runner's
  // reports reach stdout through this same function, as binary chunks) goes on to the real stream untouched.
  const writes: string[] = [];
  const realWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string" && /^(gh-broker: |\{)/.test(chunk)) {
      writes.push(chunk);
      return true;
    }
    return (realWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;

  const serving = handler(["serve"]);
  // A serve that fails to start is reported by the assertions below, not as an unhandled rejection.
  serving.catch(() => undefined);
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  // Whatever an assertion below does, the broker is stopped: a heartbeat interval left running would keep this
  // test process alive forever, and the flake-screen would wait on it until the job's ceiling.
  t.after(async () => {
    try {
      if (existsSync(join(dir, "heartbeat"))) await handler(["stop"]);
      await Promise.race([serving.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    } finally {
      process.stdout.write = realWrite;
    }
  });
  await until(() => existsSync(join(dir, "broker.sock")) && existsSync(join(dir, "heartbeat")), "the broker the CLI serves");
  assert.equal(await handler(["status", "--since", "1d"]), 0);
  const printed = writes.join("");
  const shown = JSON.parse(printed.slice(printed.indexOf("{"))) as { login_status: { login: unknown; accounts: string[]; by_account: Record<string, unknown> } };
  assert.ok(Array.isArray(shown.login_status.accounts), "status carries the per-login view from ghBrokerLoginStatus");
  assert.equal(Object.keys(shown.login_status.by_account).length, 1, "this account's request log is summarised");
  assert.equal(await handler(["stop"]), 0);
  assert.equal(await serving, 0, "serve returns once the broker it started has been stopped");
  assert.match(writes.join(""), /gh-broker: serving .*broker\.sock/);
});
