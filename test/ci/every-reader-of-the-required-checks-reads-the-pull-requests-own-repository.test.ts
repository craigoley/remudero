import assert from "node:assert/strict";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { fixCommand, type FixCommandHost } from "#src/cli/commands/fix.js";
import {
  readCiGateRequiredContract, readCiGateRequiredNames, resolveCiGateRequiredSource,
} from "#src/lib/ci-gate-required.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { classifyMergeRefusal, ciTimeoutNotReadyChecks, buildSweepEffects, runSweep, type OpenPrView } from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const owner = "craigoley";
const repo = "managed-ci-fixture";
const repository = `${owner}/${repo}`;
const headSha = "a".repeat(40);
const headRefName = "operator/fixture";
const prUrl = `https://github.com/${repository}/pull/8`;
const pending = { name: "managed-preview", status: "QUEUED" };
const green = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const red = (name: string) => ({ ...green(name), conclusion: "FAILURE" });
const plan = { tasks: [], byId: new Map() };
const workflowFile = ".github/workflows/ci-gate.yml";

function fixture(t: TestContext, names = ["managed-build", "managed-preview"]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ci-gate-source-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkoutRoot = join(root, "repos", repo);
  mkdirSync(join(checkoutRoot, ".github", "workflows"), { recursive: true });
  writeFileSync(join(checkoutRoot, workflowFile), `jobs:\n  ci-gate:\n    env:\n      REQUIRED: '${JSON.stringify(names)}'\n`);
  const config = { root, claudeBin: "/bin/true" };
  const ledgerPath = ledgerPathFor(config);
  mkdirSync(join(root, "state"));
  writeFileSync(ledgerPath, "");
  return { checkoutRoot, config, ledgerPath };
}

const pr: OpenPrView = {
  prNumber: 8, prUrl, headSha, headRefName, checksState: "red", reviewState: "none",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
  redRequiredChecks: ["head-identity-gate"],
};
const livePr = {
  number: 8, html_url: prUrl, state: "open", draft: false, title: "fixture", body: "",
  head: { sha: headSha, ref: headRefName, repo: { full_name: repository } },
  base: { ref: "main" }, mergeable_state: "clean", commits: 1, changed_files: 1,
  updated_at: pr.lastActivityAt,
};

function effects(f: ReturnType<typeof fixture>, options: Partial<Parameters<typeof buildSweepEffects>[0]> = {}) {
  return buildSweepEffects({
    ...f, owner, repo, localRepoName: "remudero", repoRoot: REPO_ROOT, plan, runId: "SWEEP-FIXTURE",
    log: () => {}, ghJsonImpl: (args) => assert.fail(args.join(" ")),
    armSessionPrsOverride: false, spawnWallClockBoundMsOverride: 1000, ...options,
  });
}

test("W1-T12942 criterion 1: head identity repair sees the managed repository's green checks", async (t) => {
  const f = fixture(t);
  const ports = effects(f, { ghJsonImpl: (args) => {
    const path = args.at(-1);
    if (args[0] === "pr") return {
      headRefOid: headSha, statusCheckRollup: [red("head-identity-gate"), red("ci-gate"), green("managed-build"), green("managed-preview")],
    };
    if (path?.endsWith("required_status_checks")) return { contexts: ["ci-gate"] };
    if (path?.includes("/commits?")) return [[{ commit: { message: "fix(ci): repair fixture", committer: {} }, author: null }]];
    if (path?.includes("/files?")) return [[{ filename: "src/example.ts" }]];
    if (path?.endsWith("/pulls/8")) return livePr;
    return assert.fail(args.join(" "));
  } }).headRehome;
  assert.ok(ports);
  const wrote: string[] = [];
  await runSweep([pr], {
    ledgerPath: f.ledgerPath, runId: "SWEEP-IDENTITY",
    arm: () => assert.fail("unexpected arm"),
    close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    headRehome: {
      ...ports,
      observe: async (candidate) => {
        const observed = await ports.observe(candidate);
        assert.deepEqual(observed.pendingChecks, []);
        return observed;
      },
      judgeQuiet: async () => ({ quiet: true, reason: "fixture" }),
      readHead: async () => headSha,
      appendIdentityCommit: async (_candidate, _sha, message) => {
        wrote.push(message);
        return "b".repeat(40);
      },
    },
  });
  assert.equal(wrote.length, 1);
  assert.match(wrote[0], /Remudero-Task: PR-8$/);
});

test("W1-T12942 criterion 2: board and fix views report the managed repository's red and pending checks", async (t) => {
  const { config, ledgerPath } = fixture(t);
  const fetch = (args: string[]) => {
    const path = args.at(-1);
    if (path?.includes("state=open")) return [livePr];
    if (path?.endsWith("/pulls/8")) return livePr;
    if (path?.includes("/check-runs?")) return { check_runs: [red("managed-build"), pending, { name: "ci-gate", status: "in_progress" }] };
    if (path?.endsWith("/status")) return { statuses: [] };
    return [];
  };
  const requiredContexts = () => ["ci-gate"];
  const [board] = await buildOpenPrViewsAsync(owner, repo, ledgerPath, {
    fetchAsync: fetch, requiredContexts, readMainPlan: () => plan, fetchCiFailureEvidence: () => [],
  });
  assert.ok(board);
  const fixHost = {
    workerBoundaryStack: { loadedModule: undefined },
    buildSweepEffects,
  } as FixCommandHost;
  let fixView: OpenPrView | undefined;
  await fixCommand(["8", "--repo", repo], {
    config, self: { owner, repo: "remudero" }, fetch, readRequiredContexts: requiredContexts,
    contributorAdmission: async () => {},
    route: (_state, view) => {
      fixView = view;
      return Promise.resolve({ outcome: "refused" as const, reason: "fixture" });
    },
  }, fixHost);
  assert.ok(fixView);
  for (const view of [board, fixView]) {
    assert.deepEqual(view.redRequiredChecks, ["managed-build"]);
    assert.deepEqual(view.pendingRequiredChecks, ["managed-preview"]);
  }
});

test("W1-T12942 criterion 3: timeout and merge refusal use the same managed required checks", (t) => {
  const read = effects(fixture(t)).readCiGateRequired;
  assert.ok(read);
  assert.deepEqual(ciTimeoutNotReadyChecks([], [red("ci-gate"), green("managed-build"), pending], read()), {
    names: ["managed-preview"], neverRegistered: [], source: "rollup-required",
  });
  const later = "2026-11-15T12:30:00Z";
  const newest = [
    { ...red("ci-gate"), completedAt: "2026-11-15T12:10:00Z" },
    { ...green("managed-build"), completedAt: later },
    { ...green("managed-preview"), completedAt: later },
  ];
  assert.equal(classifyMergeRefusal('Required status check "ci-gate" is failing', newest, read()).kind, "stale-check");
});

test("W1-T12942 criterion 4: self keeps its workflow's exact list and an unreadable managed contract is named once", (t) => {
  const f = fixture(t);
  const self = { owner, repo: "remudero" };
  const roots = { self, selfRoot: REPO_ROOT, configRoot: f.config.root };
  const expected = JSON.parse(parse(readFileSync(join(REPO_ROOT, workflowFile), "utf8")).jobs["ci-gate"].env.REQUIRED);
  assert.ok(expected.includes("lint-plan"), "the engine workflow provides the positive control");
  assert.deepEqual(readCiGateRequiredContract(resolveCiGateRequiredSource(self, roots)), { kind: "names", names: expected });
  assert.deepEqual(effects(f, { repo: self.repo }).readCiGateRequired?.(), expected);

  const path = join(f.checkoutRoot, workflowFile);
  const source = resolveCiGateRequiredSource({ owner, repo }, roots);
  rmSync(path);
  const missing = readCiGateRequiredContract(source);
  assert.equal(missing.kind, "unreadable");
  assert.equal(missing.repository, repository);
  assert.equal(missing.path, path);
  assert.match(missing.reason, /ENOENT/);
  assert.deepEqual(readCiGateRequiredContract({ ...source, isSelf: true }), { kind: "names", names: [] });
  writeFileSync(path, "jobs: {}");
  assert.equal(readCiGateRequiredContract(source).kind, "unreadable");
  writeFileSync(path, "jobs: { ci-gate: { env: { REQUIRED: '[1]' } } }");
  assert.equal(readCiGateRequiredContract(source).kind, "unreadable");
  writeFileSync(path, "jobs: [");
  assert.equal(readCiGateRequiredContract(source).kind, "unreadable");

  const diagnostics: Array<Record<string, unknown>> = [];
  const unknown = effects(f, { log: (step, fields) => {
    if (step === "ci_gate.required_unreadable") diagnostics.push(fields ?? {});
  } });
  assert.deepEqual(unknown.readCiGateRequired?.(), []);
  assert.deepEqual(unknown.readCiGateRequired?.(), []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].repository, repository);
  assert.equal(diagnostics[0].path, path);
});

// @source-text-subject: the census tracks references to the legacy path-based reader across src.
test("W1-T12942 criterion 5: the typed reader refuses a bare path and src has only the existing compatibility callers", () => {
  const sourceMustNameRepository: string extends Parameters<typeof readCiGateRequiredContract>[0] ? false : true = true;
  const namesMustNameRepository: string extends Parameters<typeof readCiGateRequiredNames>[0] ? false : true = true;
  assert.ok(sourceMustNameRepository && namesMustNameRepository);
  const files = globSync("src/**/*.ts", { cwd: REPO_ROOT });
  assert.ok(files.includes("src/lib/sweep.ts"));
  const legacyReferences = new Map<string, number>();
  for (const file of files) {
    const sourceText = readFileSync(join(REPO_ROOT, file), "utf8");
    const count = sourceText.match(/\breadCiGateRequiredChecks\b/g)?.length ?? 0;
    if (count > 0) legacyReferences.set(file, count);
  }
  assert.deepEqual(legacyReferences, new Map([
    ["src/lib/ci-gate-required.ts", 1], // Compatibility declaration.
    ["src/lib/dep-review.ts", 3], // Import and two calls fed by W1-T12940's source.
    ["src/cli/commands/daemon.ts", 2], // Import and a call fed by daemonTargetCheckoutRoot.
  ]));
});
