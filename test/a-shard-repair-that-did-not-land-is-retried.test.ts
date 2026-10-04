/**
 * W1-T5618 — the W1-T5519 duplicate-key repair lane (#8991, #9046) dropped every request in `finally`, so a repair the
 * plan-PR preflight refused, or whose read or land threw, left the shard quarantined until a daemon restart asked again.
 * And `opened.json` outlives restarts, so a repair PR closed unmerged blocked those bytes for good. One rule now: a
 * request is done only when its repair PR is open or merged, the bytes are deterministically refused, or the attempt
 * cap abandons it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { GARDEN_FILING_RETRY_BASE_MS } from "../src/lib/gardener.js";
import { gitBlobSha } from "../src/lib/plan-shard-repair.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTask from "../src/run-task.js";
import { allowGhRefusals } from "./setup/tmp-hygiene.js";

allowGhRefusals("the unreadable-PR-state test proves the default prState seam really reads gh, which the sentinel token refuses");

/** W1-T5431's shard as main carried it before #8877: the judge's priority 2.5, the gardener's 4 and its marker. */
const BROKEN_SHARD = [
  "- id: W1-T5431",
  "  title: \"REPAIR THE SELECTOR EDGE INTO test/error-subclass-census.test.ts — a coverage shard failure its retry did not recover was missed\"",
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
const SHARD_REL = "plan/tasks.d/w1-t5431-selector-shadow-miss.yaml";
const FILE = `origin/main:${SHARD_REL}`;
const BLOB = gitBlobSha(BROKEN_SHARD);
const T0 = Date.parse("2026-10-04T12:00:00.000Z");
const FIRST_PR = "https://github.com/o/r/pull/9001";
const FRESH_PR = "https://github.com/o/r/pull/9002";

type Row = { step: string; extra: Record<string, unknown> };
type Land = (rel: string, text: string, pr: { title: string; body: string }) => string | undefined;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shard-repair-retry-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One state dir, a ledger recorder, a clock, and a pass whose seams each test overrides. */
function lane(t: TestContext) {
  const stateDir = tempDir(t);
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => void rows.push({ step, extra });
  const clock = { now: T0 };
  const landed: Array<{ rel: string; text: string; body: string }> = [];
  const prStateReads: string[] = [];
  let blob = () => BROKEN_SHARD;
  let land: Land = () => FIRST_PR;
  return {
    stateDir,
    rows,
    clock,
    landed,
    prStateReads,
    steps: (step: string) => rows.filter((r) => r.step === step),
    request: () => runTask.shardRepairRequester(stateDir, log)({ id: "W1-T5431", files: [FILE], reason: "shard_invalid" }),
    setBlob: (f: () => string) => void (blob = f),
    setLand: (f: Land) => void (land = f),
    requests: () => {
      const dir = join(runTask.shardRepairDir(stateDir), "requests");
      return existsSync(dir) ? readdirSync(dir).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>) : [];
    },
    pending: () => runTask.shardRepairsPending(stateDir, clock.now),
    pass: (prState?: (url: string) => "open" | "merged" | "closed" | "unknown") =>
      runTask.runShardRepairPass({
        stateDir,
        repoDir: stateDir,
        worktreesRoot: stateDir,
        owner: "o",
        repo: "r",
        log,
        now: () => clock.now,
        readOriginBlob: (rel) => {
          assert.equal(rel, SHARD_REL);
          return blob();
        },
        land: (rel, text, pr) => {
          landed.push({ rel, text, body: pr.body });
          return land(rel, text, pr);
        },
        ...(prState ? { prState: (url: string) => (prStateReads.push(url), prState(url)) } : {}),
      }),
  };
}

function seedOpened(stateDir: string, opened: Record<string, unknown>): void {
  mkdirSync(runTask.shardRepairDir(stateDir), { recursive: true });
  writeFileSync(join(runTask.shardRepairDir(stateDir), "opened.json"), `${JSON.stringify(opened)}\n`);
}

const readOpened = (stateDir: string) => JSON.parse(readFileSync(join(runTask.shardRepairDir(stateDir), "opened.json"), "utf8")) as Record<string, unknown>;

test("a not-landed shard repair keeps its request and is retried on a later pass without a restart", (t) => {
  const l = lane(t);
  l.request();
  l.setLand(() => undefined);
  l.pass();
  assert.equal(l.steps("plan.shard_repair_not_landed").length, 1);
  const retryAt = new Date(T0 + GARDEN_FILING_RETRY_BASE_MS).toISOString();
  assert.deepEqual(l.requests(), [{ id: "W1-T5431", file: FILE, attempts: 1, blob: BLOB, next_at: retryAt }], "the request outlives the pass");
  assert.deepEqual(l.steps("plan.shard_repair_retry_scheduled").map((r) => r.extra), [{ id: "W1-T5431", file: FILE, blob: BLOB, attempt: 1, next_at: retryAt }]);
  assert.equal(l.pending(), false, "a request backing off does not make the plan garden due, so it never spins");

  l.pass();
  assert.equal(l.landed.length, 1, "a pass before next_at leaves the request alone");

  l.clock.now = T0 + GARDEN_FILING_RETRY_BASE_MS;
  assert.equal(l.pending(), true, "the request is due again at next_at, with no restart");
  l.setLand(() => FIRST_PR);
  l.pass();
  assert.equal(l.landed.length, 2);
  assert.deepEqual(l.steps("plan.shard_repair_opened").map((r) => r.extra.pr_url), [FIRST_PR]);
  assert.match(l.landed[1]!.body, /\n## Acceptance\n- no plan shard on main carries a duplicate key after this repair \| unit test: /, "#9046's block rides the retry");
  assert.deepEqual(l.requests(), [], "an opened PR is an end state");
  assert.equal(l.pending(), false);
});

test("a failed shard repair backs off, doubling, and abandons after its attempt cap with the escalation left standing", (t) => {
  const l = lane(t);
  l.request();
  l.setLand(() => {
    throw new Error("gh api: 502");
  });
  l.pass();
  l.clock.now += GARDEN_FILING_RETRY_BASE_MS;
  l.pass();
  assert.deepEqual(l.steps("plan.shard_repair_retry_scheduled").map((r) => [r.extra.attempt, r.extra.next_at]), [
    [1, new Date(T0 + GARDEN_FILING_RETRY_BASE_MS).toISOString()],
    [2, new Date(T0 + 3 * GARDEN_FILING_RETRY_BASE_MS).toISOString()],
  ]);
  l.clock.now = T0 + 3 * GARDEN_FILING_RETRY_BASE_MS;
  l.pass();
  assert.equal(l.landed.length, 3);
  assert.deepEqual(l.steps("plan.shard_repair_failed").map((r) => r.extra.stage), ["land", "land", "land"]);
  assert.deepEqual(l.steps("plan.shard_repair_abandoned").map((r) => r.extra), [
    { id: "W1-T5431", file: FILE, blob: BLOB, attempts: 3, reason: "3 repair attempts did not open a PR; the shard's quarantine escalation stands for a hand repair" },
  ]);
  assert.deepEqual(l.requests(), [], "an abandoned request is consumed");
  assert.equal(l.steps("plan.shard_repair_retry_scheduled").length, 2);

  // A restarted daemon that still quarantines the shard asks again, from a fresh count.
  l.request();
  assert.deepEqual(l.requests(), [{ id: "W1-T5431", file: FILE }]);
});

test("a read that throws, an unreadable opened record and a torn request are each retried or consumed by name", (t) => {
  const l = lane(t);
  l.request();
  l.setBlob(() => {
    throw new Error("fatal: path not in origin/main");
  });
  l.pass();
  assert.equal(l.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "read");
  assert.deepEqual(l.requests(), [{ id: "W1-T5431", file: FILE, attempts: 1, next_at: new Date(T0 + GARDEN_FILING_RETRY_BASE_MS).toISOString() }], "a read failure names no blob");

  l.setBlob(() => BROKEN_SHARD);
  writeFileSync(join(runTask.shardRepairDir(l.stateDir), "opened.json"), "{ torn");
  l.clock.now += GARDEN_FILING_RETRY_BASE_MS;
  l.pass();
  assert.equal(l.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "opened-record");
  assert.equal(l.landed.length, 0, "an unreadable record never risks a second PR");
  assert.equal(l.requests()[0]?.attempts, 2);

  const torn = join(runTask.shardRepairDir(l.stateDir), "requests", "torn.json");
  writeFileSync(torn, "{");
  assert.equal(l.pending(), true, "a torn request is due, so the pass that consumes it runs");
  l.pass();
  assert.equal(l.steps("plan.shard_repair_failed").at(-1)?.extra.stage, "pass");
  assert.equal(existsSync(torn), false, "a request that cannot be read is consumed, never retried");
  assert.equal(l.requests().length, 1, "the backing-off request is untouched");
});

test("a deterministic refusal and bytes that now parse are end states and consume the request", (t) => {
  const l = lane(t);
  l.request();
  l.setBlob(() => BROKEN_SHARD.replace("  priority: 2.5\n", "  priority: 3\n"));
  l.pass();
  assert.match(String(l.steps("plan.shard_repair_refused")[0]?.extra.reason), /risk_ruling pin/);
  assert.deepEqual(l.requests(), []);

  l.request();
  l.setBlob(() => BROKEN_SHARD.replace("  priority: 4\n", ""));
  l.pass();
  assert.equal(l.steps("plan.shard_repair_refused")[1]?.extra.reason, "the shard has no duplicate key — it parses");
  assert.deepEqual(l.requests(), []);
  assert.equal(l.landed.length, 0);
});

test("bytes main changed since the last attempt start their own attempt count", (t) => {
  const l = lane(t);
  l.request();
  l.setLand(() => undefined);
  l.pass();
  l.clock.now += GARDEN_FILING_RETRY_BASE_MS;
  l.pass();
  assert.equal(l.requests()[0]?.attempts, 2);
  const changed = BROKEN_SHARD.replace("  attempts: 0\n", "  attempts: 1\n");
  l.setBlob(() => changed);
  l.clock.now += 2 * GARDEN_FILING_RETRY_BASE_MS;
  l.pass();
  assert.deepEqual(l.steps("plan.shard_repair_abandoned"), [], "the old bytes' failures are not charged to new ones");
  assert.deepEqual(
    l.requests().map((r) => [r.attempts, r.blob]),
    [[1, gitBlobSha(changed)]],
  );
});

test("a blob whose recorded repair PR was closed unmerged gets one fresh PR, and a second close is respected", (t) => {
  const l = lane(t);
  seedOpened(l.stateDir, { [BLOB]: FIRST_PR });
  l.request();
  l.setLand(() => FRESH_PR);
  l.pass(() => "closed");
  assert.deepEqual(l.prStateReads, [FIRST_PR]);
  assert.equal(l.landed.length, 1, "one fresh PR for the same bytes");
  assert.match(l.landed[0]!.body, /\n## Acceptance\n- no plan shard on main carries a duplicate key after this repair \| unit test: /, "the fresh PR keeps #9046's block");
  assert.deepEqual(l.steps("plan.shard_repair_opened").map((r) => [r.extra.pr_url, r.extra.reopened_from]), [[FRESH_PR, FIRST_PR]]);
  assert.deepEqual(readOpened(l.stateDir), { [BLOB]: { pr_url: FRESH_PR, reopened_from: FIRST_PR } });
  assert.deepEqual(l.requests(), []);

  l.request();
  l.pass(() => "closed");
  assert.deepEqual(l.prStateReads, [FIRST_PR], "a reopened blob is not read again");
  assert.equal(l.landed.length, 1, "a second close is respected");
  assert.deepEqual(l.steps("plan.shard_repair_skipped").map((r) => [r.extra.pr_url, r.extra.reason]), [
    [FRESH_PR, "a repair PR was already reopened once for these bytes; its close is respected"],
  ]);
  assert.deepEqual(l.requests(), []);
});

test("a blob whose recorded repair PR is open or merged is still skipped", (t) => {
  for (const state of ["open", "merged"] as const) {
    const l = lane(t);
    seedOpened(l.stateDir, { [BLOB]: FIRST_PR });
    l.request();
    l.pass(() => state);
    assert.equal(l.landed.length, 0, state);
    assert.deepEqual(l.steps("plan.shard_repair_skipped").map((r) => r.extra), [
      { id: "W1-T5431", file: FILE, blob: BLOB, pr_url: FIRST_PR, pr_state: state, reason: "a repair PR was already opened for these bytes" },
    ]);
    assert.deepEqual(l.requests(), [], `${state} is an end state`);
  }
});

test("an unreadable repair PR state opens nothing and is retried, through the real gh read", (t) => {
  const l = lane(t);
  seedOpened(l.stateDir, { [BLOB]: FIRST_PR });
  l.request();
  l.pass(); // no prState seam: the default reads GitHub, which the test runner's sentinel token refuses
  assert.equal(l.landed.length, 0, "a duplicate PR is never opened on a guess");
  assert.deepEqual(l.steps("plan.shard_repair_skipped").map((r) => [r.extra.pr_state, r.extra.reason]), [
    ["unknown", "the recorded repair PR's state could not be read; retried rather than risk a duplicate PR"],
  ]);
  assert.equal(l.requests()[0]?.attempts, 1, "unknown is not an end state");
  assert.deepEqual(readOpened(l.stateDir), { [BLOB]: FIRST_PR });
});
