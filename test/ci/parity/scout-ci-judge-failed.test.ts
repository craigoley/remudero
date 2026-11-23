import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { judgeCiEscalation, productionCiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const FILE_CAP = "HTTP 406: Sorry, the diff exceeded the maximum number of files (300).";

function fixture(t: TestContext, error: string, fileCount: number, missingHead = false) {
  const repo = gitRepo({ scope: t, kind: "ci-judge-diff" });
  const base = repo.git("rev-parse", "HEAD");
  const files = Array.from({ length: fileCount }, (_, index) => `file ${index}.ts`).sort();
  for (const file of files) writeFileSync(join(repo.dir, file), "export const value = 1;\n");
  repo.git("add", "--all");
  repo.git("commit", "-qm", "feat: change files");
  const head = missingHead ? "1".repeat(40) : repo.git("rev-parse", "HEAD");
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  const posts: string[][] = [];
  const ports = productionCiJudgePorts({
    owner: "fixture", repo: "fixture", repoRoot: repo.dir, stateDir: repo.dir,
    ghJson: async () => [{ number: 7, head: { sha: head }, base: { sha: base } }],
    ghText: async (args) => {
      if (args[0] === "pr") throw new Error(error);
      posts.push(args);
      return "";
    },
    log: (step, extra) => appendLedger(ledgerPath, { run_id: "fixture", task_id: "DAEMON", step, ...extra }),
    floor: (changed) => {
      assert.deepEqual(changed, files);
      return { suites: [], fullRun: false };
    },
    suiteIds: () => ["test/example.test.ts"],
  });
  const prompts: string[] = [];
  ports.judge = async (prompt) => {
    prompts.push(prompt);
    return '{"add":["test/example.test.ts"],"escalateFull":false,"reason":"cover the change"}';
  };
  const ledger = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerLine);
  return { ports, posts, prompts, ledger, head };
}

test("W1-T13099: ci_judge.failed no longer recurs", async (t) => {
  const run = fixture(t, FILE_CAP, 301);
  assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [7], failed: [] });
  assert.equal(run.prompts.length, 1);
  assert.match(run.prompts[0], /\+export const value = 1;/);
  assert.equal(run.posts.length, 1);
  assert.ok(run.posts[0].includes(`repos/fixture/fixture/statuses/${run.head}`));
  assert.ok(run.posts[0].includes('description=ci-judge {"add":["test/example.test.ts"],"escalateFull":false}'));
  assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [] });
  assert.equal(run.posts.length, 1);
  assert.deepEqual(run.ledger().map((row) => row.step), ["ci_judge.judged"]);
});

test("W1-T13099: the symptom is still recorded when its failure occurs", async (t) => {
  for (const [error, missingHead] of [["HTTP 403: access denied", false], [FILE_CAP, true]] as const) {
    const run = fixture(t, error, 1, missingHead);
    assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [7] });
    assert.deepEqual(run.posts, []);
    assert.deepEqual(run.prompts, []);
    const [row] = run.ledger();
    assert.equal(row.step, "ci_judge.failed");
    assert.equal(row.pr, 7);
    assert.equal(row.head_sha, run.head);
    assert.ok(typeof row.error === "string");
    assert.ok(row.error.includes(error));
    if (missingHead) assert.match(row.error, /local diff failed/);
    assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [] });
    assert.equal(run.ledger().length, 1);
  }
});

test("W1-T13099: a stalled local diff aborts at its deadline and records the failure", async (t) => {
  const run = fixture(t, FILE_CAP, 1);
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    now = 1_000_000_000;
    callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [7] });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
  const [row] = run.ledger();
  assert.equal(row.step, "ci_judge.failed");
  assert.match(String(row.error), /local diff exceeded/);
});
