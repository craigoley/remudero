import { stringify as stringifyYaml } from "yaml";

/**
 * `rmd project init <repo>` — the fleet-inheritance onboarding primitive (MASTER-PLAN §5A "the
 * fleet bar is inherited, not optional" / §5 "Per-repo profile — `.remudero/principles.yaml`",
 * W1-T27).
 *
 * WHY THIS MODULE EXISTS: meeting the bar on remudero itself (the T23-T26 tiers: security scans,
 * coverage/mutation/dup ratchets, the T24 `ci-gate` aggregator) is necessary but not the point —
 * the point is that every repo Remudero touches INHERITS that bar automatically at onboarding, not
 * asked to adopt it later. A harness that builds code at fleet scale without installing its own
 * gates on the target is a liability generator, not a quality guarantee. This module is a PURE
 * GENERATOR: given a profile + owner/repo + already-measured baseline numbers, it produces the
 * exact file contents and branch-protection payload a provisioning PR against the target repo
 * would contain. It does no I/O, no `git`/`gh` calls, no network — that keeps it fixture-testable
 * (the acceptance proof is "unit test over injected deps", not a live repo) and keeps the actual
 * git/gh mutation (branch, commit, push, open PR, PATCH branch protection) as a thin, separately
 * reviewable operator step, matching the note on W1-T27: the live-repo confirmation is
 * operator-attested (Rule 18), not part of auto-verify.
 *
 * DESIGN NOTE — the single-aggregator pattern: this repo's OWN `.github/workflows/ci-gate.yml`
 * (W1-T24) proved that a required status check which can be SKIPPED (a job `if:`/path filter, or a
 * reusable-workflow caller) can permanently deadlock a merge (the synthwatch #102 class of bug).
 * The fix generalized here: branch protection on the target repo requires ONLY
 * `["ci-gate", "remudero-review"]` — one always-reporting aggregator job (which internally reads
 * the PR head SHA's check-runs via the GitHub REST API and fails only on a REAL failure
 * conclusion) plus the review context posted by the orchestrator itself. Every other gate (CI,
 * security scanners, quality ratchets, architecture fitness) can live in as many separate workflow
 * files as convenient without ever risking that deadlock class.
 */

// ── Profiles ─────────────────────────────────────────────────────────────────

/**
 * The four onboarding profiles MASTER-PLAN §5A names. Each carries sane, non-zero defaults for
 * its ecosystem's dependency manager, architecture-fitness tool, and strict-config file — the
 * operator TUNES `.remudero/principles.yaml` afterward, never authors the stack from scratch.
 */
export const KNOWN_PROFILES = ["ts-node", "ts-web", "python", "dotnet"] as const;
export type Profile = (typeof KNOWN_PROFILES)[number];

/** Thrown on a bad `--profile` value, or by {@link parseProjectInitArgs} on any malformed CLI input. */
export class ProjectInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectInitError";
  }
}

/**
 * Parse+validate a raw `--profile` flag value. `undefined` in (flag omitted) ⇒ `"ts-node"` — the
 * profile remudero itself runs, and the strictest of the four (MASTER-PLAN §5: "remudero runs the
 * strictest profile on itself"), so an operator who doesn't specify one gets the strict default
 * rather than a silently-weaker one.
 */
export function parseProfileFlag(raw: string | undefined): Profile {
  if (raw === undefined) return "ts-node";
  const p = raw.toLowerCase();
  if ((KNOWN_PROFILES as readonly string[]).includes(p)) return p as Profile;
  throw new ProjectInitError(`--profile must be one of ${KNOWN_PROFILES.join(", ")}; got "${raw}"`);
}

// ── Ratchet baselines ────────────────────────────────────────────────────────

/**
 * Coverage/mutation/dup numbers the CALLER has already measured against the target repo (e.g. by
 * running that repo's own coverage/mutation/jscpd tooling). This module deliberately does NOT
 * shell out to measure them itself — that is out of scope for a pure generator and would make
 * onboarding an arbitrary external repo require running arbitrary tooling from inside remudero.
 * Every field is a plain, REQUIRED number: the whole point (MASTER-PLAN §5A: "a repo never
 * onboards at zero") is that there is no default that silently zeros a floor.
 */
export interface CaptureBaselinesInput {
  coveragePct: number;
  branchesPct: number;
  mutationScorePct: number;
  dupPct: number;
}

/** {@link CaptureBaselinesInput} plus the capture timestamp — what gets written into the profile. */
export interface Baselines extends CaptureBaselinesInput {
  /** ISO-8601 capture time. Injectable via `captureBaselines`'s `now` option for deterministic tests. */
  capturedAt: string;
}

/**
 * Stamp the injected, already-measured numbers with a capture time. This is the ONLY place a
 * timestamp is produced in this module, and it defaults to a real clock but accepts an injected
 * `now` so callers (tests) get a deterministic `capturedAt` without needing to fake global Date.
 */
export function captureBaselines(input: CaptureBaselinesInput, opts?: { now?: () => Date }): Baselines {
  const now = opts?.now ?? (() => new Date());
  return { ...input, capturedAt: now().toISOString() };
}

// ── SHA-pinned action refs (reused/adapted from this repo's own workflows — grepped, not invented) ──

const CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
const SETUP_PYTHON = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0";
const CODEQL_INIT = "github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9 # v4.37.0";
const CODEQL_ANALYZE = "github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9 # v4.37.0";
const CODEQL_UPLOAD_SARIF = "github/codeql-action/upload-sarif@99df26d4f13ea111d4ec1a7dddef6063f76b97e9 # v4.37.0";
const OSV_REUSABLE = "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@9a498708959aeaef5ef730655706c5a1df1edbc2 # v2.3.8";
const DEPENDENCY_REVIEW = "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0";
// Not used anywhere in remudero's own workflow set (remudero ships no .NET code), so there is no
// fleet-verified SHA to reuse here the way the refs above were grepped from real usage. Pinning an
// UNVERIFIED SHA would be worse than an honest gap: it could silently pin a malicious or simply
// wrong commit. The dotnet profile's generated ci.yml therefore uses the moving major-version tag
// and calls this out explicitly so the operator pins it themselves before the workflow goes live.
const SETUP_DOTNET_UNPINNED = "actions/setup-dotnet@v4  # TODO(operator): pin to a SHA — no fleet-verified pin exists for this action yet";

// ── Per-profile spec: ecosystem, architecture-fitness tool, strict config, CI steps ──────────────

interface ProfileSpec {
  /** Dependabot `package-ecosystem` value for this profile's primary manifest. */
  ecosystem: "npm" | "pip" | "nuget";
  /** Human label used in generated comments. */
  language: string;
  /** CodeQL `languages:` matrix value. */
  codeqlLanguage: string;
  /** CodeQL `build-mode:` — `none` for interpreted/no-compile languages, `autobuild` for compiled ones. */
  codeqlBuildMode: "none" | "autobuild";
  /** Bundle Semgrep into scanners.yml — ts profiles only per W1-T27's design. */
  includeSemgrep: boolean;
  /** Filename (relative to repo root) of the architecture-fitness config this profile ships. */
  archFitnessFile: string;
  archFitnessContent: () => string;
  /** Filename of the strict tsconfig/lint/type-check config this profile ships. */
  strictConfigFile: string;
  strictConfigContent: () => string;
  /** YAML steps (indented under a job's `steps:`) that install + build + test for `ci.yml`'s `ci` job. */
  ciSteps: () => string;
  /** YAML steps that run this profile's architecture-fitness check for `depcruise.yml`'s `depcruise` job. */
  depcruiseSteps: () => string;
  /** One-line description of the fitness rule, written into `.remudero/principles.yaml`'s `fitness_rules[]`. */
  fitnessRuleDescription: string;
}

function tsArchFitnessContent(): string {
  return `/**
 * Architecture fitness rules — generated by \`rmd project init\` (MASTER-PLAN §5A / §5 TIER 3,
 * W1-T27), adapted from remudero's own \`.dependency-cruiser.cjs\`.
 *
 * This ships with ONE placeholder layering rule so the gate is ACTIVE from day one rather than an
 * empty config nobody fills in later. Adjust the \`from\`/\`to\` paths to your own repo's real
 * layering (e.g. "core lib never imports the CLI entrypoint or scratch scripts").
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "core-no-cli-or-scripts",
      severity: "error",
      comment:
        "Placeholder layering rule (edit the paths below for this repo's real layout): the " +
        "reusable core must not import CLI entrypoints or scratch scripts. Layering runs one " +
        "way — CLI/scripts may depend on core, never the reverse.",
      from: { path: "^src/lib" },
      to: { path: "^src/(cli|scripts)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // swc, not the tsc-based extractor: avoids dependency-cruiser's TypeScript-version ceiling.
    parser: "swc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
`;
}

function tsStrictConfigContent(web: boolean): string {
  const lib = web ? '["ES2022", "DOM", "DOM.Iterable"]' : '["ES2022"]';
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: JSON.parse(lib),
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noImplicitOverride: true,
          noFallthroughCasesInSwitch: true,
          forceConsistentCasingInFileNames: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n"
  );
}

function pythonArchFitnessContent(): string {
  return `# import-linter config — generated by \`rmd project init\` (MASTER-PLAN §5A / §5 TIER 3, W1-T27).
# Auto-discovered by \`lint-imports\` (pip install import-linter) at the repo root under this exact
# filename. Ships with ONE placeholder layering contract; adjust the module paths for this repo.
[importlinter]
root_package = src

[importlinter:contract:core-no-cli]
name = core package never imports the CLI entrypoint
type = forbidden
source_modules =
    src.core
forbidden_modules =
    src.cli
`;
}

function pythonStrictConfigContent(): string {
  return `# pyproject.toml strict section — generated by \`rmd project init\` (W1-T27). Merge into (or
# replace) your project's existing pyproject.toml; this is scoped to the sections a strict CI
# profile needs, not a full project manifest.

[tool.mypy]
python_version = "3.12"
strict = true
warn_unused_ignores = true
warn_redundant_casts = true
disallow_untyped_defs = true
disallow_incomplete_defs = true

[tool.pytest.ini_options]
addopts = "--strict-markers --strict-config"

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
`;
}

function dotnetArchFitnessContent(): string {
  return `// Architecture-fitness placeholder — generated by \`rmd project init\` (MASTER-PLAN §5A / §5
// TIER 3, W1-T27). No layering test project exists yet in a freshly onboarded repo, so this is a
// STUB the operator wires up next, not a working NetArchTest suite. It is intentionally NOT wired
// into depcruise.yml's steps as a real \`dotnet test\` invocation (there is no .csproj to build
// yet) — that job runs a placeholder check instead so onboarding a fresh repo doesn't fail on a
// gate for a rule set that hasn't been authored.
//
// Suggested next step: add a test project (e.g. tests/ArchitectureTests) referencing the
// NetArchTest.Rules package, and a rule such as:
//
//   Types.InAssembly(assembly)
//     .That().ResideInNamespace("MyApp.Core")
//     .ShouldNot().HaveDependencyOn("MyApp.Cli")
//     .GetResult().IsSuccessful;
//
// Then replace depcruise.yml's placeholder step with \`dotnet test tests/ArchitectureTests\`.
`;
}

function dotnetStrictConfigContent(): string {
  return `# .editorconfig strict section — generated by \`rmd project init\` (W1-T27). Merge into (or
# replace) your project's existing .editorconfig.
root = true

[*.cs]
# Treat analyzer warnings as errors in CI (paired with ci.yml's \`dotnet build /warnaserror\`).
dotnet_analyzer_diagnostic.severity = warning
dotnet_diagnostic.CS8600.severity = error
dotnet_diagnostic.CS8602.severity = error
dotnet_diagnostic.CS8603.severity = error
csharp_style_namespace_declarations = file_scoped:warning
dotnet_style_require_accessibility_modifiers = always:warning

[*.csproj]
indent_size = 2
`;
}

const PROFILES: Record<Profile, ProfileSpec> = {
  "ts-node": {
    ecosystem: "npm",
    language: "TypeScript (Node)",
    codeqlLanguage: "javascript-typescript",
    codeqlBuildMode: "none",
    includeSemgrep: true,
    archFitnessFile: ".dependency-cruiser.cjs",
    archFitnessContent: tsArchFitnessContent,
    strictConfigFile: "tsconfig.json",
    strictConfigContent: () => tsStrictConfigContent(false),
    ciSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_NODE}\n` +
      `        with:\n` +
      `          node-version-file: .nvmrc\n` +
      `      - name: Install (clean, from lockfile)\n` +
      `        run: npm ci\n` +
      `      - name: Typecheck\n` +
      `        run: npx tsc -p tsconfig.json --noEmit\n` +
      `      - name: Test\n` +
      `        run: npm test\n`,
    depcruiseSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_NODE}\n` +
      `        with:\n` +
      `          node-version-file: .nvmrc\n` +
      `      - name: Install (clean, from lockfile)\n` +
      `        run: npm ci\n` +
      `      - name: dependency-cruiser fitness rules\n` +
      `        run: npx --yes dependency-cruiser src --config .dependency-cruiser.cjs\n`,
    fitnessRuleDescription: "dependency-cruiser layering rule (.dependency-cruiser.cjs) — see forbidden[] for the enforced layers.",
  },
  "ts-web": {
    ecosystem: "npm",
    language: "TypeScript (Web)",
    codeqlLanguage: "javascript-typescript",
    codeqlBuildMode: "none",
    includeSemgrep: true,
    archFitnessFile: ".dependency-cruiser.cjs",
    archFitnessContent: tsArchFitnessContent,
    strictConfigFile: "tsconfig.json",
    strictConfigContent: () => tsStrictConfigContent(true),
    ciSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_NODE}\n` +
      `        with:\n` +
      `          node-version-file: .nvmrc\n` +
      `      - name: Install (clean, from lockfile)\n` +
      `        run: npm ci\n` +
      `      - name: Typecheck\n` +
      `        run: npx tsc -p tsconfig.json --noEmit\n` +
      `      - name: Build\n` +
      `        run: npm run build --if-present\n` +
      `      - name: Test\n` +
      `        run: npm test\n`,
    depcruiseSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_NODE}\n` +
      `        with:\n` +
      `          node-version-file: .nvmrc\n` +
      `      - name: Install (clean, from lockfile)\n` +
      `        run: npm ci\n` +
      `      - name: dependency-cruiser fitness rules\n` +
      `        run: npx --yes dependency-cruiser src --config .dependency-cruiser.cjs\n`,
    fitnessRuleDescription: "dependency-cruiser layering rule (.dependency-cruiser.cjs) — see forbidden[] for the enforced layers.",
  },
  python: {
    ecosystem: "pip",
    language: "Python",
    codeqlLanguage: "python",
    codeqlBuildMode: "none",
    includeSemgrep: false,
    archFitnessFile: ".importlinter",
    archFitnessContent: pythonArchFitnessContent,
    strictConfigFile: "pyproject.strict.toml",
    strictConfigContent: pythonStrictConfigContent,
    ciSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_PYTHON}\n` +
      `        with:\n` +
      `          python-version: "3.12"\n` +
      `      - name: Install (editable, dev extras)\n` +
      `        run: pip install -e ".[dev]"\n` +
      `      - name: Type-check (strict — see pyproject.strict.toml [tool.mypy])\n` +
      `        run: mypy .\n` +
      `      - name: Test\n` +
      `        run: pytest\n`,
    depcruiseSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_PYTHON}\n` +
      `        with:\n` +
      `          python-version: "3.12"\n` +
      `      - name: Install import-linter\n` +
      `        run: pip install import-linter\n` +
      `      - name: import-linter fitness contracts (.importlinter)\n` +
      `        run: lint-imports\n`,
    fitnessRuleDescription: "import-linter contract (.importlinter) — see [importlinter:contract:*] sections for the enforced layers.",
  },
  dotnet: {
    ecosystem: "nuget",
    language: ".NET",
    codeqlLanguage: "csharp",
    codeqlBuildMode: "autobuild",
    includeSemgrep: false,
    archFitnessFile: "architecture-fitness.stub.cs",
    archFitnessContent: dotnetArchFitnessContent,
    strictConfigFile: ".editorconfig",
    strictConfigContent: dotnetStrictConfigContent,
    ciSteps: () =>
      `      - uses: ${CHECKOUT}\n` +
      `      - name: Setup .NET\n` +
      `        uses: ${SETUP_DOTNET_UNPINNED}\n` +
      `        with:\n` +
      `          dotnet-version: "8.0.x"\n` +
      `      - name: Restore\n` +
      `        run: dotnet restore\n` +
      `      - name: Build (warnings-as-errors — see .editorconfig)\n` +
      `        run: dotnet build --no-restore /warnaserror\n` +
      `      - name: Test\n` +
      `        run: dotnet test --no-build\n`,
    depcruiseSteps: () =>
      `      - name: Architecture fitness (placeholder — see architecture-fitness.stub.cs)\n` +
      `        run: |\n` +
      `          echo "No architecture-fitness test project wired yet — see architecture-fitness.stub.cs for the suggested NetArchTest.Rules setup."\n` +
      `          echo "This placeholder always succeeds so onboarding a fresh repo isn't blocked on a rule set nobody authored yet."\n`,
    fitnessRuleDescription: "NetArchTest placeholder (architecture-fitness.stub.cs) — not yet a real rule; see the stub's suggested contract.",
  },
};

// ── Branch protection payload ────────────────────────────────────────────────

export interface BranchProtectionPayload {
  required_status_checks: { strict: true; contexts: readonly string[] };
  enforce_admins: true;
  required_pull_request_reviews: { required_approving_review_count: 1 };
  restrictions: null;
}

/**
 * The `PUT /repos/{owner}/{repo}/branches/{branch}/protection` payload shape GitHub expects,
 * requiring EXACTLY `["ci-gate", "remudero-review"]` — the single always-reporting aggregator
 * (see this module's header comment) plus the review context the orchestrator posts directly
 * (not a check-run, so it is never in `ci-gate`'s own internal REQUIRED list, only here).
 */
function buildBranchProtection(): BranchProtectionPayload {
  return {
    required_status_checks: { strict: true, contexts: ["ci-gate", "remudero-review"] },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 1 },
    restrictions: null,
  };
}

// ── Workflow generators ──────────────────────────────────────────────────────

function buildCiYml(profile: Profile): string {
  const spec = PROFILES[profile];
  return (
    `name: CI\n\n` +
    `# Generated by \`rmd project init\` (MASTER-PLAN §5A, W1-T27) — profile: ${profile} (${spec.language}).\n` +
    `# The \`ci\` job's name is the REQUIRED-check context ci-gate.yml's aggregator waits on; do not\n` +
    `# rename it without also updating the REQUIRED list in ci-gate.yml.\n\n` +
    `on:\n  pull_request:\n\n` +
    `permissions:\n  contents: read\n\n` +
    `jobs:\n` +
    `  ci:\n` +
    `    name: ci\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    spec.ciSteps()
  );
}

function buildDepcruiseYml(profile: Profile): string {
  const spec = PROFILES[profile];
  return (
    `name: Architecture fitness\n\n` +
    `# Generated by \`rmd project init\` (MASTER-PLAN §5 TIER 3, W1-T27) — profile: ${profile} (${spec.language}).\n` +
    `# Runs UNCONDITIONALLY on every PR (no path filter, no job \`if:\`) — a path-filtered REQUIRED\n` +
    `# check that can go silently absent is the class of bug ci-gate.yml's aggregator exists to\n` +
    `# avoid (a required context that never registers deadlocks the merge forever).\n\n` +
    `on:\n  pull_request:\n\n` +
    `permissions:\n  contents: read\n\n` +
    `jobs:\n` +
    `  depcruise:\n` +
    `    name: depcruise\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    spec.depcruiseSteps()
  );
}

/**
 * The aggregator (W1-T24's proven pattern, adapted verbatim): ONE always-reporting job that reads
 * the PR head SHA's check-runs via the REST API and fails ONLY on a real failure conclusion.
 * `REQUIRED` names just the two unconditional jobs THIS generated stack ships (`ci`, `depcruise`)
 * — the scanners in scanners.yml are informational (warn-only / SARIF-upload), never required,
 * matching remudero's own ci-gate.yml (its CodeQL/OSV/Semgrep are not in its REQUIRED list either).
 */
function buildCiGateYml(): string {
  return `name: CI gate

# ──────────────────────────────────────────────────────────────────────────────────────────
# ci-gate — ONE always-reporting required status check that aggregates the PR's other
# check-runs. Generated by \`rmd project init\` (MASTER-PLAN §5A, W1-T27), adapted from
# remudero's own .github/workflows/ci-gate.yml (W1-T24).
#
# WHY: a required status check that gets SKIPPED can permanently deadlock a merge — a job \`if:\`,
# path filter, or reusable-workflow caller can make its context never register, and branch
# protection then waits for "Expected" forever. THE FIX: branch protection requires ONLY this one
# job (plus \`remudero-review\`, not a check-run at all). It ALWAYS runs (no \`if:\`, no path filter)
# so its context ALWAYS reports, and it FAILS ONLY when a sibling check actually FAILED. Skipped /
# absent siblings do NOT block.
#
# ★ Branch protection must require ONLY \`ci-gate\` + \`remudero-review\` as contexts — see the
#   \`branchProtection\` payload \`rmd project init\` also generated alongside this file.
# ──────────────────────────────────────────────────────────────────────────────────────────

on:
  pull_request:

permissions:
  checks: read
  contents: read

concurrency:
  group: ci-gate-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  ci-gate:
    name: ci-gate
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: \${{ github.token }}
      REPO: \${{ github.repository }}
      SHA: \${{ github.event.pull_request.head.sha }}
      # The check-run names that ALWAYS appear on a PR (run, or report a SKIPPED run) — the gate
      # WAITS for all of these to reach a terminal state before deciding. Add a job name here
      # whenever a new UNCONDITIONAL (no path filter) required job lands.
      REQUIRED: >-
        ["ci", "depcruise"]
      # Not quality gates — never wait on or fail for these (ci-gate is self; remudero-review is a
      # separate required context posted directly by the orchestrator, not a check-run).
      IGNORE: >-
        ["ci-gate"]
    steps:
      - name: Aggregate sibling check results (fail only on a REAL failure; skipped/absent are OK)
        run: |
          set -euo pipefail

          runs_json() {
            gh api "repos/\${REPO}/commits/\${SHA}/check-runs?per_page=100" --paginate --slurp \\
              | jq -c '[ .[].check_runs[] | {name, status, conclusion} ]'
          }

          deadline=$(( $(date +%s) + 900 ))   # 15-minute hard cap
          while :; do
            runs="$(runs_json)"
            not_ready="$(jq -r --argjson req "\${REQUIRED}" '
              ([ .[] | select(.status=="completed") | .name ]) as $done
              | ($req - $done)
              | .[]' <<< "\${runs}")"
            [ -z "\${not_ready}" ] && break
            if [ "$(date +%s)" -ge "\${deadline}" ]; then
              echo "::error::ci-gate: timed out waiting for required check(s) to complete:"
              printf '%s\\n' "\${not_ready}" | sed 's/^/  - /'
              exit 1
            fi
            echo "waiting for required check(s) to complete:"
            printf '%s\\n' "\${not_ready}" | sed 's/^/  - /'
            sleep 15
          done

          echo "--- gated check runs ---"
          printf '%s' "\${runs}" | jq -r '.[] | "  \\(.conclusion // .status)\\t\\(.name)"' | sort

          fails="$(jq -r --argjson ig "\${IGNORE}" '
            .[] | .name as $n | .conclusion as $c
                | select(($ig | index($n)) == null)
                | select(["failure","timed_out","cancelled","action_required","startup_failure"] | index($c))
                | $n' <<< "\${runs}")"

          if [ -n "\${fails}" ]; then
            echo "::error::ci-gate: required check(s) FAILED — holding merge:"
            printf '%s\\n' "\${fails}" | sed 's/^/  - /'
            exit 1
          fi
          echo "ci-gate: all required checks terminal, no failures — merge may proceed."
`;
}

function buildScannersYml(profile: Profile): string {
  const spec = PROFILES[profile];
  const codeqlJob =
    `  codeql:\n` +
    `    name: CodeQL\n` +
    `    runs-on: ubuntu-latest\n` +
    `    permissions:\n` +
    `      security-events: write\n` +
    `      packages: read\n` +
    `      actions: read\n` +
    `      contents: read\n` +
    `    steps:\n` +
    `      - uses: ${CHECKOUT}\n` +
    `      - uses: ${CODEQL_INIT}\n` +
    `        with:\n` +
    `          languages: ${spec.codeqlLanguage}\n` +
    `          build-mode: ${spec.codeqlBuildMode}\n` +
    `          queries: security-and-quality\n` +
    `      - uses: ${CODEQL_ANALYZE}\n` +
    `        with:\n` +
    `          category: "/language:${spec.codeqlLanguage}"\n`;

  const osvJob =
    `  osv-scanner:\n` +
    `    name: OSV-Scanner\n` +
    `    uses: ${OSV_REUSABLE}\n` +
    `    with:\n` +
    `      scan-args: |-\n` +
    `        -r\n` +
    `        ./\n` +
    `      upload-sarif: true\n` +
    `      fail-on-vuln: false\n` +
    `    permissions:\n` +
    `      security-events: write\n` +
    `      contents: read\n` +
    `      actions: read\n`;

  const dependencyReviewJob =
    `  dependency-review:\n` +
    `    name: Dependency Review\n` +
    `    if: github.event_name == 'pull_request'\n` +
    `    runs-on: ubuntu-latest\n` +
    `    permissions:\n` +
    `      contents: read\n` +
    `      pull-requests: write\n` +
    `    steps:\n` +
    `      - uses: ${CHECKOUT}\n` +
    `      - uses: ${DEPENDENCY_REVIEW}\n` +
    `        continue-on-error: true\n` +
    `        with:\n` +
    `          comment-summary-in-pr: always\n`;

  const semgrepJob = spec.includeSemgrep
    ? `  semgrep:\n` +
      `    name: Semgrep\n` +
      `    runs-on: ubuntu-latest\n` +
      `    permissions:\n` +
      `      security-events: write\n` +
      `      contents: read\n` +
      `      actions: read\n` +
      `    steps:\n` +
      `      - uses: ${CHECKOUT}\n` +
      `      - uses: ${SETUP_PYTHON}\n` +
      `        with:\n` +
      `          python-version: "3.12"\n` +
      `      - name: Install Semgrep CE\n` +
      `        run: pip install "semgrep==1.167.0"\n` +
      `      - name: Run Semgrep\n` +
      `        run: |\n` +
      `          semgrep scan \\\n` +
      `            --config p/typescript \\\n` +
      `            --config p/javascript \\\n` +
      `            --config p/security-audit \\\n` +
      `            --config p/secrets \\\n` +
      `            --sarif --output semgrep.sarif\n` +
      `        continue-on-error: true\n` +
      `      - name: Upload SARIF to code scanning\n` +
      `        uses: ${CODEQL_UPLOAD_SARIF}\n` +
      `        if: always()\n` +
      `        with:\n` +
      `          sarif_file: semgrep.sarif\n` +
      `          category: semgrep\n`
    : "";

  return (
    `name: Scanners\n\n` +
    `# Generated by \`rmd project init\` (MASTER-PLAN §5A, W1-T27) — profile: ${profile} (${spec.language}).\n` +
    `# Bundles CodeQL + OSV-Scanner (full tree) + Dependency Review${spec.includeSemgrep ? " + Semgrep" : ""},\n` +
    `# adapted from remudero's own codeql.yml/osv-scanner.yml/dependency-review.yml${spec.includeSemgrep ? "/semgrep.yml" : ""}.\n` +
    `# WARN-ONLY: none of these jobs are in ci-gate.yml's REQUIRED list (same as on remudero itself)\n` +
    `# — they surface findings via the Security tab / PR comments without walling every merge on a\n` +
    `# scanner's own uptime.\n\n` +
    `on:\n` +
    `  push:\n` +
    `    branches: [main]\n` +
    `  pull_request:\n` +
    `    branches: [main]\n` +
    `  schedule:\n` +
    `    - cron: "17 4 * * 1"\n` +
    `  workflow_dispatch:\n\n` +
    `permissions:\n  contents: read\n\n` +
    `jobs:\n` +
    codeqlJob +
    `\n` +
    osvJob +
    `\n` +
    dependencyReviewJob +
    (semgrepJob ? `\n${semgrepJob}` : "")
  );
}

// ── Config generators ────────────────────────────────────────────────────────

function buildDependabotYml(profile: Profile): string {
  const spec = PROFILES[profile];
  return (
    `version: 2\n` +
    `updates:\n` +
    `  # Generated by \`rmd project init\` (W1-T27), adapted from remudero's own .github/dependabot.yml.\n` +
    `  - package-ecosystem: ${spec.ecosystem}\n` +
    `    directory: /\n` +
    `    schedule:\n` +
    `      interval: weekly\n` +
    `    open-pull-requests-limit: 10\n` +
    `    # IGNORE-FREE BY DESIGN (MASTER-PLAN §5 FLEET FINDING): minor+patch bumps are grouped so\n` +
    `    # they don't flood one-PR-per-bump. MAJOR bumps are excluded from AUTO-MERGE at the\n` +
    `    # dep-review lane, never via an \`ignore:\` block here — an ignore: block would hide the\n` +
    `    # PR entirely instead of just gating its auto-merge.\n` +
    `    groups:\n` +
    `      ${spec.ecosystem}-minor-and-patch:\n` +
    `        update-types:\n` +
    `          - minor\n` +
    `          - patch\n\n` +
    `  # Keeps the SHA-pinned actions in .github/workflows fresh — Dependabot bumps the pinned SHA\n` +
    `  # and the trailing version comment together.\n` +
    `  - package-ecosystem: github-actions\n` +
    `    directory: /\n` +
    `    schedule:\n` +
    `      interval: weekly\n` +
    `    groups:\n` +
    `      actions-minor-and-patch:\n` +
    `        update-types:\n` +
    `          - minor\n` +
    `          - patch\n`
  );
}

function buildSecurityMd(owner: string, repo: string): string {
  return `# Security Policy

Generated by \`rmd project init\` (MASTER-PLAN §5A, W1-T27) — a starting template; tune the
contact address and response-time commitments for this project's real capacity.

## Reporting a Vulnerability

**Please report security vulnerabilities privately — do NOT open a public GitHub issue.**

- Preferred: GitHub's private vulnerability reporting (${owner}/${repo} → Security tab → "Report a
  vulnerability").
- Alternative: email security@${owner}.example (replace with a real monitored address before this
  file goes live).

We aim to:
- **Acknowledge** a report within **3 business days**.
- Provide an initial **assessment and remediation timeline** within **10 business days** of
  confirming the report.
- Credit the reporter (unless they request otherwise) once a fix ships.

## Supported Versions

| Version         | Supported |
| ---------------- | --------- |
| \`main\` (latest) | ✅        |
| older releases    | ❌        |

## Scope

This policy covers the code in this repository. Report vulnerabilities in third-party
dependencies to their respective maintainers as well (Dependabot and the OSV-Scanner /
Dependency Review workflows in \`.github/workflows/\` also surface known-vulnerable dependencies
automatically).
`;
}

/**
 * `.remudero/principles.yaml` (MASTER-PLAN §5 "Per-repo profile") — the profile's tuned defaults
 * PLUS the captured ratchet baselines, in one document. Written as YAML via the \`yaml\` package
 * (the same library plan.ts/config.ts already depend on) rather than hand-built string
 * concatenation, so the numeric baseline fields round-trip exactly through `yaml.parse` the way a
 * consuming test (or the real ratchet scripts) would read them.
 */
function buildPrinciplesYaml(profile: Profile, baselines: Baselines): string {
  const spec = PROFILES[profile];
  const doc = {
    profile,
    // remudero's own default (MASTER-PLAN §5: "remudero runs the strictest profile on itself") —
    // every onboarded repo starts here; the operator may relax it in this file afterward.
    tdd: "strict",
    coverage_ratchet: {
      lines_pct: baselines.coveragePct,
      branches_pct: baselines.branchesPct,
    },
    mutation_baseline: {
      score_pct: baselines.mutationScorePct,
    },
    dup_threshold: {
      pct: baselines.dupPct,
    },
    complexity: {
      max_cyclomatic: 15,
    },
    fitness_rules: [{ name: spec.archFitnessFile, description: spec.fitnessRuleDescription }],
    security_profile: {
      codeql: true,
      osv_scanner: true,
      dependency_review: true,
      semgrep: spec.includeSemgrep,
      secret_scanning: true,
      push_protection: true,
    },
    // The ratchet floors above are DERIVED from these captured numbers at onboarding time — kept
    // here too, verbatim, so "a repo never onboards at zero" (MASTER-PLAN §5A) is directly
    // greppable/parseable from this one file without cross-referencing anything else.
    baselines: {
      captured_at: baselines.capturedAt,
      coverage_pct: baselines.coveragePct,
      branches_pct: baselines.branchesPct,
      mutation_score_pct: baselines.mutationScorePct,
      dup_pct: baselines.dupPct,
    },
  };
  return stringifyYaml(doc);
}

// ── Top-level orchestrator ───────────────────────────────────────────────────

export interface ProjectInitInput {
  /** GitHub owner/org the target repo lives under. */
  owner: string;
  /** Target repo name (no owner prefix). */
  repo: string;
  profile: Profile;
  /** Already-measured baseline numbers for the target repo — see {@link CaptureBaselinesInput}. */
  baselines: CaptureBaselinesInput;
  /** Injectable clock for {@link captureBaselines} — defaults to the real time. */
  now?: () => Date;
}

export interface ProjectInitPayload {
  /** `.github/workflows/<filename>` → file content. */
  workflows: Record<string, string>;
  /** Repo-root `<filename>` → file content (includes dependabot.yml, SECURITY.md, the profile's
   *  architecture-fitness config, and its strict tsconfig/lint config). */
  configs: Record<string, string>;
  /** `.remudero/principles.yaml` content. */
  principlesYaml: string;
  /** The `PUT .../branches/{branch}/protection` payload — see {@link buildBranchProtection}. */
  branchProtection: BranchProtectionPayload;
  baselines: Baselines;
}

/**
 * PURE generator: given a target owner/repo, a profile, and already-measured baseline numbers,
 * produce every file this onboarding provisioning PR would contain plus the branch-protection
 * payload — no I/O, no git/gh calls, no network. This is what both W1-T27 acceptance-criteria unit
 * tests assert against directly (fixture in, deep-equal/grep the payload out).
 */
export function buildProjectInit(input: ProjectInitInput): ProjectInitPayload {
  const spec = PROFILES[input.profile];
  const baselines = captureBaselines(input.baselines, { now: input.now });

  const workflows: Record<string, string> = {
    "ci.yml": buildCiYml(input.profile),
    "ci-gate.yml": buildCiGateYml(),
    "scanners.yml": buildScannersYml(input.profile),
    "depcruise.yml": buildDepcruiseYml(input.profile),
  };

  const configs: Record<string, string> = {
    "dependabot.yml": buildDependabotYml(input.profile),
    "SECURITY.md": buildSecurityMd(input.owner, input.repo),
    [spec.archFitnessFile]: spec.archFitnessContent(),
    [spec.strictConfigFile]: spec.strictConfigContent(),
  };

  return {
    workflows,
    configs,
    principlesYaml: buildPrinciplesYaml(input.profile, baselines),
    branchProtection: buildBranchProtection(),
    baselines,
  };
}

// ── CLI arg parsing (pure — the thin `rmd project init` CLI wrapper in run-task.ts delegates here) ──

export interface ParsedProjectInitArgs {
  owner?: string;
  repo: string;
  profile: Profile;
  baselines: CaptureBaselinesInput;
}

export type ParseProjectInitArgsResult = { ok: true; args: ParsedProjectInitArgs } | { ok: false; error: string };

/** `--flag value` lookup over a raw argv tail; undefined if the flag is absent. Local copy of
 *  run-task.ts's `flagValue` — this module must not import run-task.ts (depcruise's
 *  `lib-no-spike-or-cli` rule), so the CLI-argument parsing that belongs conceptually with the
 *  generator lives here as a small, independently testable, self-contained helper instead. */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const PROJECT_INIT_VALUE_FLAGS = ["--profile", "--coverage-pct", "--branches-pct", "--mutation-pct", "--dup-pct"];

/**
 * Parse+validate `rmd project init <repo> [--profile <p>] --coverage-pct <n> --branches-pct <n>
 * --mutation-pct <n> --dup-pct <n>`'s argv tail (everything AFTER the literal `init` token).
 *
 * FAIL LOUD, BEFORE ANY WORK (Standing rule / LEARNINGS.md control-surface-fail-loud-stop-one-shot,
 * the same discipline `unknownArgError` enforces elsewhere in this repo): a bare extra positional,
 * an unrecognized flag, a bad `--profile` value, or ANY missing/non-numeric baseline flag is
 * REJECTED here — this command never runs `buildProjectInit` on partial input. The baseline flags
 * are REQUIRED (not defaulted to 0) on purpose: MASTER-PLAN §5A's invariant is "a repo never
 * onboards at zero," so silently defaulting an omitted flag to 0 would be exactly the bug this
 * command exists to prevent — the operator must supply real measured numbers.
 */
export function parseProjectInitArgs(rest: string[]): ParseProjectInitArgsResult {
  const repoRaw = rest[0];
  if (!repoRaw || repoRaw.startsWith("--")) {
    return { ok: false, error: "rmd project init: <repo> is required as the first positional argument" };
  }

  let owner: string | undefined;
  let repo = repoRaw;
  if (repoRaw.includes("/")) {
    const parts = repoRaw.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, error: `rmd project init: <repo> must be "name" or "owner/name", got "${repoRaw}"` };
    }
    [owner, repo] = parts;
  }

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i];
    if (PROJECT_INIT_VALUE_FLAGS.includes(tok)) {
      i++; // skip its value
      continue;
    }
    return { ok: false, error: `rmd project init: unrecognized argument '${tok}'` };
  }

  let profile: Profile;
  try {
    profile = parseProfileFlag(flagValue(tail, "--profile"));
  } catch (e) {
    return { ok: false, error: e instanceof ProjectInitError ? e.message : String(e) };
  }

  const readPct = (flag: string, label: string): number | { error: string } => {
    const raw = flagValue(tail, flag);
    if (raw === undefined) {
      return {
        error:
          `rmd project init: ${flag} <pct> is required — a repo never onboards with its ${label} ` +
          `floor silently at zero (MASTER-PLAN §5A); measure it and pass the real number`,
      };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { error: `rmd project init: ${flag} must be a number, got "${raw}"` };
    }
    return n;
  };

  const coveragePct = readPct("--coverage-pct", "coverage");
  if (typeof coveragePct !== "number") return { ok: false, error: coveragePct.error };
  const branchesPct = readPct("--branches-pct", "branch-coverage");
  if (typeof branchesPct !== "number") return { ok: false, error: branchesPct.error };
  const mutationScorePct = readPct("--mutation-pct", "mutation-score");
  if (typeof mutationScorePct !== "number") return { ok: false, error: mutationScorePct.error };
  const dupPct = readPct("--dup-pct", "duplication");
  if (typeof dupPct !== "number") return { ok: false, error: dupPct.error };

  return {
    ok: true,
    args: { owner, repo, profile, baselines: { coveragePct, branchesPct, mutationScorePct, dupPct } },
  };
}
