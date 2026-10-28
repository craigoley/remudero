import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gatherActorEvidence, readActorEvidence } from "#src/lib/actor-evidence.js";
import { realDeployDeps } from "#src/lib/deployer.js";
import { isRecyclePauseDetail, pauseActor, pauseDetail } from "#src/lib/fleet-control.js";
import { deriveControlInterventions } from "#src/lib/operator-interventions.js";
import { routeOperatorInterventions } from "#src/lib/sre-lane.js";
import { daemonSreRunbookHost } from "#src/lib/sre-runbooks.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-recycle-actor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "bin", "tmp", "deploy"]) mkdirSync(join(root, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || ["CLAUDECODE", "REMUDERO_RUN_ID", "REMUDERO_WORKER_SCOPE", "AI_AGENT", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "RMD_RECYCLE_CALLER"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    PATH: `${join(root, "bin")}:${process.env.PATH}`, STUB_ROOT: root,
    RMD_STATE_DIR: root, RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_WAIT_S: "0",
    RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"), TMPDIR: join(root, "tmp"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"),
    GH_TOKEN: "fixture-token", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
  });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  writeFileSync(join(root, "state/inflight/W1-T9515.lock"), JSON.stringify({ pid: 1, host: "fixture-host", run_id: "run-fixture", startedAt: new Date().toISOString() }));
  executable(join(root, "bin/az"), "exit 0");
  executable(join(root, "bin/docker"), `
if [ -f "$RMD_STATE_DIR/state/PAUSE" ]; then cp "$RMD_STATE_DIR/state/PAUSE" "$STUB_ROOT/pause-copy"; fi
case "$1" in
  pull) cp "$RMD_STATE_DIR/state/ledger.ndjson" "$STUB_ROOT/before-pull"; exit 0 ;;
  image) echo sha256:PULLEDID; exit 0 ;;
  inspect)
    case "$*" in
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"; printf '%s\\t/home/node/.claude\\ttrue\\n' "\${RMD_CLAUDE_DIR:-$HOME/.claude}" ;;
      *Config.Image*) echo test-registry/remudero:old ;;
      *'{{.Id}}'*) printf '%064d\\n' 1 ;;
      *State.Running*) echo true ;;
      *) echo sha256:PULLEDID ;;
    esac ;;
esac
exit 0`);
  const run = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) => spawnSync("bash", [join(REPO_ROOT, "deploy/recycle-container.sh"), ...args], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, env: { ...env, ...extra },
  });
  const rows = () => readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { root, env, run, rows };
}

test("W1-T9515: a recycle PAUSE names its caller and actor", (t) => {
  const f = fixture(t);
  const caller = 'watchdog:progress-watchdog "quoted"\\path\nnext';
  const r = f.run({ RMD_RECYCLE_CALLER: caller, AI_AGENT: "1", REMUDERO_SESSION_ID: " claimed-session " });
  assert.match(r.stdout + r.stderr, /PAUSE engaged/);
  const pause = JSON.parse(readFileSync(join(f.root, "pause-copy"), "utf8"));
  assert.equal(pause.caller, caller);
  const actor = readActorEvidence(pause.actor_evidence);
  assert.ok(actor);
  assert.equal(actor.caller_class, "agent session");
  assert.equal(actor.claimed_session_id, "claimed-session");
  assert.equal(actor.host, hostname());
  assert.ok(actor.os_user);
  assert.ok(actor.parents.length > 0);
  assert.deepEqual(actor.agent_markers, ["AI_AGENT"]);
  assert.deepEqual(actor.tty, { stdin: false, stdout: false });
  assert.equal(pause.reason, "container recycle (deploy/recycle-container.sh)");
  assert.equal(pause.phase, "waiting");
  assert.ok(pause.writerStart);
  assert.equal(pause.containerName, "remudero-daemon");
  writeFileSync(join(f.root, "state/PAUSE"), JSON.stringify(pause));
  assert.match(pauseActor(f.root)!, /agent session/);
  assert.doesNotMatch(pauseActor(f.root)!, /actor unrecorded/);
  assert.equal(isRecyclePauseDetail(pauseDetail(f.root)), true);
  assert.deepEqual(f.rows()[0].actor_evidence, actor);
});

test("W1-T9515: every recycle invocation writes a recycle.invoked row", (t) => {
  for (const mode of ["drain", "container", "argument", "registry", "missing-state"]) {
    const f = fixture(t);
    if (mode === "missing-state") {
      rmSync(join(f.root, "state"), { recursive: true });
      mkdirSync(join(f.root, "remudero/.git"), { recursive: true });
    }
    const r = f.run(mode === "container" ? { RMD_RECYCLE_DOCKERENV_PATH: join(f.root, "key") }
      : mode === "missing-state" ? { RMD_RECYCLE_FIRST_BOOT: "0" } : {},
      mode === "argument" ? ["--bad-argument"] : mode === "registry" ? ["--instance", "missing"] : []);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    const rows = f.rows().filter((row) => row.step === "recycle.invoked");
    assert.equal(rows.length, 1, mode);
    assert.equal(rows[0].caller, "unattributed");
    assert.equal(typeof rows[0].pid, "number");
    assert.ok(rows[0].writer_start);
    assert.equal(rows[0].container, "remudero-daemon");
    assert.equal(rows[0].instance, mode === "registry" ? "missing" : "");
    assert.equal(rows[0].verdict, "");
    assert.ok(readActorEvidence(rows[0].actor_evidence));
    if (mode === "container") assert.match(r.stderr, /INSIDE a container/);
    if (mode === "missing-state") assert.match(r.stderr, /state is MISSING/);
    if (mode === "drain") {
      assert.match(r.stdout + r.stderr, /PAUSE engaged/);
      assert.equal(JSON.parse(readFileSync(join(f.root, "before-pull"), "utf8")).step, "recycle.invoked");
    } else assert.equal(existsSync(join(f.root, "state/PAUSE")), false);
  }
});

test("W1-T9515: the watchdog and the deploy tick name themselves to the recycle", (t) => {
  const f = fixture(t);
  const state = join(f.root, "watchdog");
  mkdirSync(join(state, "daemon-install/deploy"), { recursive: true });
  mkdirSync(join(state, "remudero/bin"), { recursive: true });
  executable(join(state, "daemon-install/deploy/recycle-container.sh"), 'printf "%s" "$RMD_RECYCLE_CALLER" > "$STUB_ROOT/watchdog-caller"');
  executable(join(state, "remudero/bin/rmd"), `if [ "$1" = progress-watchdog ]; then echo '{"state":"STALLED","action":"recycle","progressAgeMs":2400000}'; fi`);
  executable(join(f.root, "bin/docker"), 'case "$1" in ps) echo fixture-container ;; inspect) echo 1 ;; esac');
  executable(join(f.root, "bin/findmnt"), "exit 0");
  const launcher = join(f.root, "launcher.sh");
  const rendered = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    encoding: "utf8", env: { ...f.env, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(f.root, "units"), RMD_BIN_DIR: join(f.root, "unitbin"), RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(f.root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const tick = spawnSync("bash", [launcher], { encoding: "utf8", timeout: 30_000, env: f.env });
  assert.equal(tick.status, 0, tick.stderr);
  assert.equal(readFileSync(join(f.root, "watchdog-caller"), "utf8"), "watchdog:progress-watchdog");

  executable(join(f.root, "deploy/recycle-container.sh"), 'printf "%s" "$RMD_RECYCLE_CALLER" > "$(dirname "$0")/deploy-caller"');
  for (const history of [false, true]) {
    writeFileSync(join(f.root, "state/ledger.ndjson"), history ? Array.from({ length: 20 }, () => JSON.stringify({ step: "implement.done", worker_duration_ms: 60_000 })).join("\n") : "");
    const deps = realDeployDeps({ installPath: f.root, stateRoot: f.root, daemonLabel: "fixture", serveLabel: "fixture-serve", servePort: 1, uid: 1, ledgerPath: join(f.root, "state/ledger.ndjson"), log: () => {}, sleep: () => {},
      ...(history ? { execFile: (cmd: string, args: string[], options?: { env: NodeJS.ProcessEnv }) => execFileSync(cmd, args, { encoding: "utf8", ...options }) } : {}),
    });
    deps.restartBackends!().find((b) => b.name === "recycle-container")!.restart();
    assert.equal(readFileSync(join(f.root, "deploy/deploy-caller"), "utf8"), "deploy-tick");
  }
});

test("W1-T9515: a recycle with no known caller is a hand-recycle intervention", async (t) => {
  const f = fixture(t);
  f.run({ SSH_CONNECTION: "192.0.2.1 123 192.0.2.2 22", REMUDERO_PROCESS_ACTOR: "daemon" }, ["--bad-argument"]);
  const row = f.rows()[0];
  const derived = deriveControlInterventions([row, row]);
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.action, "recycle.invoked");
  assert.equal(derived[0]!.cause_class, "hand-recycle:remote non-interactive");
  assert.deepEqual(derived[0]!.actor_evidence, row.actor_evidence);
  const written: Array<Record<string, unknown>> = [];
  const input = { detectors: [], stateDir: join(f.root, "state"), nowMs: Date.parse(row.ts) + 1, writeEvent: (event: Record<string, unknown>) => written.push(event) };
  const events = await routeOperatorInterventions(input);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, "hand-recycle:remote non-interactive");
  assert.deepEqual(written.find((event) => event.step === "operator.intervention")!.actor_evidence, row.actor_evidence);
  assert.deepEqual(await routeOperatorInterventions(input), []);
  for (const caller of ["watchdog:progress-watchdog", "watchdog:deploy code", "deploy-tick", "sre-runbook:recycle-stale-container"]) {
    assert.deepEqual(deriveControlInterventions([{ ...row, caller }]), []);
  }
  for (const caller of [undefined, "", "unattributed", "operator-label"]) {
    assert.equal(deriveControlInterventions([{ ...row, caller }]).length, 1);
  }
  assert.equal(deriveControlInterventions([{ ...row, actor_evidence: undefined }])[0]!.cause_class, "hand-recycle:actor unrecorded");
});

test("test/every-recycle-names-who-invoked-it.test.ts: shell and TypeScript actor classifiers agree", (t) => {
  for (const extra of [{}, { SSH_CONNECTION: "192.0.2.1 123 192.0.2.2 22" }, { SSH_CLIENT: "192.0.2.3 123 22", SSH_TTY: "/dev/pts/1" }, { AI_AGENT: "yes", REMUDERO_RUN_ID: "run-9515" }]) {
    const f = fixture(t);
    f.run(extra, ["--bad-argument"]);
    const actor = f.rows()[0].actor_evidence;
    const expected = gatherActorEvidence({ env: { ...f.env, ...extra }, osUser: () => actor.os_user, host: () => actor.host, containerId: () => actor.container_id, stdinIsTTY: () => false, stdoutIsTTY: () => false, parents: () => actor.parents });
    assert.deepEqual(actor, expected);
  }
});

test("W1-T9515: the sre runbook names itself", async (t) => {
  const f = fixture(t);
  executable(join(f.root, "deploy/recycle-container.sh"), 'printf "%s" "$RMD_RECYCLE_CALLER" > "$(dirname "$0")/caller"');
  const host = daemonSreRunbookHost({ root: f.root, repoDir: f.root, owner: "fixture", repo: "fixture" });
  await host.recycle("fixture-container");
  assert.equal(readFileSync(join(f.root, "deploy/caller"), "utf8"), "sre-runbook:recycle-stale-container");
});

test("W1-T9515: actor evidence records the writer's terminal before capture redirects stdout", (t) => {
  const f = fixture(t);
  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", "bash", join(REPO_ROOT, "deploy/recycle-container.sh"), "--bad-argument"]
    : ["-qec", 'exec bash "$RECYCLE_TEST_SCRIPT" --bad-argument', "/dev/null"];
  const result = spawnSync("script", args, {
    encoding: "utf8", timeout: 30_000,
    env: { ...f.env, RECYCLE_TEST_SCRIPT: join(REPO_ROOT, "deploy/recycle-container.sh") },
  });
  assert.ok(result.status === 0 || result.status === 2, result.stdout + result.stderr);
  assert.deepEqual(f.rows()[0].actor_evidence.tty, { stdin: true, stdout: true });
});
