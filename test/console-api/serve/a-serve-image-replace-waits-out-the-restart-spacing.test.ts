/**
 * W1-T13623: on 2026-11-18 every new image swapped serve, so serve restarted at 06:00:41Z, 06:06:29Z and 06:22:02Z, each a
 * cold fold of the ledger, while the supervisor's handoff spacing held self-syncs to about 09:14Z. An automatic replace for
 * image drift ALONE now waits out the same 2 h from serve's last restart, read from the ledger, and then takes the newest image.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  newestServeRestartMs, realServePolicyDeps, runServePolicyCycle, SERVE_IMAGE_REPLACE_SPACING_MS, serveLastRestartMsFromLedger,
} from "#src/lib/serve-policy-convergence.js";
import { SERVE_HANDOFF_SPACING_BASE_MS } from "#src/lib/serve-supervisor.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const row = (ts: string, step: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts, task_id: "SERVE", step, lane: "serve", ...extra });
const IMAGE = (n: number) => ({ expected: `sha256:${String(n).padStart(64, "e")}`, actual: `sha256:${"0".repeat(64)}` });

function primary(t: TestContext, ledger: string[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-restart-spacing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install"), stateRoot = join(root, "primary-state");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(join(installPath, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: remudero-daemon\n`);
  const ledgerPath = join(stateRoot, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, ledger.length ? `${ledger.join("\n")}\n` : "");
  return { installPath, stateRoot, ledgerPath };
}

/** One deploy tick at `nowMs` against a serve whose image is `image` behind (or has `resource` drift); a replace writes the restart row serve would. */
function tick(p: ReturnType<typeof primary>, nowMs: number, drift: { image?: ReturnType<typeof IMAGE>; resource?: boolean }) {
  const rows: Array<{ step: string; reason?: string }> = [];
  let replaced = 0;
  const seams = realServePolicyDeps(p);
  const deps = {
    log: (step: string, extra: { reason?: string } = {}) => rows.push({ step, reason: extra.reason }),
    now: () => nowMs,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => (drift.resource && replaced === 0 ? [{ field: "memory", expected: "7680m", actual: "5120m" }] : []),
    serveMountPlanDrift: () => [],
    serveImageDrift: () => (replaced > 0 ? undefined : drift.image),
    serveLastRestartAtMs: seams.serveLastRestartAtMs,
    replaceServe: () => { replaced++; appendFileSync(p.ledgerPath, `${row(new Date(nowMs).toISOString(), "serve.recycle_swapped")}\n`); },
    clearServePolicyFailure: () => {},
  } as unknown as Parameters<typeof runServePolicyCycle>[0];
  const out = runServePolicyCycle(deps, { imageDriftOnly: true });
  return { out, rows, replaced };
}

test("W1-T13623 criterion 1: replaying 2026-11-18, a new image every tick restarts serve once per spacing, not per image", (t) => {
  // serve cold-started at 06:01:29Z; images were published at 06:03Z and after. The deployer ticks every 5 minutes.
  const p = primary(t, [row("2026-11-18T06:00:57.528Z", "serve.supervisor_ready"), row("2026-11-18T06:01:29.271Z", "serve.cold_start_ready")]);
  const first = tick(p, at("2026-11-18T06:05:25Z"), { image: IMAGE(1) });
  assert.equal(first.replaced, 0, first.out.reason);
  assert.deepEqual(first.rows.map(r => r.step), ["deploy.serve_policy_held"]);
  assert.match(first.rows[0]!.reason!, /restarted 4 min ago .*120 min restart spacing \(117 min left\)/);
  const restarts: number[] = [];
  for (let ms = at("2026-11-18T06:10:00Z"), n = 2; ms <= at("2026-11-18T12:10:00Z"); ms += 5 * MIN, n++) {
    if (tick(p, ms, { image: IMAGE(n) }).replaced) restarts.push(ms);
  }
  assert.deepEqual(restarts.map(ms => new Date(ms).toISOString()),
    ["2026-11-18T08:05:00.000Z", "2026-11-18T10:05:00.000Z", "2026-11-18T12:05:00.000Z"], "one restart per two hours, each on the newest image");
});

test("W1-T13623 criterion 2: resource drift beside a recent restart still replaces at once", (t) => {
  const p = primary(t, [row("2026-11-18T06:01:29.271Z", "serve.cold_start_ready")]);
  const resource = tick(p, at("2026-11-18T06:05:25Z"), { resource: true, image: IMAGE(1) });
  assert.equal(resource.replaced, 1, resource.out.reason);
  assert.deepEqual(resource.rows.map(r => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
});

test("W1-T13623 criterion 3: an unreadable last restart holds an image-only replace, and a ledger with none replaces", (t) => {
  const none = primary(t, [row("2026-11-18T05:00:00Z", "serve.handoff_requested")]);
  assert.equal(serveLastRestartMsFromLedger(join(none.stateRoot, "state")), null);
  assert.equal(tick(none, at("2026-11-18T06:05:25Z"), { image: IMAGE(1) }).replaced, 1);
  const unreadable = primary(t, []);
  rmSync(join(unreadable.stateRoot, "state"), { recursive: true, force: true });
  const held = tick(unreadable, at("2026-11-18T06:05:25Z"), { image: IMAGE(1) });
  assert.equal(held.replaced, 0);
  assert.match(held.out.reason, /last restart is unreadable/);
});

test("W1-T13623 criterion 4: every restart kind counts, and the spacing equals the supervisor's handoff base", () => {
  assert.equal(SERVE_IMAGE_REPLACE_SPACING_MS, SERVE_HANDOFF_SPACING_BASE_MS);
  const kinds = ["serve.supervisor_ready", "serve.cold_start_ready", "serve.handoff_done", "serve.recycle_swapped"];
  for (const [i, step] of kinds.entries()) {
    const ts = `2026-11-18T06:0${i}:00.000Z`;
    assert.equal(newestServeRestartMs([row("2026-11-18T05:00:00Z", "serve.handoff_done"), row(ts, step), row("2026-11-18T07:00:00Z", "serve.handoff_requested")]), at(ts), step);
  }
});
