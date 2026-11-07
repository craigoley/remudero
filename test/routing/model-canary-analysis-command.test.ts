import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, chmodSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildEffectiveConfigCensus, modelCanaryConfigId } from "#src/lib/model-canary-config-census.js";
import { planCanaryMatrix } from "#src/lib/model-canary-matrix-plan.js";
import { commonCanarySuite } from "#src/lib/model-canary-suite.js";
import { canaryCommand, nativeCanaryExecutionWithinObservationWindow } from "#src/lib/model-canary-command.js";

test("native analysis CLI refuses absent source data without provisioning owner config or output state", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-analysis-no-provision-`));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = join(root, "home");
    const ownerDir = join(root, "owner"), fieldDir = join(root, "field");
    mkdirSync(ownerDir, { mode: 0o700 }); mkdirSync(fieldDir, { mode: 0o700 });
    chmodSync(ownerDir, 0o700); chmodSync(fieldDir, 0o700);
    const inputFile = join(root, "analysis.json"), corpusFile = join(root, "corpus.json");
    const analysis = { version: "model-canary-analysis-input-v1", seed: "seed",
      censusInput: {}, matrixOptions: { day: "2026-11-05", seed: "matrix-seed", replicates: 1 },
      matrixDigest: "a".repeat(64),
      design: { comparisons: [{ id: "compare-a", endpoints: ["correctness"], estimands: ["first-attempt"] }],
        splits: ["development", "sealed-holdout"] },
      comparisons: [{ id: "compare-a", endpoint: "correctness", leftConfigId: "left", rightConfigId: "right" }],
      observationWindow: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" } };
    writeFileSync(inputFile, JSON.stringify(analysis), { mode: 0o600 }); writeFileSync(corpusFile, "{}", { mode: 0o600 });
    const outDir = join(root, "out");
    assert.throws(() => canaryCommand(["analyze-private", outDir, ownerDir, inputFile, fieldDir, corpusFile]),
      /native-config-not-found/);
    assert.equal(existsSync(join(ownerDir, "model-canary-slots.sqlite")), false);
    assert.equal(existsSync(join(process.env.HOME, ".config", "remudero", "config.json")), false);
    assert.equal(existsSync(outDir), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native field joins require the entire verified execution interval inside the requested window", () => {
  const window = { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" };
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-11-01T00:00:00.000Z", completedAt: "2026-11-07T23:59:59.999Z",
  }, window), true);
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-10-31T23:59:59.999Z", completedAt: "2026-11-01T00:00:00.001Z",
  }, window), false);
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-11-07T23:59:59.999Z", completedAt: "2026-11-08T00:00:00.000Z",
  }, window), false);
  assert.equal(nativeCanaryExecutionWithinObservationWindow(null, window), false);
});

const analysisDigest = (value: unknown): string => {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort()
      .map(key => [key, canonical((item as Record<string, unknown>)[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
};

test("native analysis CLI exports a repeated-failure evidence row from a real owner receipt", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-analysis-e2e-`)));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = join(root, "home");
    mkdirSync(join(root, "home", ".config", "remudero"), { recursive: true });
    writeFileSync(join(root, "home", ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }), { mode: 0o600 });
    const ownerDir = join(root, "owner"), fieldDir = join(root, "field");
    mkdirSync(ownerDir, { mode: 0o700 }); mkdirSync(fieldDir, { mode: 0o700 });
    chmodSync(ownerDir, 0o700); chmodSync(fieldDir, 0o700);

    const anchor = commonCanarySuite().find(value => value.id === "schema-deploy")!;
    const item = { ...anchor, id: "case-a", expected: { category: "deploy", ticket: 17, severity: "low" }, tools: "none" as const };
    const corpus = { version: "model-canary-private-bundle-v1", development: { version: "model-canary-private-payload-v1",
      split: "development", cases: [{ item, provenance: { sourceFamilyId: "family-a", incidentRootId: "root-a",
        sourceDigest: "c".repeat(64), observedAt: "2026-11-03T00:00:00.000Z", splitId: "dev-2026w45",
        split: "development", role: "worker" }, expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" }] } };
    const worker = { model: "claude-sonnet-4", effort: "high", maxTurns: 8, contextBudget: 16_384 };
    const configuration = { provider: "codex", deployment: "native-default", requestedModel: "claude-sonnet-4",
      model: "gpt-6.1-sol", effort: "high", route: "routes.implement.high.src", billing: "subscription",
      treatment: { scaffold: "empty-project-v1", tools: "native-tools-v1", context: "small-v1", cache: "first-use-v1" } } as const;
    const configId = modelCanaryConfigId(configuration);
    const evidence = (digit: string) => ({ configId, state: "eligible" as const, reasons: [] as string[],
      asOf: "2026-11-02T12:00:00.000Z", sourceDigest: digit.repeat(64), billing: "subscription" as const });
    const censusInput = { asOf: "2026-11-02T12:00:00.000Z",
      mounts: { tiers: { "claude-sonnet-4": 2 }, efforts: { high: 2 },
        capabilities: { ladder: { balanced: 1 }, claude: { "claude-sonnet-4": "balanced" },
          claudeCandidates: { balanced: ["claude-sonnet-4"] },
          codex: { balanced: { high: ["gpt-6.1-sol", "gpt-6-sol"], medium: ["gpt-6-medium-only"] } },
          cash: { balanced: { high: ["gpt-5-nano"] } } },
        architect: worker, judge: worker, synthesis: { retro: worker, triage: worker, inbox_draft: worker },
        routes: { implement: { high: { src: worker } } } },
      policy: { provenance: "default", committed: { enabledProviders: ["claude", "codex", "cash"], preference: "automatic",
        reservePercent: 5, parks: [], codexModelPreference: null }, enabledProviders: ["claude", "codex", "cash"],
        routableProviders: ["claude", "codex", "cash"], preference: "automatic", reservePercent: 5, parks: [] },
      sourceDigests: { "mounts-source": "d".repeat(64), "policy-source": "e".repeat(64) },
      cases: [item], treatments: [configuration.treatment],
      configurations: [{ configuration, sourceDigests: { "mounts.yaml": "a".repeat(64), "config-overrides": "b".repeat(64) } }],
      capabilityEvidence: [evidence("c")], accessEvidence: [evidence("d")],
      caseEvidence: [{ ...evidence("e"), caseId: item.id }] };
    const matrixOptions = { day: "2026-11-05", seed: "matrix-seed", replicates: 1 };
    const matrix = planCanaryMatrix({ census: buildEffectiveConfigCensus(censusInput as never), cases: [item], ...matrixOptions });
    const slot = matrix.shards[0]!.schedule.slots[0]!;
    const receipt = { slot, run: { id: "native-run-1", caseId: item.id, suiteHash: slot.pin.suiteHash,
      model: configuration.model, route: configuration.route, effort: configuration.effort, family: "structured",
      executionSource: "native-provider-execution", verified: false, totalDurationMs: 5, attempts: [{ id: "attempt-1" }],
      outcomeReason: "tool-use-failure" },
    executionWindow: { startedAt: "2026-11-04T00:00:00.000Z", completedAt: "2026-11-04T00:00:01.000Z" },
    grade: { passed: false, reason: "tool-use-failure", schemaValid: true }, state: "scored" };
    const ownerPath = join(ownerDir, "model-canary-slots.sqlite");
    closeSync(openSync(ownerPath, "wx", 0o600));
    const db = new DatabaseSync(ownerPath);
    db.exec(`CREATE TABLE canary_slots_v1 (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, owner TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('started','terminal')), receipt TEXT);
      CREATE UNIQUE INDEX canary_one_active_v1 ON canary_slots_v1((1)) WHERE phase='started';`);
    db.prepare("INSERT INTO canary_slots_v1(id,binding,owner,phase,receipt) VALUES(?,?,?,?,?)")
      .run(slot.id, "binding", "owner", "terminal", JSON.stringify(receipt));
    db.close();

    const analysis = { version: "model-canary-analysis-input-v1",
      seed: analysisDigest(["model-canary-analysis-seed-v1", matrix.digest, matrix.seed]),
      censusInput, matrixOptions, matrixDigest: matrix.digest,
      design: { comparisons: [{ id: "compare-a", endpoints: ["correctness"], estimands: ["first-attempt"] }],
        splits: ["development", "sealed-holdout"] },
      comparisons: [{ id: "compare-a", endpoint: "correctness", leftConfigId: configId, rightConfigId: configId }],
      observationWindow: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" } };
    const inputFile = join(root, "analysis.json"), corpusFile = join(root, "corpus.json"), outDir = join(root, "out");
    writeFileSync(inputFile, JSON.stringify(analysis), { mode: 0o600 });
    writeFileSync(corpusFile, JSON.stringify(corpus), { mode: 0o600 });

    const result = canaryCommand(["analyze-private", outDir, ownerDir, inputFile, fieldDir, corpusFile]);
    assert.equal(result.state, "analyzed-private");
    assert.equal(result.nativeReceipts, 1);
    assert.equal(result.benchmarkCases, 1);
    const written = JSON.parse(readFileSync(join(outDir, "model-canary-analysis.json"), "utf8"));
    assert.equal(written.counts.benchmarkCases, 1);
    assert.equal(written.proposals.proposals.length, result.proposals);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
