import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import { parseHeartbeatPayload, runHostResourcePass, type HostResourcePorts } from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const reason = 'AADSTS700082: session expired; run "az login"\nrequest id: a\\b; path: c:\\new\\tfile';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}acr-login-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "fleet", "state");
  mkdirSync(bin);
  mkdirSync(state, { recursive: true });
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
    RMD_ROOT: join(root, "fleet"), RMD_STATE_DIR: join(root, "fleet"),
    REGISTRY: "fixture-registry", CALLS: calls, AZ_REASON: reason, AZ_RESULT: "0",
    RMD_SERVE_REPO_DIR: join(root, "serve-repo"), RMD_SERVE_SUPERVISOR: "off",
    RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"), RMD_HEARTBEAT_DRY_RUN: "1",
    RMD_SERVE_BANNER_WAIT_S: "0", RMD_HEARTBEAT_CONTAINER: "none",
    RMD_INSTANCE_REGISTRY: join(root, "no-registry"), GH_TOKEN: "fixture-token",
  };
  writeFileSync(join(bin, "az"), `#!/bin/bash
printf 'az %s\n' "$*" >> "$CALLS"
if [ "$AZ_RESULT" != 0 ]; then printf '%s\n' "$AZ_REASON" >&2; exit "$AZ_RESULT"; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/bin/bash
printf 'docker %s\n' "$*" >> "$CALLS"
case "$1" in
  network) echo cloudflared; exit 0 ;;
  inspect) exit 1 ;;
  pull) exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const run = (script: string, args: string[] = [], over: Record<string, string> = {}) =>
    spawnSync("bash", [join(repo, script), ...args], { encoding: "utf8", env: { ...env, ...over }, timeout: 15_000 });
  return { root, bin, state, env, run, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
}

test("W1-T5319: serve-container logs in to the registry before its preflight pull", (t) => {
  const f = fixture(t);
  const result = f.run("deploy/serve-container.sh", ["--replace"]);
  assert.equal(result.status, 1, result.stderr);
  const calls = f.calls();
  const login = calls.indexOf("az acr login -n fixture-registry");
  const pull = calls.indexOf("docker pull fixture-registry.azurecr.io/remudero:latest");
  assert.ok(login >= 0, calls.join(" | "));
  assert.ok(pull > login, calls.join(" | "));
  assert.match(result.stderr, /could not be pulled/);
  assert.equal(calls.some((c) => /^docker (stop|rm|run) /.test(c)), false);
});

test("W1-T5319: a failed serve login refuses before pull or replacement", (t) => {
  const f = fixture(t);
  const result = f.run("deploy/serve-container.sh", ["--replace"], { AZ_RESULT: "1" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(reason));
  assert.equal(f.calls().some((c) => /^docker (pull|stop|rm|run) /.test(c)), false);
  const dry = f.run("deploy/serve-container.sh", ["--dry-run"], { AZ_RESULT: "1" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(f.calls().filter((c) => c.startsWith("az ")).length, 1);
});

test("W1-T5319: the refresh records a failed az acr login with its reason", (t) => {
  const f = fixture(t);
  const result = f.run("deploy/acr-login.sh", ["--refresh"], { AZ_RESULT: "1" });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(reason));
  const record = JSON.parse(readFileSync(join(f.state, "acr-login.json"), "utf8"));
  assert.equal(record.result, "failed");
  assert.equal(record.reason, reason);
  assert.equal(record.registry, "fixture-registry");
  assert.ok(Number.isFinite(Date.parse(record.ts)));
  const beat = f.run("scripts/fleet-heartbeat.sh");
  assert.equal(beat.status, 0, beat.stderr);
  const payload = parseHeartbeatPayload(beat.stdout);
  assert.equal(payload.acr_login_result, "failed");
  assert.equal(payload.acr_login_ts, record.ts);
  assert.equal(payload.acr_login_reason, reason.replace(/\n/g, " "));
  assert.equal(payload.acr_login_registry, "fixture-registry");
});

test("W1-T5319: a successful refresh publishes ok and clears the failed reason", (t) => {
  const f = fixture(t);
  f.run("deploy/acr-login.sh", ["--refresh"], { AZ_RESULT: "1" });
  const result = f.run("deploy/acr-login.sh", ["--refresh"]);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(f.state, "acr-login.json"), "utf8"));
  assert.equal(record.result, "ok");
  assert.equal(record.reason, "");
  const payload = parseHeartbeatPayload(f.run("scripts/fleet-heartbeat.sh").stdout);
  assert.equal(payload.acr_login_result, "ok");
  assert.equal(payload.acr_login_reason, "");
});

test("W1-T5319: a host without az publishes unavailable even with an old failed record", (t) => {
  const f = fixture(t);
  f.run("deploy/acr-login.sh", ["--refresh"], { AZ_RESULT: "1" });
  rmSync(join(f.bin, "az"));
  const refresh = f.run("deploy/acr-login.sh", ["--refresh"]);
  assert.equal(refresh.status, 0, refresh.stderr);
  const record = JSON.parse(readFileSync(join(f.state, "acr-login.json"), "utf8"));
  assert.equal(record.result, "unavailable");
  writeFileSync(join(f.state, "acr-login.json"), JSON.stringify({ ...record, result: "failed" }));
  const beat = f.run("scripts/fleet-heartbeat.sh");
  assert.equal(parseHeartbeatPayload(beat.stdout).acr_login_result, "unavailable");
});

test("W1-T5319: an absent or unreadable refresh receipt never publishes ok", (t) => {
  const f = fixture(t);
  const path = join(f.state, "acr-login.json");
  assert.equal(parseHeartbeatPayload(f.run("scripts/fleet-heartbeat.sh").stdout).acr_login_result, "unknown");
  writeFileSync(path, '{"result":"garbage","ts":"broken"}');
  assert.equal(parseHeartbeatPayload(f.run("scripts/fleet-heartbeat.sh").stdout).acr_login_result, "unknown");
});

test("W1-T5319: a sourced helper waits for an explicit login call", (t) => {
  const f = fixture(t);
  const result = spawnSync("bash", ["-c", 'source "$1"; echo sourced', "fixture", join(repo, "deploy/acr-login.sh")], {
    encoding: "utf8", env: f.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sourced/);
  assert.deepEqual(f.calls(), [""]);
});

function garden(t: TestContext) {
  const f = fixture(t);
  const escalations: Escalation[] = [];
  const rows: string[] = [];
  let beats: Array<{ host: string; payload: string }> = [];
  const ports: HostResourcePorts = {
    stateDir: f.state, clock: fixedClock(Date.parse("2026-10-04T12:00:00Z")),
    log: (step) => rows.push(step), readHeartbeats: () => beats, planOrigins: () => [],
    escalate: (e) => { escalations.push(e); return "https://issue/1"; },
  };
  const beat = (host: string, result: string, ts: string) => ({
    host, payload: `beat_ts=${ts}\nacr_login_result=${result}\nacr_login_ts=${ts}\nacr_login_reason=session expired\nacr_login_registry=fixture-registry\n`,
  });
  return { escalations, rows, ports, beat, pass: (next: typeof beats) => { beats = next; return runHostResourcePass(ports); } };
}

test("W1-T5319: a failed registry refresh escalates once as needs-human", (t) => {
  const g = garden(t);
  const fail = g.beat("azure", "failed", "2026-10-04T11:00:00Z");
  g.pass([fail]);
  g.pass([fail]);
  g.pass([g.beat("azure", "failed", "2026-10-04T11:05:00Z")]);
  assert.equal(g.escalations.length, 1);
  assert.equal(g.escalations[0]!.class, "MANUAL");
  assert.match(g.escalations[0]!.detail, /azure.*session expired/s);
  assert.match(g.escalations[0]!.detail, /az login && az acr login -n fixture-registry/);
  assert.equal(g.escalations[0]!.headDedup, "independent");
  assert.equal(g.rows.filter((r) => r === "host_resource.acr_login_failed").length, 1);
  g.pass([g.beat("mini", "unavailable", "2026-10-04T11:05:00Z"), g.beat("other", "ok", "2026-10-04T11:05:00Z")]);
  g.pass([g.beat("azure", "failed", "2026-10-04T11:10:00Z")]);
  assert.equal(g.escalations.length, 1, "missing or unavailable beats do not clear a failure episode");
  g.pass([g.beat("other", "failed", "2026-10-04T11:10:00Z")]);
  assert.equal(g.escalations.length, 2, "episodes belong to each host");
});

test("W1-T5319: a refresh that recovers clears the episode so the next failure escalates again", (t) => {
  const g = garden(t);
  g.pass([g.beat("azure", "failed", "2026-10-04T11:00:00Z")]);
  g.pass([g.beat("azure", "ok", "2026-10-04T11:05:00Z")]);
  assert.ok(g.rows.includes("host_resource.acr_login_recovered"));
  g.pass([g.beat("azure", "failed", "2026-10-04T11:00:00Z")]);
  assert.equal(g.escalations.length, 1, "an older failure cannot reopen a recovered episode");
  g.pass([g.beat("azure", "failed", "2026-10-04T11:10:00Z")]);
  g.pass([g.beat("azure", "failed", "2026-10-04T11:10:00Z")]);
  assert.equal(g.escalations.length, 2);
});

test("W1-T5319: missing or invalid refresh timestamps cannot open an episode", (t) => {
  const g = garden(t);
  g.pass([{ host: "azure", payload: "acr_login_result=failed\nacr_login_ts=broken\n" }]);
  g.pass([{ host: "azure", payload: "acr_login_result=failed\n" }]);
  assert.equal(g.escalations.length, 0);
  g.pass([g.beat("azure", "failed", "2026-10-04T11:00:00Z")]);
  assert.equal(g.escalations.length, 1);
});

test("W1-T5319: a failed escalation is retried rather than counted as delivered", (t) => {
  const g = garden(t);
  const deliver = g.ports.escalate!;
  g.ports.escalate = () => { throw new Error("issue transport failed"); };
  const beat = g.beat("azure", "failed", "2026-10-04T11:00:00Z");
  assert.throws(() => g.pass([beat]), /issue transport failed/);
  g.ports.escalate = undefined;
  g.pass([beat]);
  assert.equal(g.escalations.length, 0);
  g.ports.escalate = deliver;
  g.pass([beat]);
  assert.equal(g.escalations.length, 1);
});

// @source-text-subject: copies of shell scripts are mutated to falsify the call-order proof.
test("W1-T5319: removing the serve login makes the order proof fail", (t) => {
  const f = fixture(t);
  const deploy = join(f.root, "deploy");
  cpSync(join(repo, "deploy"), deploy, { recursive: true });
  const path = join(deploy, "serve-container.sh");
  const source = readFileSync(path, "utf8");
  const mutated = source.replace('rmd_acr_login "${REGISTRY}"', "true");
  assert.ok(mutated !== source, "the mutant must remove the helper call");
  writeFileSync(path, mutated);
  const result = spawnSync("bash", [path, "--replace"], { encoding: "utf8", env: f.env });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(f.calls().some((c) => c.startsWith("docker pull ")));
  assert.equal(f.calls().some((c) => c.startsWith("az ")), false);
});

// @source-text-subject: rendered systemd directives are the installer output under test.
test("W1-T5319: the installed timer runs refresh as the host credential owner", (t) => {
  const f = fixture(t);
  const units = join(f.root, "units");
  const result = f.run("deploy/install-host-units.sh", ["--install"], {
    RMD_UNIT_DIR: units, RMD_BIN_DIR: join(f.root, "installed-bin"),
    RMD_LAUNCHER_PATH: join(f.root, "launcher"), RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_SERVICE_USER: "fixture-owner", RMD_REVIVAL_LOG: join(f.root, "revivals"),
  });
  assert.equal(result.status, 0, result.stderr);
  const service = readFileSync(join(units, "rmd-acr-login.service"), "utf8");
  const timer = readFileSync(join(units, "rmd-acr-login.timer"), "utf8");
  assert.match(service, /User=fixture-owner/);
  assert.match(service, /Environment=RMD_ROOT=/);
  assert.match(service, /Environment=REGISTRY=fixture-registry/);
  assert.match(service, /acr-login\.sh --refresh/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(timer, /Unit=rmd-acr-login.service/);
  assert.ok(existsSync(join(f.root, "installed-bin", "acr-login.sh")));
});
