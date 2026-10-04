/**
 * W1-T5519 — twice on 2026-10-03 the machine-filing judge and the backlog gardener each added a `priority:` line to
 * one shard from one base; git merged both, the shard stopped parsing, and #8877 and #8922 repaired it by hand. #8878
 * quarantines such a shard; this lane repairs it. The judge's `risk_ruling.pin` covers exactly one candidate.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Escalation } from "../src/lib/escalate.js";
import type { QuarantinedTask } from "../src/lib/plan.js";
import { acceptanceAuthorTimeCheck, parseAcceptanceBlock, parseWhitelistedProof } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

/** Loaded per test, so this file still loads where the module does not exist yet. */
const repairModule = () => import("../src/lib/plan-shard-repair.js");

/** W1-T5431's shard exactly as main carried it before #8877 (f267479f^): the judge's 2.5, the gardener's 4 and marker. */
const REAL_1003_SHARD = [
  "- id: W1-T5431",
  "  title: \"REPAIR THE SELECTOR EDGE INTO test/error-subclass-census.test.ts \u2014 a coverage shard failure its retry did not recover was missed\"",
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  "  verify: auto",
  "  priority: 2.5",
  "  risk: low",
  "  priority: 4",
  "  status: queued",
  "  # backlog gardener: band=4 evidence=0140d95b35f086e4",
  "  attempts: 0",
  "  author_class: machine",
  "  origin: \"selector-shadow-miss:test/error-subclass-census.test.ts\"",
  "  files: [src/lib/affected-suites.ts]",
  "  note: \"W1-T4439 first observed a floor miss on coverage run 37106619888 for PR #8861 at 453ddd5111257a8e590dce2dfb20fefc6f937d3d: src/lib/onboarding-golive.ts, src/lib/serve.ts -> test/error-subclass-census.test.ts. The failing shard concluded failure, so its retry did not recover it. The changed paths are candidate missing edges, not guessed import edges. Later misses of the same suite are ledgered as selector-shadow.miss_evidence rows naming this task rather than filed again.\"",
  "  acceptance:",
  "    - claim: \"the floor selector includes test/error-subclass-census.test.ts when this edge is exercised\"",
  "      proof: \"grep: test/error-subclass-census\\\\.test\\\\.ts in src/lib/affected-suites.ts\"",
  "  risk_ruling:",
  "    verdict: \"low\"",
  "    action: proceed",
  "    confidence: 0.88",
  "    reasons:",
  "      - \"The filed remedy and sole declared file align: include test/error-subclass-census.test.ts through src/lib/affected-suites.ts.\"",
  "      - \"The supplied scope describes a test-selection repair and names no sensitive access, deletion, irreversible action, operator decision, or merge/deploy/review policy change.\"",
  "      - \"Filing-time verification is auto with an explicit grep proof; no failing gate is reported. No implementation or actual-change view is supplied, so implementation correctness remains unverified.\"",
  "    judged_at: \"2026-10-03T08:48:29.101Z\"",
  "    pin: \"ab561e1f8b0b1a2db9dc2724733bce897da330455897447b4d4ff7927b7c634a\"",
  "",
].join("\n");
const GARDENER_PRIORITY = "  priority: 4\n";
const GARDENER_MARKER = "  # backlog gardener: band=4 evidence=0140d95b35f086e4\n";
/** What #8877 left on main: the gardener's line and marker gone, nothing else touched. */
const REPAIRED_BY_HAND = REAL_1003_SHARD.replace(GARDENER_PRIORITY, "").replace(GARDENER_MARKER, "");
const SHARD_REL = "plan/tasks.d/w1-t5431-selector-shadow-miss.yaml";

type Row = { step: string; extra: Record<string, unknown> };

function recorder() {
  const rows: Row[] = [];
  const raised: Escalation[] = [];
  return {
    rows,
    raised,
    log: (step: string, extra: Record<string, unknown> = {}) => void rows.push({ step, extra }),
    raise: (e: Escalation) => {
      raised.push(e);
      return `https://github.com/o/r/issues/${raised.length}`;
    },
    steps: (step: string) => rows.filter((r) => r.step === step),
  };
}

function tempDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function minimalTask(id: string): string {
  return `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`;
}

/** A checkout whose origin/main carries `shard` at {@link SHARD_REL} beside a loadable monolith. */
function originCarrying(t: TestContext, shard: string) {
  const seed = gitRepo({ kind: "shard-repair-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), minimalTask("W1-T1"));
  writeFileSync(join(seed.dir, SHARD_REL), shard);
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "a shard two machine PRs merged into a duplicate key");
  const origin = gitRepo({ kind: "shard-repair-origin", bare: true });
  seed.git("push", "--quiet", origin.dir, "HEAD:main");
  const clone = gitRepo({ kind: "shard-repair-clone", cloneFrom: origin.dir });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  t.after(() => [seed, origin, clone].forEach((r) => r.cleanup()));
  return clone;
}

/** A fake plan-PR path that records every repair it is asked to open. */
function landRecorder(answer: () => string | undefined = () => "https://github.com/o/r/pull/9001") {
  const calls: Array<{ rel: string; text: string; title: string; body: string }> = [];
  return { calls, land: (rel: string, text: string, pr: { title: string; body: string }) => (calls.push({ rel, text, ...pr }), answer()) };
}

const DUPLICATE_KEY_TEST_TITLE = "no plan shard on main carries a duplicate key";

/** #9005: the repair PR carried no `## Acceptance` block and no trailer, so the required acceptance-author-gate
 *  refused it (no-header). The body must parse, through the real parser, to the one criterion whose test fails at base. */
function assertRepairBodyIsJudgeable(body: string): void {
  assert.deepEqual(acceptanceAuthorTimeCheck(body), { ok: true, message: "Acceptance block is judgeable" });
  assert.deepEqual(parseAcceptanceBlock(body), [
    { claim: "no plan shard on main carries a duplicate key after this repair", proof: `unit test: ${DUPLICATE_KEY_TEST_TITLE}` },
  ]);
  const proof = parseWhitelistedProof(`unit test: ${DUPLICATE_KEY_TEST_TITLE}`);
  assert.deepEqual([proof?.kind, proof?.nameFiltered], ["test", true], "a name-filtered unit test, not prose");
  const suite = readFileSync(new URL("./no-plan-shard-carries-a-duplicate-key.test.ts", import.meta.url), "utf8");
  assert.ok(suite.includes(`test("${DUPLICATE_KEY_TEST_TITLE}"`), "the proof names a test that exists");
}

test("a repair body without its Acceptance block is refused by the author-time gate", () => {
  const bare = "The daemon quarantined `plan/tasks.d/x.yaml`.\n\nOpened by the duplicate-key repair lane (W1-T5519).";
  assert.equal(acceptanceAuthorTimeCheck(bare).defect, "no-header");
  assert.throws(() => assertRepairBodyIsJudgeable(bare));
});

test("the real 2026-10-03 duplicate keeps the judge's priority 2.5 and drops the gardener's line and marker", async () => {
  const { repairDuplicateKeyShard } = await repairModule();
  const verdict = repairDuplicateKeyShard(REAL_1003_SHARD);
  assert.ok("repaired" in verdict, JSON.stringify(verdict));
  assert.equal(verdict.text, REPAIRED_BY_HAND, "byte-identical to #8877's hand repair");
  assert.deepEqual(verdict.kept, { priority: "2.5" });
});

test("the judge's pin decides, not line order: the gardener's priority written first is still dropped", async () => {
  const { repairDuplicateKeyShard } = await repairModule();
  const gardenerFirst = REAL_1003_SHARD.replace(GARDENER_PRIORITY, "").replace("  priority: 2.5\n", `${GARDENER_PRIORITY}  priority: 2.5\n`);
  assert.notEqual(gardenerFirst, REAL_1003_SHARD);
  const verdict = repairDuplicateKeyShard(gardenerFirst);
  assert.ok("repaired" in verdict, JSON.stringify(verdict));
  assert.deepEqual(verdict.kept, { priority: "2.5" });
  assert.equal(verdict.text, REPAIRED_BY_HAND);
});

test("an uncovered conflict is refused with its reason instead of a guess", async () => {
  const { repairDuplicateKeyShard } = await repairModule();
  const neither = REAL_1003_SHARD.replace("  priority: 2.5\n", "  priority: 3\n");
  assert.deepEqual(repairDuplicateKeyShard(neither), { refused: true, reason: "no candidate value of `priority` matches the record's risk_ruling pin" });
  const both = REAL_1003_SHARD.replace(GARDENER_PRIORITY, "").replace("  attempts: 0\n", "  attempts: 0\n  attempts: 1\n");
  const verdict = repairDuplicateKeyShard(both);
  assert.ok("refused" in verdict);
  assert.match(verdict.reason, /^2 candidate values of `attempts` match the risk_ruling pin — choosing one would be a guess$/);
  const unpinned = minimalTask("W1-T60").replace("  status: queued\n", "  priority: 2.5\n  priority: 4\n  status: queued\n");
  assert.deepEqual(repairDuplicateKeyShard(unpinned), { refused: true, reason: "the record carries no risk_ruling pin, so no value of `priority` is the judge's" });
});

test("a shard this repair cannot reason about is refused by name", async () => {
  const { repairDuplicateKeyShard, isDuplicateKeyError, DUPLICATE_KEY_ERROR_RE } = await repairModule();
  const refusal = (text: string) => {
    const v = repairDuplicateKeyShard(text);
    assert.ok("refused" in v, `refused: ${text}`);
    return v.reason;
  };
  assert.equal(refusal(REPAIRED_BY_HAND), "the shard has no duplicate key — it parses");
  assert.match(refusal("- id: [unclosed\n"), /^not a duplicate key: /);
  assert.equal(refusal(`${REAL_1003_SHARD}${minimalTask("W1-T2")}`), "the shard holds 2 task entries; only a one-task shard is repaired");
  assert.equal(refusal(REAL_1003_SHARD.replace(GARDENER_PRIORITY, "").replace('    verdict: "low"\n', '    verdict: "low"\n    verdict: "high"\n')), "the duplicated key is not a top-level task key");
  assert.match(refusal(REAL_1003_SHARD.replace(GARDENER_PRIORITY, "  priority: |\n    4\n")), /^duplicated key `priority` \(line \d+\) is not a one-line scalar$/);
  const many = ["repo", "type", "verify", "risk", "status"].reduce((text, key) => text.replace(new RegExp(`^(  ${key}: .*)$`, "m"), "$1\n$1"), REPAIRED_BY_HAND);
  assert.equal(refusal(many), "32 candidates exceed the 16 this repair weighs");
  assert.match(refusal(REPAIRED_BY_HAND.replace("  type: implement\n", "  type: bogus\n  type: worse\n")), /^no candidate value of `type` loads: task W1-T5431: invalid type 'bogus'/);
  assert.equal(DUPLICATE_KEY_ERROR_RE.test("YAMLParseError: Map keys must be unique at line 9, column 3"), true);
  assert.equal(DUPLICATE_KEY_ERROR_RE.test("YAMLParseError: Unexpected flow-seq-end at line 1"), false);
  assert.equal(isDuplicateKeyError("YAMLParseError: Map keys must be unique at line 9"), true);
  assert.equal(isDuplicateKeyError(undefined), false);
});

test("a duplicate-key quarantine opens exactly one repair PR per shard blob", async (t) => {
  const { gitBlobSha } = await repairModule();
  const clone = originCarrying(t, REAL_1003_SHARD);
  const stateDir = tempDir(t, "shard-repair-state");
  const r = recorder();
  const requester = runTask.shardRepairRequester(stateDir, r.log);
  const lane = landRecorder();
  const pass = () => runTask.runShardRepairPass({ stateDir, repoDir: clone.dir, worktreesRoot: stateDir, owner: "o", repo: "r", log: r.log, land: lane.land });

  runTask.syncPlanFromOrigin(clone.dir, "plan/tasks.yaml", { quarantine: runTask.quarantineReporter(r.log, r.raise, requester) });
  assert.equal(r.raised.length, 1, "the hand-repair escalation still stands");
  assert.equal(r.steps("plan.shard_repair_requested").length, 1, "the daemon's quarantine reporting asked for a repair");
  assert.equal(runTask.shardRepairsPending(stateDir), true, "the plan garden is due");
  pass();
  assert.equal(lane.calls.length, 1);
  assert.equal(lane.calls[0]!.rel, SHARD_REL);
  assert.equal(lane.calls[0]!.text, REPAIRED_BY_HAND, "the PR carries #8877's repair");
  assert.match(lane.calls[0]!.title, /^fix\(plan\): drop the duplicate priority key from a quarantined shard$/);
  const blob = gitBlobSha(REAL_1003_SHARD);
  assert.equal(blob, clone.git("rev-parse", `origin/main:${SHARD_REL}`).trim(), "the dedup key is git's own blob id");
  assert.deepEqual(r.steps("plan.shard_repair_opened").map((row) => [row.extra.blob, row.extra.pr_url]), [[blob, "https://github.com/o/r/pull/9001"]]);
  assert.equal(runTask.shardRepairsPending(stateDir), false, "the request is consumed");

  // A restarted daemon quarantines the same bytes again: nothing new opens.
  runTask.syncPlanFromOrigin(clone.dir, "plan/tasks.yaml", { quarantine: runTask.quarantineReporter(r.log, r.raise, requester) });
  pass();
  assert.equal(lane.calls.length, 1, "one PR per shard blob");
  assert.deepEqual(r.steps("plan.shard_repair_skipped").map((row) => row.extra.pr_url), ["https://github.com/o/r/pull/9001"]);
});

test("a shard repair PR body carries the acceptance block its required gate demands", async (t) => {
  const clone = originCarrying(t, REAL_1003_SHARD);
  const stateDir = tempDir(t, "shard-repair-acceptance");
  const r = recorder();
  const lane = landRecorder();
  runTask.shardRepairRequester(stateDir, r.log)({ id: "W1-T5431", files: [`origin/main:${SHARD_REL}`], reason: "shard_invalid" });
  runTask.runShardRepairPass({ stateDir, repoDir: clone.dir, worktreesRoot: stateDir, owner: "o", repo: "r", log: r.log, land: lane.land });
  assert.equal(lane.calls.length, 1, JSON.stringify(r.rows));
  assertRepairBodyIsJudgeable(lane.calls[0]!.body);
});

test("an uncovered quarantine escalates and ledgers its refusal, and opens nothing", async (t) => {
  const neither = REAL_1003_SHARD.replace("  priority: 2.5\n", "  priority: 3\n");
  const clone = originCarrying(t, neither);
  const stateDir = tempDir(t, "shard-repair-refused");
  const r = recorder();
  const lane = landRecorder();
  runTask.syncPlanFromOrigin(clone.dir, "plan/tasks.yaml", { quarantine: runTask.quarantineReporter(r.log, r.raise, runTask.shardRepairRequester(stateDir, r.log)) });
  runTask.runShardRepairPass({ stateDir, repoDir: clone.dir, worktreesRoot: stateDir, owner: "o", repo: "r", log: r.log, land: lane.land });
  assert.equal(lane.calls.length, 0, "never a guess");
  assert.equal(r.raised.length, 1, "the escalation is left standing");
  assert.match(String(r.steps("plan.shard_repair_refused")[0]?.extra.reason), /matches the record's risk_ruling pin/);
});

test("the default plan-PR path really cuts the repair commit, and a refused push is ledgered, not recorded as opened", async (t) => {
  const clone = originCarrying(t, REAL_1003_SHARD);
  const stateDir = tempDir(t, "shard-repair-default");
  const r = recorder();
  runTask.shardRepairRequester(stateDir, r.log)({ id: "W1-T5431", files: [`origin/main:${SHARD_REL}`], reason: "shard_invalid" });
  runTask.runShardRepairPass({ stateDir, repoDir: clone.dir, worktreesRoot: join(stateDir, "wt"), owner: "o", repo: "r", log: r.log });
  const failed = r.steps("plan.shard_repair_failed");
  assert.equal(failed.length, 1, JSON.stringify(r.rows));
  assert.equal(failed[0]!.extra.stage, "land");
  assert.match(String(failed[0]!.extra.reason), /git-push/, "the test runner's live-write guard stops the push");
  assert.equal(existsSync(join(runTask.shardRepairDir(stateDir), "opened.json")), false);
  assert.deepEqual(readdirSync(join(stateDir, "wt")), [], "the checkout is disposed");
});

test("every way a repair request fails is ledgered and consumes the request", async (t) => {
  const clone = originCarrying(t, REAL_1003_SHARD);
  const stateDir = tempDir(t, "shard-repair-failures");
  const r = recorder();
  const request = runTask.shardRepairRequester(stateDir, r.log);
  const q = (file: string): QuarantinedTask => ({ id: "W1-T5431", files: [file], reason: "shard_invalid", error: "Map keys must be unique" });
  const run = (land = landRecorder().land) =>
    runTask.runShardRepairPass({ stateDir, repoDir: clone.dir, worktreesRoot: stateDir, owner: "o", repo: "r", log: r.log, land });

  request(q("plan/tasks.d/on-disk.yaml"));
  assert.match(String(r.steps("plan.shard_repair_refused")[0]?.extra.reason), /not read from origin\/main/);

  request(q("origin/main:plan/tasks.d/absent.yaml"));
  run();
  assert.equal(r.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "read");

  request(q(`origin/main:${SHARD_REL}`));
  run(landRecorder(() => undefined).land);
  assert.equal(r.steps("plan.shard_repair_not_landed").length, 1, "a preflight refusal is not an opened PR");

  request(q(`origin/main:${SHARD_REL}`));
  run(() => {
    throw new Error("gh api: 502");
  });
  assert.deepEqual(r.steps("plan.shard_repair_failed").at(-1)?.extra, { id: "W1-T5431", file: `origin/main:${SHARD_REL}`, stage: "land", reason: "gh api: 502" });

  writeFileSync(join(runTask.shardRepairDir(stateDir), "opened.json"), "{ torn");
  const lane = landRecorder();
  request(q(`origin/main:${SHARD_REL}`));
  run(lane.land);
  assert.equal(r.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "opened-record");
  assert.equal(lane.calls.length, 0, "an unreadable record never risks a second PR");

  writeFileSync(join(runTask.shardRepairDir(stateDir), "requests", "torn.json"), "{");
  run();
  assert.equal(r.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "pass");
  assert.equal(runTask.shardRepairsPending(stateDir), false, "every request was consumed");

  const blocked = join(stateDir, "a-file");
  writeFileSync(blocked, "");
  const reporter = runTask.quarantineReporter(r.log, r.raise, runTask.shardRepairRequester(blocked, r.log));
  reporter([q(`origin/main:${SHARD_REL}`)]);
  assert.equal(r.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "request", "a request that cannot be written is ledgered");
  runTask.quarantineReporter(r.log, r.raise, request)([{ ...q(`origin/main:${SHARD_REL}`), id: "W1-T5432", error: "plan is not valid YAML: unexpected end" }]);
  assert.equal(r.steps("plan.shard_repair_requested").length, 4, "a quarantine that is not a duplicate key asks for nothing");
});

test("the plan garden runs the repair lane first, is due while a request waits, and a lane failure never skips the garden", (t) => {
  const stateDir = tempDir(t, "shard-repair-garden");
  const r = recorder();
  let gardened = 0;
  const garden = Object.assign(() => void gardened++, { due: () => false });
  const composed = runTask.withShardRepairs(stateDir, () => {
    throw new Error("disk gone");
  }, garden, r.log);
  assert.equal(composed.due!(), false, "nothing waits and the garden is not due");
  runTask.shardRepairRequester(stateDir, r.log)({ id: "W1-T5431", files: [`origin/main:${SHARD_REL}`], reason: "shard_invalid" });
  assert.equal(composed.due!(), true);
  composed();
  assert.equal(gardened, 1);
  assert.deepEqual(r.steps("plan.shard_repair_failed").map((row) => row.extra), [{ stage: "pass", reason: "disk gone" }]);
  assert.equal(runTask.withShardRepairs(stateDir, () => {}, () => {}, r.log).due!(), true, "a garden with no probe of its own is due");
});
