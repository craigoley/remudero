import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildRepoDashboardRoutes, repoSummarySync, type RepoDashboardResult } from "../src/lib/repo-dashboard-route.js";
import { installPolicyPath, loadDefaultPolicy } from "../src/lib/policy.js";
import { loadAlertPolicy } from "../src/lib/alert-lane.js";
import { createService } from "../src/lib/service.js";
import { fixedClock } from "../src/lib/clock.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const REPO = { owner: "acme", repo: "alpha" };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repo-settings-"));
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "alert-policy.yaml"), [
    "act_severities: [low]", "critical_paths:",
    "  review: [src/lib/review.ts]", "  gate: [src/gate.ts]",
    "  containment: [src/containment.ts]", "  ledger: [src/ledger.ts]", "  status: [src/status.ts]",
  ].join("\n"));
  return root;
}

test("W1-T5178: a repository reports its effective settings with their source", async () => {
  const root = fixture();
  const server = createService({ tokens: { read: "settings-read", write: "settings-write" },
    routes: buildRepoDashboardRoutes({ root, instanceRepository: REPO, clock: fixedClock(NOW) }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/v1/repos", "/v1/repos/summary"]) {
      const response = await fetch(base + path, { headers: { authorization: "Bearer settings-read" } });
      assert.equal(response.status, 200);
      const body = await response.json() as RepoDashboardResult;
      const entry = body.repos[0];
      const policy = loadDefaultPolicy().values;
      assert.deepEqual(entry.settings.proofpolicy, { timeoutMs: policy.proofTimeoutMs });
      assert.equal(entry.settings.workerpoolsize, policy.sweep.dispatchLanes);
      assert.deepEqual(entry.settings.alertthreshold, loadAlertPolicy(join(root, "plan", "alert-policy.yaml")));
      assert.deepEqual(entry.settings.configSource, {
        proofpolicy: "organization-default", workerpoolsize: "organization-default", alertthreshold: "repository-override",
      });
      assert.deepEqual(entry.settings.source, {
        proofpolicy: "plan/policy.yaml#proofTimeoutMs", workerpoolsize: "plan/policy.yaml#sweep.dispatchLanes",
        alertthreshold: "plan/alert-policy.yaml",
      });
      // Freshness is the newest source's own modification time, never the read's clock (NOW).
      const newest = Math.max(statSync(installPolicyPath()).mtimeMs, statSync(join(root, "plan", "alert-policy.yaml")).mtimeMs);
      assert.equal(entry.settings.freshness, new Date(newest).toISOString());
      assert.notEqual(entry.settings.freshness, new Date(NOW).toISOString());
      assert.deepEqual(entry.settings.reasons, {});
      assert.equal(entry.not_computed.settings, "");
      assert.equal(entry.actions.find((action) => action.id === "configure")?.available, false);
    }
    const write = await fetch(base + "/v1/repos/summary", {
      method: "POST", headers: { authorization: "Bearer settings-write" },
    });
    assert.equal(write.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("W1-T5178: a setting with no source stays null with a reason", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-repo-settings-missing-"));
  const result = repoSummarySync({ root, instanceRepository: REPO,
    readSettingsPolicy: () => { throw new Error("policy source unavailable"); } }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const entry = result.summary.repos[0];
  assert.equal(entry.settings.proofpolicy, null);
  assert.equal(entry.settings.workerpoolsize, null);
  assert.equal(entry.settings.alertthreshold, null);
  assert.deepEqual(entry.settings.configSource, { proofpolicy: null, workerpoolsize: null, alertthreshold: null });
  assert.match(entry.settings.reasons!.proofpolicy!, /policy source unavailable/);
  assert.match(entry.settings.reasons!.workerpoolsize!, /policy source unavailable/);
  assert.match(entry.settings.reasons!.alertthreshold!, /ENOENT/);
  assert.match(entry.not_computed.settings, /alertthreshold/);
  assert.equal(entry.settings.freshness, null, "no source file was read, so nothing dates the settings");
});

test("settings retain independent sources when the repository alert policy is malformed", () => {
  const root = fixture();
  writeFileSync(join(root, "plan", "alert-policy.yaml"), "act_severities: [invented]\n");
  const result = repoSummarySync({ root, instanceRepository: REPO }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const settings = result.summary.repos[0].settings;
  assert.deepEqual(settings.proofpolicy, { timeoutMs: loadDefaultPolicy().values.proofTimeoutMs });
  assert.equal(settings.workerpoolsize, loadDefaultPolicy().values.sweep.dispatchLanes);
  assert.equal(settings.alertthreshold, null);
  assert.match(settings.reasons!.alertthreshold!, /act_severities/);
  assert.equal(settings.configSource!.alertthreshold, null);
});

test("settings file reads replay the same source observation for the read-model shadow", () => {
  const root = fixture();
  const options = { root, instanceRepository: REPO };
  const first = repoSummarySync(options, NOW);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.summary.repos[0].settings.alertthreshold,
    loadAlertPolicy(join(root, "plan", "alert-policy.yaml")));
  writeFileSync(join(root, "plan", "alert-policy.yaml"), "invalid: policy\n");
  const replay = repoSummarySync({ ...options, fileReads: first.fileReads }, NOW + 1000);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.deepEqual(replay.summary.repos[0].settings, first.summary.repos[0].settings);
  const current = repoSummarySync(options, NOW + 1000);
  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal(current.summary.repos[0].settings.alertthreshold, null);
});
