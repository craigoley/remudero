/**
 * 2026-10-11 follow-up to #10818: the host watchdog's own alarms never left the host. The launcher
 * wrote `state/DAEMON_CRASH_LOOP` ("this needs a human") with no reader, and its converge/refresh
 * refusals and "deploy-run reported a problem" were journal lines only. These suites pin the wiring:
 * the launcher asks `rmd host-alert`, which tiers a refusal by persistence on the deployer's own
 * scale, spools it for the daemon to post, and withdraws or closes it on recovery.
 *
 * The launcher cases run the REAL rendered launcher (or its rendered functions) with an `rmd` stub
 * that records each argv; each recorded `host-alert` argv is then fed to the real verb in-process,
 * so the contract under test runs end to end: the launcher's words, the verb, the spool, the drain.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { REFUSAL_ESCALATE_AT, REFUSAL_PERSISTING_AT } from "../src/lib/deployer.js";
import type { AsyncIssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { escalationSpoolDir, escalationSpoolDrain, escalationSpoolKey, HOST_ESCALATION_STEPS, type SpoolEntry } from "../src/lib/host-escalation-spool.js";
import {
  clearLauncherAlert,
  LAUNCHER_ALERT_STEPS,
  launcherAlertIdentity,
  launcherAlertPath,
  raiseLauncherAlert,
  type LauncherAlertMeta,
} from "../src/lib/launcher-host-alerts.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { hostAlertCommand } from "../src/run-task.js";
import { runBeat } from "./helpers/fleet-heartbeat-harness.js";
import { gitRepo } from "./helpers/git-repo.js";

const T0 = Date.parse("2026-10-11T07:00:00Z");
const TICK = 5 * 60_000;
const INSTANCE = "remudero-daemon";

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const meta = (nowMs: number): LauncherAlertMeta => ({ host: "fleet-host", clock: fixedClock(nowMs) });

function pending(stateDir: string): SpoolEntry[] {
  const dir = escalationSpoolDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as SpoolEntry);
}

function steps(stateDir: string): string[] {
  const path = join(stateDir, "ledger.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step) : [];
}

type Issue = OpenIssue & { open: boolean; comments: string[]; closedWith?: string };

/** The fleet's needs-human surface, in memory: what the daemon's `gh` would do. */
function fleet(): { gateway: AsyncIssueGateway; issues: Issue[] } {
  const issues: Issue[] = [];
  return {
    issues,
    gateway: {
      create: (title, body) => {
        const url = `https://github.com/o/r/issues/${issues.length + 1}`;
        issues.push({ number: issues.length + 1, url, title, body, open: true, comments: [] });
        return url;
      },
      listOpen: async () => issues.filter((i) => i.open),
      comment: async (url, body) => { issues.find((i) => i.url === url)!.comments.push(body); },
      closeWithComment: async (url, comment) => {
        const issue = issues.find((i) => i.url === url)!;
        issue.open = false;
        issue.closedWith = comment;
      },
    },
  };
}

const drain = (stateDir: string, gateway: AsyncIssueGateway, nowMs: number) =>
  escalationSpoolDrain({ stateDir, ledgerPath: join(stateDir, "ledger.ndjson"), issues: () => gateway, clock: fixedClock(nowMs) })();

test("a launcher refusal pages only once it persists: a transient never spools, and a success in between restarts the count", async (t) => {
  const dir = scratch(t, "launcher-alert-tiers");
  const refusal = { instance: INSTANCE, condition: "deploy-code-fetch-failed" as const, message: "rmd-relaunch: deploy code -- fetch failed" };
  for (let i = 1; i < REFUSAL_ESCALATE_AT; i += 1) {
    const v = raiseLauncherAlert(dir, refusal, meta(T0 + i * TICK));
    assert.equal(v.tier, i >= REFUSAL_PERSISTING_AT ? "persisting" : "observed");
  }
  assert.deepEqual(pending(dir), [], "below REFUSAL_ESCALATE_AT nothing is spooled");
  assert.equal(steps(dir).filter((s) => s === LAUNCHER_ALERT_STEPS.persisting).length, 1, "persisting is ledgered once");

  const cleared = clearLauncherAlert(dir, refusal, meta(T0 + 10 * TICK));
  assert.equal(cleared.tier, "cleared");
  assert.equal(existsSync(launcherAlertPath(dir, INSTANCE, "deploy-code-fetch-failed")), false);
  for (let i = 1; i < REFUSAL_ESCALATE_AT; i += 1) raiseLauncherAlert(dir, refusal, meta(T0 + (10 + i) * TICK));
  assert.deepEqual(pending(dir), [], "a success in between restarted the count: still nothing spooled");

  const escalated = raiseLauncherAlert(dir, refusal, meta(T0 + 20 * TICK));
  assert.equal(escalated.tier, "escalated");
  assert.equal(escalated.count, REFUSAL_ESCALATE_AT);
  const [entry] = pending(dir);
  assert.equal(pending(dir).length, 1);
  assert.equal(entry!.key, escalationSpoolKey(launcherAlertIdentity(INSTANCE, "deploy-code-fetch-failed")));
  assert.equal(entry!.source, "host-watchdog");
  assert.ok(steps(dir).includes(LAUNCHER_ALERT_STEPS.escalated));

  const f = fleet();
  assert.deepEqual(await drain(dir, f.gateway, T0 + 21 * TICK), { delivered: 1, failed: 0 });
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0]!.title ?? "", /: deploy code for remudero-daemon cannot refresh: fetching origin\/main fails$/);
  assert.match(f.issues[0]!.body ?? "", /First refusal: rmd-relaunch: deploy code -- fetch failed/);

  const again = raiseLauncherAlert(dir, refusal, meta(T0 + 22 * TICK));
  assert.equal(again.issueUrl, f.issues[0]!.url, "the run learns the issue the daemon opened");
  assert.deepEqual(pending(dir), [], "the same episode, already delivered, is not spooled again");

  clearLauncherAlert(dir, refusal, meta(T0 + 23 * TICK));
  assert.deepEqual(pending(dir).map((e) => e.kind), ["close"], "recovery spools the close of the delivered issue");
  await drain(dir, f.gateway, T0 + 24 * TICK);
  assert.equal(f.issues[0]!.open, false);
  assert.match(f.issues[0]!.closedWith ?? "", /fetching origin\/main .* -- closing\.$/);
});

test("a crash loop is spooled on its first observation, and a recovery before delivery withdraws it unposted", async (t) => {
  const dir = scratch(t, "launcher-alert-crash");
  const loop = { instance: INSTANCE, condition: "crash-loop" as const, message: "2026-10-11T07:00:00Z 5 consecutive revivals from exit 1" };
  const v = raiseLauncherAlert(dir, loop, meta(T0));
  assert.equal(v.tier, "escalated");
  assert.equal(pending(dir).length, 1, "the launcher already tiered it: one observation is enough");
  assert.match(pending(dir)[0]!.headline, /daemon remudero-daemon is crash-looping on the host$/);

  clearLauncherAlert(dir, loop, meta(T0 + TICK));
  assert.deepEqual(pending(dir), [], "nobody was told, and there is nothing left to tell");
  assert.ok(steps(dir).includes(HOST_ESCALATION_STEPS.withdrawn));
  const f = fleet();
  await drain(dir, f.gateway, T0 + 2 * TICK);
  assert.equal(f.issues.length, 0);
});

test("rmd host-alert raises and clears as JSON, and refuses a missing condition or a raise with a clear", (t) => {
  const dir = scratch(t, "launcher-alert-verb");
  const out: string[] = [];
  t.mock.method(console, "log", (line: string) => { out.push(line); });
  t.mock.method(console, "error", () => undefined);
  const base = ["--state-root", dir, "--instance", INSTANCE, "--condition", "crash-loop"];
  assert.equal(hostAlertCommand([...base, "--raise", "looping", "--json"], fixedClock(T0)), 0);
  assert.deepEqual(JSON.parse(out[0]!), { instance: INSTANCE, condition: "crash-loop", tier: "escalated", count: 1, issueUrl: "" });
  assert.equal(hostAlertCommand([...base, "--clear"], fixedClock(T0 + TICK)), 0);
  assert.equal(out[1], "host-alert crash-loop (remudero-daemon): cleared, count 1");
  assert.equal(hostAlertCommand([...base, "--clear", "--json"], fixedClock(T0 + 2 * TICK)), 0);
  assert.equal(JSON.parse(out[2]!).tier, "none", "a clear with no open run is a no-op");
  assert.equal(hostAlertCommand(["--state-root", dir, "--instance", INSTANCE, "--condition", "nope", "--clear"]), 2);
  assert.equal(hostAlertCommand([...base, "--raise", "x", "--clear"]), 2);
  assert.equal(hostAlertCommand([...base, "--bogus"]), 2);
});

// ── the launcher's side ─────────────────────────────────────────────────────────────────────────

/** Records each call's argv one arg per line, then `--END--`; answers as the real verbs would. */
const STUB = `#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '%s\\n' '--END--'; } >> "$RMD_STUB_CALLS"
case "$1" in
  progress-watchdog) cat "$RMD_STUB_VERDICT" 2>/dev/null || true ;;
  deploy-run) cat "$RMD_STUB_DEPLOY_OUT" 2>/dev/null || true; exit "$(cat "$RMD_STUB_DEPLOY_EXIT" 2>/dev/null || echo 0)" ;;
  host-alert) echo '{"stub":true}' ;;
esac
exit 0
`;

function calls(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("--END--\n").filter((c) => c.length > 0).map((c) => c.replace(/\n$/, "").split("\n"));
}

/** Feed every `host-alert` call since `from` to the real verb, as the host's rmd would run it. */
function applyHostAlerts(path: string, from: number, nowMs: number): string[][] {
  const log = console.log;
  console.log = () => undefined;
  try {
    return applyEach(path, from, nowMs);
  } finally {
    console.log = log;
  }
}

function applyEach(path: string, from: number, nowMs: number): string[][] {
  const made = calls(path).slice(from).filter((c) => c[0] === "host-alert");
  for (const argv of made) assert.equal(hostAlertCommand(argv.slice(1), fixedClock(nowMs)), 0, argv.join(" "));
  return made;
}

const flag = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];

function render(t: TestContext): { root: string; launcher: string; env: NodeJS.ProcessEnv } {
  const root = scratch(t, "launcher-alert-render");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: join(root, "state-root"),
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
  };
  const r = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return { root, launcher: join(root, "rmd-relaunch.sh"), env };
}

function renderedFunctions(t: TestContext, names: string[]): string {
  const text = readFileSync(render(t).launcher, "utf8");
  return names.map((name) => {
    const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(text) ?? new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(text);
    assert.ok(body, `the rendered launcher defines ${name}`);
    return body[0];
  }).join("\n");
}

const ALERT_FNS = ["host_alert", "host_alert_raise", "host_alert_clear"];

/** An origin, a daemon tree and an install tree at origin/main, a state dir whose remudero is the daemon tree. */
function trees(t: TestContext) {
  const origin = gitRepo({ bare: true, kind: "launcher-alert-origin" });
  const seed = gitRepo({ kind: "launcher-alert-seed" });
  mkdirSync(join(seed.dir, "bin"));
  writeFileSync(join(seed.dir, "bin", "rmd"), STUB);
  chmodSync(join(seed.dir, "bin", "rmd"), 0o755);
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "launcher-alert-daemon" });
  const install = gitRepo({ cloneFrom: origin.dir, kind: "launcher-alert-install" });
  const state = scratch(t, "launcher-alert-state");
  symlinkSync(daemon.dir, join(state, "remudero"), "dir");
  mkdirSync(join(state, "state"));
  const bin = join(state, "path-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nprintf 'PID ARGS\\n1 node rmd daemon\\n'\n");
  chmodSync(join(bin, "docker"), 0o755);
  const callLog = join(state, "rmd-calls");
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env, ...extra, STATE_DIR: state, CHECKOUT: install.dir, RMD_STUB_CALLS: callLog,
    HOST_ALERT_INSTANCE: INSTANCE, PATH: `${bin}:${process.env.PATH}`,
    INSTANCE_NAME: "", INSTANCE_REGISTRY: "", UNITS_HEAP_MB: "8192", REVIVAL_LOG: join(state, "revivals.log"),
  });
  return { origin, seed, daemon, install, state, callLog, env };
}

test("the deploy-code refresh raises a failing fetch and a diverged checkout through rmd host-alert, and clears each once it succeeds", (t) => {
  const h = trees(t);
  const fns = renderedFunctions(t, [...ALERT_FNS, "deploy_code_idle", "deploy_code_clean", "live_edits_ladder", "refresh_deploy_code"]);
  const tick = () => spawnSync("bash", ["-c", `set -euo pipefail\n${fns}\nrefresh_deploy_code ${INSTANCE}`], { encoding: "utf8", env: h.env() });
  const stateDir = join(h.state, "state");

  assert.equal(tick().status, 0);
  assert.deepEqual(calls(h.callLog), [], "a healthy tick with no open run spawns no rmd at all");

  h.daemon.git("remote", "set-url", "origin", join(h.state, "no-such-origin"));
  for (let i = 1; i <= REFUSAL_ESCALATE_AT; i += 1) {
    const before = calls(h.callLog).length;
    const r = tick();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fetch failed; deferring/, "the journal line stays");
    const [raised] = applyHostAlerts(h.callLog, before, T0 + i * TICK);
    assert.equal(flag(raised!, "--condition"), "deploy-code-fetch-failed");
    assert.equal(flag(raised!, "--instance"), INSTANCE);
    assert.equal(flag(raised!, "--state-root"), stateDir);
    assert.match(flag(raised!, "--raise") ?? "", /git fetch origin main failed/);
  }
  assert.equal(pending(stateDir).length, 1, "persisting across REFUSAL_ESCALATE_AT ticks, it is spooled");

  h.daemon.git("remote", "set-url", "origin", h.origin.dir);
  let before = calls(h.callLog).length;
  assert.equal(tick().status, 0, "the fetch recovers");
  const [clear] = applyHostAlerts(h.callLog, before, T0 + 10 * TICK);
  assert.deepEqual([flag(clear!, "--condition"), clear!.includes("--clear")], ["deploy-code-fetch-failed", true]);
  assert.deepEqual(pending(stateDir), [], "recovery withdrew the undelivered escalation");

  writeFileSync(join(h.daemon.dir, "local.txt"), "a commit main never had\n");
  h.daemon.git("add", "local.txt");
  h.daemon.git("commit", "--quiet", "-m", "local only");
  before = calls(h.callLog).length;
  assert.equal(tick().status, 1);
  const [diverged] = applyHostAlerts(h.callLog, before, T0 + 11 * TICK);
  assert.equal(flag(diverged!, "--condition"), "deploy-code-diverged");
  assert.ok(existsSync(launcherAlertPath(stateDir, INSTANCE, "deploy-code-diverged")));

  h.daemon.git("reset", "--quiet", "--hard", "origin/main");
  before = calls(h.callLog).length;
  assert.equal(tick().status, 0);
  const [undiverged] = applyHostAlerts(h.callLog, before, T0 + 12 * TICK);
  assert.deepEqual([flag(undiverged!, "--condition"), undiverged!.includes("--clear")], ["deploy-code-diverged", true]);
  assert.equal(existsSync(launcherAlertPath(stateDir, INSTANCE, "deploy-code-diverged")), false);
});

test("the install-units converge raises a checkout off main or diverged through rmd host-alert, and clears each once it converges", (t) => {
  const h = trees(t);
  const fns = renderedFunctions(t, [...ALERT_FNS, "converge_host_units"]);
  mkdirSync(join(h.install.dir, "deploy"));
  writeFileSync(join(h.install.dir, "deploy", "install-host-units.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(h.install.dir, "deploy", "install-host-units.sh"), 0o755);
  const tick = () => spawnSync("bash", ["-c", `set -euo pipefail\n${fns}\nconverge_host_units`], { encoding: "utf8", env: h.env() });
  const stateDir = join(h.state, "state");
  const step = (nowMs: number) => {
    const before = calls(h.callLog).length;
    const r = tick();
    assert.equal(r.status, 0, r.stderr);
    return { r, made: applyHostAlerts(h.callLog, before, nowMs) };
  };

  h.install.git("checkout", "--quiet", "-b", "side");
  const off = step(T0);
  assert.match(off.r.stderr, /not on branch main \(branch='side'\)/);
  assert.equal(flag(off.made[0]!, "--condition"), "units-not-on-main");
  h.install.git("checkout", "--quiet", "main");
  const back = step(T0 + TICK);
  assert.deepEqual(back.made.map((c) => [flag(c, "--condition"), c.includes("--clear")]), [["units-not-on-main", true]]);

  writeFileSync(join(h.install.dir, "local.txt"), "install-only commit\n");
  h.install.git("add", "local.txt");
  h.install.git("commit", "--quiet", "-m", "install only");
  h.seed.git("commit", "--quiet", "--allow-empty", "-m", "main moves on");
  h.seed.git("push", "--quiet", "origin", "main");
  const div = step(T0 + 2 * TICK);
  assert.match(div.r.stderr, /DIVERGED from origin\/main/);
  assert.deepEqual(div.made.map((c) => flag(c, "--condition")), ["units-diverged"]);
  h.install.git("reset", "--quiet", "--hard", "HEAD~1");
  const ff = step(T0 + 3 * TICK);
  assert.deepEqual(ff.made.map((c) => [flag(c, "--condition"), c.includes("--clear")]), [["units-diverged", true]]);
  assert.equal(readdirSync(join(stateDir, "launcher-alerts")).length, 0, "both runs ended");
});

interface Launcher { root: string; stateDir: string; launcher: string; revivals: string; callLog: string; env: NodeJS.ProcessEnv }

/** The whole rendered launcher, with an `rmd` stub, a fake docker and no daemon source tree. */
function launcher(t: TestContext, running: boolean): Launcher {
  const { root, launcher: path, env } = render(t);
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  for (const dir of [join(stateDir, "state"), join(stateDir, "remudero", "bin"), join(stateDir, "daemon-install", "deploy"), stub]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stateDir, "remudero", "bin", "rmd"), STUB);
  chmodSync(join(stateDir, "remudero", "bin", "rmd"), 0o755);
  writeFileSync(join(stub, "docker"), `#!/usr/bin/env bash\ncase "$1" in\n  ps) ${running ? "echo fake-container-id" : ":"} ;;\n  inspect) echo 1 ;;\nesac\nexit 0\n`);
  chmodSync(join(stub, "docker"), 0o755);
  writeFileSync(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(stub, "findmnt"), 0o755);
  writeFileSync(join(stateDir, "state", "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-11T06:00:00Z", step: "daemon.boot" })}\n`);
  const verdict = join(root, "verdict.json");
  writeFileSync(verdict, `${JSON.stringify({ state: "PROGRESSING", action: "none" })}\n`);
  const callLog = join(root, "rmd-calls");
  return {
    root, stateDir, launcher: path, revivals: join(root, "revivals.log"), callLog,
    env: { ...env, RMD_STUB_CALLS: callLog, RMD_STUB_VERDICT: verdict, RMD_STUB_DEPLOY_OUT: join(root, "deploy-out"), RMD_STUB_DEPLOY_EXIT: join(root, "deploy-exit"), PATH: `${stub}:${process.env.PATH ?? ""}` },
  };
}

const runTick = (l: Launcher) => spawnSync("bash", [l.launcher], { encoding: "utf8", env: l.env });
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const revivalRun = (n: number, newestAgoMs: number) =>
  Array.from({ length: n }, (_, i) => `${isoAgo(newestAgoMs + (n - 1 - i) * TICK)} revive boot=0 prev_status=exited prev_exit=1 prev_restarts=5`).join("\n") + "\n";

test("the launcher spools a crash loop it names, keeps the flag while the run is live, and clears both once it lapses", (t) => {
  const down = launcher(t, false);
  writeFileSync(down.revivals, revivalRun(5, TICK));
  const r = runTick(down);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /CRASH LOOP -- 6 consecutive revivals from exit 1/);
  const marker = join(down.stateDir, "state", "DAEMON_CRASH_LOOP");
  const [raised] = applyHostAlerts(down.callLog, 0, T0);
  assert.equal(flag(raised!, "--condition"), "crash-loop");
  assert.equal(flag(raised!, "--raise"), readFileSync(marker, "utf8").trim(), "the escalation carries the marker's own line");
  assert.equal(pending(join(down.stateDir, "state")).length, 1, "spooled for a later healthy daemon to post");

  const up = launcher(t, true);
  const upMarker = join(up.stateDir, "state", "DAEMON_CRASH_LOOP");
  writeFileSync(upMarker, "2026-10-11T07:00:00Z 6 consecutive revivals from exit 1\n");
  raiseLauncherAlert(join(up.stateDir, "state"), { instance: INSTANCE, condition: "crash-loop", message: "looping" }, meta(T0));
  writeFileSync(up.revivals, revivalRun(6, TICK));
  assert.equal(runTick(up).status, 0);
  assert.ok(existsSync(upMarker), "running between deaths is not recovery: the flag stays while the run is live");
  assert.equal(calls(up.callLog).filter((c) => c[0] === "host-alert").length, 0);

  writeFileSync(up.revivals, revivalRun(6, 9 * 60 * 60_000));
  const before = calls(up.callLog).length;
  assert.equal(runTick(up).status, 0);
  assert.equal(existsSync(upMarker), false, "a lapsed run clears the flag");
  const [cleared] = applyHostAlerts(up.callLog, before, T0 + TICK);
  assert.deepEqual([flag(cleared!, "--condition"), cleared!.includes("--clear")], ["crash-loop", true]);
  assert.deepEqual(pending(join(up.stateDir, "state")), [], "and withdraws its undelivered escalation");
});

test("a hold-revive verdict spools the crash loop it names", (t) => {
  const down = launcher(t, false);
  writeFileSync(join(down.root, "verdict.json"), `${JSON.stringify({ state: "CRASH_LOOP", action: "hold-revive", failedBoots15m: 3 })}\n`);
  const r = runTick(down);
  assert.match(r.stderr, /CRASH LOOP -- not reviving into the same input/);
  const [raised] = applyHostAlerts(down.callLog, 0, T0);
  assert.equal(flag(raised!, "--condition"), "crash-loop");
  assert.match(flag(raised!, "--raise") ?? "", /crash-loop-hold failed_boots=3/);
});

test("a deploy-run that reports a problem is raised with its last line, and cleared when it next exits cleanly", (t) => {
  const up = launcher(t, true);
  writeFileSync(join(up.root, "deploy-out"), "### rmd deploy-run — checking\nrefused: dirty-tree-conflict on deploy/x.sh\n");
  writeFileSync(join(up.root, "deploy-exit"), "1\n");
  const r = runTick(up);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /deploy-run reported a problem/);
  const [raised] = applyHostAlerts(up.callLog, 0, T0);
  assert.equal(flag(raised!, "--condition"), "deploy-run-problem");
  assert.equal(flag(raised!, "--raise"), "rmd deploy-run --image-drift-only exited non-zero: refused: dirty-tree-conflict on deploy/x.sh");

  writeFileSync(join(up.root, "deploy-exit"), "0\n");
  const before = calls(up.callLog).length;
  assert.equal(runTick(up).status, 0);
  const [cleared] = applyHostAlerts(up.callLog, before, T0 + TICK);
  assert.deepEqual([flag(cleared!, "--condition"), cleared!.includes("--clear")], ["deploy-run-problem", true]);
  assert.equal(existsSync(launcherAlertPath(join(up.stateDir, "state"), INSTANCE, "deploy-run-problem")), false);
});

test("the heartbeat publishes the launcher's crash-loop marker itself, so it reaches off-host with no daemon to drain", () => {
  const field = (published: string) => published.split("\n").find((l) => l.startsWith("crash_loop_verdict="));
  assert.equal(field(runBeat({}).published), "crash_loop_verdict=ok");
  const looping = runBeat({ stateFiles: { DAEMON_CRASH_LOOP: "2026-10-11T07:00:00Z 6 consecutive revivals from exit 1\n" } }).published;
  assert.equal(field(looping), "crash_loop_verdict=CRASH_LOOP — 2026-10-11T07:00:00Z 6 consecutive revivals from exit 1");
  const empty = runBeat({ stateFiles: { DAEMON_CRASH_LOOP: "" } }).published;
  assert.match(field(empty) ?? "", /^crash_loop_verdict=CRASH_LOOP — .*present but empty or unreadable$/, "an empty marker is never read as ok");
});
