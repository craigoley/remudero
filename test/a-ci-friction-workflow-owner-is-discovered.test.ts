import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ciFrictionGardenSpec, ciFrictionLadder, expandWorkflowMatrix, gitCiFrictionOwnerSearch, workflowJobCheckNames } from "../src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "../src/lib/ci-friction-remedy.js";
import type { CiFrictionRemedyTask } from "../src/lib/ci-friction-remedy.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { runGarden, type GardenerDeps } from "../src/lib/gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { gitRepo } from "./helpers/git-repo.js";

const FAMILY = "coverage-shard";
const KEY = `check:${FAMILY} (1/8)`;
const ORIGIN = `ci-friction:${KEY}`;
const WORKFLOW = ".github/workflows/ci.yml";
const YAML = 'jobs:\n  coverage:\n    name: coverage-shard (${{ matrix.shard }}/8)\n    strategy:\n      matrix:\n        shard: [1, 2, 3, 4, 5, 6, 7, 8]\n';
const NOW = Date.parse("2026-10-08T12:00:00Z");

function fixture(workflow = YAML) {
  const repo = gitRepo({ kind: "ci-workflow-owner" });
  const put = (file: string, content: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), content);
  };
  put(WORKFLOW, workflow);
  put("src/product.ts", 'const ci = "ci Test coverage";\n');
  const commit = () => {
    repo.git("add", ".");
    repo.git("commit", "-qm", "fixture");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  };
  commit();
  const search = () => gitCiFrictionOwnerSearch(args => repo.git(...args));
  return { repo, put, commit, search };
}

/** Resolve `key` and return why its workflow owner was a gap: it must resolve to no owner and say why. */
function gapFor(search: ReturnType<typeof gitCiFrictionOwnerSearch>, key: string): string {
  assert.equal(locateCiFrictionOwner(key, [], search), undefined);
  const gaps = search.workflowGaps!();
  assert.equal(gaps.length, 1, JSON.stringify(gaps));
  return gaps[0]!.reason;
}

function ladder(search: ReturnType<typeof gitCiFrictionOwnerSearch>, records: readonly LedgerRecord[] = [], tasks: CiFrictionRemedyTask[] = [], receipts = new Set<string>()) {
  return ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: `${FAMILY} (1/8)` }, minutes: 12, rounds: 3, prs: 2 }],
    rounds: [], tasks, receipts, escalated: new Set([ORIGIN]),
    ownerSearch: search, nowMs: NOW, holds: records,
  });
}

test("CI friction resolves a declared matrix job without assigning a generic term to product code", () => {
  const f = fixture();
  const owner = locateCiFrictionOwner(KEY, [], f.search());
  assert.deepEqual(owner?.files, [WORKFLOW]);
  assert.match(owner!.why[0]!, /coverage/);
  for (const generic of ["ci", "Test", "coverage"]) {
    assert.equal(locateCiFrictionOwner(`check:${generic}`, [], f.search()), undefined);
  }
  f.put(WORKFLOW, "jobs:\n  lint:\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.deepEqual(locateCiFrictionOwner("check:lint", [], f.search())?.files, [WORKFLOW]);
  f.put(WORKFLOW, readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  f.commit();
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-shard:test-example-test-ts", ["coverage-shard (1/8): test/example.test.ts"], f.search())?.files, [WORKFLOW]);
});

test("CI friction preserves distinctive ownership and distinguishes unreadable discovery from no owner", () => {
  const f = fixture();
  const signature = "distinctive refusal surface";
  f.put("src/refusal.ts", `throw new Error("${signature}");\n`);
  f.put("scripts/refusal.mjs", `throw new Error("${signature}");\n`);
  f.commit();
  const reader = f.search();
  const refusalKey = `check:ci-log:${FAMILY}:refusal`;
  const details = [`coverage-shard (1/8): ${signature}`];
  const specific = locateCiFrictionOwner(refusalKey, details, reader);
  assert.deepEqual(specific?.files, ["scripts/refusal.mjs", "src/refusal.ts"]);
  assert.match(reader.evidence!(refusalKey, details, specific).fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(locateCiFrictionOwner("check:absent-job", [], f.search()), undefined);
  f.put(WORKFLOW, "jobs: [");
  f.commit();
  assert.match(gapFor(f.search(), KEY), /unreadable.*ci.yml/i);
  f.put(WORKFLOW, YAML + '  other:\n    name: coverage-shard (${{ matrix.shard }}/8)\n    strategy:\n      matrix:\n        shard: [1, 2]\n');
  f.commit();
  assert.match(gapFor(f.search(), KEY), /ambiguous.*coverage/i);
  f.put(WORKFLOW, 'jobs:\n  coverage:\n    name: coverage-shard (${{ inputs.shard }}/8)\n');
  f.commit();
  assert.match(gapFor(f.search(), KEY), /unsupported.*coverage/i);
  for (const malformed of ["null\n", "jobs: []\n", "jobs:\n  coverage: null\n", "jobs:\n  coverage:\n    name: 42\n"]) {
    f.put(WORKFLOW, malformed);
    f.commit();
    assert.match(gapFor(f.search(), KEY), /unreadable.*unsupported/i);
  }
  f.put(WORKFLOW, YAML.replace("[1, 2, 3, 4, 5, 6, 7, 8]", "[one, two]"));
  f.commit();
  const named = f.search();
  assert.equal(locateCiFrictionOwner(KEY, [], named), undefined, "a string shard names another check");
  assert.deepEqual(named.workflowGaps!(), []);
  f.put(WORKFLOW, 'jobs:\n  unknown:\n    name: ${{ inputs.check }}\n');
  f.commit();
  assert.match(gapFor(f.search(), KEY), /unsupported.*coverage.*inputs\.check/i);
});

test("CI friction reconsiders only a no-owner hold once per changed ownership witness", () => {
  const f = fixture();
  const oldRefusal = `no code in src/ or scripts/ names ${KEY}, so no remedy can be drafted against it`;
  const hold: LedgerRecord = { step: "ci-friction.remedy_escalated", origin: ORIGIN, why: oldRefusal };
  const inventory = ladder(f.search(), [hold]);
  assert.equal(inventory.next?.decision.kind, "draft");
  const decision = inventory.next!.decision;
  assert.equal(decision.kind, "draft");
  if (decision.kind !== "draft") assert.fail("expected a draft");
  const revalidation = decision.reconsideration!;
  assert.equal(revalidation.oldRefusal, oldRefusal);
  assert.match(revalidation.evidence.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(revalidation.evidence.revision, f.repo.git("rev-parse", "HEAD"));
  assert.deepEqual(revalidation.owner.files, [WORKFLOW]);
  assert.equal(ladder(f.search(), [{ ...hold, hold_reason: "no-owner", ownership_evidence: { fingerprint: "0".repeat(64), revision: "0".repeat(40) } }]).next?.decision.kind, "draft");
  assert.equal(ladder(f.search(), [{ ...hold, hold_reason: "operator" }]).next, undefined);
  const consumed: LedgerRecord = { step: "ci-friction.scorecard", ownership_reconsiderations: [revalidation] };
  assert.equal(ladder(f.search(), [hold, consumed]).next, undefined);
  f.put("src/unrelated.ts", 'const churn = true;\n');
  f.commit();
  assert.equal(ladder(f.search(), [hold, consumed]).next, undefined);
  f.put(WORKFLOW, YAML + "  unrelated:\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.equal(ladder(f.search(), [hold, consumed]).next, undefined);
  f.put(WORKFLOW, YAML.replace("[1, 2, 3, 4, 5, 6, 7, 8]", "[1, 2]"));
  f.commit();
  assert.equal(ladder(f.search(), [hold, consumed]).next?.decision.kind, "draft");
  for (const why of ["operator hold", "2 remedy rung(s) did not move cause", "unknown legacy reason"]) {
    assert.equal(ladder(f.search(), [{ ...hold, why }]).next, undefined);
  }
  assert.equal(ladder(f.search(), []).next, undefined);
  assert.equal(ladder(f.search(), [hold], [], new Set([ORIGIN])).next, undefined);
  const exhaustedOrigin = `${ORIGIN}#r3`;
  const exhausted = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: `${FAMILY} (1/8)` }, minutes: 12, rounds: 2, prs: 2 }],
    rounds: [-1800000, 1800000].map((offset, i) => ({ pr: i + 1, cause: { kind: "check", name: `${FAMILY} (1/8)` }, minutes: 6, at: new Date(NOW - 3600000 + offset).toISOString() })),
    tasks: [{ id: "W1-T2", origin: `${ORIGIN}#r2`, status: "merged", retired: false, files: [WORKFLOW], mergedAt: new Date(NOW - 3600000).toISOString() }],
    receipts: new Set(), escalated: new Set([exhaustedOrigin]), ownerSearch: f.search(), nowMs: NOW,
    holds: [{ ...hold, origin: exhaustedOrigin, hold_reason: "no-owner" }],
  });
  assert.equal(exhausted.next, undefined);
  assert.equal(exhausted.ladder[0]!.state, "escalated");
  for (const task of [
    { id: "W1-T1", status: "queued", retired: false },
    { id: "W1-T1", status: "blocked", retired: true },
  ]) {
    assert.equal(ladder(f.search(), [hold], [{ ...task, origin: ORIGIN, files: [WORKFLOW] }]).next, undefined);
  }
  const changed = ladder(f.search(), [hold, consumed]).next!.decision;
  if (changed.kind !== "draft") assert.fail("expected new witness draft");
  const sameWitness = { ...hold, hold_reason: "no-owner", ownership_evidence: changed.reconsideration!.evidence };
  assert.equal(ladder(f.search(), [sameWitness, consumed]).next, undefined);
  const absent = fixture("jobs:\n  unrelated:\n    runs-on: ubuntu-latest\n");
  assert.equal(ladder(absent.search(), [hold]).next, undefined);
  const stateDir = join(f.repo.dir, "state");
  mkdirSync(stateDir);
  const records: LedgerRecord[] = [hold,
    { step: "pr.opened", run_id: "r", pr_url: "https://github.com/acme/repo/pull/1", ts: new Date(NOW - 3600000).toISOString() },
    { step: "fix.dispatch", run_id: "r", mode: `${FAMILY} (1/8)`, round: 1, ts: new Date(NOW - 1800000).toISOString() },
  ];
  const deps: GardenerDeps = { repoRoot: f.repo.dir, stateDir, seed: 1, clock: clockFromMillisFn(() => NOW),
    log: (step, extra) => records.push({ step, ...extra }),
    openWorkspace: () => ({ root: f.repo.dir, branch: "fixture", land: () => { assert.fail("fixture does not publish"); }, dispose: () => {} }) };
  const spec = ciFrictionGardenSpec(deps, { ownerSearch: f.search(), planState: () => ({ tasks: [] }),
    ledgerRecords: () => records, mintTaskId: () => { throw new Error("fixture filing failure"); } });
  const pass = runGarden(spec, deps);
  assert.equal(pass.prUrl, undefined);
  const card = records.find(row => row.step === "ci-friction.scorecard")!;
  assert.equal(card.filing_failed, 1);
  const saved = card.ownership_reconsiderations as typeof revalidation[];
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.decision, "draft");
  assert.equal(saved[0]!.oldRefusal, oldRefusal);
  assert.equal(saved[0]!.evidence.revision, f.repo.git("rev-parse", "HEAD"));
  assert.deepEqual(saved[0]!.owner.files, [WORKFLOW]);
  assert.equal(spec.inventory().next, undefined, "even a failed filing consumes this witness once");
});

test("CI friction workflow ownership uses real pinned git reads and reports native read failures", () => {
  const f = fixture();
  const reader = f.search();
  const revision = f.repo.git("rev-parse", "HEAD");
  const owner = locateCiFrictionOwner(KEY, [], reader);
  assert.deepEqual(owner?.files, [WORKFLOW]);
  f.put(WORKFLOW, "jobs:\n  replaced:\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.deepEqual(locateCiFrictionOwner(KEY, [], reader)?.files, [WORKFLOW]);
  assert.equal(reader.fileExists("src/product.ts"), true);
  assert.equal(reader.fileExists("src/missing.ts"), false);
  const broken = gitCiFrictionOwnerSearch(args => f.repo.git(...args), "missing-ref");
  assert.throws(() => broken.fileExists("src/product.ts"), /missing-ref|revision/i);
  assert.throws(() => broken.filesContaining("ci"), /missing-ref|revision/i);
  assert.throws(() => locateCiFrictionOwner(KEY, [], broken), /missing-ref|revision/i);
  assert.throws(() => gitCiFrictionOwnerSearch(() => "not-a-sha").fileExists("src/product.ts"), /invalid revision/);
  const lost = fixture();
  const lostReader = lost.search();
  assert.equal(lostReader.fileExists("src/product.ts"), true);
  lost.repo.cleanup();
  assert.throws(() => lostReader.filesContaining("ci"), /cannot change to/);
  assert.throws(() => locateCiFrictionOwner(KEY, [], lostReader), /cannot change to/);
  const blob = f.repo.git("rev-parse", `${revision}:${WORKFLOW}`);
  rmSync(join(f.repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const unreadable = gitCiFrictionOwnerSearch(args => f.repo.git(...args), revision);
  assert.throws(() => locateCiFrictionOwner(KEY, [], unreadable), /blob|object|bad file/i);
  assert.throws(() => unreadable.fileExists(WORKFLOW), /cat-file/);
  const productBlob = f.repo.git("rev-parse", `${revision}:src/product.ts`);
  rmSync(join(f.repo.dir, ".git", "objects", productBlob.slice(0, 2), productBlob.slice(2)));
  assert.throws(() => unreadable.filesContaining("ci"), /unable to read/i);
  const stateDir = join(f.repo.dir, "state");
  mkdirSync(stateDir);
  const statePath = join(stateDir, "ci-friction-gardener.json");
  const previous = JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 } }, lastPass: { fingerprint: "previous" } });
  writeFileSync(statePath, previous);
  const events: string[] = [];
  const deps: GardenerDeps = { repoRoot: f.repo.dir, stateDir, clock: clockFromMillisFn(() => NOW),
    log: step => events.push(step), openWorkspace: () => { throw new Error("unreadable input must not act"); } };
  const spec = ciFrictionGardenSpec(deps, { ownerSearch: unreadable, mintTaskId: () => "W1-T1", planState: () => ({ tasks: [] }),
    ledgerRecords: () => [
      { step: "ci-friction.remedy_escalated", origin: ORIGIN, why: `no code in src/ or scripts/ names ${KEY}, so no remedy can be drafted against it` },
      { step: "pr.opened", run_id: "r", pr_url: "https://github.com/acme/repo/pull/1", ts: new Date(NOW - 3600000).toISOString() },
      { step: "fix.dispatch", run_id: "r", mode: `${FAMILY} (1/8)`, round: 1, ts: new Date(NOW - 1800000).toISOString() },
    ] });
  assert.throws(() => runGarden(spec, deps), /blob|object|bad file/i);
  assert.equal(readFileSync(statePath, "utf8"), previous);
  assert.equal(events.includes("ci-friction.scorecard"), false);
});

test("CI friction resolves ci-gate to the merge-queue producer when ci.yml and ci-gate.yml both declare it", () => {
  const f = fixture();
  const real = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const GATE = ".github/workflows/ci-gate.yml";
  f.put(WORKFLOW, real(WORKFLOW));
  f.put(GATE, real(GATE));
  f.commit();
  const owner = locateCiFrictionOwner("check:ci-gate", [], f.search());
  assert.deepEqual(owner?.files, [WORKFLOW]);
  assert.match(owner!.why[0]!, /merge_group.*ci-gate\.yml:ci-gate/);
  const gateLadder = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: "ci-gate" }, minutes: 12, rounds: 3, prs: 2 }],
    rounds: [], tasks: [], receipts: new Set(), escalated: new Set(["ci-friction:check:ci-gate"]),
    ownerSearch: f.search(), nowMs: NOW,
    holds: [{ step: "ci-friction.remedy_escalated", origin: "ci-friction:check:ci-gate", why: "no code in src/ or scripts/ names check:ci-gate, so no remedy can be drafted against it" }],
  });
  const decision = gateLadder.next?.decision;
  if (decision?.kind !== "draft") assert.fail(`expected the ci-gate cause to draft, got ${decision?.kind}`);
  assert.deepEqual(decision.reconsideration?.owner.files, [WORKFLOW]);
  // Two producers on the queue is still ambiguity, and so is a job whose `if:` keeps it off the queue.
  const both = 'on: [pull_request, merge_group]\njobs:\n  ci-gate:\n    runs-on: ubuntu-latest\n';
  f.put(GATE, both);
  f.put(WORKFLOW, both);
  f.commit();
  assert.match(gapFor(f.search(), "check:ci-gate"), /ambiguous.*ci-gate/);
  f.put(WORKFLOW, "on:\n  merge_group:\njobs:\n  ci-gate:\n    if: github.event_name != 'merge_group'\n    runs-on: ubuntu-latest\n");
  f.put(GATE, "on: pull_request\njobs:\n  ci-gate:\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.match(gapFor(f.search(), "check:ci-gate"), /ambiguous.*ci-gate/);
});

test("CI friction expands codeql.yml's language matrix into its checks and never fails a pass over a workflow it cannot name", () => {
  const f = fixture();
  const real = new URL("../.github/workflows/", import.meta.url);
  const files = readdirSync(real).filter(file => /\.ya?ml$/.test(file));
  assert.ok(files.includes("codeql.yml") && files.length >= 5, `the fixture copies every real workflow (${files.length})`);
  for (const file of files) f.put(`.github/workflows/${file}`, readFileSync(new URL(file, real), "utf8"));
  f.commit();
  const CODEQL = ".github/workflows/codeql.yml";
  assert.deepEqual(workflowJobCheckNames("Analyze (${{ matrix.language }})",
    { include: [{ language: "javascript-typescript", "build-mode": "none" }, { language: "actions", "build-mode": "none" }] }),
  ["Analyze (javascript-typescript)", "Analyze (actions)"]);
  const search = f.search();
  for (const check of ["Analyze (javascript-typescript)", "Analyze (actions)"]) {
    assert.deepEqual(locateCiFrictionOwner(`check:${check}`, [], search)?.files, [CODEQL], check);
  }
  // Every check any real workflow declares resolves without a gap.
  let declared = 0;
  for (const file of files) {
    const workflow = parseDocument(readFileSync(new URL(file, real), "utf8")).toJS() as { jobs?: Record<string, { name?: string; uses?: string; strategy?: { matrix?: unknown } }> };
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const names = workflowJobCheckNames(job.name ?? jobId, job.strategy?.matrix);
      assert.ok(Array.isArray(names), `${file}:${jobId} names its checks (${String(names)})`);
      for (const name of names) {
        declared += 1;
        // A reusable-workflow caller's checks are `<name> / <called job>`; its bare name is no check of its own.
        const check = job.uses ? `${name} / called-job` : name;
        // ci-gate.yml's `edited`-only re-aggregation defers to ci.yml's merge-queue producer.
        const owner = `${file}:${jobId}` === "ci-gate.yml:ci-gate" ? "ci.yml" : file;
        assert.deepEqual(locateCiFrictionOwner(`check:${check}`, [], search)?.files, [`.github/workflows/${owner}`],
          `${file}:${jobId} owns ${check} ${JSON.stringify(search.workflowGaps!())}`);
      }
    }
  }
  assert.deepEqual(locateCiFrictionOwner("check:scan", [], search)?.files, [".github/workflows/semgrep.yml"],
    "osv-scanner.yml's `scan` caller reports `scan / …` checks, so semgrep.yml's `Scan` owns the bare name");
  assert.ok(declared >= 30, `every real job was read (${declared} checks)`);
  assert.deepEqual(search.workflowGaps!(), []);

  // An unexpandable name is a gap for its own check, with a reason row, and the pass still completes.
  f.put(".github/workflows/odd.yml", "on: push\njobs:\n  analyze:\n    name: Analyze (${{ inputs.language }})\n    runs-on: ubuntu-latest\n");
  f.commit();
  assert.deepEqual(workflowJobCheckNames("Analyze (${{ inputs.language }})", undefined), "${{ inputs.language }} has no literal value");
  const stateDir = join(f.repo.dir, "state");
  mkdirSync(stateDir);
  const rows: LedgerRecord[] = [
    { step: "pr.opened", run_id: "r", pr_url: "https://github.com/acme/repo/pull/1", ts: new Date(NOW - 3600000).toISOString() },
    { step: "fix.dispatch", run_id: "r", mode: "Analyze (javascript-typescript)", round: 1, ts: new Date(NOW - 1800000).toISOString() },
  ];
  const deps: GardenerDeps = { repoRoot: f.repo.dir, stateDir, seed: 1, clock: clockFromMillisFn(() => NOW),
    log: (step, extra) => rows.push({ step, ...extra }),
    openWorkspace: () => ({ root: f.repo.dir, branch: "fixture", land: () => { assert.fail("fixture does not publish"); }, dispose: () => {} }) };
  const spec = ciFrictionGardenSpec(deps, { ownerSearch: f.search(), planState: () => ({ tasks: [] }), ledgerRecords: () => rows,
    mintTaskId: () => { throw new Error("fixture filing failure"); } });
  const inventory = spec.inventory();
  const gap = rows.find(row => row.step === "ci-friction.workflow_ownership_unresolved");
  assert.match(JSON.stringify(gap?.gaps), /Analyze \(javascript-typescript\).*unsupported.*odd\.yml:analyze.*inputs\.language/);
  assert.equal(inventory.next?.decision.kind, "escalate");
  if (inventory.next?.decision.kind !== "escalate") assert.fail("expected the gap to escalate");
  assert.match(inventory.next.decision.why, /workflow ownership unsupported for Analyze \(javascript-typescript\)/);
  assert.deepEqual(spec.scorecard(inventory, { actions: [], acting: [] }).workflow_ownership_unresolved, inventory.workflowGaps);
});

test("CI friction expands a workflow matrix the way GitHub does, and says why when it cannot", () => {
  assert.deepEqual(expandWorkflowMatrix(undefined), [{}]);
  assert.deepEqual(expandWorkflowMatrix({ os: ["a", "b"], node: [1, 2], exclude: [{ os: "b", node: 2 }], include: [{ os: "a", extra: true }, { os: "c" }] }),
    [{ os: "a", node: 1, extra: true }, { os: "a", node: 2, extra: true }, { os: "b", node: 1 }, { os: "c" }]);
  assert.equal(expandWorkflowMatrix("${{ fromJSON(needs.plan.outputs.matrix) }}"), "matrix is not a literal mapping");
  assert.equal(expandWorkflowMatrix({ os: "${{ inputs.os }}" }), "matrix.os is not a literal list");
  assert.equal(expandWorkflowMatrix({ include: ["a"] }), "matrix.include is not a literal list of mappings");
  assert.equal(expandWorkflowMatrix({ exclude: "a" }), "matrix.exclude is not a literal list of mappings");
  assert.deepEqual(workflowJobCheckNames("lint", undefined), ["lint"]);
  assert.deepEqual(workflowJobCheckNames("t (${{ matrix.os }}, ${{ matrix.node }})", { os: ["a"], node: [1, 2] }), ["t (a, 1)", "t (a, 2)"]);
  assert.equal(workflowJobCheckNames("t (${{ matrix.os }})", { os: [{ name: "a" }] }), "${{ matrix.os }} has no literal value");
  assert.equal(workflowJobCheckNames("t (${{ matrix.os }})", { os: [] }), "matrix expands to no combination");
  assert.equal(workflowJobCheckNames("t (${{ matrix.os }})", "${{ fromJSON(x) }}"), "matrix is not a literal mapping");
});
