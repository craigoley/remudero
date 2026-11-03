import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { WorkerProviderId } from "#src/lib/config.js";
import type { Mount, Mounts } from "#src/lib/mounts.js";
import type { EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { clearProviderRoutingPolicyOverride, resolveProviderRoutingPolicy, writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import { buildEffectiveConfigCensus, modelCanaryConfigId, type ModelCanaryConfigCandidate,
  type ModelCanaryConfigEvidence, type ModelCanaryConfigOverrideEvidence, type ModelCanaryConfiguration } from "#src/lib/model-canary-config-census.js";
import type { CanaryCase } from "#src/lib/model-canary-suite.js";

const asOf = "2026-11-02T12:00:00.000Z";
const sha = (digit: string) => digit.repeat(64);
const treatment = { scaffold: "empty-project-v1", tools: "native-tools-v1", context: "small-v1", cache: "first-use-v1" };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const createCanonicalDigestForTest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))!).digest("hex");

function fixtureRoot(prefix: string): string {
  const hasGitMarkerAncestor = (candidate: string): boolean => {
    let current = realpathSync(candidate);
    while (true) {
      if (existsSync(join(current, ".git"))) return true;
      const next = dirname(current);
      if (next === current) return false;
      current = next;
    }
  };
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => !hasGitMarkerAncestor(candidate));
  assert.ok(parent, "the test host must provide a scratch parent outside every .git marker");
  return mkdtempSync(join(parent, prefix));
}

test("native matrix preparation emits private inert manifests through the real CLI", (t) => {
  const root = fixtureRoot("rmd-matrix-command-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configuration({ provider: "codex", model: "gpt-6.1-sol" });
  const configId = modelCanaryConfigId(config), item = sampleCase();
  const request = { version: "model-canary-matrix-input-v1", census: {
    asOf, mounts: mounts(), policy: policy(), sourceDigests: { mounts: sha("a"), policy: sha("b") },
    cases: [item], treatments: [treatment], configurations: [candidate(config)],
    capabilityEvidence: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
    accessEvidence: [evidence(configId, "eligible", sha("d"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("e")), caseId: item.id }],
  }, matrix: { day: "2026-11-02", seed: "fixture-only", replicates: 2 } };
  const input = join(root, "input.json"), outDir = join(root, "private-output");
  writeFileSync(input, JSON.stringify(request), { mode: 0o600 });
  const args = ["--import", "tsx", join(REPO_ROOT, "src/lib/model-canary-command.ts"),
    "prepare-matrix", outDir, input];
  const run = () => execFileSync(process.execPath, args,
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
  const result = JSON.parse(run());
  assert.equal(result.state, "prepared-not-activated");
  assert.equal(result.configurations, 1);
  assert.equal(result.shards, 2);
  const censusPath = join(outDir, "model-canary-configuration-census.json");
  const matrixPath = join(outDir, "model-canary-matrix-manifest.json");
  const censusBytes = readFileSync(censusPath, "utf8"), matrixBytes = readFileSync(matrixPath, "utf8");
  const manifest = JSON.parse(matrixBytes);
  assert.equal(manifest.state, "prepared-not-activated");
  assert.equal(manifest.denominator.slots.planned, 2);
  assert.ok(manifest.requires.includes("shared-owner"));
  assert.ok(manifest.requires.includes("agreed-experiment-budget"));
  assert.equal((censusBytes + matrixBytes).includes('"expected"'), false);
  assert.equal((censusBytes + matrixBytes).includes(item.prompt), false);
  assert.equal(statSync(outDir).mode & 0o777, 0o700);
  assert.equal(statSync(censusPath).mode & 0o777, 0o600);
  assert.equal(statSync(matrixPath).mode & 0o777, 0o600);
  assert.throws(run, /EEXIST/, "preparation never overwrites a prior private manifest");
  assert.equal(readFileSync(matrixPath, "utf8"), matrixBytes);
  const publicDir = join(root, "public-output");
  mkdirSync(publicDir, { mode: 0o700 });
  chmodSync(publicDir, 0o755);
  const runTo = (dir: string) => execFileSync(process.execPath, [...args.slice(0, -2), dir, input],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
  assert.throws(() => runTo(publicDir), /canary-output-private-owned-directory-required/);
  assert.equal(existsSync(join(publicDir, "model-canary-configuration-census.json")), false);
  const linkedDir = join(root, "linked-output"), target = join(root, "link-target");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, linkedDir, "dir");
  assert.throws(() => runTo(linkedDir), /canary-output-private-owned-directory-required/);
  assert.equal(existsSync(join(target, "model-canary-configuration-census.json")), false);
  const markedDir = join(root, "marked-output");
  mkdirSync(markedDir, { mode: 0o700 });
  mkdirSync(join(markedDir, ".git"));
  assert.throws(() => runTo(markedDir), /canary-output-inside-git/);
  assert.equal(existsSync(join(markedDir, "model-canary-configuration-census.json")), false);
});

function mount(): Mount {
  return { model: "claude-sonnet-4", effort: "high", maxTurns: 8, contextBudget: 16_384 };
}

function mounts(): Mounts {
  const worker = mount();
  return { tiers: { "claude-sonnet-4": 2 }, efforts: { high: 2 },
    capabilities: { ladder: { balanced: 1 }, claude: { "claude-sonnet-4": "balanced" },
      claudeCandidates: { balanced: ["claude-sonnet-4"] },
      codex: { balanced: { high: ["gpt-6.1-sol", "gpt-6-sol"], medium: ["gpt-6-medium-only"] } },
      cash: { balanced: { high: ["gpt-5-nano"] } } },
    architect: worker, judge: worker,
    synthesis: { retro: worker, triage: worker, inbox_draft: worker },
    routes: { implement: { high: { src: worker } } } };
}

function policy(enabledProviders: WorkerProviderId[] = ["claude", "codex", "cash"]): EffectiveProviderRoutingPolicy {
  return { provenance: "default", committed: { enabledProviders, preference: "automatic",
    reservePercent: 5, parks: [], codexModelPreference: null }, enabledProviders,
    routableProviders: [...enabledProviders], preference: "automatic", reservePercent: 5, parks: [] };
}

function configuration(overrides: Partial<ModelCanaryConfiguration> = {}): ModelCanaryConfiguration {
  return { provider: "claude", deployment: "native-default", requestedModel: "claude-sonnet-4",
    model: "claude-sonnet-4", effort: "high", route: "routes.implement.high.src", billing: "subscription",
    treatment: { ...treatment }, ...overrides };
}

function candidate(value: ModelCanaryConfiguration): ModelCanaryConfigCandidate {
  return { configuration: value, sourceDigests: { "mounts.yaml": sha("a"), "config-overrides": sha("b") } };
}

function evidence(configId: string, state: ModelCanaryConfigEvidence["state"], sourceDigest = sha("c"),
  evidenceAsOf = asOf, billing?: "api" | "subscription"):
  ModelCanaryConfigEvidence {
  return { configId, state, reasons: state === "eligible" ? [] : [`${state}-evidence`], asOf: evidenceAsOf,
    sourceDigest, ...(billing === undefined ? {} : { billing }) };
}

function sampleCase(id = "coding-small"): CanaryCase {
  return { id, family: "schema", prompt: "Return only JSON.", expected: { ok: true }, tools: "none", cadence: "daily" };
}

function census(configs: readonly ModelCanaryConfiguration[], options: {
  capabilities?: readonly ModelCanaryConfigEvidence[];
  access?: readonly ModelCanaryConfigEvidence[];
  caseEvidence?: readonly (ModelCanaryConfigEvidence & { caseId: string })[];
  cases?: readonly CanaryCase[];
  policy?: EffectiveProviderRoutingPolicy;
  maxEvidenceAgeMs?: number;
  overrides?: readonly ModelCanaryConfigOverrideEvidence[];
} = {}) {
  return buildEffectiveConfigCensus({ asOf, mounts: mounts(), policy: options.policy ?? policy(),
    ...(options.maxEvidenceAgeMs === undefined ? {} : { maxEvidenceAgeMs: options.maxEvidenceAgeMs }),
    sourceDigests: { "mounts-source": sha("d"), "policy-source": sha("e") },
    cases: options.cases ?? [sampleCase()], treatments: [treatment], configurations: configs.map(candidate),
    capabilityEvidence: options.capabilities ?? [], accessEvidence: options.access ?? [],
    configurationOverrideEvidence: options.overrides ?? [],
    caseEvidence: options.caseEvidence ?? [] });
}

test("configuration census preserves provider model effort and treatment identity", () => {
  const config = configuration({ provider: "codex", model: "gpt-6.1-sol", billing: "subscription",
    treatment: { scaffold: "repo-fixture-v3", tools: "read-only-v2", context: "medium-v1", cache: "repeat-v1" } });
  const configId = modelCanaryConfigId(config);
  const result = census([config], { capabilities: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
    access: [evidence(configId, "eligible", sha("f"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" }] });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.configId, configId);
  assert.deepEqual(result.rows[0]!.configuration, config);
  assert.equal(result.rows[0]!.pin.model, "gpt-6.1-sol");
  assert.equal(result.rows[0]!.pin.effort, "high");
  assert.equal(result.rows[0]!.pin.billing, "subscription");
  assert.deepEqual(result.rows[0]!.eligibility, { state: "eligible", reasons: [] });
  assert.deepEqual(result.rows[0]!.caseEligibility, [{ caseId: "coding-small", state: "eligible", reasons: [] }]);
  assert.equal(result.caseSet.caseIds[0], "coding-small");
  assert.equal("expected" in result.caseSet, false);
});

test("configuration census rejects non JSON scorer values before hashing", () => {
  const overflow = JSON.parse("1e309") as number;
  const withExpected = (expected: Record<string, unknown>): CanaryCase => ({ ...sampleCase(), expected });
  const rejects = (expected: Record<string, unknown>) => assert.throws(() => census([], { cases: [withExpected(expected)] }),
    /canary-config-census-expected-json-invalid/);
  rejects({ score: overflow });
  rejects({ score: undefined });
  rejects({ score: () => 1 });
  rejects({ score: Symbol("score") });
  rejects({ score: 1n });
  rejects({ score: new Date(0) });
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects({ score: sparse });
  const customArray: unknown[] & { extra?: string } = [];
  customArray.extra = "ignored by JSON.stringify";
  rejects({ score: customArray });
  let arrayGetterCalls = 0;
  const accessorArray: unknown[] = [];
  accessorArray.length = 1;
  Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => { arrayGetterCalls++; return 1; } });
  rejects({ score: accessorArray });
  assert.equal(arrayGetterCalls, 0);
  const accessorRecord: Record<string, unknown> = {};
  Object.defineProperty(accessorRecord, "score", { enumerable: true, get: () => { arrayGetterCalls++; return 1; } });
  rejects(accessorRecord);
  assert.equal(arrayGetterCalls, 0);
  const symbolRecord = { score: 1, [Symbol("hidden")]: 2 };
  rejects(symbolRecord);
  const nonEnumerableRecord: Record<string, unknown> = {};
  Object.defineProperty(nonEnumerableRecord, "score", { enumerable: false, value: 1 });
  rejects(nonEnumerableRecord);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejects(cycle);
  let tooDeep: unknown = null;
  for (let depth = 0; depth < 65; depth++) tooDeep = { nested: tooDeep };
  rejects({ score: tooDeep });

  const shared = { score: 2.5 };
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { ok: true });
  const frozen = Object.freeze({ value: "stable" });
  const valid = census([], { cases: [withExpected({ nested: [{ score: shared }, null], again: shared,
    absent: null, passed: true, nullPrototype, frozen })] });
  assert.equal(valid.caseSet.caseIds[0], "coding-small");

  const jsonText = "quote:\" slash:\\ controls:\0\b\t\n\f\r BMP:\u00e9 non-BMP:\u{1f600} high:\ud800 low:\udc00";
  const validText = census([], { cases: [withExpected({ text: jsonText })] });
  assert.equal(validText.caseSet.caseIds[0], "coding-small");

  const largeExpected = "x".repeat(1_100_000);
  const largeCases = ["large-a", "large-b"].map(id => ({ ...withExpected({ text: largeExpected }), id }));
  assert.throws(() => census([], { cases: largeCases }), /canary-config-census-case-set-byte-bound/);

  const oversizedUtf8String = "é".repeat(1_048_577);
  assert.ok(Buffer.byteLength(oversizedUtf8String, "utf8") > 2 * 1024 * 1024);
  assert.throws(() => census([], { cases: [withExpected({ text: oversizedUtf8String })] }),
    /canary-config-census-case-set-byte-bound/);

  // A work sentinel makes removing the byte guard fail without exhausting the test host.
  let leafVisits = 0;
  let expanded: unknown = new Proxy({ leaf: true }, {
    ownKeys(target) {
      if (++leafVisits > 300_000) throw new Error("scorer-json-work-unbounded");
      return Reflect.ownKeys(target);
    },
  });
  for (let depth = 0; depth < 60; depth++) expanded = { a: expanded, b: expanded };
  assert.throws(() => census([], { cases: [withExpected({ expanded })] }), /canary-config-census-case-set-byte-bound/);
  assert.ok(leafVisits > 0 && leafVisits <= 300_000);
});

test("configuration census canonicalizes the deprecated provider alias without losing mounted coverage", () => {
  const config = configuration({ provider: "openweight", model: "gpt-5-nano", deployment: "gpt-5-nano", billing: "api" });
  const configId = modelCanaryConfigId(config);
  const localMounts = mounts();
  localMounts.routes.implement.high.src.provider = "openweight";
  const result = buildEffectiveConfigCensus({ asOf, mounts: localMounts, policy: policy(),
    sourceDigests: { mounts: sha("d"), policy: sha("e") }, cases: [sampleCase()], treatments: [treatment],
    configurations: [candidate(config)], capabilityEvidence: [evidence(configId, "eligible", sha("c"), asOf, "api")],
    accessEvidence: [evidence(configId, "eligible", sha("f"), asOf, "api")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(result.rows[0]!.configuration.provider, "cash");
  assert.equal(result.rows[0]!.eligibility.state, "eligible");
  assert.equal(result.declarationCoverage.complete, true);
  assert.deepEqual(result.declarations.filter(row => row.scope === "mounted-route").map(row => row.provider), ["cash"]);
  assert.equal(result.declarations.some(row => row.provider === "openweight"), false);
});

test("configuration census retains pins outside native owner bounds as unknown", () => {
  const config = configuration({ effort: "x".repeat(33) }), configId = modelCanaryConfigId(config);
  const localMounts = mounts();
  localMounts.routes.implement.high.src.effort = config.effort!;
  const result = buildEffectiveConfigCensus({ asOf, mounts: localMounts, policy: policy(),
    sourceDigests: { mounts: sha("a") }, cases: [sampleCase()], treatments: [treatment],
    configurations: [candidate(config)],
    capabilityEvidence: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
    accessEvidence: [evidence(configId, "eligible", sha("d"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("e")), caseId: "coding-small" }] });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.eligibility.state, "unknown");
  assert.ok(result.rows[0]!.eligibility.reasons.includes("native-owner-pin-binding-bound"));
  assert.throws(() => census([config], { cases: [sampleCase("x".repeat(129))] }),
    /canary-config-census-case-identity-invalid/);
});

test("configuration census counts concrete provider candidates instead of ranked model aliases", () => {
  const localMounts = mounts();
  localMounts.tiers = { "gpt-5.6-terra": 3, sonnet: 2 };
  localMounts.routes.implement.high.src.model = "sonnet";
  localMounts.capabilities!.claude = { sonnet: "balanced", "gpt-5.6-terra": "balanced" };
  localMounts.capabilities!.claudeCandidates = { balanced: ["claude-sonnet-5-5", "claude-sonnet-5"] };
  localMounts.capabilities!.codex = { balanced: { high: ["gpt-6.1-sol", "gpt-6-sol"] } };
  localMounts.capabilities!.cash = { balanced: { high: ["gpt-5.6-terra", "gpt-5.6-luna"] } };
  const configs: ModelCanaryConfiguration[] = [
    ...["claude-sonnet-5-5", "claude-sonnet-5"].map(model => configuration({ provider: "claude",
      requestedModel: "sonnet", model, deployment: "native-default", effort: "high", billing: "subscription" })),
    ...["gpt-6.1-sol", "gpt-6-sol"].map(model => configuration({ provider: "codex",
      requestedModel: "sonnet", model, deployment: "native-default", effort: "high", billing: "subscription" })),
    ...["gpt-5.6-terra", "gpt-5.6-luna"].map(model => configuration({ provider: "cash",
      requestedModel: "sonnet", model, deployment: model, effort: "high", billing: "api" })),
  ];
  const ids = configs.map(modelCanaryConfigId);
  const result = buildEffectiveConfigCensus({ asOf, mounts: localMounts, policy: policy(),
    sourceDigests: { mounts: sha("d"), policy: sha("e") }, cases: [sampleCase()], treatments: [treatment],
    configurations: configs.map(candidate),
    capabilityEvidence: configs.map((config, index) => evidence(ids[index]!, "eligible", sha(String(index + 1)), asOf,
      config.provider === "cash" ? "api" : "subscription")),
    accessEvidence: configs.map((config, index) => evidence(ids[index]!, "eligible", sha(String(index + 2)), asOf,
      config.provider === "cash" ? "api" : "subscription")),
    caseEvidence: configs.map((config, index) => ({ ...evidence(ids[index]!, "eligible", sha(String(index + 3)), asOf),
      caseId: "coding-small" })) });
  assert.equal(result.declarationCoverage.complete, true);
  assert.equal(result.declarationCoverage.declared, 6);
  assert.equal(result.tableCoverage.complete, true);
  assert.equal(result.tableCoverage.declared, 6);
  assert.equal(result.tableCoverage.projected, 6);
  assert.deepEqual(result.declarations.filter(row => row.scope === "mounted-route").map(row => row.model).sort(),
    ["claude-sonnet-5", "claude-sonnet-5-5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-sol", "gpt-6.1-sol"].sort());
  assert.equal(result.declarations.some(row => row.scope === "mounted-route"
    && row.provider === "claude" && ["sonnet", "gpt-5.6-terra"].includes(row.model ?? "")), false);
  assert.equal(result.declarations.some(row => row.scope === "capability-table"
    && row.provider === "claude" && ["sonnet", "gpt-5.6-terra"].includes(row.model ?? "")), false);
});

test("configuration census respects Claude concrete pin fallback bounds and marks legacy routes unknown", () => {
  const pinnedMounts = mounts();
  pinnedMounts.tiers = { "claude-sonnet-5-5": 2, "claude-sonnet-5": 2 };
  pinnedMounts.routes.implement.high.src = { ...mount(), model: "claude-sonnet-5", provider: "claude" };
  pinnedMounts.capabilities!.claude = { "claude-sonnet-5-5": "balanced", "claude-sonnet-5": "balanced" };
  pinnedMounts.capabilities!.claudeCandidates = { balanced: ["claude-sonnet-5-5", "claude-sonnet-5"] };
  const pinned = configuration({ provider: "claude", requestedModel: "claude-sonnet-5", model: "claude-sonnet-5",
    deployment: "native-default", billing: "subscription" });
  const pinnedId = modelCanaryConfigId(pinned);
  const pinnedCensus = buildEffectiveConfigCensus({ asOf, mounts: pinnedMounts, policy: policy(),
    sourceDigests: { mounts: sha("c"), policy: sha("d") }, cases: [sampleCase()], treatments: [treatment],
    configurations: [candidate(pinned)], capabilityEvidence: [evidence(pinnedId, "eligible", sha("c"), asOf, "subscription")],
    accessEvidence: [evidence(pinnedId, "eligible", sha("f"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(pinnedId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(pinnedCensus.declarations.some(row => row.scope === "mounted-route" && row.model === "claude-sonnet-5-5"), false);
  assert.equal(pinnedCensus.declarations.some(row => row.scope === "capability-table" && row.model === "claude-sonnet-5-5"), true);

  const legacyMounts = mounts();
  delete legacyMounts.capabilities;
  legacyMounts.routes.implement.high.src = { ...mount(), model: "sonnet", provider: "claude" };
  const legacy = buildEffectiveConfigCensus({ asOf, mounts: legacyMounts, policy: policy(),
    sourceDigests: { mounts: sha("a"), policy: sha("b") }, cases: [sampleCase()], treatments: [treatment],
    configurations: [], capabilityEvidence: [], accessEvidence: [], caseEvidence: [] });
  const legacyRoute = legacy.declarations.find(row => row.scope === "mounted-route");
  assert.ok(legacyRoute);
  assert.equal(legacyRoute.model, null);
  assert.equal(legacyRoute.state, "unknown");
  assert.equal(legacyRoute.projection, "missing");
  assert.ok(legacyRoute.reasons.includes("concrete-model-unknown"));
  assert.equal(legacy.declarationCoverage.complete, false);
});

test("configuration census retains excluded rows and unknown eligibility", () => {
  const excluded = configuration({ provider: "codex", model: "gpt-5-codex" });
  const unknown = configuration({ provider: "claude", effort: null, deployment: null, billing: null,
    treatment: { scaffold: null, tools: "native-tools-v1", context: "small-v1", cache: "first-use-v1" } });
  const excludedId = modelCanaryConfigId(excluded), unknownId = modelCanaryConfigId(unknown);
  const result = census([excluded, unknown], {
    capabilities: [evidence(excludedId, "excluded")], access: [evidence(excludedId, "eligible", sha("f"))],
    caseEvidence: [{ ...evidence(excludedId, "eligible", sha("1")), caseId: "coding-small" }],
  });

  assert.equal(result.rows.length, 2);
  const excludedRow = result.rows.find((row) => row.configId === excludedId)!;
  const unknownRow = result.rows.find((row) => row.configId === unknownId)!;
  assert.equal(excludedRow.eligibility.state, "excluded");
  assert.equal(excludedRow.caseEligibility[0]!.state, "excluded");
  assert.equal(unknownRow.eligibility.state, "unknown");
  assert.equal(unknownRow.pin.effort, null);
  assert.equal(unknownRow.pin.billing, null);
  assert.ok(unknownRow.eligibility.reasons.includes("effort-unknown"));
  assert.ok(unknownRow.eligibility.reasons.includes("case-eligibility-evidence-unavailable"));
});

test("configuration census retains omitted router model declarations as unknown", () => {
  const result = census([]);
  const omittedSol = result.declarations.find((row) => row.provider === "codex" && row.model === "gpt-6.1-sol");

  assert.ok(omittedSol);
  assert.equal(omittedSol.projection, "missing");
  assert.equal(omittedSol.state, "unknown");
  assert.ok(omittedSol.reasons.includes("configuration-projection-missing"));
  assert.equal(result.declarationCoverage.complete, false);
  assert.ok(result.declarationCoverage.missing > 0);

  const disabledProvider = census([], { policy: policy(["claude", "cash"]) });
  const mediumOnly = disabledProvider.declarations.find((row) => row.provider === "codex" && row.model === "gpt-6-medium-only");
  assert.ok(mediumOnly);
  assert.equal(mediumOnly.effort, "medium");
  assert.equal(mediumOnly.route, null);
  assert.equal(mediumOnly.projection, "unmapped");
  assert.equal(mediumOnly.state, "excluded");
  assert.ok(disabledProvider.tableCoverage.unmapped > 0);
  assert.equal(disabledProvider.tableCoverage.complete, false);
});

test("configuration census keeps Claude API billing and rejects stale or future evidence", () => {
  const apiConfig = configuration({ provider: "claude", billing: "api" });
  const apiId = modelCanaryConfigId(apiConfig);
  const api = census([apiConfig], { capabilities: [evidence(apiId, "eligible", sha("c"), asOf, "api")],
    access: [evidence(apiId, "eligible", sha("f"), asOf, "api")],
    caseEvidence: [{ ...evidence(apiId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(api.rows[0]!.eligibility.state, "eligible");
  assert.equal(api.maxEvidenceAgeMs, 0);

  const stale = census([apiConfig], { maxEvidenceAgeMs: 1_000,
    capabilities: [evidence(apiId, "eligible", sha("2"), "2026-11-02T11:59:58.000Z", "api")],
    access: [evidence(apiId, "eligible", sha("f"), asOf, "api")],
    caseEvidence: [{ ...evidence(apiId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(stale.rows[0]!.eligibility.state, "unknown");
  assert.ok(stale.rows[0]!.eligibility.reasons.includes("evidence-stale"));
  assert.equal(stale.rows[0]!.evidence.capability?.asOf, "2026-11-02T11:59:58.000Z");

  const future = census([apiConfig], { capabilities: [evidence(apiId, "eligible", sha("3"), "2026-11-02T12:00:01.000Z", "api")],
    access: [evidence(apiId, "eligible", sha("f"), asOf, "api")],
    caseEvidence: [{ ...evidence(apiId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(future.rows[0]!.eligibility.state, "unknown");
  assert.ok(future.rows[0]!.eligibility.reasons.includes("evidence-from-future"));
});

test("configuration census rejects only current billing contradictions at their evidence scope", () => {
  const cashConfig = configuration({ provider: "cash", deployment: "gpt-5-nano", model: "gpt-5-nano", billing: "api" });
  const cashId = modelCanaryConfigId(cashConfig);
  const cases = [sampleCase("coding-small"), sampleCase("coding-large")];
  const current = (digit: string, billing?: "api" | "subscription") => evidence(cashId, "eligible", sha(digit), asOf, billing);
  const caseEvidence = (smallBilling?: "api" | "subscription", largeBilling?: "api" | "subscription") => [
    { ...current("1", smallBilling), caseId: "coding-small" },
    { ...current("2", largeBilling), caseId: "coding-large" },
  ];
  const build = (options: {
    capabilities?: ModelCanaryConfigEvidence[];
    access?: ModelCanaryConfigEvidence[];
    overrides?: ModelCanaryConfigOverrideEvidence[];
    caseEvidence?: Array<ModelCanaryConfigEvidence & { caseId: string }>;
    maxEvidenceAgeMs?: number;
  } = {}) => census([cashConfig], { cases,
    ...(options.maxEvidenceAgeMs === undefined ? {} : { maxEvidenceAgeMs: options.maxEvidenceAgeMs }),
    capabilities: options.capabilities ?? [current("3")], access: options.access ?? [current("4")],
    overrides: options.overrides,
    caseEvidence: options.caseEvidence ?? caseEvidence() });

  const explicitApiEvidence = build({ capabilities: [current("a", "api")], access: [current("b", "api")],
    caseEvidence: caseEvidence("api", "api") });
  assert.equal(explicitApiEvidence.rows[0]!.eligibility.state, "eligible",
    "explicit matching API evidence remains eligible");
  const noBillingEvidence = build();
  assert.equal(noBillingEvidence.rows[0]!.eligibility.state, "eligible",
    "cash remains intrinsically API billed when optional billing evidence is absent");

  for (const kind of ["capability", "access"] as const) {
    const result = build({ [kind === "capability" ? "capabilities" : "access"]: [current("5", "subscription")] });
    assert.equal(result.rows[0]!.eligibility.state, "excluded", `${kind} billing contradiction excludes cash/API`);
    assert.ok(result.rows[0]!.eligibility.reasons.includes("billing-evidence-conflicts-with-configuration"));
  }

  const override: ModelCanaryConfigOverrideEvidence = { ...current("6", "subscription"),
    sourcePath: "workerProviders.cashModel", changes: [{ field: "model", from: "claude-sonnet-4", to: "gpt-5-nano" }] };
  const overrideConflict = build({ overrides: [override] });
  assert.equal(overrideConflict.rows[0]!.eligibility.state, "excluded");
  assert.ok(overrideConflict.rows[0]!.eligibility.reasons.includes("billing-evidence-conflicts-with-configuration"));

  const caseConflict = build({ caseEvidence: caseEvidence("subscription", "api") });
  const caseStates = Object.fromEntries(caseConflict.rows[0]!.caseEligibility.map(row => [row.caseId, row]));
  assert.equal(caseStates["coding-small"]!.state, "excluded");
  assert.ok(caseStates["coding-small"]!.reasons.includes("case-billing-evidence-conflicts-with-configuration"));
  assert.equal(caseStates["coding-large"]!.state, "eligible", "one case billing conflict does not exclude a sibling case");
  assert.equal(caseConflict.rows[0]!.eligibility.state, "eligible");

  for (const evidenceAsOf of ["2026-11-02T11:59:58.000Z", "2026-11-02T12:00:01.000Z"]) {
    const staleOrFutureCapability = build({ maxEvidenceAgeMs: 1_000,
      capabilities: [evidence(cashId, "eligible", sha("7"), evidenceAsOf, "subscription")] });
    assert.equal(staleOrFutureCapability.rows[0]!.eligibility.state, "unknown");
    assert.equal(staleOrFutureCapability.rows[0]!.eligibility.reasons.includes("billing-evidence-conflicts-with-configuration"), false);
  }
  const staleOverride = build({ maxEvidenceAgeMs: 1_000, overrides: [{ ...override,
    asOf: "2026-11-02T11:59:58.000Z" }] });
  assert.equal(staleOverride.rows[0]!.eligibility.state, "unknown");
  assert.equal(staleOverride.rows[0]!.eligibility.reasons.includes("billing-evidence-conflicts-with-configuration"), false);
  const futureCase = build({ caseEvidence: [
    { ...evidence(cashId, "eligible", sha("8"), "2026-11-02T12:00:01.000Z", "subscription"), caseId: "coding-small" },
    { ...current("9", "api"), caseId: "coding-large" },
  ] });
  const futureCaseStates = Object.fromEntries(futureCase.rows[0]!.caseEligibility.map(row => [row.caseId, row]));
  assert.equal(futureCaseStates["coding-small"]!.state, "unknown");
  assert.equal(futureCaseStates["coding-small"]!.reasons.includes("case-billing-evidence-conflicts-with-configuration"), false);
  assert.equal(futureCaseStates["coding-large"]!.state, "eligible");
});

test("configuration census requires an overridden routing policy snapshot active at its as-of boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-policy-census-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bothProviders = { workerProviders: { enabled: ["claude", "codex"], reservePercent: 5 } } as never;
  const claudeOnly = { workerProviders: { enabled: ["claude"], reservePercent: 5 } } as never;
  const config = configuration({ provider: "codex", model: "gpt-6.1-sol", billing: "subscription" });
  const configId = modelCanaryConfigId(config);
  const policyInput = { enabledProviders: ["claude", "codex"] as WorkerProviderId[], preference: "codex" as const,
    reservePercent: 5, parks: [], codexModelPreference: null, expiresAt: "2026-11-02T12:30:00.000Z" };
  writeProviderRoutingPolicyOverride(root, policyInput, { config: bothProviders,
    writerFingerprint: "0123456789ab", now: () => Date.parse(asOf) });
  const atWrittenAtBoundary = resolveProviderRoutingPolicy(root, bothProviders, { now: () => Date.parse(asOf) });
  assert.equal(atWrittenAtBoundary.provenance, "overridden");
  const current = census([config], { policy: atWrittenAtBoundary,
    capabilities: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
    access: [evidence(configId, "eligible", sha("f"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" }] });
  assert.equal(current.rows[0]!.eligibility.state, "eligible");
  const invalidSnapshots: EffectiveProviderRoutingPolicy[] = [
    { ...atWrittenAtBoundary, committed: policy(["claude"]).committed },
    { ...atWrittenAtBoundary, routableProviders: ["codex"] },
    { ...atWrittenAtBoundary, reservePercent: 51 },
    { ...atWrittenAtBoundary, parks: [{ provider: "codex", until: "2026-11-02T12:15:00.000Z" }] },
    { ...atWrittenAtBoundary, enabledProviders: ["claude"], routableProviders: ["claude"] },
    { ...atWrittenAtBoundary, overrideExpiresAt: "2026-11-04T12:00:00.000Z" },
  ];
  for (const snapshot of invalidSnapshots) {
    const result = census([config], { policy: snapshot,
      capabilities: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
      access: [evidence(configId, "eligible", sha("f"), asOf, "subscription")],
      caseEvidence: [{ ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" }] });
    assert.notEqual(result.rows[0]!.eligibility.state, "eligible");
    assert.ok(result.rows[0]!.eligibility.reasons.includes("effective-routing-policy-override-snapshot-inconsistent"));
  }

  clearProviderRoutingPolicyOverride(root);
  writeProviderRoutingPolicyOverride(root, { ...policyInput, expiresAt: "2026-11-02T11:30:00.000Z" },
    { config: bothProviders, writerFingerprint: "0123456789ab", now: () => Date.parse("2026-11-02T11:00:00.000Z") });
  const oldSnapshot = resolveProviderRoutingPolicy(root, bothProviders, { now: () => Date.parse("2026-11-02T11:00:00.000Z") });
  assert.equal(oldSnapshot.provenance, "overridden");
  const currentResolver = resolveProviderRoutingPolicy(root, claudeOnly, { now: () => Date.parse(asOf) });
  assert.equal(currentResolver.provenance, "default");
  assert.equal(currentResolver.routableProviders.includes("codex"), false);
  const stale = census([config], { policy: oldSnapshot,
    capabilities: [evidence(configId, "eligible", sha("2"), asOf, "subscription")],
    access: [evidence(configId, "eligible", sha("3"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("4")), caseId: "coding-small" }] });
  assert.equal(stale.rows[0]!.eligibility.state, "unknown");
  assert.ok(stale.rows[0]!.eligibility.reasons.includes("effective-routing-policy-override-expired-at-census-as-of"));

  const expiredDefault = resolveProviderRoutingPolicy(root, bothProviders, { now: () => Date.parse(asOf) });
  assert.equal(expiredDefault.provenance, "default");
  assert.equal(expiredDefault.fallback?.reason, "expired");
  const normalExpired = census([config], { policy: expiredDefault,
    capabilities: [evidence(configId, "eligible", sha("5"), asOf, "subscription")],
    access: [evidence(configId, "eligible", sha("6"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("7")), caseId: "coding-small" }] });
  assert.equal(normalExpired.rows[0]!.eligibility.state, "eligible");
  assert.ok(normalExpired.rows[0]!.eligibility.reasons.includes("effective-routing-policy-fallback-expired"));
  assert.equal(normalExpired.rows[0]!.eligibility.reasons.includes("effective-routing-policy-override-timestamps-invalid"), false);
  const inconsistentDefault = census([config], { policy: { ...expiredDefault, preference: "codex" },
    capabilities: [evidence(configId, "eligible", sha("8"), asOf, "subscription")],
    access: [evidence(configId, "eligible", sha("9"), asOf, "subscription")],
    caseEvidence: [{ ...evidence(configId, "eligible", sha("a")), caseId: "coding-small" }] });
  assert.equal(inconsistentDefault.rows[0]!.eligibility.state, "unknown");
  assert.ok(inconsistentDefault.rows[0]!.eligibility.reasons.includes("effective-routing-policy-default-snapshot-inconsistent"));
  for (const committed of [
    { ...expiredDefault.committed, reservePercent: 51 },
    { ...expiredDefault.committed, enabledProviders: ["claude", "codex", "codex"] as WorkerProviderId[] },
  ]) {
    const invalid = census([config], { policy: { ...expiredDefault, committed },
      capabilities: [evidence(configId, "eligible", sha("8"), asOf, "subscription")],
      access: [evidence(configId, "eligible", sha("9"), asOf, "subscription")],
      caseEvidence: [{ ...evidence(configId, "eligible", sha("a")), caseId: "coding-small" }] });
    assert.equal(invalid.rows[0]!.eligibility.state, "unknown");
    assert.ok(invalid.rows[0]!.eligibility.reasons.includes("effective-routing-policy-snapshot-shape-invalid"));
  }
});

test("configuration census requires explicit current evidence for model and effort overrides", () => {
  const config = configuration({ provider: "codex", deployment: "native-default", model: "gpt-6.1-sol",
    effort: "medium" });
  const configId = modelCanaryConfigId(config);
  const capability = evidence(configId, "eligible", sha("c"), asOf, "subscription");
  const access = evidence(configId, "eligible", sha("f"), asOf, "subscription");
  const caseRow = { ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" };
  const withoutOverride = census([config], { capabilities: [capability], access: [access], caseEvidence: [caseRow] });
  assert.equal(withoutOverride.rows[0]!.eligibility.state, "unknown");
  assert.ok(withoutOverride.rows[0]!.eligibility.reasons.includes("model-override-evidence-unavailable"));
  assert.ok(withoutOverride.rows[0]!.eligibility.reasons.includes("effort-override-evidence-unavailable"));

  const override: ModelCanaryConfigOverrideEvidence = { ...evidence(configId, "eligible", sha("2")),
    sourcePath: "workerProviders.codexModel",
    changes: [{ field: "model", from: "claude-sonnet-4", to: "gpt-6.1-sol" },
      { field: "effort", from: "high", to: "medium" }] };
  const withOverride = census([config], { capabilities: [capability], access: [access],
    overrides: [override], caseEvidence: [caseRow] });
  assert.equal(withOverride.rows[0]!.eligibility.state, "eligible");
  assert.equal(withOverride.declarations.find(row => row.projection === "override")!.scope, "configuration-override");
  assert.equal(withOverride.declarationCoverage.declared,
    withOverride.declarations.filter(row => row.scope === "mounted-route").length);

  const staleOverride = census([config], { capabilities: [capability], access: [access],
    overrides: [{ ...override, asOf: "2026-11-02T11:59:59.000Z" }], caseEvidence: [caseRow] });
  assert.equal(staleOverride.rows[0]!.eligibility.state, "unknown");
  assert.ok(staleOverride.rows[0]!.eligibility.reasons.includes("model-override-evidence-not-current-or-eligible"));
  assert.ok(staleOverride.rows[0]!.eligibility.reasons.includes("effort-override-evidence-not-current-or-eligible"));

  const ineligibleOverride = census([config], { capabilities: [capability], access: [access],
    overrides: [{ ...override, state: "unknown", reasons: ["override-not-qualified"] }], caseEvidence: [caseRow] });
  assert.equal(ineligibleOverride.rows[0]!.eligibility.state, "unknown");
  assert.ok(ineligibleOverride.rows[0]!.eligibility.reasons.includes("model-override-evidence-not-current-or-eligible"));
  assert.ok(ineligibleOverride.rows[0]!.eligibility.reasons.includes("effort-override-evidence-not-current-or-eligible"));
  assert.throws(() => census([config], { capabilities: [capability], access: [access],
    overrides: [{ ...override, apiKey: "secret-test-value" } as ModelCanaryConfigOverrideEvidence] }), /override-evidence-invalid/);
});

test("configuration census rejects credential fields and uses locale-independent code-unit ordering", () => {
  const config = configuration({ provider: "codex", model: "gpt-6.1-sol" });
  const configId = modelCanaryConfigId(config);
  assert.throws(() => census([config], { capabilities: [
    { ...evidence(configId, "eligible"), token: "secret-test-value" } as ModelCanaryConfigEvidence,
  ] }), /capability-evidence-invalid/);
  const astral = sampleCase("\u{10000}"), privateUse = sampleCase("\uE000");
  const ordered = census([], { cases: [privateUse, astral] });
  assert.deepEqual(ordered.caseSet.caseIds, ["\u{10000}", "\uE000"]);
});

test("configuration census source digest binds parsed mounts and the effective policy", () => {
  const config = configuration({ provider: "codex", model: "gpt-6.1-sol" });
  const configId = modelCanaryConfigId(config);
  const sourceDigests = { "mounts-source": sha("d"), "policy-source": sha("e") };
  const baseMounts = mounts();
  const basePolicy: EffectiveProviderRoutingPolicy = { ...policy(), provenance: "overridden",
    writtenAt: asOf, overrideExpiresAt: "2026-11-02T12:30:00.000Z" };
  const build = (mountValues: Mounts, routing: EffectiveProviderRoutingPolicy, digests: Record<string, string> = sourceDigests) =>
    buildEffectiveConfigCensus({ asOf, mounts: mountValues, policy: routing, sourceDigests: digests,
      cases: [sampleCase()], treatments: [treatment], configurations: [candidate(config)],
      capabilityEvidence: [evidence(configId, "eligible", sha("c"), asOf, "subscription")],
      accessEvidence: [evidence(configId, "eligible", sha("f"), asOf, "subscription")],
      caseEvidence: [{ ...evidence(configId, "eligible", sha("1")), caseId: "coding-small" }] });
  const baseline = build(baseMounts, basePolicy);
  const changedPreference = build(baseMounts, { ...basePolicy, preference: "claude" });
  const changedReserve = build(baseMounts, { ...basePolicy, reservePercent: basePolicy.reservePercent + 1 });
  const changedExpiry = build(baseMounts, { ...basePolicy, overrideExpiresAt: "2026-11-02T12:31:00.000Z" });
  const changedMountBudget = mounts();
  changedMountBudget.routes.implement.high.src.contextBudget++;
  const changedMount = build(changedMountBudget, basePolicy);
  for (const changed of [changedPreference, changedReserve, changedExpiry, changedMount]) {
    assert.notEqual(changed.digest, baseline.digest);
    assert.equal(changed.rows[0]!.configId, baseline.rows[0]!.configId);
  }
  assert.equal(baseline.sourceDigests["derived:parsed-mounts:v1"],
    createCanonicalDigestForTest(baseMounts));
  assert.equal(baseline.sourceDigests["derived:effective-routing-policy:v1"],
    createCanonicalDigestForTest(basePolicy));
  assert.throws(() => build(baseMounts, basePolicy,
    { ...sourceDigests, "derived:parsed-mounts:v1": sha("f") }), /source-digest-conflict/);
});
