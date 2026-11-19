/**
 * W1-T13720 -- a host Node off its .nvmrc pin raises the `host-node-behind` host alert. The units
 * converge reports a Node it could not move and returns 0, so from 2026-11-18 14:20Z a hand-set apt
 * hold kept the fleet host on 24.22.2 under a 24.22.3 pin and every full author preflight refused,
 * with nothing raised. The launcher case runs the REAL rendered host_node_alert with a stub `node`,
 * a stub `apt-mark` and an `rmd` stub that records each argv; each recorded `host-alert` argv is then
 * fed to the real verb body in-process.
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

const T0 = Date.parse("2026-11-18T14:20:00Z");
const TICK = 5 * 60_000;
const INSTANCE = "remudero-daemon";
const meta = (nowMs: number) => ({ host: "fleet-host", clock: fixedClock(nowMs) });

const RMD_STUB = `#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '%s\\n' '--END--'; } >> "$RMD_STUB_CALLS"
[ "$1" = host-alert ] && echo '{"stub":true}'
exit 0
`;

interface Rig { root: string; stateDir: string; checkout: string; callLog: string; fns: string; env: NodeJS.ProcessEnv }

function rig(t: TestContext): Rig {
  const root = mkdtempSync(join(tmpdir(), "rmd-host-node-alert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state-root");
  const checkout = join(stateDir, "daemon-install");
  const stub = join(root, "stubbin");
  for (const d of [join(stateDir, "state"), join(stateDir, "remudero", "bin"), checkout, stub]) mkdirSync(d, { recursive: true });
  const exe = (path: string, body: string) => { writeFileSync(path, body); chmodSync(path, 0o755); };
  exe(join(stateDir, "remudero", "bin", "rmd"), RMD_STUB);
  exe(join(stub, "node"), `#!/usr/bin/env bash\ncat "${root}/node-version"\n`);
  exe(join(stub, "apt-mark"), `#!/usr/bin/env bash\n[ "$1" = showhold ] && [ -f "${root}/held" ] && echo nodejs\nexit 0\n`);
  writeFileSync(join(checkout, ".nvmrc"), "24.22.3\n");
  const launcher = join(root, "rmd-relaunch.sh");
  const renderEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    RMD_NODESOURCE_PATH: join(root, "no-nodesource.sources"),
  };
  const install = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install"], { encoding: "utf8", env: renderEnv, cwd: REPO_ROOT });
  assert.equal(install.status, 0, install.stderr);
  const text = readFileSync(launcher, "utf8");
  const fns = ["host_alert", "host_alert_raise", "host_alert_clear", "host_node_alert"].map((name) => {
    const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(text) ?? new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(text);
    assert.ok(body, `the rendered launcher defines ${name}`);
    return body[0];
  }).join("\n");
  assert.match(text, /^ {2}\[ "\$BOOT" -eq 0 \] && converge_host_units\n {2}\[ "\$BOOT" -eq 0 \] && host_node_alert$/m,
    "the tick asks right after the units converge");
  const callLog = join(root, "rmd-calls");
  const env: NodeJS.ProcessEnv = {
    ...process.env, STATE_DIR: stateDir, CHECKOUT: checkout, HOST_ALERT_INSTANCE: INSTANCE,
    RMD_STUB_CALLS: callLog, PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  return { root, stateDir, checkout, callLog, fns, env };
}

function tick(r: Rig, version: string, held = false) {
  writeFileSync(join(r.root, "node-version"), `${version}\n`);
  if (held) writeFileSync(join(r.root, "held"), "");
  else rmSync(join(r.root, "held"), { force: true });
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${r.fns}\nhost_node_alert`], { encoding: "utf8", env: r.env });
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

function apply(argv: string[], nowMs: number): LauncherAlertVerdict {
  const out = hostAlertCommandResult(
    { stateRoot: flag(argv, "--state-root"), instance: flag(argv, "--instance"), condition: flag(argv, "--condition"), message: flag(argv, "--raise"), clear: argv.includes("--clear") },
    meta(nowMs),
  );
  assert.equal(typeof out, "object", String(out));
  return out as LauncherAlertVerdict;
}

test("W1-T13720 criterion 4: host-node-behind is a host alert condition that escalates once it persists and clears on recovery", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-host-node-alert-verb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(isLauncherAlertCondition("host-node-behind"));
  const input = { stateRoot: dir, instance: INSTANCE, condition: "host-node-behind", message: "host node 24.22.2 is not the 24.22.3 that .nvmrc pins", clear: false };
  let v: LauncherAlertVerdict | string = "";
  for (let i = 1; i <= REFUSAL_ESCALATE_AT; i += 1) v = hostAlertCommandResult(input, meta(T0 + i * TICK));
  assert.equal((v as LauncherAlertVerdict).tier, "escalated");
  const e = launcherAlertEscalation(JSON.parse(readFileSync(launcherAlertPath(dir, INSTANCE, "host-node-behind"), "utf8")));
  assert.match(e.summary, /host Node .* is not the version \.nvmrc pins/);
  assert.match(e.detail, /First refusal: host node 24\.22\.2 is not the 24\.22\.3/);
  const cleared = hostAlertCommandResult({ ...input, message: undefined, clear: true }, meta(T0 + 9 * TICK));
  assert.equal((cleared as LauncherAlertVerdict).tier, "cleared");
  assert.equal(existsSync(launcherAlertPath(dir, INSTANCE, "host-node-behind")), false);
});

test("W1-T13720 criterion 5: a tick with the host Node off its pin raises host-node-behind naming a hold, and the next in-step tick clears it", (t) => {
  const r = rig(t);
  const stateDir = join(r.stateDir, "state");

  const behind = tick(r, "v24.22.2", true);
  assert.match(behind.stderr, /rmd-relaunch: host-node 24\.22\.2 is not the pinned 24\.22\.3; nodejs is apt-mark held/);
  const [raised, ...rest] = hostAlertCalls(r);
  assert.equal(rest.length, 0);
  assert.equal(flag(raised!, "--condition"), "host-node-behind");
  assert.equal(flag(raised!, "--raise"), `host node 24.22.2 is not the 24.22.3 that ${r.checkout}/.nvmrc pins; nodejs is apt-mark held`);
  assert.equal(flag(raised!, "--state-root"), stateDir);
  assert.equal(apply(raised!, T0).condition, "host-node-behind");
  assert.ok(existsSync(launcherAlertPath(stateDir, INSTANCE, "host-node-behind")), "the run is open");

  tick(r, "v24.22.3");
  const calls = hostAlertCalls(r);
  assert.equal(calls.length, 2);
  assert.deepEqual([flag(calls[1]!, "--condition"), calls[1]!.includes("--clear")], ["host-node-behind", true]);
  assert.equal(apply(calls[1]!, T0 + TICK).tier, "cleared");
  assert.equal(existsSync(launcherAlertPath(stateDir, INSTANCE, "host-node-behind")), false);

  tick(r, "v24.22.3");
  assert.equal(hostAlertCalls(r).length, 2, "an in-step tick with no open run spawns no rmd");

  const ahead = tick(r, "v24.23.0");
  assert.match(ahead.stderr, /host-node 24\.23\.0 is not the pinned 24\.22\.3$/m, "no hold, no hold clause");
  assert.equal(flag(hostAlertCalls(r)[2]!, "--condition"), "host-node-behind");
});
