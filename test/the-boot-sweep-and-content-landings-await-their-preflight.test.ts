// test/the-boot-sweep-and-content-landings-await-their-preflight.test.ts — W1-T9695.
//
// W1-T9660's census row for runInTree named three drivers of the SYNCHRONOUS plan-PR preflight (spawnSync of
// lint-plan-precheck, task-id-existence-check, check-proof and the shard census) on the daemon loop: daemonBoot's
// feedback-landing sweep, the measurement cadence's plan-reconcile landing and the evidence-coverage filer's status
// landing. Each now awaits the async preflight, or queues for the per-poll async sweep and runs none.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { daemonBoot } from "#src/lib/daemon.js";
import { daemonEvidenceCoverageInput } from "#src/lib/evidence-coverage-gardener.js";
import { feedbackEntryPath, feedbackEntryRepoPath } from "#src/lib/feedback.js";
import * as landing from "#src/lib/feedback-landing.js";
import { queuedFeedbackDir, queuedFeedbackLandings, type LandFeedbackResult } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "#src/lib/measurement-cadence.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// Namespace reads, so this file still loads at the base (where these forms do not exist) and reds per subtest.
type Rungs = { atBoot: () => Promise<LandFeedbackResult> | LandFeedbackResult };
type Landing = { land: (inputs: readonly { relPath: string; content: string }[]) => void; settled: () => Promise<void> };
const feedbackLandingSweepRungs = (landing as Record<string, unknown>).feedbackLandingSweepRungs as (root: string, opts: object) => Rungs;
const planReconcileLanding = (landing as Record<string, unknown>).planReconcileLanding as (
  root: string, opts: () => object, lander?: (...args: unknown[]) => Promise<LandFeedbackResult>) => Landing;

const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
type Row = { step: string; extra?: Record<string, unknown> };

test("W1-T9695: the boot sweep awaits the async feedback landing", async () => {
  const rows: Row[] = [];
  const landed: LandFeedbackResult = { landed: true, pushed: true, files: ["plan/feedback/fb-boot.yaml"] };
  let settled = false;
  const sweep = () => new Promise<LandFeedbackResult>((resolve) => setTimeout(() => ((settled = true), resolve(landed)), 5));
  const boot = daemonBoot((step, extra) => void rows.push({ step, extra }), { PATH: "/usr/bin" },
    undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, sweep);
  assert.equal(settled, false, "the sweep resolves after a tick, so a sync boot would log before it");
  await boot;
  assert.ok(settled, "boot settles only after the sweep");
  assert.deepEqual(rows.filter((r) => r.step === "daemon.feedback_landing_sweep").map((r) => r.extra),
    [{ landed: true, pushed: true, file_count: 1 }]);

  // The daemon's own boot rung is the awaited sweep, never the sync one.
  const root = mkdtempSync(join(tmpdir(), "rmd-w9695-boot-"));
  const offline = () => { throw new Error("offline fixture"); };
  const atBoot = feedbackLandingSweepRungs(root, { git: offline, gh: offline }).atBoot();
  assert.ok(atBoot instanceof Promise, "atBoot returns the awaited sweep's promise");
  await atBoot.catch(() => undefined);
});

test("W1-T9695: the plan-reconcile landing never drives the sync preflight", async () => {
  const seed = gitRepo({ kind: "w9695-reconcile-seed" });
  const origin = gitRepo({ bare: true, kind: "w9695-reconcile-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "w9695-reconcile-clone" });
  const ids = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
  const gh = (args: string[]): string => (args[1] === "list" ? "[]" : args[1] === "create" ? "https://github.com/o/r/pull/9695\n" : "");
  // The seam answers with a Promise: only the awaited driver can read its green verdict. A sync driver would
  // take the Promise itself for the verdict and refuse the landing.
  const asked: string[] = [];
  const planPrPreflight = async (sha: string) => (asked.push(sha), GREEN);
  // The measurement cadence's production land seam, over the awaited lander it defaults to.
  const reconcile = planReconcileLanding(checkout.dir, () => ({ gh, planPrPreflight, landingOwner: "measurement-cadence" }));
  const cadenceFor = (land: Landing["land"]) => buildPlanReconcileCadenceInput({
    checkoutRoot: checkout.dir,
    readShards: () => ids.map((taskId) => ({ taskId, path: join(checkout.dir, "plan", "tasks.d", `${taskId}.yaml`), text: `- id: ${taskId}\n  status: queued\n` })),
    creditedMergedIds: () => new Set(ids),
    land,
  });
  const report = await withLiveWritesAllowed(async () => {
    const cadence = planReconcileCadence(cadenceFor(reconcile.land));
    assert.equal(asked.length, 0, "the cadence only starts the landing; its preflight is awaited");
    await reconcile.settled();
    return cadence;
  });
  assert.equal(report.status, "landed");
  assert.equal(asked.length, 1, "the awaited preflight judged the landing tree");
  assert.equal(existsSync(join(checkout.dir, "plan")), false, "the landing never writes the daemon checkout");

  // A refused landing still fails the cadence: `settled` rethrows it.
  const refused = planReconcileLanding(checkout.dir, () => ({}), async () => ({ landed: false, files: [], error: "simulated async refusal" }));
  assert.equal(planReconcileCadence(cadenceFor(refused.land)).status, "landed");
  await assert.rejects(refused.settled(), /simulated async refusal/);
});

test("W1-T9695: the evidence-coverage status landing queues under the state root and runs no preflight", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w9695-evidence-root-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w9695-evidence-state-"));
  const id = "evidence-coverage-fix-cost";
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  const before = `id: ${id}\nstatus: triaged\nraw: first body\n`;
  writeFileSync(feedbackEntryPath(root, id), before);

  const deps = daemonEvidenceCoverageInput({ stateDir: stateRoot, root, log: () => {}, landingStateRoot: stateRoot });
  deps.file({ id, action: "update", lane: "fix", field: "cost", raw: "second body" });

  // `root` is no git checkout, so any landing (and its preflight) could only have failed; the record waits instead.
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [feedbackEntryRepoPath(id)]);
  const queued = parseYaml(readFileSync(join(queuedFeedbackDir(stateRoot), `${id}.yaml`), "utf8"));
  assert.equal(queued.raw, "second body");
  assert.equal(queued.status, "triaged", "the update keeps the entry's status");
  assert.equal(readFileSync(feedbackEntryPath(root, id), "utf8"), before, "the checkout copy is untouched");
});
