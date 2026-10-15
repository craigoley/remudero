import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSweepEffects } from "../src/run-task.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OBSERVED = "instance_mode.shadow_observed";
type Settings = { mode: "shadow"; instanceName: string; registryPath?: string; timeoutMs?: number };
const registry = (mode: string | undefined, privateValue = "/private/selected-mode-sentinel") => [
  "instances:", "  fixture:", "    github_repo: owner/repo",
  ...(mode === undefined ? [] : [`    mode: ${mode}`]),
  `    state_dir: ${privateValue}`, "",
].join("\n");
const pr = { prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1,
  taskId: "W1-T9572", headSha: "a".repeat(40) } as OpenPrView;

function fixture(mode: string | undefined = "shadow", legacy: "shadow" | "live" = "live", optedIn = true) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selected-mode-consumer-`));
  const selected = join(root, "selected.yaml"), other = join(root, "other.yaml");
  writeFileSync(selected, registry(mode, root)); writeFileSync(other, registry("live", root));
  const prior = { path: process.env.RMD_INSTANCE_REGISTRY, name: process.env.RMD_INSTANCE_NAME };
  delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_INSTANCE_NAME;
  const settings: Settings = { mode: "shadow", instanceName: "fixture", registryPath: selected, timeoutMs: 1500 };
  const config = { root, claudeBin: "/bin/true", installRoot: REPO_ROOT,
    ...(optedIn ? { selectedRegistryMode: settings } : {}) };
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let arms = 0;
  const deps = { owner: "owner", repo: "repo", config, ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-selected-mode-fixture", plan: loadPlanFromYaml("[]"),
    instanceRegistryTextImpl: () => registry(legacy),
    log: (step: string, fields: Record<string, unknown> = {}) => logs.push({ step, fields }),
    armImpl: async () => { arms += 1; return "armed" as const; },
  };
  const effects = buildSweepEffects(deps);
  return { root, selected, other, settings, effects, logs, arms: () => arms,
    rows: () => logs.filter(row => row.step === OBSERVED).map(row => row.fields),
    cleanup: () => {
      if (prior.path === undefined) delete process.env.RMD_INSTANCE_REGISTRY;
      else process.env.RMD_INSTANCE_REGISTRY = prior.path;
      if (prior.name === undefined) delete process.env.RMD_INSTANCE_NAME;
      else process.env.RMD_INSTANCE_NAME = prior.name;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("selected mode shadow evidence reaches actual run and sweep consumers", async () => {
  // First red: the real entrypoint-built sweep currently ignores selected configuration.
  // Actual run/deferred/default-transport cases join this criterion before task completion.
  for (const mode of ["shadow", "live"] as const) {
    const fx = fixture(mode);
    try {
      assert.equal(await fx.effects.arm!(pr), "armed");
      assert.equal(fx.arms(), 1, "SHADOW must preserve the real legacy result");
      assert.equal(fx.rows().at(-1)?.selected_outcome, `would-${mode}`);
      assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
    } finally { fx.cleanup(); }
  }
});

test("selected mode evidence never falls back after explicit failure", async () => {
  const fx = fixture(undefined);
  try {
    assert.equal(await fx.effects.arm!(pr), "armed", "healthy legacy effects remain unchanged");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "mode_missing");
    assert.equal(fx.arms(), 1);
  } finally { fx.cleanup(); }
});

test("selected mode revisions invalidate deferred arm observations", async () => {
  const fx = fixture("live");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    const original = fx.rows().at(-1)?.binding_digest;
    assert.equal(typeof original, "string");
    writeFileSync(fx.selected, registry("shadow", fx.root));
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "revision_changed");
    assert.equal(fx.rows().at(-1)?.binding_digest, original, "do not retarget the original binding");
    assert.equal(fx.arms(), 2);
  } finally { fx.cleanup(); }
});

test("selected mode snapshots survive caller and transport mutation", async () => {
  const fx = fixture("shadow");
  try {
    fx.settings.registryPath = fx.other;
    fx.settings.instanceName = "another-instance";
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
  } finally { fx.cleanup(); }
});

test("selected mode shadow unknown preserves owner and trusted legacy effects", async () => {
  for (const legacy of ["shadow", "live"] as const) {
    const fx = fixture(undefined, legacy);
    try {
      const outcome = await fx.effects.arm!(pr);
      assert.equal(outcome, legacy === "shadow" ? "shadow-refused" : "armed");
      assert.equal(fx.arms(), legacy === "shadow" ? 0 : 1);
      assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
      assert.equal(fx.rows().at(-1)?.legacy_outcome, outcome);
    } finally { fx.cleanup(); }
  }
});

test("selected mode defaults stay bounded asynchronous and private", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(readFileSync(fx.selected, "utf8").includes(fx.root), true, "private-value control");
    let pulsed = false;
    const pulse = new Promise<void>(resolve => setImmediate(() => { pulsed = true; resolve(); }));
    assert.equal(await fx.effects.arm!(pr), "armed"); await pulse;
    assert.equal(pulsed, true);
    assert.ok(fx.rows().length > 0, "real default selected filesystem read must reach this consumer");
    assert.equal(JSON.stringify(fx.rows()).includes(fx.root), false);
    assert.equal(JSON.stringify(fx.rows()).includes("selected.yaml"), false);
    assert.equal(fx.rows().at(-1)?.publication_permission, "not-granted");
  } finally { fx.cleanup(); }
});

test("selected mode shadow qualification never activates selected permissions", async () => {
  const legacy = fixture("shadow", "live", false);
  try {
    process.env.RMD_INSTANCE_REGISTRY = legacy.selected;
    assert.equal(await legacy.effects.arm!(pr), "armed");
    assert.equal(legacy.arms(), 1); assert.equal(legacy.rows().length, 0, "environment alone is not opt-in");
  } finally { legacy.cleanup(); }
  const observed = fixture("shadow");
  try {
    assert.equal(await observed.effects.arm!(pr), "armed");
    assert.equal(observed.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(observed.rows().at(-1)?.publication_permission, "not-granted");
    assert.equal(observed.arms(), 1, "a would-shadow observation is not an enforced hold");
  } finally { observed.cleanup(); }
});
