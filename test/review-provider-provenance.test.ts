import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { buildReviewPrompt } from "../src/lib/review.js";
import {
  recordHeadProviderAfterPush,
  resolveReviewProviderProvenance,
} from "../src/lib/review-provider-provenance.js";
import { reviewCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const PR = "https://github.com/craigoley/remudero/pull/99";
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function claim(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    run_id: "run-1",
    task_id: "W1-T2594",
    step: "pr.head_provider",
    pr_url: PR,
    head_sha: HEAD,
    provider: "codex",
    model: "gpt-5.6-sol",
    source: "implement",
    availability: "known",
    ...overrides,
  };
}

test("W1-T2594: resolver accepts only an exact task + PR + live-head claim", () => {
  const lines = [
    claim({ head_sha: "older" }),
    claim({ pr_url: `${PR}0` }),
    claim({ task_id: "W1-T2593" }),
    claim(),
  ];

  assert.deepEqual(resolveReviewProviderProvenance(lines, { taskId: "W1-T2594", prUrl: PR, headSha: HEAD }), {
    state: "known",
    provider: "codex",
    model: "gpt-5.6-sol",
    source: "implement",
    claimCount: 1,
  });
  assert.deepEqual(resolveReviewProviderProvenance(lines, { taskId: "W1-T2594", prUrl: PR, headSha: "human-push" }), {
    state: "unknown",
    reason: "no-exact-claim",
  });
});

test("W1-T2594: conflicting exact-key provider claims are ambiguous, never last-write-wins", () => {
  const result = resolveReviewProviderProvenance(
    [claim({ provider: "codex" }), claim({ provider: "claude", run_id: "run-2" })],
    { taskId: "W1-T2594", prUrl: PR, headSha: HEAD },
  );

  assert.deepEqual(result, {
    state: "ambiguous",
    providers: ["claude", "codex"],
    claimCount: 2,
  });
});

test("W1-T2594: producer recording binds a valid worker provider to the freshly read head", () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const result = recordHeadProviderAfterPush(
    {
      taskId: "W1-T2594",
      prUrl: PR,
      source: "fix",
      worker: { provider: "claude", model: "claude-opus-4-1" },
      priorHeadSha: "prior",
    },
    {
      readProducedHeadSha: () => HEAD,
      readHeadSha: () => HEAD,
      log: (step, fields = {}) => rows.push({ step, fields }),
    },
  );

  assert.equal(result.state, "recorded");
  assert.deepEqual(rows, [
    {
      step: "pr.head_provider",
      fields: {
        task_id: "W1-T2594",
        pr_url: PR,
        head_sha: HEAD,
        provider: "claude",
        model: "claude-opus-4-1",
        source: "fix",
        availability: "known",
      },
    },
  ]);
});

test("W1-T2594: missing, unreadable, unchanged, or mismatched producer evidence is unavailable and makes no claim", () => {
  const cases = [
    {
      worker: { model: "unknown" },
      readProducedHeadSha: () => {
        throw new Error("must not read a produced head without a provider");
      },
      readHeadSha: () => {
        throw new Error("must not read a head without a provider");
      },
      priorHeadSha: undefined,
      reason: "worker-provider-unavailable",
    },
    {
      worker: { provider: "codex", model: "gpt-5.6-sol" },
      readProducedHeadSha: () => HEAD,
      readHeadSha: () => {
        throw new Error("REST unavailable");
      },
      priorHeadSha: undefined,
      reason: "live-head-unreadable",
    },
    {
      worker: { provider: "codex", model: "gpt-5.6-sol" },
      readProducedHeadSha: () => HEAD,
      readHeadSha: () => HEAD,
      priorHeadSha: HEAD,
      reason: "head-unchanged-after-push",
    },
    {
      worker: { provider: "codex", model: "gpt-5.6-sol" },
      readProducedHeadSha: () => {
        throw new Error("local head unreadable");
      },
      readHeadSha: () => {
        throw new Error("must not trust a live head when the worker output is unreadable");
      },
      priorHeadSha: "prior",
      reason: "produced-head-unreadable",
    },
    {
      worker: { provider: "codex", model: "gpt-5.6-sol" },
      readProducedHeadSha: () => "worker-head",
      readHeadSha: () => HEAD,
      priorHeadSha: "prior",
      reason: "live-head-mismatch",
    },
  ] as const;

  for (const c of cases) {
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const result = recordHeadProviderAfterPush(
      { taskId: "W1-T2594", prUrl: PR, source: "fix", worker: c.worker, priorHeadSha: c.priorHeadSha },
      {
        readProducedHeadSha: c.readProducedHeadSha,
        readHeadSha: c.readHeadSha,
        log: (step, fields = {}) => rows.push({ step, fields }),
      },
    );
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, c.reason);
    assert.equal(rows[0].step, "pr.head_provider");
    assert.equal(rows[0].fields.availability, "unavailable");
    assert.equal(rows[0].fields.reason, c.reason);
    assert.ok(!("provider" in rows[0].fields), `${c.reason}: unavailable row must not claim a provider`);
    assert.ok(!("head_sha" in rows[0].fields), `${c.reason}: unavailable row must not claim a head`);
  }
});

test("W1-T2594: the production review command resolves and ledgers provenance for the exact head", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-provider-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const sentinel = "stop-after-provenance";
  try {
    appendLedger(ledgerPath, claim(), { ceilingBytes: Number.MAX_SAFE_INTEGER });

    await assert.rejects(
      () =>
        reviewCommand("provenance-branch", ["--repo", "craigoley/remudero"], {
          fetchView: () => ({
            headRefOid: HEAD,
            headRefName: "provenance-branch",
            body: "Remudero-Task: W1-T2594",
            url: PR,
            number: 99,
          }),
          fetchHead: () => {},
          loadConfig: () => ({ root }) as Config,
          postReviewPending: (() => {}) as never,
          materialize: (() => {
            throw new Error(sentinel);
          }) as never,
        }),
      (error: Error) => error.message === sentinel,
    );

    const rows = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const observed = rows.find((line) => line.step === "review.provider_provenance");
    assert.deepEqual(
      observed && {
        state: observed.state,
        provider: observed.provider,
        model: observed.model,
        source: observed.source,
        claim_count: observed.claim_count,
        pr_url: observed.pr_url,
        head_sha: observed.head_sha,
      },
      {
        state: "known",
        provider: "codex",
        model: "gpt-5.6-sol",
        source: "implement",
        claim_count: 1,
        pr_url: PR,
        head_sha: HEAD,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2594: production ordering records only after ownership/push and before the next gate", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

  const ownership = source.indexOf("const ownership = checkPrOwnership(prUrl, branch");
  const implementationClaim = source.indexOf("recordHeadProviderAfterPush(", ownership);
  const opened = source.indexOf('log("pr.opened"', ownership);
  assert.ok(ownership >= 0 && ownership < implementationClaim && implementationClaim < opened);

  const fixPush = source.indexOf("deps.push(opts.worktreePath, opts.branch);");
  const fixClaim = source.indexOf("recordHeadProviderAfterPush(", fixPush);
  const fixCi = source.indexOf("deps.waitForCiGreen(opts.prUrl", fixPush);
  assert.ok(fixPush >= 0 && fixPush < fixClaim && fixClaim < fixCi);
});

test("W1-T2594: provider and model labels stay out of the semantic reviewer prompt", () => {
  const prompt = buildReviewPrompt({
    task: { id: "W1-T2594", acceptance: [{ claim: "exact head", proof: "test: provenance" }] },
    prUrl: PR,
    owner: "craigoley",
    repo: "remudero",
    headSha: HEAD,
  });
  assert.doesNotMatch(prompt, /\b(?:provider|claude|codex|gpt-5|sonnet|opus)\b/i);
});
