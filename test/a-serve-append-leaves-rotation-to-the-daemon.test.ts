/**
 * W1-T13236: whichever process's append crossed the ceiling rotated the shared core ledger on its own thread. When
 * that was serve, its request loop stopped: on 2026-11-18, 43 serve runtime.loop_stall_profile rows named
 * rotateLedger (76 s of stall). Serve now rotates only past the backstop; the daemon keeps rotating at the ceiling.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { daemonBoot } from "#src/lib/daemon.js";
import { appendLedger, LEDGER_ROTATION_BACKSTOP_MULTIPLIER, ledgerRotationRole, setLedgerRotationRole } from "#src/lib/ledger.js";
import { buildReadyServeServer, buildServeServer, CONSOLE_SHA_UNKNOWN, type ServeDeps } from "#src/lib/serve.js";
import { withTempDir } from "#src/lib/tmp.js";

const CEILING = 8 * 1024;
const archives = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".gz"));
/** Appends rows of about 200 bytes until the live file passes `bytes`. */
function fillPast(path: string, bytes: number): void {
  for (let i = 0; i < Math.ceil(bytes / 150) + 2; i++) {
    appendLedger(path, { run_id: "r", task_id: "W1-T13236", step: "test.row", pad: "x".repeat(120), i } as never, { ceilingBytes: CEILING });
  }
}

test("W1-T13236 criterion 1: a backstop-only process rotates past the backstop, not at the ceiling", async (t) => {
  const prior = setLedgerRotationRole("backstop-only");
  t.after(() => setLedgerRotationRole(prior));
  await withTempDir("rotation-role", async (dir) => {
    const path = join(dir, "ledger.ndjson");
    fillPast(path, CEILING * 2);
    assert.deepEqual(archives(dir), [], "past the ceiling but under the backstop: no rotation");
    fillPast(path, CEILING * LEDGER_ROTATION_BACKSTOP_MULTIPLIER);
    assert.ok(archives(dir).length >= 1, "past the backstop: the append rotates");
  });
});

test("W1-T13236 criterion 3: invariant:default-role-unchanged — a process that sets no role rotates at the ceiling", async () => {
  assert.equal(ledgerRotationRole(), "rotator");
  await withTempDir("rotation-default", async (dir) => {
    const path = join(dir, "ledger.ndjson");
    fillPast(path, CEILING * 2);
    assert.ok(archives(dir).length >= 1, "the default role rotates once past the ceiling");
  });
});

test("W1-T13236 criterion 2: serve's boot takes backstop-only before its appending timers start; the daemon keeps the default", async () => {
  daemonBoot(() => undefined, { PATH: "/usr/bin", RMD_SPAWN_HELPER: "off" });
  assert.equal(ledgerRotationRole(), "rotator", "the daemon's boot leaves the default role");
  await withTempDir("rotation-serve", async (root) => {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
    writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
    const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    let roleAtMonitorStart: string | undefined;
    const deps: ServeDeps = {
      ledgerPath, fleetControlRoot: root, questionsRoot: root,
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
      issues: { close() {} }, tokens: { read: "r", write: "w" },
      consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never,
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      assistantRepository: "craigoley/remudero",
      demand: { every: () => () => undefined },
      hostServeEvidence: { root },
      incidentInvariants: {
        readLedger: () => [],
        setInterval: (() => { roleAtMonitorStart = ledgerRotationRole(); return { unref() {} }; }) as never,
        clearInterval: () => undefined,
      },
    } as ServeDeps;
    const bootError = new Error("gateway assembly failed");
    assert.throws(() => buildServeServer({
      ...deps, board: { ...deps.board, github: { ...github, serveOffLoop: () => { throw bootError; } } },
    }), bootError);
    assert.equal(ledgerRotationRole(), "rotator", "failed assembly restores the prior role");

    const server = buildServeServer(deps);
    try {
      assert.equal(roleAtMonitorStart, "backstop-only", "the role is set before the incident monitor's timer starts");
      assert.equal(ledgerRotationRole(), "backstop-only");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(ledgerRotationRole(), "rotator", "closing serve restores the role it replaced");

    roleAtMonitorStart = undefined;
    let recheck: (() => void) | undefined;
    const standby = await buildReadyServeServer({
      ...deps,
      consoleSha: CONSOLE_SHA_UNKNOWN,
      generation: { requestHandoff() {} },
      gatewayCheckout: async () => { throw new Error("checkout unavailable"); },
      staleExitSeams: {
        scheduleRecheck: (run) => { recheck = run; return () => { recheck = undefined; }; },
      },
      log: (step, extra) => appendLedger(ledgerPath, { run_id: "SERVE-test", task_id: "SERVE", step, lane: "serve", ...extra }, { ceilingBytes: CEILING }),
    });
    try {
      assert.equal(standby.listening, false);
      assert.equal(roleAtMonitorStart, undefined, "the incident monitor waits for the main listener");
      assert.ok(recheck, "checkout recheck is scheduled in standby");
      writeFileSync(ledgerPath, "{}".padEnd(CEILING - 1) + "\n");
      recheck();
      await setImmediate();
      assert.deepEqual(archives(join(root, "state")), [], "the standby recheck leaves rotation to the daemon");
      assert.match(readFileSync(ledgerPath, "utf8"), /"step":"serve\.gateway_checkout_unreadable"/);
      assert.ok(statSync(ledgerPath).size > CEILING, "the checkout log crossed the ordinary ceiling");

      const anotherServer = buildServeServer(deps);
      await new Promise<void>((resolve) => anotherServer.close(() => resolve()));
      assert.equal(ledgerRotationRole(), "backstop-only", "the open standby still owns the process role");
    } finally {
      await new Promise<void>((resolve) => standby.close(() => resolve()));
    }
    assert.equal(ledgerRotationRole(), "rotator", "closing before promotion also restores the prior role");
  });
});
