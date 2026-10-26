import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { ciFrictionLadder, ciFrictionRoundsFromLedger, ciFrictionShardYaml, gitCiFrictionOwnerSearch, priceCiFrictionCauses, type CiFrictionRound } from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner, type OwnerSearch } from "#src/lib/ci-friction-remedy.js";
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


test("a scanner warning retains measured friction without inventing a defect in its reporter", t => {
  const f = fixture(t);
  const warning = "UNTRUSTED SCANNER EVIDENCE: the CodeQL check failed at this pull request's head, and this high-severity";
  writeFileSync(join(f.repo.dir, "src/scanner-reporter.ts"), `export const warning = ${JSON.stringify(warning)};\n`);
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "record the real scanner warning producer");
  f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const search = f.search();
  assert.deepEqual(search.filesContaining(warning).map(hit => hit.file), ["src/scanner-reporter.ts"],
    "positive control sees the exact warning in its actual emitter");
  const key = "check:ci-log:codeql-alert-909-js-file-system-race:untrusted-scanner-evidence-the-codeql-check-failed-at-this-p";
  const detail = `ci-log round — coverage-shard (7/8): unrelated caller assertion; CodeQL alert #910 (js/file-system-race): ${warning}; CodeQL alert #909 (js/file-system-race): ${warning}; security-merge-policy`;
  assert.equal(locateCiFrictionOwner(key, [detail], search), undefined,
    "emitting a scanner finding establishes no harness failure mechanism");
  const result = ladder(key, [detail, detail, detail, detail], search);
  assert.equal(result.next?.decision.kind, "escalate");
  assert.equal(result.next?.price.minutes, 27);
  assert.equal(result.next?.price.rounds, 4);
  assert.equal(result.next?.decision.kind === "escalate" && result.next.decision.holdReason, "no-owner");
  assert.match(result.next?.decision.kind === "escalate" ? result.next.decision.why : "", /scanner.*mechanism.*UNKNOWN/i);
});

test("a concrete scanner runner defect remains owned even beside another alert's warning", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo.dir, "src/scanner-runner.ts"), 'throw new Error("scanner helper crashed");\n');
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "record a concrete scanner runner failure");
  f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const key = "check:ci-log:codeql-alert-909-js-file-system-race:scanner-helper-crashed";
  const details = ["ci-log round — CodeQL alert #910 (js/file-system-race): UNTRUSTED SCANNER EVIDENCE: another finding; CodeQL alert #909 (js/file-system-race): scanner helper crashed"];
  assert.deepEqual(locateCiFrictionOwner(key, details, f.search())?.files, ["src/scanner-runner.ts"],
    "only this cause's own signature can identify its diagnosis");
  assert.equal(ladder(key, details, f.search()).next?.decision.kind, "draft");
});

test("a census growth refusal retains its observations without assigning the reporter as a repair owner", async t => {
  const reporter = "scripts/census-precheck.mjs";
  const runner = reporter;
  const diagnostic = "census-precheck: this branch grows";
  const failure = "census-precheck: could not measure — census snapshot reader crashed";
  const sources = new Map([
    [runner, `const message = ${JSON.stringify(diagnostic)};\nthrow new Error(${JSON.stringify(failure)});\n`],
  ]);
  const searched: string[] = [];
  const search: OwnerSearch = {
    filesContaining(term) {
      searched.push(term);
      return [...sources].flatMap(([file, source]) => source.includes(term) ? [{ file, hits: 1 }] : []);
    },
    fileExists: file => sources.has(file),
  };
  assert.deepEqual(search.filesContaining(diagnostic).map(hit => hit.file), [reporter],
    "positive control resolves the growth reporter");
  const crashed = spawnSync(process.execPath, ["-e", sources.get(runner)!], { encoding: "utf8" });
  assert.equal(crashed.status, 1);
  assert.ok(crashed.stderr.includes(failure), "positive control executes the concrete runner failure");
  const growth = [
    `${diagnostic} 1 census count(s) CI will refuse: census-suite: test/the-affected-suite-reach-ratchet.test.ts fails — importerCount: 934 > 933`,
    `${diagnostic} 1 census count(s) CI will refuse: comment-load: src/lib/repo-location.ts has 60 comment lines > ceiling 57`,
    `${diagnostic} 3 census count(s) CI will refuse: fixture-copy: gitInitSites 224 > baseline 223`,
  ];
  const scenarios = [
    { name: "growth alone", details: growth, owned: false },
    { name: "runner alone", details: [failure], owned: true },
    { name: "growth then runner", details: [...growth, failure], owned: true },
    { name: "runner then growth", details: [failure, ...growth], owned: true },
  ];
  for (const { name, details, owned } of scenarios) await t.test(name, () => {
    const records: Parameters<typeof ciFrictionRoundsFromLedger>[0] = details.flatMap((reason, index) => {
      const run_id = `census-${index}`;
      const ts = new Date(NOW).toISOString();
      return [
        { step: "pr.opened", run_id, ts, pr_url: `https://github.com/fixture/repo/pull/${12700 + index}` },
        { step: "fix.dispatch", run_id, ts, round: 1, mode: "ci-log", elapsed_ms: (index + 1) * 60_000 },
        { step: "fix.commit_refused", run_id, ts, round: 1, reason },
      ];
    });
    const rounds = ciFrictionRoundsFromLedger(records);
    const retained = JSON.stringify(rounds);
    const cause = { kind: "fix_refusal" as const, name: "census-precheck" };
    const minutes = details.length * (details.length + 1) / 2;
    assert.deepEqual(rounds.map(round => round.detail), details, "ledger observations survive grouping");
    assert.deepEqual(rounds.map(round => round.cause), details.map(() => cause));
    const priced = priceCiFrictionCauses(rounds, undefined, NOW);
    assert.deepEqual(priced, [{ cause, minutes, rounds: details.length, prs: details.length }]);
    searched.length = 0;
    assert.deepEqual(locateCiFrictionOwner("fix_refusal:census-precheck", details, search)?.files,
      owned ? [runner] : undefined);
    const result = ciFrictionLadder({ priced, rounds, tasks: [], receipts: new Set(), escalated: new Set(),
      ownerSearch: search, nowMs: NOW });
    assert.deepEqual(result.next?.price, priced[0], "all growth and runner costs remain priced");
    assert.equal(JSON.stringify(rounds), retained, "ownership diagnosis preserves every original round");
    assert.equal(result.next?.decision.kind, owned ? "draft" : "escalate");
    if (owned) {
      assert.ok(result.next?.decision.kind === "draft");
      assert.deepEqual(result.next.decision.owner.files, [runner], "concrete runner evidence retains its source owner");
    } else {
      assert.ok(result.next?.decision.kind === "escalate");
      assert.equal(result.next.decision.holdReason, "no-owner");
      assert.match(result.next.decision.why, /census.*mechanism.*UNKNOWN/i);
    }
    assert.equal(searched.length, owned ? 2 : 0, "only concrete runner evidence enters each ownership search");
  });
});

test("mixed census findings retain the concrete runner owner through ledger pricing and the ladder", t => {
  const f = fixture(t);
  mkdirSync(join(f.repo.dir, "scripts"));
  writeFileSync(join(f.repo.dir, "scripts/census-precheck.mjs"), 'export const refusal = "census-precheck: this branch grows";\n');
  const message = "census snapshot reader crashed";
  writeFileSync(join(f.repo.dir, "scripts/census-runner.mjs"), `throw new Error(${JSON.stringify(message)});\n`);
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "record distinct census reporter and failing runner");
  f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const crash = spawnSync(process.execPath, [join(f.repo.dir, "scripts/census-runner.mjs")], { encoding: "utf8" });
  assert.equal(crash.status, 1);
  assert.ok(crash.stderr.includes(message));
  const reasons = [
    "census-precheck: this branch grows 1 census count(s) CI will refuse: fixture-copy: real branch finding",
    `census-precheck: ${message}`,
  ];
  const records = reasons.flatMap((reason, index) => {
    const run_id = `run-census-${index}`, head_sha = String(index).repeat(40), task_id = `W1-T${9000 + index}`;
    return [
      { step: "pr.opened", run_id, task_id, ts: new Date(NOW - 3000).toISOString(), pr_number: 13000 + index, pr_url: `https://github.com/acme/fixture/pull/${13000 + index}` },
      { step: "fix.dispatch", run_id, task_id, ts: new Date(NOW - 2000).toISOString(), head_sha, round: 1, mode: "ci-log", elapsed_ms: 180000 },
      { step: "fix.commit_refused", run_id, task_id, ts: new Date(NOW - 1000).toISOString(), head_sha, round: 1, reason },
    ];
  });
  const retained = JSON.stringify(records);
  const rounds = ciFrictionRoundsFromLedger(records), priced = priceCiFrictionCauses(rounds);
  assert.equal(rounds.length, 2);
  assert.equal(priced.length, 1, "the existing cost class is not renamed or split to fabricate a lower after-window");
  assert.deepEqual(priced[0], { cause: { kind: "fix_refusal", name: "census-precheck" }, minutes: 6, rounds: 2, prs: 2 });
  const result = ciFrictionLadder({ priced, rounds, tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: f.search(), nowMs: NOW });
  assert.equal(result.next?.decision.kind, "draft");
  assert.deepEqual(result.next?.decision.kind === "draft" ? result.next.decision.owner.files : [], ["scripts/census-runner.mjs"]);
  assert.equal(result.next?.price.minutes, 6);
  assert.equal(JSON.stringify(records), retained);
  assert.deepEqual(locateCiFrictionOwner("fix_refusal:census-precheck", [reasons[1]!], f.search())?.files, ["scripts/census-runner.mjs"]);
});
