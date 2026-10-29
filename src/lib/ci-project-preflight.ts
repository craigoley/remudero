import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { resolveOwnerRepoAt } from "./owner-repo.js";
import { commitlintStep, defaultPreflightSpawn, emitterChecksStep, type PreflightDeps } from "./commit-message.js";
import { boundedSuiteLeaf, LOCAL_FULL_SUITE_TIMEOUT_MS, type CiParityStepResult } from "./ci-parity.js";
import { acquireTestSlot, lowPriorityCommand, readMemoryHeadroom, testSlotExecutionAllowed, type TestSlotLease, type TestSlotOptions } from "./test-slot.js";
import { TYPECHECK_COLD_PEAK_BYTES } from "./typecheck-buildinfo.js";
import { hostWorktreeGit } from "./worktree-git.js";

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
interface QualityCommand { name: string; file: string; args: string[] }
interface ConsumerProfile {
  scripts: Record<string, string>;
  checks: string[];
  tools: string[];
  full: string[];
}

// Reviewed against each repository's package.json and .github/workflows/ci.yml. A changed
// declaration needs a reviewed profile update; a package name never selects this table.
const PROFILES: Readonly<Record<string, ConsumerProfile>> = {
  "craigoley/remudero-console": {
    scripts: { typecheck: "tsc --noEmit", "test:unit": "vitest run tests/unit", build: "next build", "test:e2e": "playwright test" },
    checks: ["check-plan-dependencies", "check-core-contract-compatibility", "check-core-write-parity", "check-core-read-contract"],
    tools: ["tsc", "vitest"], full: ["build", "test:e2e"],
  },
  "craigoley/wreckterra": {
    scripts: { typecheck: "tsc --noEmit", test: "vitest run --maxWorkers=1", "test:coverage": "vitest run --coverage --maxWorkers=1", build: "tsc --noEmit && vite build", security: "npm audit --audit-level=low" },
    checks: [], tools: ["tsc", "vitest", "vite"], full: [],
  },
};

export type ProjectPreflight =
  | { kind: "core"; root: string; repository: string }
  | { kind: "consumer"; root: string; repository: string; harnessRoot: string; commands: QualityCommand[] }
  | { kind: "unavailable"; root: string; repository?: string; reason: string };

export interface ProjectPreflightOptions {
  ciParity?: boolean;
  coverage?: boolean;
  proofs?: boolean;
}

/** Canonical identity is read from this checkout, never from flags, package metadata or cwd shape. */
export function resolveProjectPreflight(root: string, options: ProjectPreflightOptions = {}): ProjectPreflight {
  let repository: string | undefined;
  try {
    const target = resolveOwnerRepoAt(root);
    repository = `${target.owner}/${target.repo}`;
    if (repository === "craigoley/remudero") return { kind: "core", root, repository };
    const profile = Object.hasOwn(PROFILES, repository) ? PROFILES[repository] : undefined;
    if (!profile) throw new Error(`unregistered quality profile: ${repository}`);
    if (options.proofs) throw new Error("consumer proof discrimination is unavailable in this preflight profile");
    if (options.coverage && repository !== "craigoley/wreckterra") throw new Error("target declares no coverage command");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const workflow = parseYaml(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
      jobs?: Record<string, { steps?: { run?: unknown }[] }>;
    } | null;
    const declared = new Set(Object.values(workflow?.jobs ?? {}).flatMap(job =>
      (job.steps ?? []).flatMap(step => typeof step.run === "string" ? step.run.trim().split("\n").map(line => line.trim()) : [])));
    const requireDeclaration = (command: string) => {
      if (!declared.has(command)) throw new Error(`CI declaration missing: ${command}`);
    };
    const names = repository === "craigoley/wreckterra"
      ? ["typecheck", options.coverage || options.ciParity ? "test:coverage" : "test", "build", "security"]
      : ["typecheck", "test:unit", ...(options.ciParity ? profile.full : [])];
    const commands: QualityCommand[] = profile.checks.map(name => {
      const path = `scripts/${name}.mjs`;
      accessSync(join(root, path), constants.R_OK);
      requireDeclaration(`node ${path}`);
      return { name, file: process.execPath, args: [join(root, path)] };
    });
    for (const name of names) {
      if (pkg.scripts?.[name] !== profile.scripts[name]) throw new Error(`missing or changed target script: ${name}`);
      // Wreckterra's default test is the uninstrumented form of CI's declared coverage run.
      requireDeclaration(`npm run ${name === "test" ? "test:coverage" : name}`);
      commands.push({ name, file: "npm", args: ["run", name, ...(name === "test:unit" ? ["--", "--maxWorkers=1"] : [])] });
    }
    if (repository === "craigoley/remudero-console" && options.ciParity) {
      requireDeclaration("npm audit --audit-level=high");
      commands.push({ name: "security", file: "npm", args: ["audit", "--audit-level=high"] });
    }
    const tools = [...profile.tools, ...(repository === "craigoley/remudero-console" && options.ciParity ? ["next", "playwright"] : [])];
    accessSync(join(root, "tsconfig.json"), constants.R_OK);
    for (const tool of tools) accessSync(join(root, "node_modules/.bin", tool), constants.X_OK);
    accessSync(join(HARNESS_ROOT, "node_modules/.bin/commitlint"), constants.R_OK);
    accessSync(join(HARNESS_ROOT, "commitlint.config.mjs"), constants.R_OK);
    return { kind: "consumer", root, repository, harnessRoot: HARNESS_ROOT, commands };
  } catch (error) {
    return { kind: "unavailable", root, repository, reason: `project preflight unavailable: ${String(error)}` };
  }
}

export interface ProjectPreflightResult {
  ok: boolean;
  steps: CiParityStepResult[];
}

/** A failed observation stays absent and does not change the existing preflight's verdict. */
function qualificationSource(root: string): { head: string; clean: boolean; error?: string } {
  try {
    const head = hostWorktreeGit(root, ["rev-parse", "HEAD"]).trim();
    const status = hostWorktreeGit(root, ["status", "--porcelain", "--untracked-files=normal"]).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) return { head: "unknown", clean: false, error: "source head unreadable" };
    return { head, clean: status === "" };
  } catch (error) { return { head: "unknown", clean: false, error: String(error).slice(0, 500) }; }
}

/** Shared commit policy runs against the target range using the installed harness's pinned tools. */
export function runProjectPreflight(
  project: ProjectPreflight,
  deps: PreflightDeps & { testSlot?: TestSlotOptions } = {},
): ProjectPreflightResult {
  const unavailable = (reason: string): ProjectPreflightResult => ({ ok: false, steps: [{ name: "project:unavailable", ok: false, detail: reason }] });
  if (project.kind !== "consumer") return unavailable(project.kind === "unavailable" ? project.reason : "Core requires its existing preflight engine");
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const sourceBefore = spawn === defaultPreflightSpawn ? qualificationSource(project.root) : undefined;
  const steps: ProjectPreflightResult["steps"] = [
    commitlintStep(project.root, deps.range, (file, args, opts) => spawn(file, args.map(arg =>
      arg === join(project.root, "node_modules/.bin/commitlint") ? join(project.harnessRoot, "node_modules/.bin/commitlint") :
      arg === join(project.root, "commitlint.config.mjs") ? join(project.harnessRoot, "commitlint.config.mjs") : arg), opts)),
    emitterChecksStep(project.root, deps.range, spawn),
  ];
  let slot: TestSlotLease | undefined;
  try {
    const memory = (deps.testSlot?.memoryHeadroom ?? readMemoryHeadroom)();
    const peak = deps.testSlot?.memoryBytes ?? TYPECHECK_COLD_PEAK_BYTES;
    if (memory === undefined || !Number.isFinite(memory)) throw new Error("memory headroom unavailable");
    if (memory < peak) throw new Error(`insufficient memory headroom: ${memory} < ${peak}`);
    slot = acquireTestSlot("project-preflight", { memoryBytes: peak, ...deps.testSlot });
    if (slot.outcome !== "acquired" || !testSlotExecutionAllowed(slot)) throw new Error(`resource admission refused: ${slot.note}`);
    for (const command of project.commands) {
      const name = `project:${command.name}`;
      try {
        const launch = lowPriorityCommand(command.file, command.args);
        const result = boundedSuiteLeaf(spawn, name, launch.file, launch.args,
          { cwd: project.root, env: slot.childEnvironment }, LOCAL_FULL_SUITE_TIMEOUT_MS);
        if (result.qualification) result.qualification = { ...result.qualification, command: { file: command.file, args: [...command.args] },
          profile: project.repository, sourceBefore, sourceAfter: qualificationSource(project.root) };
        steps.push({ name, ...result });
      } catch (error) {
        steps.push({ name, ok: false, detail: `${name}: unavailable — ${String(error)}` });
      }
    }
  } catch (error) {
    steps.push({ name: "project:admission", ok: false, detail: `project preflight unavailable: ${String(error)}` });
  } finally { slot?.release(); }
  return { ok: steps.every(step => step.ok), steps };
}
