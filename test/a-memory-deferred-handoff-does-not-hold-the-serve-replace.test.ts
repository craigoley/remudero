import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { realServePolicyDeps, runServePolicyCycle, serveHandoffOpen } from "#src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T9504 — 2026-10-14: serve's handoff never fit (need 5.15 GB, ~3.5 GB free), so the supervisor deferred it 75
// times; each deferral read as a handoff in flight, and every serve-policy tick from 16:03Z held serve's image replace.
const row = (step: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: "2026-10-14T16:59:28Z", task_id: "SERVE", step, lane: "serve", ...extra });
/** The rows serve wrote 16:59:28-16:59:48Z: a request, both shed tiers, still short, deferred for memory. */
const DEFERRED = [
  row("serve.handoff_requested", { reason: "checkout_behind" }),
  row("serve.handoff_shed", { generation: 1, answered: true, gc: true }),
  row("serve.handoff_shed", { tier: 2, phase: "shed", generation: 1 }),
  row("serve.handoff_shed", { tier: 2, phase: "restored", reason: "still_short", generation: 1 }),
  row("serve.handoff_deferred", { reason: "memory", hold: "container_headroom", deferrals: 68, retryMs: 900000 }),
];
const NOW = Date.parse("2026-10-14T17:00:00Z");
const DRIFT = { expected: `sha256:${"d".repeat(64)}`, actual: `sha256:${"3".repeat(64)}` };

function primary(t: TestContext, ledger: string[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-deferred-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install");
  const stateRoot = join(root, "primary-state");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(join(installPath, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: remudero-daemon\n`);
  writeFileSync(join(stateRoot, "state", "ledger.ndjson"), `${ledger.join("\n")}\n`);
  return { installPath, stateRoot };
}

function cycle(serveHandoffInProgress: () => boolean | undefined) {
  const rows: string[] = [];
  let replaced = 0;
  const deps = {
    log: (step: string) => rows.push(step),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => [],
    serveMountPlanDrift: () => [],
    serveImageDrift: () => (replaced > 0 ? undefined : DRIFT),
    replaceServe: () => { replaced++; },
    clearServePolicyFailure: () => {},
  } as unknown as Parameters<typeof runServePolicyCycle>[0];
  const out = runServePolicyCycle(deps, { imageDriftOnly: true });
  return { out, rows, replaced: () => replaced };
}

test("W1-T9504: a memory-deferred handoff does not hold the serve replace", (t) => {
  assert.equal(serveHandoffOpen(DEFERRED.join("\n")), false);
  const seams = realServePolicyDeps(primary(t, DEFERRED));
  assert.equal(seams.serveHandoffInProgress!(), false);
  const c = cycle(seams.serveHandoffInProgress!);
  assert.equal(c.out.replaced, true, c.out.reason);
  assert.equal(c.replaced(), 1);
  assert.deepEqual(c.rows, ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
});

test("W1-T9504: a handoff still running holds the replace", (t) => {
  const running = [
    DEFERRED.slice(0, 1), // requested, nothing after it yet
    DEFERRED.slice(0, 3), // mid-shed
    DEFERRED.slice(0, 4), // shed restored: a handoff that now fits goes on to fork its standby
    [...DEFERRED, row("serve.handoff_requested", { reason: "retry" })], // the deferral's retry asked again
  ];
  for (const ledger of running) {
    assert.equal(serveHandoffOpen(ledger.join("\n")), true, ledger.at(-1));
    const c = cycle(realServePolicyDeps(primary(t, ledger)).serveHandoffInProgress!);
    assert.equal(c.out.replaced, false);
    assert.equal(c.replaced(), 0);
    assert.match(c.out.reason, /a serve handoff is in progress/);
  }
});

test("W1-T9504: a spacing deferral also leaves nothing mid-swap", () => {
  const spacing = [DEFERRED[0]!, row("serve.handoff_deferred", { reason: "spacing", waitMs: 60000 })];
  assert.equal(serveHandoffOpen(spacing.join("\n")), false);
});
