/**
 * W1-T10844 -- a failed tunnel roll raises the `tunnel-roll-failed` host alert. A silent failed roll
 * is exactly how 2026.8.3 survived seven weeks. deploy/edge-heal.sh exits 3 on a failed (or held)
 * roll and only then; the core launcher's edge_heal_on_exit raises the alert on that status, never
 * on another heal failure, and clears it once edge-heal names the tunnel on its pin. The launcher
 * case runs the REAL rendered launcher with a fake edge-heal and an `rmd` stub that records each
 * argv; each recorded `host-alert` argv is then fed to the real verb body in-process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { REFUSAL_ESCALATE_AT } from "#src/lib/deployer.js";
import {
  hostAlertCommandResult,
  isLauncherAlertCondition,
  launcherAlertEscalation,
  launcherAlertPath,
  type LauncherAlertVerdict,
} from "#src/lib/launcher-host-alerts.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const T0 = Date.parse("2026-10-27T13:00:00Z");
const TICK = 5 * 60_000;
const INSTANCE = "remudero-daemon";
const meta = (nowMs: number) => ({ host: "fleet-host", clock: fixedClock(nowMs) });

const RMD_STUB = `#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '%s\\n' '--END--'; } >> "$RMD_STUB_CALLS"
[ "$1" = host-alert ] && echo '{"stub":true}'
exit 0
`;

/** A fake edge-heal that prints the file `heal-out` and exits with the status in `heal-exit`. */
const HEAL_STUB = (root: string) => `#!/usr/bin/env bash
cat "${root}/heal-out" 2>/dev/null || true
exit "$(cat "${root}/heal-exit" 2>/dev/null || echo 0)"
`;

interface Rig { root: string; stateDir: string; launcher: string; callLog: string; env: NodeJS.ProcessEnv }

function rig(t: TestContext): Rig {
  const root = mkdtempSync(join(tmpdir(), "rmd-tunnel-alert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  for (const d of [join(stateDir, "state"), join(stateDir, "remudero", "bin"), join(stateDir, "daemon-install", "deploy"), stub]) mkdirSync(d, { recursive: true });
  const exe = (path: string, body: string) => { writeFileSync(path, body); chmodSync(path, 0o755); };
  exe(join(stateDir, "remudero", "bin", "rmd"), RMD_STUB);
  exe(join(stateDir, "daemon-install", "deploy", "edge-heal.sh"), HEAL_STUB(root));
  exe(join(stub, "docker"), '#!/usr/bin/env bash\n[ "$1" = ps ] && echo fake-id\nexit 0\n');
  const launcher = join(root, "rmd-relaunch.sh");
  const callLog = join(root, "rmd-calls");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    RMD_STUB_CALLS: callLog,
    PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  const install = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install"], { encoding: "utf8", env, cwd: REPO_ROOT });
  assert.equal(install.status, 0, install.stderr);
  return { root, stateDir, launcher, callLog, env };
}

/** One clean watchdog tick whose edge-heal prints `out` and exits `code`. */
function tick(r: Rig, out: string, code: number) {
  writeFileSync(join(r.root, "heal-out"), out);
  writeFileSync(join(r.root, "heal-exit"), `${code}\n`);
  const res = spawnSync("bash", [r.launcher], { encoding: "utf8", env: r.env });
  assert.equal(res.status, 0, res.stderr);
  return res;
}

function hostAlertCalls(r: Rig): string[][] {
  if (!existsSync(r.callLog)) return [];
  return readFileSync(r.callLog, "utf8").split("--END--\n").filter(Boolean).map((c) => c.replace(/\n$/, "").split("\n")).filter((c) => c[0] === "host-alert");
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Feed one recorded `host-alert` argv to the real verb body, as the host's rmd would run it. */
function apply(argv: string[], nowMs: number): LauncherAlertVerdict {
  const out = hostAlertCommandResult(
    { stateRoot: flag(argv, "--state-root"), instance: flag(argv, "--instance"), condition: flag(argv, "--condition"), message: flag(argv, "--raise"), clear: argv.includes("--clear") },
    meta(nowMs),
  );
  assert.equal(typeof out, "object", String(out));
  return out as LauncherAlertVerdict;
}

test("tunnel-roll-failed is a host alert condition that escalates once it persists and clears on recovery", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-tunnel-alert-verb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(isLauncherAlertCondition("tunnel-roll-failed"));
  const input = { stateRoot: dir, instance: INSTANCE, condition: "tunnel-roll-failed", message: "edge-heal: replica never registered", clear: false };
  let v: LauncherAlertVerdict | string = "";
  for (let i = 1; i <= REFUSAL_ESCALATE_AT; i += 1) v = hostAlertCommandResult(input, meta(T0 + i * TICK));
  assert.equal((v as LauncherAlertVerdict).tier, "escalated");
  const e = launcherAlertEscalation(JSON.parse(readFileSync(launcherAlertPath(dir, INSTANCE, "tunnel-roll-failed"), "utf8")));
  assert.match(e.summary, /console tunnel .* off its pinned cloudflared image/);
  assert.match(e.detail, /First refusal: edge-heal: replica never registered/);
  const cleared = hostAlertCommandResult({ ...input, message: undefined, clear: true }, meta(T0 + 9 * TICK));
  assert.equal((cleared as LauncherAlertVerdict).tier, "cleared");
  assert.equal(existsSync(launcherAlertPath(dir, INSTANCE, "tunnel-roll-failed")), false);
});

test("a failed roll raises the tunnel-roll-failed host alert, another heal failure does not, and the alert clears once the tunnel is on its pin", (t) => {
  const r = rig(t);
  const stateDir = join(r.stateDir, "state");

  const failed = tick(r, "edge-heal: tunnel roll failed -- replica cloudflared-next never registered within 120s; removed it, cloudflared untouched\n", 3);
  assert.match(failed.stderr, /edge heal incomplete/);
  const [raised, ...rest] = hostAlertCalls(r);
  assert.equal(rest.length, 0);
  assert.equal(flag(raised!, "--condition"), "tunnel-roll-failed");
  assert.equal(flag(raised!, "--raise"), "edge-heal: replica cloudflared-next never registered within 120s; removed it, cloudflared untouched");
  assert.equal(flag(raised!, "--state-root"), stateDir);
  assert.equal(apply(raised!, T0).condition, "tunnel-roll-failed");
  assert.ok(existsSync(launcherAlertPath(stateDir, INSTANCE, "tunnel-roll-failed")), "the run is open");

  const other = tick(r, "edge-heal: remudero-serve absent -- running serve-container.sh\n", 1);
  assert.match(other.stderr, /edge heal incomplete/);
  assert.equal(hostAlertCalls(r).length, 1, "a serve heal failure raises nothing and clears nothing");

  tick(r, "edge-heal: cloudflared rolled to x\nedge-heal: tunnel on pin cloudflare/cloudflared:2026.10.4@sha256:x\n", 0);
  const calls = hostAlertCalls(r);
  assert.equal(calls.length, 2);
  const cleared = calls[1]!;
  assert.deepEqual([flag(cleared, "--condition"), cleared.includes("--clear")], ["tunnel-roll-failed", true]);
  assert.equal(apply(cleared, T0 + 2 * TICK).tier, "cleared");
  assert.equal(existsSync(launcherAlertPath(stateDir, INSTANCE, "tunnel-roll-failed")), false);

  tick(r, "edge-heal: tunnel on pin cloudflare/cloudflared:2026.10.4@sha256:x\n", 0);
  assert.equal(hostAlertCalls(r).length, 2, "a healthy tick with no open run spawns no rmd");
});
