import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { ciFrictionLadder, ciFrictionShardYaml, gitCiFrictionOwnerSearch, type CiFrictionRound } from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "#src/lib/ci-friction-remedy.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.parse("2026-10-25T03:56:00Z");
const WORKFLOW = ".github/workflows/merge-queue-review-attest.yml";

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t });
  mkdirSync(join(repo.dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, WORKFLOW), "jobs:\n  review:\n    name: remudero-review\n    runs-on: ubuntu-latest\n    steps:\n      - run: node src/review-step.ts\n");
  writeFileSync(join(repo.dir, "src/review-step.ts"), 'throw new Error("attestation body invalid");\n');
  repo.git("add", "."); repo.git("commit", "-qm", "declared producer and concrete failure control");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const search = () => gitCiFrictionOwnerSearch(args => repo.git(...args));
  return { repo, search };
}

function ladder(key: string, details: string[], search: ReturnType<typeof gitCiFrictionOwnerSearch>) {
  const cause = { kind: "check" as const, name: key.slice("check:".length) };
  const rounds: CiFrictionRound[] = details.map((detail, index) => ({ pr: 14007 + index, cause, minutes: 27 / details.length,
    at: new Date(NOW).toISOString(), detail }));
  const retained = JSON.stringify(rounds);
  const result = ciFrictionLadder({ priced: [{ cause, minutes: 27, rounds: details.length, prs: details.length }], rounds,
    tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: search, nowMs: NOW });
  assert.equal(JSON.stringify(rounds), retained, "every original round and its cost is retained");
  return result;
}

test("a bare review status retains measured friction without inventing a workflow repair", t => {
  const f = fixture(t);
  assert.deepEqual(f.search().workflowOwner!("remudero-review")?.files, [WORKFLOW], "positive control sees the declared producer");
  const details = [
    "ci-log round — rule-checks: test/census-discovery-is-blind-to-a-second-idiom.test.ts; remudero-review",
    "ci-log round — coverage-ratchet: diff-coverage: BLOCKED; remudero-review",
    "ci-log round — task-id-existence; remudero-review",
  ];
  const key = "check:ci-log:remudero-review";
  assert.equal(locateCiFrictionOwner(key, details, f.search()), undefined);
  const result = ladder(key, details, f.search());
  assert.equal(result.next?.decision.kind, "escalate");
  assert.equal(result.next?.price.minutes, 27);
  assert.equal(result.next?.price.rounds, 3);
  assert.match(result.next?.decision.kind === "escalate" ? result.next.decision.why : "", /mechanism.*UNKNOWN/);
  assert.equal(result.next?.decision.kind === "escalate" && result.next.decision.holdReason, "no-owner");
});

test("a concrete review-step failure remains owned and its remedy requires an executable regression", t => {
  const f = fixture(t);
  const failed = spawnSync(process.execPath, [join(f.repo.dir, "src/review-step.ts")], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Error: attestation body invalid/);
  const key = "check:ci-log:remudero-review:attestation-body-invalid";
  const details = ["ci-log round — remudero-review: attestation body invalid"];
  assert.deepEqual(locateCiFrictionOwner(key, details, f.search())?.files, ["src/review-step.ts"]);
  const result = ladder(key, details, f.search());
  assert.equal(result.next?.decision.kind, "draft");
  assert.ok(result.next && result.next.decision.kind === "draft");
  const task = loadPlanFromYaml(ciFrictionShardYaml({ price: result.next.price, rung: result.next.rung,
    owner: result.next.decision.owner, rounds: [] }, "W1-T999903"), "fixture").tasks[0]!;
  assert.match(task.acceptance![0].proof!, /^unit test: W1-T999903:/);
  assert.doesNotMatch(task.acceptance![0].proof!, /^grep:/);
  assert.equal(task.verify, "human");
  assert.equal(result.next.price.minutes, 27);
});

test("a source coverage refusal preserves observations without inventing a workflow defect", t => {
  const f = fixture(t);
  const workflow = ".github/workflows/ci.yml";
  writeFileSync(join(f.repo.dir, workflow), "jobs:\n  coverage-ratchet-required:\n    name: coverage-ratchet\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo coverage\n");
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "declare the coverage verdict producer");
  f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const search = f.search();
  assert.deepEqual(search.workflowOwner!("coverage-ratchet")?.files, [workflow], "the producer was actually resolved");
  const key = "check:ci-log:coverage-ratchet:error-diff-coverage-blocked-this-diff-adds-source-line-s-wit";
  const details = [
    "coverage-ratchet: ##[error]diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; src/lib/gate-gardener.ts:242",
    "coverage-ratchet: ##[error]diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; src/lib/commit-message.ts:46",
  ];
  assert.equal(locateCiFrictionOwner(key, details, search), undefined, "a healthy predicate refusal does not establish a producer defect");
  const result = ladder(key, details, search);
  assert.equal(result.next?.decision.kind, "escalate");
  assert.equal(result.next?.price.minutes, 27);
  assert.equal(result.next?.price.rounds, 2);
  assert.match(result.next?.decision.kind === "escalate" ? result.next.decision.why : "", /coverage.*mechanism.*UNKNOWN/i);
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-ratchet:coverage-report-failed", ["coverage-ratchet: COVERAGE-REPORT-FAILED artifact upload failed"], f.search())?.files,
    [workflow], "actual infrastructure evidence keeps its original workflow route");
});
