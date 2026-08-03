import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildProjectInit,
  captureBaselines,
  KNOWN_PROFILES,
  parseProfileFlag,
  parseProjectInitArgs,
  ProjectInitError,
  type Profile,
} from "../src/lib/project-init.js";

// A fixed, injected clock so every test's `capturedAt` is deterministic.
const FIXED_NOW = () => new Date("2026-07-18T12:00:00.000Z");

/** REAL (non-zero, non-default-looking) baseline numbers — nothing here is a round/hardcoded value. */
const REAL_BASELINES = { coveragePct: 73.4, branchesPct: 68.9, mutationScorePct: 61.2, dupPct: 4.2 };

function fixtureInput(profile: Profile = "ts-node") {
  return {
    owner: "acme-corp",
    repo: "widget-service",
    profile,
    baselines: REAL_BASELINES,
    now: FIXED_NOW,
  };
}

// ── W1-T27 acceptance 1: the generator produces the full gate stack + the single-aggregator payload ──

test("acceptance 1: buildProjectInit's branch-protection payload names exactly [ci-gate, remudero-review]", () => {
  const payload = buildProjectInit(fixtureInput());
  assert.deepEqual(payload.branchProtection.required_status_checks.contexts, ["ci-gate", "remudero-review"]);
  assert.equal(payload.branchProtection.required_status_checks.strict, true);
  assert.equal(payload.branchProtection.enforce_admins, true);
  assert.equal(payload.branchProtection.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(payload.branchProtection.restrictions, null);
});

test("acceptance 1: buildProjectInit ships the full .github/workflows set — ci/ci-gate/scanners/depcruise, all non-empty", () => {
  const payload = buildProjectInit(fixtureInput());
  const keys = Object.keys(payload.workflows).sort();
  assert.deepEqual(keys, ["ci-gate.yml", "ci.yml", "depcruise.yml", "scanners.yml"]);
  for (const [name, content] of Object.entries(payload.workflows)) {
    assert.ok(content.length > 0, `${name} must be non-empty`);
    assert.ok(content.trim().startsWith("name:"), `${name} should be a valid workflow (starts with 'name:')`);
  }
});

test("acceptance 1: buildProjectInit ships the profile configs — dependabot/arch-fitness/strict-config/SECURITY.md, all non-empty", () => {
  const payload = buildProjectInit(fixtureInput("ts-node"));
  assert.ok(payload.configs["dependabot.yml"]?.length, "dependabot.yml must be present and non-empty");
  assert.ok(payload.configs["SECURITY.md"]?.length, "SECURITY.md must be present and non-empty");
  // ts profiles ship .dependency-cruiser.cjs as their architecture-fitness config.
  assert.ok(payload.configs[".dependency-cruiser.cjs"]?.length, ".dependency-cruiser.cjs must be present and non-empty");
  // and tsconfig.json as the strict config.
  assert.ok(payload.configs["tsconfig.json"]?.length, "tsconfig.json must be present and non-empty");
  // tsconfig.json must actually parse as JSON and be strict.
  const tsconfig = JSON.parse(payload.configs["tsconfig.json"]!);
  assert.equal(tsconfig.compilerOptions.strict, true);
});

test("acceptance 1: the ci-gate.yml aggregator waits on exactly the jobs the generated stack ships (ci, depcruise)", () => {
  const payload = buildProjectInit(fixtureInput());
  const gate = payload.workflows["ci-gate.yml"]!;
  assert.match(gate, /REQUIRED: >-\s*\n\s*\["ci", "depcruise"\]/);
  // ci.yml and depcruise.yml must actually define jobs by those exact names.
  assert.match(payload.workflows["ci.yml"]!, /\n {2}ci:\n {4}name: ci\n/);
  assert.match(payload.workflows["depcruise.yml"]!, /\n {2}depcruise:\n {4}name: depcruise\n/);
});

test("acceptance 1: no live repo / no network required — buildProjectInit is a pure function of its fixture input", () => {
  const a = buildProjectInit(fixtureInput());
  const b = buildProjectInit(fixtureInput());
  assert.deepEqual(a, b, "same fixture input must always produce the same output (pure, no hidden I/O)");
});

// ── W1-T27 acceptance 2: ratchet baselines captured at onboarding are NEVER zero ─────────────────

test("acceptance 2: onboarding with REAL non-zero injected coverage/mutation/dup data writes those EXACT numbers into principles.yaml", () => {
  const payload = buildProjectInit(fixtureInput());
  const parsed = parseYaml(payload.principlesYaml) as Record<string, any>;

  assert.equal(parsed.baselines.coverage_pct, REAL_BASELINES.coveragePct);
  assert.equal(parsed.baselines.branches_pct, REAL_BASELINES.branchesPct);
  assert.equal(parsed.baselines.mutation_score_pct, REAL_BASELINES.mutationScorePct);
  assert.equal(parsed.baselines.dup_pct, REAL_BASELINES.dupPct);
  assert.equal(parsed.baselines.captured_at, "2026-07-18T12:00:00.000Z");

  // The ratchet-floor fields derived from the same capture must also carry the real numbers,
  // not a zeroed/defaulted placeholder.
  assert.equal(parsed.coverage_ratchet.lines_pct, REAL_BASELINES.coveragePct);
  assert.equal(parsed.coverage_ratchet.branches_pct, REAL_BASELINES.branchesPct);
  assert.equal(parsed.mutation_baseline.score_pct, REAL_BASELINES.mutationScorePct);
  assert.equal(parsed.dup_threshold.pct, REAL_BASELINES.dupPct);

  // Also directly greppable in the raw string (belt-and-suspenders vs. a parser quirk).
  assert.match(payload.principlesYaml, /73\.4/);
  assert.match(payload.principlesYaml, /61\.2/);
  assert.match(payload.principlesYaml, /4\.2/);
});

test("acceptance 2: a repo with real coverage never onboards at zero — none of the captured baseline numbers are 0", () => {
  const payload = buildProjectInit(fixtureInput());
  assert.equal(payload.baselines.coveragePct, REAL_BASELINES.coveragePct);
  assert.equal(payload.baselines.branchesPct, REAL_BASELINES.branchesPct);
  assert.equal(payload.baselines.mutationScorePct, REAL_BASELINES.mutationScorePct);
  assert.equal(payload.baselines.dupPct, REAL_BASELINES.dupPct);
  for (const v of Object.values(payload.baselines)) {
    if (typeof v === "number") assert.notEqual(v, 0, "no captured baseline number may silently be zero");
  }
});

test("captureBaselines: stamps the injected numbers with an injectable capture time, deterministic under a fixed clock", () => {
  const b = captureBaselines(REAL_BASELINES, { now: FIXED_NOW });
  assert.deepEqual(b, { ...REAL_BASELINES, capturedAt: "2026-07-18T12:00:00.000Z" });
});

test("captureBaselines: defaults to a real clock when no `now` is injected (still non-zero passthrough)", () => {
  const before = Date.now();
  const b = captureBaselines(REAL_BASELINES);
  const capturedMs = new Date(b.capturedAt).getTime();
  assert.ok(capturedMs >= before, "capturedAt must be a real, current timestamp when no clock is injected");
  assert.equal(b.coveragePct, REAL_BASELINES.coveragePct);
});

// ── Profile coverage: each of the 4 profiles is accepted and produces profile-appropriate configs ──

const EXPECTED_ARCH_FITNESS_FILE: Record<Profile, string> = {
  "ts-node": ".dependency-cruiser.cjs",
  "ts-web": ".dependency-cruiser.cjs",
  python: ".importlinter",
  dotnet: "architecture-fitness.stub.cs",
};

const EXPECTED_STRICT_CONFIG_FILE: Record<Profile, string> = {
  "ts-node": "tsconfig.json",
  "ts-web": "tsconfig.json",
  python: "pyproject.strict.toml",
  dotnet: ".editorconfig",
};

for (const profile of KNOWN_PROFILES) {
  test(`profile coverage: '${profile}' is accepted and produces profile-appropriate config filenames`, () => {
    const payload = buildProjectInit(fixtureInput(profile));
    assert.ok(
      payload.configs[EXPECTED_ARCH_FITNESS_FILE[profile]]?.length,
      `${profile} must ship ${EXPECTED_ARCH_FITNESS_FILE[profile]} with non-empty content`,
    );
    assert.ok(
      payload.configs[EXPECTED_STRICT_CONFIG_FILE[profile]]?.length,
      `${profile} must ship ${EXPECTED_STRICT_CONFIG_FILE[profile]} with non-empty content`,
    );
    // Every profile still ships the profile-independent pieces.
    assert.ok(payload.configs["dependabot.yml"]?.length);
    assert.ok(payload.configs["SECURITY.md"]?.length);
    assert.deepEqual(payload.branchProtection.required_status_checks.contexts, ["ci-gate", "remudero-review"]);
    // The principles.yaml declares which profile it was generated for.
    const parsed = parseYaml(payload.principlesYaml) as Record<string, any>;
    assert.equal(parsed.profile, profile);
  });
}

// ── W1-T291: the dotnet profile ships a SHA-pinned setup-dotnet and an honest (unarmed) fitness gate ──

test("W1-T291: the generated dotnet ci.yml pins setup-dotnet by a 40-char SHA — no moving tag, no operator TODO", () => {
  const payload = buildProjectInit(fixtureInput("dotnet"));
  const ci = payload.workflows["ci.yml"]!;
  assert.match(ci, /uses: actions\/setup-dotnet@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.doesNotMatch(ci, /setup-dotnet@v\d+\s*$/m, "must not reference a bare moving version tag");
  assert.doesNotMatch(ci, /TODO\(operator\)/, "must not defer pinning to the operator");
});

test("W1-T291: no generated workflow step claims a placeholder 'always succeeds'", () => {
  for (const profile of KNOWN_PROFILES) {
    const payload = buildProjectInit(fixtureInput(profile));
    for (const [name, content] of Object.entries(payload.workflows)) {
      assert.doesNotMatch(
        content,
        /always succeeds/i,
        `${profile}/${name} must not report success while asserting nothing`,
      );
    }
  }
});

test("W1-T291: the dotnet depcruise job still runs unconditionally, so the required check-run can't go absent and deadlock", () => {
  const payload = buildProjectInit(fixtureInput("dotnet"));
  const depcruise = payload.workflows["depcruise.yml"]!;
  // Same shape acceptance-1 already asserts for the default (ts-node) fixture: the `depcruise`
  // job is defined by exactly that name, with no job- or workflow-level `if:`/path filter that
  // could make its check-run go silently absent instead of reporting a terminal conclusion.
  assert.match(depcruise, /\n {2}depcruise:\n {4}name: depcruise\n/);
  // Check real YAML lines only — the header comment prose mentions `if:` in backticks while
  // explaining why there ISN'T one, which would otherwise false-positive a naive whole-string match.
  const yamlLines = depcruise.split("\n").filter((l) => !l.trim().startsWith("#"));
  assert.ok(
    !yamlLines.some((l) => /\bif:\s/.test(l)),
    "the dotnet depcruise job must run unconditionally, same as every other profile",
  );
  assert.match(depcruise, /UNARMED/);
});

test("W1-T291: principles.yaml marks the dotnet fitness rule unarmed; the other three profiles stay armed (unchanged)", () => {
  for (const profile of KNOWN_PROFILES) {
    const payload = buildProjectInit(fixtureInput(profile));
    const parsed = parseYaml(payload.principlesYaml) as Record<string, any>;
    const rule = parsed.fitness_rules[0];
    if (profile === "dotnet") {
      assert.equal(rule.armed, false, "dotnet's generated fitness rule must be marked unarmed, not an enforced contract");
      assert.match(rule.description, /NOT YET ARMED/);
    } else {
      assert.equal(rule.armed, true, `${profile}'s real, enforced fitness rule must stay armed`);
    }
  }
});

test("W1-T291: the pinned dotnet action ref is a named constant on the generator's dotnet path (SETUP_DOTNET_PINNED)", () => {
  // Belt-and-suspenders alongside the source-level grep proof: the SHA that constant resolves to
  // must actually appear in the generated dotnet ci.yml.
  const payload = buildProjectInit(fixtureInput("dotnet"));
  assert.match(payload.workflows["ci.yml"]!, /actions\/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9/);
});

test("parseProfileFlag: undefined ⇒ the ts-node default (remudero's own, strictest profile)", () => {
  assert.equal(parseProfileFlag(undefined), "ts-node");
});

test("parseProfileFlag: accepts known profiles case-insensitively", () => {
  assert.equal(parseProfileFlag("PYTHON"), "python");
  assert.equal(parseProfileFlag("Dotnet"), "dotnet");
  assert.equal(parseProfileFlag("ts-web"), "ts-web");
});

test("parseProfileFlag: throws ProjectInitError on an unknown value", () => {
  assert.throws(() => parseProfileFlag("rust"), ProjectInitError);
});

// ── CLI-level arg parsing: invalid --profile or a bogus extra positional is REJECTED, no work done ──

test("parseProjectInitArgs: valid full argv parses into repo/profile/baselines", () => {
  const result = parseProjectInitArgs([
    "widget-service",
    "--profile",
    "python",
    "--coverage-pct",
    "73.4",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    "--dup-pct",
    "4.2",
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.args.repo, "widget-service");
  assert.equal(result.args.owner, undefined);
  assert.equal(result.args.profile, "python");
  assert.deepEqual(result.args.baselines, REAL_BASELINES);
});

test("parseProjectInitArgs: 'owner/repo' positional splits into owner + repo", () => {
  const result = parseProjectInitArgs([
    "acme-corp/widget-service",
    "--coverage-pct",
    "73.4",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    "--dup-pct",
    "4.2",
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.args.owner, "acme-corp");
  assert.equal(result.args.repo, "widget-service");
  assert.equal(result.args.profile, "ts-node", "omitted --profile falls back to the default, not an error");
});

test("parseProjectInitArgs: missing <repo> ⇒ REJECTED, no work done", () => {
  const result = parseProjectInitArgs([]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /<repo> is required/);
});

test("parseProjectInitArgs: an invalid --profile value ⇒ REJECTED (fail loud, not silent fallthrough)", () => {
  const result = parseProjectInitArgs([
    "widget-service",
    "--profile",
    "cobol",
    "--coverage-pct",
    "73.4",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    "--dup-pct",
    "4.2",
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /--profile must be one of/);
});

test("parseProjectInitArgs: a bogus extra positional arg ⇒ REJECTED, not silently ignored", () => {
  const result = parseProjectInitArgs(["widget-service", "extra-junk-positional"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unrecognized argument 'extra-junk-positional'/);
});

test("parseProjectInitArgs: an unrecognized flag ⇒ REJECTED, not silently ignored", () => {
  const result = parseProjectInitArgs([
    "widget-service",
    "--coverage-pct",
    "73.4",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    "--dup-pct",
    "4.2",
    "--dry-run",
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unrecognized argument '--dry-run'/);
});

test("parseProjectInitArgs: an omitted baseline flag ⇒ REJECTED — never silently defaults to zero", () => {
  const result = parseProjectInitArgs([
    "widget-service",
    "--coverage-pct",
    "73.4",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    // --dup-pct omitted
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /--dup-pct <pct> is required/);
  assert.match(result.error, /never onboards with its duplication floor silently at zero/);
});

test("parseProjectInitArgs: a non-numeric baseline flag value ⇒ REJECTED", () => {
  const result = parseProjectInitArgs([
    "widget-service",
    "--coverage-pct",
    "not-a-number",
    "--branches-pct",
    "68.9",
    "--mutation-pct",
    "61.2",
    "--dup-pct",
    "4.2",
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /--coverage-pct must be a number/);
});

test("parseProjectInitArgs: malformed 'owner/repo/extra' positional ⇒ REJECTED", () => {
  const result = parseProjectInitArgs(["a/b/c"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /must be "name" or "owner\/name"/);
});
