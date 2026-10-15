/**
 * W1-T9625 — a down-daemon alert reaches GitHub without the daemon.
 *
 * 2026-10-15: the launcher named CRASH LOOP at 08:43:51 and raised `rmd host-alert crash-loop` every
 * five minutes (tier escalated, issueUrl ""), but host-alert only SPOOLED the escalation for the
 * daemon to post, and the daemon was the thing that was down. #11965 was opened at 10:30:10 by the
 * daemon that had just recovered, 1 h 46 m later. Now, while the instance's container is not running,
 * the host posts the crash-loop escalation itself and records its spool entry delivered, so the
 * daemon's drain never posts a second issue.
 *
 * Every GitHub call here is an in-memory fake; the real seams are driven through a stub `docker` on
 * PATH and a `data:` URL token exchange, so nothing reaches a real host or GitHub.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SpawnSyncReturns } from "node:child_process";

import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import { GH_APP_ID_ENV, GH_APP_INSTALLATION_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV } from "../src/lib/github-app.js";
import {
  deliveredEscalationUrl,
  drainEscalationSpool,
  escalationSpoolDir,
  HOST_ESCALATION_STEPS,
  type SpoolEntry,
} from "../src/lib/host-escalation-spool.js";
import {
  dockerContainerState,
  hostAlertCommandResult,
  hostAlertRepo,
  hostGithubToken,
  launcherAlertIdentity,
  raiseLauncherAlert,
  realHostDirectDelivery,
  type ContainerRunState,
  type HostDirectDelivery,
  type LauncherAlertMeta,
  type LauncherAlertVerdict,
} from "../src/lib/launcher-host-alerts.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-15T08:43:51Z");
const TICK = 5 * 60_000;
const INSTANCE = "remudero-daemon";
const LOOP = { instance: INSTANCE, condition: "crash-loop" as const, message: "2026-10-15T08:43:51Z 5 consecutive revivals from exit 1" };
const ISSUE = "https://github.com/craigoley/remudero/issues/11965";

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pending(stateDir: string): SpoolEntry[] {
  const dir = escalationSpoolDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as SpoolEntry);
}

function ledgerRows(stateDir: string): Array<Record<string, unknown>> {
  const path = join(stateDir, "ledger.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

/** The host's delivery, in memory: what docker says about the container and what `escalate` posted. */
function hostDelivery(state: ContainerRunState, post: (e: Escalation) => string = () => ISSUE): HostDirectDelivery & { posted: Escalation[] } {
  const posted: Escalation[] = [];
  return {
    posted,
    containerState: () => state,
    post: (e) => {
      posted.push(e);
      return post(e);
    },
  };
}

const meta = (nowMs: number, direct?: HostDirectDelivery): LauncherAlertMeta => ({ host: "fleet-host", clock: fixedClock(nowMs), ...(direct ? { direct } : {}) });

function raise(stateDir: string, nowMs: number, direct?: HostDirectDelivery): LauncherAlertVerdict {
  const v = hostAlertCommandResult({ stateRoot: stateDir, instance: INSTANCE, condition: "crash-loop", message: LOOP.message, clear: false }, meta(nowMs, direct));
  assert.notEqual(typeof v, "string", String(v));
  return v as LauncherAlertVerdict;
}

/** The daemon's drain once it is back: every spooled entry it would post, recorded. */
async function drainAsDaemon(stateDir: string, nowMs: number, url = "https://github.com/craigoley/remudero/issues/99999"): Promise<{ escalated: Escalation[]; delivered: number }> {
  const escalated: Escalation[] = [];
  const r = await drainEscalationSpool(stateDir, {
    clock: fixedClock(nowMs),
    escalate: async (e) => {
      escalated.push(e);
      return url;
    },
    close: async () => {},
    comment: async () => {},
  });
  return { escalated, delivered: r.delivered };
}

test("a down-daemon alert reaches github without the daemon, and the daemon does not post it again", async (t) => {
  const dir = scratch(t, "down-alert");
  const host = hostDelivery("down");

  const first = raise(dir, T0, host);
  assert.equal(first.tier, "escalated");
  assert.equal(first.issueUrl, ISSUE, "the host delivered it: the url is known on the very tick that named the loop");
  assert.equal(first.direct, "posted");
  assert.equal(host.posted.length, 1);
  const identity = launcherAlertIdentity(INSTANCE, "crash-loop");
  assert.equal(host.posted[0].taskId, identity.taskId, "the same identity, so escalate's title dedup applies");
  assert.equal(host.posted[0].summary, identity.summary);
  assert.match(host.posted[0].detail, /Posted by the host watchdog \(`rmd host-alert`\) on fleet-host while remudero-daemon was not running/);

  // The spool holds nothing for the daemon to post, and the delivery is recorded as the drain's own.
  assert.deepEqual(pending(dir), []);
  assert.equal(deliveredEscalationUrl(dir, identity), ISSUE);
  const delivered = ledgerRows(dir).filter((r) => r.step === HOST_ESCALATION_STEPS.delivered);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].issue_url, ISSUE);
  assert.equal(delivered[0].direct, true);

  // Every later tick of the same episode re-raises it: no second post, the url stays.
  for (let i = 1; i <= 3; i += 1) {
    const again = raise(dir, T0 + i * TICK, host);
    assert.equal(again.issueUrl, ISSUE);
    assert.equal(again.direct, undefined, "already delivered: the host does not try again");
  }
  assert.equal(host.posted.length, 1, "one issue per episode");

  // The daemon recovers and drains: nothing is left for it to post.
  const drained = await drainAsDaemon(dir, T0 + 20 * TICK);
  assert.deepEqual(drained.escalated, [], "the daemon must not open a second issue");
  assert.equal(drained.delivered, 0);
});

test("a failed direct post leaves the spool for the daemon, with the host's reason on it", async (t) => {
  const dir = scratch(t, "down-alert-fail");
  const host = hostDelivery("down", () => {
    throw new Error("HTTP 401: Bad credentials");
  });
  const v = raise(dir, T0, host);
  assert.equal(v.tier, "escalated");
  assert.equal(v.issueUrl, "");
  assert.equal(v.direct, "failed");
  assert.match(v.directError ?? "", /Bad credentials/);
  const entries = pending(dir);
  assert.equal(entries.length, 1, "the escalation is spooled exactly as before");
  assert.match(entries[0].directError ?? "", /Bad credentials/);

  // An empty url is a failure too, never a delivery.
  const empty = scratch(t, "down-alert-empty");
  const blank = raise(empty, T0, hostDelivery("down", () => ""));
  assert.equal(blank.direct, "failed");
  assert.match(blank.directError ?? "", /opened no issue/);
  assert.equal(pending(empty).length, 1);

  // The daemon comes back and posts it; the host's next raise learns that url and posts nothing.
  const drained = await drainAsDaemon(dir, T0 + 2 * TICK, ISSUE);
  assert.equal(drained.escalated.length, 1);
  assert.match(drained.escalated[0].detail, /The host's own attempt failed: HTTP 401: Bad credentials/);
  const after = raise(dir, T0 + 3 * TICK, host);
  assert.equal(after.issueUrl, ISSUE);
  assert.equal(host.posted.length, 1, "the host tried once, before the daemon delivered it");
});

test("a running or unreadable daemon, or any other condition, keeps spool-only delivery", (t) => {
  for (const state of ["running", "unknown"] as const) {
    const dir = scratch(t, `alert-${state}`);
    const host = hostDelivery(state);
    const v = raise(dir, T0, host);
    assert.equal(v.direct, "daemon-running", state);
    assert.equal(host.posted.length, 0, `${state}: the daemon is (or may be) up, so it posts`);
    assert.equal(pending(dir).length, 1);
    assert.equal(pending(dir)[0].directError, undefined);
  }
  const dir = scratch(t, "alert-other");
  const host = hostDelivery("down");
  for (let i = 0; i < 10; i += 1) {
    raiseLauncherAlert(dir, { instance: INSTANCE, condition: "units-diverged", message: "diverged" }, meta(T0 + i * TICK, host));
  }
  assert.equal(host.posted.length, 0, "only the crash loop is the down-daemon alert");
  assert.equal(pending(dir).length, 1);
  // With no delivery wired at all, a crash loop is spooled exactly as before this task.
  const plain = scratch(t, "alert-plain");
  const v = raiseLauncherAlert(plain, LOOP, meta(T0));
  assert.equal(v.direct, undefined);
  assert.equal(pending(plain).length, 1);
});

// ── the real seams ────────────────────────────────────────────────────────────────────────────

function spawned(r: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...r };
}

function withStubDocker(t: TestContext, script: string): void {
  const bin = scratch(t, "stub-docker");
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(docker, 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  t.after(() => {
    process.env.PATH = prior;
  });
}

test("docker inspect reads a stopped or absent container as down, and no answer as unknown", (t) => {
  const answer = (r: Partial<SpawnSyncReturns<string>>) => () => spawned(r);
  assert.equal(dockerContainerState(INSTANCE, answer({ stdout: "true\n" })), "running");
  assert.equal(dockerContainerState(INSTANCE, answer({ stdout: "false\n" })), "down");
  assert.equal(dockerContainerState(INSTANCE, answer({ stdout: "maybe\n" })), "unknown");
  assert.equal(dockerContainerState(INSTANCE, answer({ status: 1, stderr: "Error: No such object: remudero-daemon\n" })), "down");
  assert.equal(dockerContainerState(INSTANCE, answer({ status: 1, stderr: "Cannot connect to the Docker daemon\n" })), "unknown");
  assert.equal(dockerContainerState(INSTANCE, answer({ status: null, error: new Error("spawnSync docker ENOENT") })), "unknown");

  // The default really shells out to `docker` on PATH.
  withStubDocker(t, 'echo "$*" > "$(dirname "$0")/argv"; echo false');
  assert.equal(dockerContainerState(INSTANCE), "down");
  // The production delivery's down check is that same probe.
  assert.equal(realHostDirectDelivery(scratch(t, "real-delivery")).containerState(INSTANCE), "down");
});

test("the host credential is a minted App installation token, else GH_TOKEN, else a named refusal", (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyDir = scratch(t, "app-key");
  const keyPath = join(keyDir, "rmd-app.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const app = { [GH_APP_ID_ENV]: "4648213", [GH_APP_INSTALLATION_ID_ENV]: "155256285", [GH_APP_PRIVATE_KEY_PATH_ENV]: keyPath };
  const answer = (body: string) => () => `data:application/json,${encodeURIComponent(body)}`;

  // The real exchange child runs, reads the JWT from stdin and prints the token.
  assert.equal(hostGithubToken({ env: app, exchangeUrl: answer(JSON.stringify({ token: "ghs_minted" })) }), "ghs_minted");
  // A refused exchange falls back to GH_TOKEN, or names both failures.
  assert.equal(hostGithubToken({ env: { ...app, GH_TOKEN: "ghp_fallback" }, exchangeUrl: answer("{}") }), "ghp_fallback");
  assert.throws(() => hostGithubToken({ env: app, exchangeUrl: answer("{}") }), /installation token exchange failed \(installation token exchange answered HTTP 200\) and no GH_TOKEN/);
  assert.throws(
    () => hostGithubToken({ env: app, spawn: () => spawned({ status: null, error: new Error("spawnSync ETIMEDOUT") }) }),
    /exchange failed \(spawnSync ETIMEDOUT\)/,
  );
  assert.throws(() => hostGithubToken({ env: app, spawn: () => spawned({ status: 0, stdout: "not json" }) }), /printed no token/);
  assert.throws(() => hostGithubToken({ env: app, spawn: () => spawned({ status: 3 }) }), /exchange failed \(exit 3\)/);
  // An unreadable or unusable key is named, never a stack.
  assert.throws(() => hostGithubToken({ env: { ...app, [GH_APP_PRIVATE_KEY_PATH_ENV]: join(keyDir, "absent.pem") } }), /could not sign a JWT/);
  // No App config at all: GH_TOKEN, else the refusal that names every variable.
  assert.equal(hostGithubToken({ env: { GH_TOKEN: "ghp_only" } }), "ghp_only");
  assert.throws(() => hostGithubToken({ env: {} }), /no host credential: set GH_APP_ID, GH_APP_INSTALLATION_ID and GH_APP_PRIVATE_KEY_PATH, or GH_TOKEN/);
});

test("the post goes to the checkout's own github repo, and is refused under the test runner", (t) => {
  assert.deepEqual(
    hostAlertRepo(() => spawned({ stdout: "https://github.com/craigoley/remudero.git\n" })),
    { owner: "craigoley", repo: "remudero" },
  );
  assert.throws(() => hostAlertRepo(() => spawned({ status: 128, stderr: "not a git repository" })), /no github\.com origin/);
  // The default really runs git in the working directory, as the launcher's `cd` into the daemon tree.
  const own = hostAlertRepo();
  assert.match(`${own.owner}/${own.repo}`, /^[^/\s]+\/[^/\s]+$/, "this checkout's own github.com origin");

  // The production post never reaches docker, git or GitHub from a suite.
  const dir = scratch(t, "real-post");
  const e = { class: "BLOCKED", taskId: "HOST-WATCHDOG-x-crash-loop", summary: "s", detail: "d", options: [], recommendation: "", consequence: "" } as unknown as Escalation;
  assert.throws(() => realHostDirectDelivery(dir).post(e), /gh-issue-create/);

  // The verb's default under the test runner wires no delivery: spool-only, nothing probed.
  withStubDocker(t, 'touch "$(dirname "$0")/probed"; echo false');
  const v = raise(dir, T0);
  assert.equal(v.direct, undefined);
  assert.equal(pending(dir).length, 1);
  const stub = (process.env.PATH ?? "").split(":")[0];
  assert.equal(existsSync(join(stub, "probed")), false, "a suite must never probe this machine's docker");
});
