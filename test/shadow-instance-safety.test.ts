import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseInstanceRegistry } from "../src/lib/instance-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects,
  ghPrCreateFillCommand,
  instanceMode,
  readInstanceRegistryText,
  resolveShadowInstanceArmPermission,
  shadowLiveWouldHaveDone,
} from "../src/run-task.js";

const registry = (mode?: string) => [
  "instances:",
  "  worker:",
  "    github_repo: owner/repo",
  ...(mode ? [`    mode: ${mode}`] : []),
  "",
].join("\n");

test("a shadow instance opens pull requests ready for review under the no-draft rule", () => {
  assert.equal(parseInstanceRegistry(registry("shadow")).instances[0]?.mode, "shadow");
  assert.equal(instanceMode("owner/repo", registry("shadow")), "shadow");
  const command = withLiveWritesAllowed(() =>
    ghPrCreateFillCommand(process.cwd(), "owner", "repo", "shadow-fixture", "test: shadow PR"),
  );
  assert.ok(command.args.includes("base=main"));
  assert.ok(!command.args.some((arg) => arg.startsWith("draft=")), "the create API opens ready by default");
});

test("a shadow instance never arms or merges a pull request", () => {
  let mergeCalls = 0;
  const permission = resolveShadowInstanceArmPermission(true);
  if (permission.armed) mergeCalls += 1;
  assert.equal(mergeCalls, 0);
  assert.match(permission.reason ?? "", /shadow instance/);
  assert.equal(resolveShadowInstanceArmPermission(false).armed, true);
});

test("a shadow run records what a live instance would have done", () => {
  const verdict = shadowLiveWouldHaveDone(true);
  assert.equal(verdict.would, "would_merge");
  assert.deepEqual(shadowLiveWouldHaveDone(false, "review held"), {
    would: "would_block",
    reason: "review held",
  });
});

test("an instance with no mode stays live", () => {
  assert.equal(instanceMode("owner/repo", undefined), "live");
  assert.equal(instanceMode("owner/repo", registry()), "live");
});

test("an invalid or unreadable registry does not invent shadow mode", () => {
  assert.throws(() => parseInstanceRegistry(registry("bogus")), /not "shadow" or "live"/);
  assert.equal(instanceMode("owner/repo", registry("bogus")), "live");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-registry-absent-`));
  try {
    assert.equal(readInstanceRegistryText(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the independent sweep path cannot arm a shadow instance", () => {
  let sweepArmCalls = 0;
  const effects = buildSweepEffects({
    owner: "owner",
    repo: "repo",
    instanceRegistryTextImpl: () => registry("shadow"),
    config: { root: "/tmp/shadow-sweep-fixture" } as Config,
    ledgerPath: "/tmp/shadow-sweep-fixture/ledger.ndjson",
    runId: "SWEEP-shadow",
    plan: { tasks: [], byId: new Map() } as Plan,
    log: () => {},
    armImpl: () => { sweepArmCalls += 1; return "armed"; },
  });
  const outcome = effects.arm({
    prUrl: "https://github.com/owner/repo/pull/1",
    taskId: "W1-T4265",
    headSha: "abc123",
  } as OpenPrView);
  assert.equal(outcome, "shadow-refused");
  assert.equal(sweepArmCalls, 0);
});
