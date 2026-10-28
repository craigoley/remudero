import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { describeActorEvidence, gatherActorEvidence, readActorEvidence, type ActorEvidenceProbe } from "#src/lib/actor-evidence.js";
import {
  checkSharedPause, isRecyclePauseDetail, pauseDetail, pauseFilePath, readSharedPauseAnchor,
  realSharedPauseGitDeps, requestFleetPause, requestPause,
} from "#src/lib/fleet-control.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { armPause, controlStatusBody } from "#src/lib/panel-actions.js";
import { buildStatusBoard, renderStatusBoardText } from "#src/lib/status-board.js";
import { readLedgerLines } from "#src/lib/status.js";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

const RMD = fileURLToPath(new URL("../bin/rmd", import.meta.url));
const CLAIMED_SESSION = "operator-claimed-session";

function remoteProbe(): ActorEvidenceProbe {
  return {
    env: { SSH_CONNECTION: "192.0.2.10 40000 192.0.2.20 22", REMUDERO_SESSION_ID: CLAIMED_SESSION },
    osUser: () => "craig", host: () => "Remudero", containerId: () => undefined,
    stdinIsTTY: () => false, stdoutIsTTY: () => false, parents: () => ["bash", "sshd"],
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-pause-actor-"));
}

function cliFixture() {
  const root = scratch();
  const origin = gitRepo({ bare: true, kind: "pause-actor-origin" });
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "pause-actor-checkout" });
  checkout.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  checkout.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const registry = daemonInstanceRegistryPath(checkout.dir);
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, `instances:\n  core:\n    repo: remudero\n    project: remudero\n    primary: true\n    github_repo: fixture/remudero\n    state_dir: ${root}\n`);
  checkout.git("add", "-A");
  checkout.git("commit", "-qm", "fixture");
  checkout.git("push", "-q", "origin", "HEAD:main");
  mkdirSync(join(root, "state"), { recursive: true });
  const configDir = join(root, "home", ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const env = { ...process.env, HOME: join(root, "home"), RMD_ALLOW_LIVE_WRITES: "1",
    SSH_CONNECTION: "192.0.2.10 40000 192.0.2.20 22", REMUDERO_SESSION_ID: CLAIMED_SESSION };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || ["CLAUDECODE", "REMUDERO_RUN_ID", "REMUDERO_WORKER_SCOPE", "AI_AGENT", "SSH_TTY"].includes(key)) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
  }
  return { root, checkout, origin, env };
}

function invoke(fx: ReturnType<typeof cliFixture>, ...args: string[]) {
  const res = spawnSync(RMD, args, { cwd: fx.checkout.dir, env: fx.env, encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
}

test("W1-T7839: a pause row records the actor evidence gathered by the writer", () => {
  const fx = cliFixture();
  for (const scope of ["instance", "fleet"]) {
    const flags = scope === "fleet" ? ["--fleet"] : [];
    invoke(fx, "pause", ...flags, "--reason", "maintenance");
    const paused = readLedgerLines(join(fx.root, "state", "ledger.ndjson")).filter(r => r.step === "fleet.pause").at(-1)!;
    assert.equal(paused.scope, scope);
    const actor = paused.actor_evidence as ReturnType<typeof gatherActorEvidence>;
    assert.equal(actor.os_user, userInfo().username);
    assert.equal(actor.caller_class, "remote non-interactive");
    assert.equal(actor.ssh?.client_address, "192.0.2.10");
    assert.equal(actor.claimed_session_id, CLAIMED_SESSION);
    assert.equal(paused.session_id, CLAIMED_SESSION);
    if (scope === "instance") {
      const flag = JSON.parse(readFileSync(pauseFilePath(fx.root), "utf8"));
      assert.deepEqual(flag.actor_evidence, actor);
    } else {
      const sha = fx.origin.git("rev-parse", "refs/rmd-pause/hold");
      assert.deepEqual(readSharedPauseAnchor(sha, realSharedPauseGitDeps(fx.checkout.dir))?.actor_evidence, actor);
    }
    invoke(fx, "resume", ...flags);
    const resumed = readLedgerLines(join(fx.root, "state", "ledger.ndjson")).filter(r => r.step === "fleet.resume").at(-1)!;
    assert.equal(resumed.scope, scope);
    assert.equal((resumed.actor_evidence as typeof actor).caller_class, "remote non-interactive");
    assert.equal((resumed.actor_evidence as typeof actor).os_user, userInfo().username);
    assert.equal(resumed.session_id, CLAIMED_SESSION);
  }
});

test("W1-T7839: a pause over ssh with no terminal is recorded as remote, not unknown", () => {
  const probe = remoteProbe();
  const remote = gatherActorEvidence(probe);
  assert.equal(remote.caller_class, "remote non-interactive");
  assert.deepEqual(remote.ssh, { client_address: "192.0.2.10", pty: false });
  const clientOnly = gatherActorEvidence({ ...probe, env: { SSH_CLIENT: "192.0.2.11 40000 22" } });
  assert.equal(clientOnly.ssh?.client_address, "192.0.2.11");
  assert.equal(clientOnly.caller_class, "remote non-interactive");
  const terminal = gatherActorEvidence({ ...probe, env: { ...probe.env, SSH_TTY: "/dev/pts/1" } });
  assert.equal(terminal.ssh?.pty, true);
  assert.equal(terminal.caller_class, "human at a terminal");
  assert.equal(gatherActorEvidence({ ...probe, env: {}, stdinIsTTY: () => true }).caller_class, "human at a terminal");
  assert.equal(gatherActorEvidence({ ...probe, env: {} }).caller_class, "host automation");
  const agent = gatherActorEvidence({ ...probe, env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "agent-1" } });
  assert.equal(agent.caller_class, "agent session");
  assert.equal(agent.session, "agent-1");
  assert.deepEqual(agent.agent_markers, ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]);
  assert.equal(gatherActorEvidence({ ...probe, env: {}, containerId: () => "container-1" }).caller_class, "agent session");
  const root = scratch();
  const info = requestPause(root, "remote maintenance", undefined, { actorProbe: probe });
  assert.deepEqual(info.actor_evidence, remote);
  const real = requestPause(scratch(), "default probe").actor_evidence!;
  assert.equal(real.os_user, userInfo().username);
  assert.ok(real.host.length > 0);
});

test("W1-T7839: the PAUSE flag and the shared hold anchor carry the actor", () => {
  const fx = cliFixture();
  const deps = realSharedPauseGitDeps(fx.checkout.dir);
  const info = withLiveWritesAllowed(() => requestPause(fx.root, "maintenance", deps, { actorProbe: remoteProbe() }));
  const flag = JSON.parse(readFileSync(pauseFilePath(fx.root), "utf8"));
  assert.deepEqual(flag.actor_evidence, gatherActorEvidence(remoteProbe()));
  const sha = fx.origin.git("rev-parse", "refs/rmd-pause/hold");
  const body = fx.checkout.git("show", "-s", "--format=%B", sha);
  assert.match(body, /^rmd-pause hold /);
  assert.match(body, /\nactor: /);
  assert.deepEqual(readSharedPauseAnchor(sha, deps)?.actor_evidence, info.actor_evidence);
  const synchronous = { run: deps.run, mintAnchor: deps.mintAnchor };
  assert.match(checkSharedPause(scratch(), synchronous)!, /craig on Remudero.*remote non-interactive/);
  invoke(fx, "resume", "--fleet");
  const fleet = withLiveWritesAllowed(() => requestFleetPause(deps, "maintenance", { actorProbe: remoteProbe() }));
  assert.equal(fleet.pushed, true);
  const fleetSha = fx.origin.git("rev-parse", "refs/rmd-pause/hold");
  assert.deepEqual(readSharedPauseAnchor(fleetSha, deps)?.actor_evidence, fleet.actor_evidence);
});

function board(root: string) {
  return buildStatusBoard(root, join(root, "state", "ledger.ndjson"), {
    queryService: () => ({ running: false, pid: null }), repoDir: root,
    resolveOriginMainSha: () => undefined, readSharedPauseState: () => "absent",
    readPushedRunBranches: () => "", readDispatchClaims: () => ({ status: "clear" }),
  });
}

test("W1-T7839: the control status and the board show who set the pause", () => {
  const root = scratch();
  requestPause(root, "maintenance", undefined, { actorProbe: remoteProbe() });
  const status = controlStatusBody({ root, ledgerPath: join(root, "state", "ledger.ndjson") }, []);
  assert.match(status.pauseActor!, /craig on Remudero.*remote non-interactive/);
  assert.match(status.pauseActor!, /operator-claimed-session \(claimed\)/);
  assert.match(status.pauseDetail!, /craig on Remudero/);
  const model = board(root);
  assert.match(model.latches.rows.find(r => r.name === "PAUSE")!.consequence, /craig on Remudero.*remote non-interactive/);
  assert.match(renderStatusBoardText(model), /operator-claimed-session \(claimed\)/);
  requestPause(root, "agent maintenance", undefined, { actorProbe: { ...remoteProbe(), env: { AI_AGENT: "1" }, containerId: () => "container-1" } });
  assert.match(pauseDetail(root)!, /container container-1.*agent session/);
  const panel = armPause({ root, ledgerPath: join(root, "state", "ledger.ndjson") }, "panel maintenance", "console");
  assert.deepEqual(readLedgerLines(join(root, "state", "ledger.ndjson")).at(-1)!.actor_evidence, panel.info.actor_evidence);
});

test("W1-T7839: a pause flag with no actor reads as actor unrecorded", () => {
  const root = scratch();
  assert.equal(pauseDetail(root), undefined);
  assert.equal(controlStatusBody({ root, ledgerPath: "unused" }, []).pauseActor, undefined);
  mkdirSync(join(root, "state"), { recursive: true });
  const reason = "legacy maintenance";
  writeFileSync(pauseFilePath(root), JSON.stringify({ reason, requestedAt: new Date().toISOString(), pid: 1, host: "legacy" }));
  assert.match(pauseDetail(root)!, /actor unrecorded/);
  assert.equal(isRecyclePauseDetail("PAUSE requested: different maintenance; actor unrecorded"), false);
  assert.match(controlStatusBody({ root, ledgerPath: "unused" }, []).pauseActor!, /actor unrecorded/);
  assert.match(board(root).latches.rows.find(r => r.name === "PAUSE")!.consequence, /actor unrecorded/);
  writeFileSync(pauseFilePath(root), "broken JSON");
  assert.match(pauseDetail(root)!, /actor unrecorded/);
  assert.equal(controlStatusBody({ root, ledgerPath: "unused" }, []).paused, true);
});

test("W1-T7839: invalid actor metadata stays held and reads as unrecorded", () => {
  for (const invalid of [null, "text", {}, { os_user: 7, host: "host", caller_class: "host automation" },
    { os_user: "craig", host: 7, caller_class: "host automation" },
    { os_user: "craig", host: "host", caller_class: "unknown" }]) {
    assert.equal(readActorEvidence(invalid), undefined);
    assert.equal(describeActorEvidence(invalid), "actor unrecorded");
  }
  for (const suffix of ["", "\nactor: {broken", "\nactor: {}", `\nactor: ${JSON.stringify(gatherActorEvidence(remoteProbe()))}`]) {
    const deps = { mintAnchor: () => "anchor", run: () => ({ status: 0, stdout: `rmd-pause hold 1@legacy 2000-01-01T00:00:00.000Z${suffix}` }) };
    const anchor = readSharedPauseAnchor("anchor", deps)!;
    assert.equal(anchor.pid, "1");
    if (suffix.includes("craig")) assert.equal(anchor.actor_evidence?.os_user, "craig");
    else assert.equal(anchor.actor_evidence, undefined);
  }
  const root = scratch();
  const reason = "container recycle (deploy/recycle-container.sh)";
  requestPause(root, reason, undefined, { actorProbe: remoteProbe() });
  assert.equal(isRecyclePauseDetail(pauseDetail(root)), true);
  requestPause(root, `${reason}; actor: another maintenance`, undefined, { actorProbe: remoteProbe() });
  assert.equal(isRecyclePauseDetail(pauseDetail(root)), false);
});
