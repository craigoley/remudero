import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ciFrictionGardenSpec, ciFrictionRoundsFromLedger, gitCiFrictionOwnerSearch, withoutBirthRounds, workflowJobScripts, type CiFrictionRound,
} from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner, type OwnerSearch } from "#src/lib/ci-friction-remedy.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TEST = "test/x.test.ts";
const SOURCE = "src/lib/x.ts";
const WORKFLOW = ".github/workflows/ci.yml";
const round = (pr: number, name = `test:${TEST}`): CiFrictionRound => ({ pr, cause: { kind: "check", name }, minutes: 10 });
const prsOf = (rounds: readonly CiFrictionRound[]) => rounds.map((r) => r.pr);

test("a ci-friction round whose pull request's own diff reaches the failing test is dropped, as its birth round is", () => {
  // Built at run time: import-like text inside a string literal would read as this file's own relative import.
  const imports = (specifier: string) => ["import", "{ x }", "from", JSON.stringify(specifier)].join(" ");
  const files = new Map([[TEST, `${imports("../src/lib/x.js")};\n${imports("./helper.js")};\nexport const t = x;\n`]]);
  const diffs = new Map<number, string[]>([[1, [TEST]], [2, [SOURCE]], [3, ["docs/unrelated.md"]], [4, ["src/lib/other.ts"]]]);
  const search = {
    changedByPr: (pr: number) => diffs.get(pr),
    fileExists: (file: string) => files.has(file),
    readSource: (file: string) => files.get(file),
  };
  const rounds = [1, 2, 3, 4, 5].map((pr) => round(pr));
  // #1 changed the test, #2 changed a module the test imports at runtime: both are their own development.
  assert.deepEqual(prsOf(withoutBirthRounds(rounds, search)), [3, 4, 5]);
  // A non-test cause is never dropped by a diff.
  assert.deepEqual(prsOf(withoutBirthRounds([round(1, "ci-log:commitlint")], search)), [1]);
  // A flaky-keyed cause is the same test file.
  assert.deepEqual(prsOf(withoutBirthRounds([round(2, `test:${TEST}:flaky`), round(3, `test:${TEST}:flaky`)], search)), [3]);
  // A test no longer on main contributes only itself: its imports cannot be read, so a module change does not reach it.
  assert.deepEqual(prsOf(withoutBirthRounds([round(1), round(2)], { ...search, fileExists: () => false })), [2]);
  // No readable source seam keeps a module change's round; the test file itself still reaches.
  assert.deepEqual(prsOf(withoutBirthRounds([round(1), round(2)], { changedByPr: search.changedByPr })), [2]);
  // No provenance seam at all keeps every round.
  assert.deepEqual(prsOf(withoutBirthRounds(rounds, {})), [1, 2, 3, 4, 5]);
});

test("a ci-friction round is still dropped as a birth round beside a diff seam that names nothing for it", () => {
  const search = { addedByPr: (file: string) => (file === TEST ? 7 : undefined), changedByPr: () => undefined };
  assert.deepEqual(prsOf(withoutBirthRounds([round(7), round(8)], search)), [8]);
});

test("the git owner search lists the files a pull request's squash merge changed, and nothing for a pull request it cannot see", (t) => {
  const repo = gitRepo({ kind: "changed-by-pr" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put(TEST, "a\n");
  put(SOURCE, "a\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "test(x): add the x suite (#101)");
  put(SOURCE, "b\n");
  repo.git("commit", "-qam", "fix(x): change the module (#102)");
  put("docs/n.md", "n\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "docs: a note with no pull request number");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const search = gitCiFrictionOwnerSearch((args) => repo.git(...args));
  assert.deepEqual([...search.changedByPr!(101)!].sort(), [SOURCE, TEST]);
  assert.deepEqual(search.changedByPr!(102), [SOURCE]);
  assert.equal(search.changedByPr!(103), undefined, "an unknown pull request is not an empty diff");
  assert.throws(() => gitCiFrictionOwnerSearch((args) => repo.git(...args), "missing-ref").changedByPr!(101), /missing-ref|revision/i);
});

function pricedAfter(t: TestContext, extra: Partial<OwnerSearch>, journaled: boolean): string[] {
  const repo = gitRepo({ kind: "reach-inventory" });
  t.after(() => repo.cleanup());
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir);
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 11, head_sha: "aaa", ts: "2026-10-16T00:00:00.000Z" } as LedgerRecord,
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "aaa", elapsed_ms: 600_000, ts: "2026-10-16T01:00:00.000Z",
      ci_failures: [{ check: "ci-shard (1/8)", signature: TEST }] } as LedgerRecord,
  ];
  assert.equal(ciFrictionRoundsFromLedger(records).length, 1, "positive control: the ledger holds the round");
  const deps: GardenerDeps = { repoRoot: repo.dir, stateDir, seed: 1, clock: clockFromMillisFn(() => NOW), log: () => {},
    openWorkspace: () => { throw new Error("an inventory opens no workspace"); } };
  const ownerSearch: OwnerSearch & { historyRevision?: () => string } = {
    filesContaining: () => [], fileExists: () => false, ...(journaled ? { historyRevision: () => "r1", addedByPr: () => undefined } : {}), ...extra,
  };
  const spec = ciFrictionGardenSpec(deps, { ownerSearch, planState: () => ({ tasks: [] }), ledgerRecords: () => records, mintTaskId: () => "W1-T1" });
  return spec.inventory().priced.map((p) => p.cause.name);
}

test("a ci-friction pass prices no cause from a round whose pull request's own diff reaches its failing test", (t) => {
  for (const journaled of [false, true]) {
    assert.deepEqual(pricedAfter(t, {}, journaled), [`test:${TEST}`], "an unreached round is priced");
    assert.deepEqual(pricedAfter(t, { changedByPr: (pr) => (pr === 11 ? [TEST] : undefined) }, journaled), [], `a reached round is dropped (journaled: ${journaled})`);
    assert.deepEqual(pricedAfter(t, { changedByPr: (pr) => (pr === 99 ? [TEST] : ["docs/n.md"]) }, journaled), [`test:${TEST}`], "another pull request's diff does not reach it");
  }
});

// ── a workflow-owned cause names the script its job runs ──────────────────────────────────────

function workflowRepo(t: TestContext, workflow: string, files: Record<string, string> = {}) {
  const repo = gitRepo({ kind: "workflow-script-owner" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put(WORKFLOW, workflow);
  for (const [file, text] of Object.entries(files)) put(file, text);
  const commit = () => {
    repo.git("add", ".");
    repo.git("commit", "-qm", "fixture");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  };
  commit();
  return { repo, put, commit, search: () => gitCiFrictionOwnerSearch((args) => repo.git(...args)) };
}
const job = (...runs: string[]) => `jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${runs.map((run) => `      - run: ${run}\n`).join("")}`;

test("a workflow-owned ci-friction cause names the script its job runs, never the workflow file", (t) => {
  const f = workflowRepo(t, job("npm run --silent lint:gate"), {
    "package.json": JSON.stringify({ scripts: { "lint:gate": "node --import tsx scripts/lint-gate.mjs --strict", test: "node --test" } }),
    "scripts/lint-gate.mjs": "export {};\n",
  });
  const owner = locateCiFrictionOwner("check:lint", [], f.search());
  assert.deepEqual(owner?.files, ["scripts/lint-gate.mjs"]);
  assert.match(owner!.why[0]!, /scripts\/lint-gate\.mjs: run by job lint of \.github\/workflows\/ci\.yml for lint/);
  const before = f.search();
  const fingerprint = before.evidence!("check:lint", [], locateCiFrictionOwner("check:lint", [], before)).fingerprint;
  f.put("scripts/lint-gate.mjs", "export const changed = true;\n");
  f.commit();
  const after = f.search();
  assert.notEqual(after.evidence!("check:lint", [], locateCiFrictionOwner("check:lint", [], after)).fingerprint, fingerprint,
    "an edit to the script is a changed ownership witness");
  // A timeout in the job is owned by the same script: the infrastructure route resolves the same job.
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:lint:timed-out", ["lint: timed out with no test result"], f.search())?.files, ["scripts/lint-gate.mjs"]);
});

test("a workflow-owned ci-friction cause escalates as having no owner when its job runs no single script", (t) => {
  const both = workflowRepo(t, job("node scripts/a.mjs", "bash ./scripts/b.sh"), { "scripts/a.mjs": "export {};\n", "scripts/b.sh": "true\n" });
  const reader = both.search();
  assert.equal(locateCiFrictionOwner("check:lint", [], reader), undefined, "two scripts and nothing says which owns the failure");
  assert.match(reader.workflowGaps!()[0]!.reason, /runs 2 scripts and nothing says which owns the failure.*scripts\/a\.mjs, scripts\/b\.sh/);

  const none = workflowRepo(t, job("echo hello", "node scripts/missing.mjs"), { "scripts/other.mjs": "export {};\n" });
  const empty = none.search();
  assert.equal(locateCiFrictionOwner("check:lint", [], empty), undefined, "a script that is not on main is not an owner");
  assert.match(empty.workflowGaps!()[0]!.reason, /workflow job \.github\/workflows\/ci\.yml:lint for lint runs no script under src\/ or scripts\//);

  // A search that hands back the workflow file itself still yields no owner: a workflow is never a remedy's owner.
  const fake: OwnerSearch = { filesContaining: () => [], fileExists: () => true, workflowOwner: () => ({ files: [WORKFLOW], why: ["declares the job"] }) };
  assert.equal(locateCiFrictionOwner("check:lint", [], fake), undefined);
  assert.equal(locateCiFrictionOwner("check:ci-log:lint:timed-out", ["lint: timed out with no test result"], fake), undefined);
  assert.equal(locateCiFrictionOwner("check:lint", [], { ...fake, workflowOwner: () => ({ files: [], why: [] }) }), undefined);
  assert.deepEqual(locateCiFrictionOwner("check:lint", [], { ...fake, workflowOwner: () => ({ files: ["scripts/a.mjs"], why: ["runs it"] }) })?.files, ["scripts/a.mjs"]);
});

test("a workflow job's scripts are the existing src and scripts files its steps and package scripts name", () => {
  const present = new Set(["scripts/a.mjs", "scripts/b.sh", "src/c.ts", "scripts/loop.mjs", "scripts/x.test.ts", "src/lib/ci-friction-remedy.ts", "scripts/d.mjs"]);
  const pkg = JSON.stringify({ scripts: { first: "npm run second && node scripts/b.sh", second: "node scripts/loop.mjs; npm run first", test: "node scripts/d.mjs", bad: 3 } });
  const source = (readPackage: () => string | undefined) => ({ exists: (file: string) => present.has(file), readPackage });
  assert.deepEqual(workflowJobScripts(["node scripts/a.mjs", "./scripts/b.sh --x", "tsx src/c.ts"], source(() => undefined)), ["scripts/a.mjs", "scripts/b.sh", "src/c.ts"]);
  assert.deepEqual(workflowJobScripts(["npm run -s first"], source(() => pkg)), ["scripts/loop.mjs", "scripts/b.sh"], "nested npm run, and a cycle ends");
  assert.deepEqual(workflowJobScripts(["npm test", "npm run missing", "npm run bad"], source(() => pkg)), ["scripts/d.mjs"]);
  assert.deepEqual(workflowJobScripts(["node scripts/x.test.ts", "node src/lib/ci-friction-remedy.ts", "node ../scripts/a.mjs", "node ${{ github.workspace }}/scripts/a.mjs", "echo done"], source(() => pkg)), [],
    "a test, the remedy source and a path outside the repository are no owner");
  assert.deepEqual(workflowJobScripts(["npm test"], source(() => JSON.stringify({ scripts: "none" }))), []);
  assert.deepEqual(workflowJobScripts(["node scripts/a.mjs", "node scripts/a.mjs"], source(() => pkg)), ["scripts/a.mjs"], "a script named twice is one script");
});
