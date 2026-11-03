import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "#src/lib/ledger.js";
import { createDispatchBreakerCache, DISPATCH_BREAKER_JUDGED_STEP, evaluateDispatchBreakerDetailed, readLedgerLines } from "#src/lib/status.js";
import {
  implicatedMainPaths, judgeDispatchBreak, mainEvidenceReader,
  type DispatchBreakInput, type MainEvidence,
} from "#src/lib/stall-verifier.js";
import { withTempDir } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const TASK = { id: "PORTAL-T45", title: "changes timeline", files: ["app/changes.tsx", "tests/unit/changes.test.tsx"] };
const REFUSAL = "proof did not pass: candidates: 1 file(s) — tests/unit/changes.test.tsx TAP 1..0 verdict: no-match";
const STALL = { kind: "escalate", owner: "operator", reason: "same refusal" } as const;

function seedTrippedHistory(ledgerPath: string): void {
  for (let i = 0; i < 5; i++) {
    const ts = new Date(Date.UTC(2026, 9, 27, 19, i * 5)).toISOString();
    appendLedger(ledgerPath, { ts, run_id: `PORTAL-T45-${i}`, task_id: TASK.id, step: "run.start" } as never);
    appendLedger(ledgerPath, { ts, run_id: `PORTAL-T45-${i}`, task_id: TASK.id, step: "verdict", verdict: "failed",
      stage: "pr_open.refused", reason: REFUSAL } as never);
  }
}

test("W1-T11093 criterion 1: a settled escalate is re-asked once main changes an implicated path, and a continue resets the breaker", async () => {
  await withTempDir("breaker-main-rejudge", async (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    seedTrippedHistory(ledgerPath);
    let evidence: MainEvidence = { digest: "aaaaaaaaaaaaaaaa", changedPaths: [] };
    const asked: DispatchBreakInput[] = [];
    let ruling: "escalate" | "continue" = "escalate";
    const ctx = { repo: "remudero-site", ledgerPath, runId: "DAEMON-1", mainEvidence: async () => evidence,
      judge: async (input: DispatchBreakInput) => {
        asked.push(input);
        return ruling === "escalate" ? { verdict: "escalate" as const, loop: "zero tests collected", reason: "identical refusal" }
          : { verdict: "continue" as const, reason: "main now collects tsx tests" };
      } };
    const detail = { freshCount: 5, excludedByReason: {} };

    assert.equal(await judgeDispatchBreak(TASK, detail, STALL, ctx), "escalate");
    assert.equal(await judgeDispatchBreak(TASK, detail, STALL, { ...ctx, runId: "DAEMON-2" }), "escalate");
    assert.equal(asked.length, 1, "an unchanged main never re-asks the judge");
    assert.equal(asked[0].mainChangedSinceLastAttempt, undefined);

    evidence = { digest: "bbbbbbbbbbbbbbbb", changedPaths: ["vitest.config.mjs"] };
    ruling = "continue";
    assert.equal(await judgeDispatchBreak(TASK, detail, STALL, { ...ctx, runId: "DAEMON-3" }), "continue");
    assert.equal(asked.length, 2, "a changed implicated path re-asks the judge");
    assert.deepEqual(asked[1].mainChangedSinceLastAttempt, ["vitest.config.mjs"]);

    const rulings = readLedgerLines(ledgerPath).filter((row) => row.step === DISPATCH_BREAKER_JUDGED_STEP);
    assert.deepEqual(rulings.map((row) => row.main_digest), ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    assert.deepEqual(rulings[1].main_changed, ["vitest.config.mjs"]);
    assert.equal(evaluateDispatchBreakerDetailed(ledgerPath, TASK.id, createDispatchBreakerCache()).state, "clear");
  });
});

test("W1-T11093 criterion 2: the implicated paths are the runner config, the task's files and the paths its failures named", () => {
  const paths = implicatedMainPaths({ files: [...TASK.files, "plan/tasks.d/*.yaml"] },
    [{ runId: "r", verdict: "failed", reason: "refused: src/lib/check-proof.ts exited 1" }]);
  for (const expected of ["package.json", "vitest.config.mjs", "app/changes.tsx", "tests/unit/changes.test.tsx", "src/lib/check-proof.ts"]) {
    assert.ok(paths.includes(expected), `${expected} is implicated`);
  }
  assert.ok(!paths.some((path) => path.includes("*")), "a glob is never a path to read");
});

test("W1-T11093 criterion 3: the real reader fingerprints main's implicated blobs and names what main changed since the last attempt", async () => {
  await withTempDir("breaker-main-reader", async (dir) => {
    const repo = join(dir, "site");
    mkdirSync(join(repo, "tests", "unit"), { recursive: true });
    const env = (date: string) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const git = (date: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: env(date), encoding: "utf8" });
    git("2026-10-27T19:00:00Z", "init", "-q", "-b", "main");
    writeFileSync(join(repo, "vitest.config.mjs"), 'export default { test: { include: ["tests/unit/**/*.test.ts"] } };\n');
    writeFileSync(join(repo, "tests", "unit", "changes.test.tsx"), "it('x', () => {});\n");
    git("2026-10-27T19:00:00Z", "add", "-A");
    git("2026-10-27T19:00:00Z", "commit", "-q", "-m", "seed");
    git("2026-10-27T19:00:00Z", "update-ref", "refs/remotes/origin/main", "HEAD");
    const read = mainEvidenceReader(repo);
    const paths = implicatedMainPaths({ files: ["tests/unit/changes.test.tsx"] }, []);
    const lastAttemptMs = Date.parse("2026-10-27T19:30:00Z");
    const before = await read(paths, lastAttemptMs);
    assert.ok("digest" in before, JSON.stringify(before));
    assert.deepEqual(before.changedPaths, []);

    writeFileSync(join(repo, "vitest.config.mjs"), 'export default { test: { include: ["tests/unit/**/*.test.{ts,tsx}"] } };\n');
    git("2026-10-27T19:56:00Z", "commit", "-q", "-am", "collect tsx tests");
    git("2026-10-27T19:56:00Z", "update-ref", "refs/remotes/origin/main", "HEAD");
    const after = await read(paths, lastAttemptMs);
    assert.ok("digest" in after, JSON.stringify(after));
    assert.notEqual(after.digest, before.digest);
    assert.deepEqual(after.changedPaths, ["vitest.config.mjs"]);

    const missing = await mainEvidenceReader(join(dir, "no-such-checkout"))(paths, lastAttemptMs);
    assert.ok("unreadable" in missing, "an unreadable checkout is named, never read as an unchanged main");
  });
});
