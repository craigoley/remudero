import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildBundle,
  extractAssertedWorkerSettingsValues,
  renderBundle,
  type BundleProvenance,
} from "../src/lib/bundle.js";
import { loadGlobalArtifact, verifyBundlePin, type LearningEntry } from "../src/lib/learnings.js";
import { bundleCommand, bundleExportCommand, learningsImportCommand } from "../src/run-task.js";

// W1-T2580 — THE MISSING EXPORT HALF. W1-T425 shipped the IMPORT side (`rmd learnings import`,
// `verifyBundlePin`) with nothing able to PRODUCE the artifact it consumes. These tests exercise
// the task's own falsifiers: (i) a built bundle round-trips through the SHIPPED, UNCHANGED
// import + pin verification; (ii) identical trees export byte-identical bundles; (iii) provenance
// survives the round trip; (iv) no token/ledger/state path can ever reach a bundle, even when fed
// the REAL committed worker-settings template; (v) the budget bounds the corpus rather than
// dumping it; (vi) the CLI glue actually calls the pure builder.

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "fleet-fact",
    subsystem: "knowledge",
    lifecycle: "active",
    files: [],
    fact: "One entry shape is valid at every knowledge layer.",
    src: "W1-T2580-provenance-tag",
    ...over,
  };
}

const provenance: BundleProvenance = {
  sourceRepo: "craigoley/remudero",
  sourceSha: "deadbeef",
  exportedAt: "2026-08-12T00:00:00.000Z",
};

/** A minimal, otherwise-valid worker-settings object — mirrors test/worker-settings-values.test.ts's fixture shape. */
function validSettings(): Record<string, unknown> {
  return {
    permissions: { deny: [], allow: [], ask: [] },
    hooks: {},
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ["github.com", "api.github.com"] },
    },
  };
}

// ── (i) ROUND TRIP IS THE PROOF: a built bundle verifies + loads through the SHIPPED import ──

test("W1-T2580: buildBundle's output verifies through verifyBundlePin and loads through the SAME loadGlobalArtifact the injector reads", () => {
  const entries = [entry({ id: "roundtrip-fact" })];
  const result = buildBundle(entries, validSettings(), provenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = renderBundle(result.bundle);

  const pinOk = verifyBundlePin(text, result.bundle.hash);
  assert.equal(pinOk.ok, true, "the bundle's own declared hash must verify against itself as the pin");

  const dir = tmpDir("bundle-roundtrip-");
  const path = join(dir, "artifact.yaml");
  writeFileSync(path, text, "utf8");
  const loaded = loadGlobalArtifact(path);
  assert.equal(loaded.ok, true, "a bundle buildBundle produced must load through the UNCHANGED loadGlobalArtifact guard");
  if (!loaded.ok) return;
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].id, "roundtrip-fact");
});

function setupHome(root: string): string {
  const home = mkdtempSync(join(tmpdir(), "bundle-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  return home;
}

function withHome(home: string, fn: () => void): void {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fn();
  } finally {
    process.env.HOME = oldHome;
  }
}

test("W1-T2580: rmd bundle export's output round-trips through the REAL, UNCHANGED `rmd learnings import <file> --pin <hash>` command", () => {
  const projectDir = tmpDir("bundle-cli-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "cli-roundtrip-fact" })]));
  const settingsDir = tmpDir("bundle-cli-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify(validSettings()));
  const outDir = tmpDir("bundle-cli-out-");
  const out = join(outDir, "bundle.yaml");

  const code = bundleExportCommand([out], { projectDir, settingsPath, now: () => provenance.exportedAt });
  assert.equal(code, 0);
  const bundleText = readFileSync(out, "utf8");
  const hashLine = bundleText.match(/^hash:\s*(\S+)/m);
  assert.ok(hashLine, "exported bundle must carry a hash: line");
  const pin = hashLine![1];

  const root = tmpDir("bundle-cli-import-root-");
  const home = setupHome(root);
  withHome(home, () => {
    // The SAME shipped importer W1-T425 built — never a reimplementation, never a second import path.
    const importCode = learningsImportCommand([out, "--pin", pin]);
    assert.equal(importCode, 0);
    const loaded = loadGlobalArtifact(join(root, "learnings-global", "artifact.yaml"));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.entries[0].id, "cli-roundtrip-fact");
  });
});

// ── (ii) DETERMINISM: identical trees export byte-identical bundles ──────────────────────────

test("W1-T2580: buildBundle is deterministic — identical entries/settings/provenance in produce byte-identical rendered bundles out", () => {
  const entries = [entry({ id: "det-fact-a" }), entry({ id: "det-fact-b", fact: "A second fact." })];
  const settings = validSettings();
  const r1 = buildBundle(entries, settings, provenance);
  const r2 = buildBundle(entries, settings, provenance);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(renderBundle(r1.bundle), renderBundle(r2.bundle));
  assert.equal(r1.bundle.hash, r2.bundle.hash);
});

test("W1-T2580: two `rmd bundle export` runs over the same tree (same entries/settings/injected now/headSha) write byte-identical files", () => {
  const projectDir = tmpDir("bundle-det-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "det-cli-fact" })]));
  const settingsDir = tmpDir("bundle-det-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify(validSettings()));
  const outDir = tmpDir("bundle-det-out-");
  const out1 = join(outDir, "bundle-1.yaml");
  const out2 = join(outDir, "bundle-2.yaml");
  const deps = { projectDir, settingsPath, now: () => provenance.exportedAt, headSha: () => "cafefeed" };

  assert.equal(bundleExportCommand([out1], deps), 0);
  assert.equal(bundleExportCommand([out2], deps), 0);
  assert.equal(readFileSync(out1, "utf8"), readFileSync(out2, "utf8"));
});

// ── (iii) PROVENANCE SURVIVES THE ROUND TRIP ──────────────────────────────────────────────────

test("W1-T2580: every bundled learning keeps its own `src` provenance tag through build + render + reload", () => {
  const entries = [
    entry({ id: "prov-a", src: "PR#1234" }),
    entry({ id: "prov-b", src: "learnings#some-other-entry" }),
  ];
  const result = buildBundle(entries, validSettings(), provenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.entries.find((e) => e.id === "prov-a")?.src, "PR#1234");
  assert.equal(result.bundle.entries.find((e) => e.id === "prov-b")?.src, "learnings#some-other-entry");

  const dir = tmpDir("bundle-provenance-");
  const path = join(dir, "artifact.yaml");
  writeFileSync(path, renderBundle(result.bundle), "utf8");
  const loaded = loadGlobalArtifact(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.entries.find((e) => e.id === "prov-a")?.src, "PR#1234");
  assert.equal(loaded.entries.find((e) => e.id === "prov-b")?.src, "learnings#some-other-entry");

  // The bundle's own EXPORT provenance (where/when it was assembled) also survives untouched.
  assert.deepEqual(result.bundle.provenance, provenance);
});

// ── (iv) NO TOKEN, LEDGER OR STATE PATH CAN EVER APPEAR IN A BUNDLE ──────────────────────────

test("W1-T2580: buildBundle over the REAL committed worker-settings template strips its deny-paths (state/, .ssh, .aws) rather than shipping them", () => {
  const realSettingsPath = new URL("../settings/worker.json", import.meta.url).pathname;
  const realSettings = JSON.parse(readFileSync(realSettingsPath, "utf8"));
  // Sanity: the REAL template does name these paths (in its deny list / $comment) — proves the
  // assertion below is actually testing narrowing, not a fixture that never had them to begin with.
  const rawText = readFileSync(realSettingsPath, "utf8");
  assert.match(rawText, /state\/service-tokens\.json/);
  assert.match(rawText, /\.ssh/);

  const entries = [entry({ id: "template-strip-fact" })];
  const result = buildBundle(entries, realSettings, provenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rendered = renderBundle(result.bundle);
  assert.doesNotMatch(rendered, /service-tokens/);
  assert.doesNotMatch(rendered, /state\//);
  assert.doesNotMatch(rendered, /\.ssh/);
  assert.doesNotMatch(rendered, /\.aws/);
  assert.doesNotMatch(rendered, /\bledger\b/);

  // workerSettings carries ONLY the four asserted fields — never the raw deny lists/$comment.
  assert.deepEqual(Object.keys(result.bundle.workerSettings).sort(), [
    "allowedNetworkDomains",
    "sandboxAutoAllowBashIfSandboxed",
    "sandboxEnabled",
    "sandboxFailIfUnavailable",
  ]);
});

test("W1-T2580: extractAssertedWorkerSettingsValues refuses (throws) a template that fails validateWorkerSettings, never bundling an unvalidated posture", () => {
  assert.throws(() => extractAssertedWorkerSettingsValues({ sandbox: { enabled: false } }));
});

test("W1-T2580: buildBundle refuses the WHOLE bundle (never a silent drop) when a selected entry matches the leak-grep tripwire, naming the entry", () => {
  const secret = "AKIA" + "0".repeat(16); // AWS-access-key-shaped, built via concatenation so this
  // file's own text never carries the literal pattern (same convention test/learnings-commons.test.ts uses).
  const entries = [entry({ id: "leaky-fact", fact: `Use ${secret} to authenticate.` })];
  const result = buildBundle(entries, validSettings(), provenance);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.blockedEntryId, "leaky-fact");
  assert.match(result.reason, /leak-grep tripwire/);
});

test("W1-T2580: a worker-settings template that fails validation refuses the export (exit 1), writing no file", () => {
  const projectDir = tmpDir("bundle-badsettings-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "irrelevant" })]));
  const settingsDir = tmpDir("bundle-badsettings-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify({ sandbox: { enabled: false } }));
  const outDir = tmpDir("bundle-badsettings-out-");
  const out = join(outDir, "bundle.yaml");
  const code = bundleExportCommand([out], { projectDir, settingsPath });
  assert.equal(code, 1);
  assert.throws(() => readFileSync(out, "utf8"));
});

// ── (v) THE BUDGET BOUNDS THE CORPUS RATHER THAN DUMPING IT ───────────────────────────────────

test("W1-T2580: buildBundle honors an injected budget — an over-budget corpus is trimmed, not dumped whole", () => {
  const entries: LearningEntry[] = Array.from({ length: 20 }, (_, i) =>
    entry({ id: `budget-fact-${i}`, fact: `Fact number ${i} repeated to add bulk to the budget weight.` }),
  );
  const tinyBudget = 200; // far smaller than 20 facts' combined rendered weight
  const result = buildBundle(entries, validSettings(), provenance, { budgetChars: tinyBudget });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.bundle.entries.length < entries.length, "an over-budget corpus must be trimmed");
  assert.ok(result.dropped.length > 0, "dropped entries must be reported, never silently discarded");
  assert.equal(result.bundle.entries.length + result.dropped.length, entries.length);
});

test("W1-T2580: an under-budget corpus is carried whole, with nothing dropped", () => {
  const entries = [entry({ id: "small-fact" })];
  const result = buildBundle(entries, validSettings(), provenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.entries.length, 1);
  assert.equal(result.dropped.length, 0);
});

test("W1-T2580: buildBundle refuses when zero entries are available — no empty-but-valid bundle", () => {
  const result = buildBundle([], validSettings(), provenance);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /zero active learnings entries/);
});

// ── (vi) CLI GLUE: bundleCommand/bundleExportCommand ──────────────────────────────────────────

test("W1-T2580: bundleCommand refuses an unknown subcommand, spawning/writing nothing", () => {
  assert.equal(bundleCommand(["frobnicate"]), 2);
});

test("W1-T2580: bundleCommand routes 'export' to bundleExportCommand", () => {
  // No <path> given -> the subcommand's own usage refusal (code 2), proving the dispatcher
  // actually reached bundleExportCommand rather than falling through.
  assert.equal(bundleCommand(["export"]), 2);
});

test("W1-T2580: bundleExportCommand rejects a stray flag and a missing <path>", () => {
  assert.equal(bundleExportCommand(["out.yaml", "--bogus"]), 2);
  assert.equal(bundleExportCommand([]), 2);
});

test("W1-T2580: bundleExportCommand degrades sourceSha to \"unknown\" (never crashes) when the head-sha read throws", () => {
  const projectDir = tmpDir("bundle-degrade-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "degrade-fact" })]));
  const settingsDir = tmpDir("bundle-degrade-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify(validSettings()));
  const outDir = tmpDir("bundle-degrade-out-");
  const out = join(outDir, "bundle.yaml");
  const code = bundleExportCommand([out], {
    projectDir,
    settingsPath,
    headSha: () => {
      throw new Error("simulated: no git history readable");
    },
  });
  assert.equal(code, 0);
  const written = readFileSync(out, "utf8");
  assert.match(written, /sourceSha: unknown/);
});
