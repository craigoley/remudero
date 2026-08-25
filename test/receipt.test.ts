import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReceipt, type ReceiptLedgerLine } from "../src/lib/receipt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TASK_ID = "W1-T71";
const RUN_ID = `${TASK_ID}-1755000000000`;
const PR_URL = "https://github.com/craigoley/remudero/pull/9001";

/** A full, ground-truth ledger for one run — every step the rationale verified live, plus the
 *  W1-T71 `prompt_template_hash` emission on `prompt.linted`. Deep-cloned per test via
 *  `fullLedger()` so no test can mutate a shared fixture out from under another. */
function fullLedger(): ReceiptLedgerLine[] {
  return [
    { run_id: RUN_ID, task_id: TASK_ID, step: "run.start", lane: "run-task", repo: "remudero" },
    {
      run_id: RUN_ID,
      task_id: TASK_ID,
      step: "prompt.linted",
      provenance: "clean",
      prompt_template_hash: "abc123def456",
    },
    {
      run_id: RUN_ID,
      task_id: TASK_ID,
      step: "learnings.injected",
      matched: 2,
      matched_ids: ["cache-prefix-bytes", "control-surface-fail-loud-stop-one-shot"],
    },
    {
      run_id: RUN_ID,
      task_id: TASK_ID,
      step: "implement.done",
      model: "claude-opus-4",
      effort: "high",
      num_turns: 42,
      cost_usd: 3.14,
    },
    { run_id: RUN_ID, task_id: TASK_ID, step: "pr.opened", pr_url: PR_URL, branch: `run-${TASK_ID}-1755000000000` },
    { run_id: RUN_ID, task_id: TASK_ID, step: "automerge.armed", at: "open", outcome: "armed" },
    {
      run_id: RUN_ID,
      task_id: TASK_ID,
      step: "review.posted",
      head_sha: "deadbeef",
      reviewer_outcome: "reviewer_completed",
    },
    { run_id: RUN_ID, task_id: TASK_ID, step: "pr.merged", state: "MERGED" },
    {
      run_id: "CORRECT-1755000100000",
      task_id: TASK_ID,
      step: "correction.provenance",
      claimed_pr_url: null,
      actual_pr_url: PR_URL,
      by: "operator",
      reason: null,
    },
  ];
}

test("buildReceipt deterministically assembles the predicate — byte-identical across two calls over one ledger", () => {
  const ledger = fullLedger();
  const a = buildReceipt(ledger, { taskId: TASK_ID, prUrl: PR_URL });
  const b = buildReceipt(ledger, { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Sanity: every ground-truth field actually resolved, not just "didn't throw".
  assert.deepEqual(a.predicate.run.run_id, { value: RUN_ID });
  assert.deepEqual(a.predicate.pr.branch, { value: `run-${TASK_ID}-1755000000000` });
  assert.deepEqual(a.predicate.learnings.injected_ids, {
    value: ["cache-prefix-bytes", "control-surface-fail-loud-stop-one-shot"],
  });
  assert.deepEqual(a.predicate.implement, {
    model: { value: "claude-opus-4" },
    effort: { value: "high" },
    num_turns: { value: 42 },
    cost_usd: { value: 3.14 },
  });
  assert.deepEqual(a.predicate.review.reviewer_outcome, { value: "reviewer_completed" });
  assert.deepEqual(a.predicate.merge, {
    state: { value: "MERGED" },
    automerge_outcome: { value: "armed" },
  });
  assert.deepEqual(a.predicate.correction, { present: true });
  assert.deepEqual(a.predicate.prompt_template_hash, { value: "abc123def456" });
});

test("a ledger missing reviewer_outcome yields that field null-with-reason, never fabricated", () => {
  const ledger = fullLedger().filter((l) => l.step !== "review.posted");
  const receipt = buildReceipt(ledger, { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(receipt.predicate.review.reviewer_outcome.value, null);
  assert.equal(
    "reason" in receipt.predicate.review.reviewer_outcome && receipt.predicate.review.reviewer_outcome.reason,
    `no "review.posted" ledger line found for task ${TASK_ID}`,
  );
  // Every OTHER field is untouched — one absent step degrades only its own field(s).
  assert.deepEqual(receipt.predicate.run.run_id, { value: RUN_ID });
  assert.deepEqual(receipt.predicate.merge.state, { value: "MERGED" });

  // The narrower case: the line exists but this run's `review.posted` never carried the field
  // (e.g. a keyword-floor-only line an older ledger shape wrote without it) — same null-with-a-
  // reason contract, a DIFFERENT, more specific reason string.
  const partial = fullLedger().map((l) =>
    l.step === "review.posted" ? { run_id: l.run_id, task_id: l.task_id, step: l.step, head_sha: l.head_sha } : l,
  );
  const receiptPartial = buildReceipt(partial, { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(receiptPartial.predicate.review.reviewer_outcome.value, null);
  assert.equal(
    "reason" in receiptPartial.predicate.review.reviewer_outcome &&
      receiptPartial.predicate.review.reviewer_outcome.reason,
    `"review.posted" ledger line for task ${TASK_ID} carries no reviewer_outcome field`,
  );
});

test("the drift golden holds: regeneration byte-equals the prior artifact; a mutated ground-truth line changes it", () => {
  const ledger = fullLedger();
  const priorArtifact = JSON.stringify(buildReceipt(ledger, { taskId: TASK_ID, prUrl: PR_URL }));

  // Regenerate from the SAME ledger — must byte-equal what was "previously committed".
  const regenerated = JSON.stringify(buildReceipt(fullLedger(), { taskId: TASK_ID, prUrl: PR_URL }));
  assert.equal(regenerated, priorArtifact);

  // Mutate exactly one ground-truth ledger field (the reviewer outcome) — the receipt MUST change.
  const mutated = fullLedger().map((l) =>
    l.step === "review.posted" ? { ...l, reviewer_outcome: "reviewer_capped" } : l,
  );
  const afterMutation = JSON.stringify(buildReceipt(mutated, { taskId: TASK_ID, prUrl: PR_URL }));
  assert.notEqual(afterMutation, priorArtifact);
});

test("the v2 rungs are deferred, not entangled — the predicate module carries no signing dependency", () => {
  const src = readFileSync(join(__dirname, "..", "src", "lib", "receipt.ts"), "utf8");
  // No IMPORT of a signing package — this module's prose is free to name what it defers
  // (see the file's own header comment), but its `import`/`require` graph must not.
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  for (const line of importLines) {
    assert.doesNotMatch(line, /sigstore|cosign/i);
  }

  // The predicate itself is a standalone value — nothing under `predicate` is a signature/
  // envelope field a v2 signer would already assume exists.
  const receipt = buildReceipt(fullLedger(), { taskId: TASK_ID, prUrl: PR_URL });
  const keys = JSON.stringify(Object.keys(receipt));
  assert.doesNotMatch(keys, /signature|sigstore|cosign/i);

  // No new signing dependency landed in package.json alongside this task.
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal(Object.keys(allDeps).some((name) => /sigstore|cosign/i.test(name)), false);
});

test("buildReceipt scopes strictly to the given task id — a shared ledger never bleeds another task's data in", () => {
  const other = { run_id: "OTHER-1", task_id: "W1-T999", step: "review.posted", reviewer_outcome: "reviewer_completed" };
  const receipt = buildReceipt([...fullLedger(), other], { taskId: TASK_ID, prUrl: PR_URL });
  assert.deepEqual(receipt.predicate.review.reviewer_outcome, { value: "reviewer_completed" });

  const forOther = buildReceipt([...fullLedger(), other], { taskId: "W1-T999", prUrl: PR_URL });
  assert.equal(forOther.predicate.run.run_id.value, null);
});

// ── `rmd receipt <pr>` — the CLI wiring around buildReceipt (design item 3), driven with
// injected deps so the resolution + refusal paths are exercised with zero network. ────────
test("receiptCommand resolves the task id from the PR body's Remudero-Task trailer and prints buildReceipt's predicate", async () => {
  const { receiptCommand } = await import("../src/run-task.js");
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await receiptCommand("9001", ["--repo", "remudero"], {
      // "9001" is REST-addressable (reviewPrNumber matches a bare number), so reviewViewArgs
      // takes the REST arm and this fake must return a raw REST pull row — mapRestPr's shape,
      // not `gh pr view --json`'s — exactly as reviewCommand's own fetchView fake would.
      gh: () => ({
        number: 9001,
        html_url: PR_URL,
        head: { sha: "deadbeef", ref: `run-${TASK_ID}-1755000000000` },
        body: `Some prose mentioning Remudero-Task: W1-T20c mid-body.\n\nRemudero-Task: ${TASK_ID}\n`,
      }),
      config: { root: "/tmp/rmd-receipt-command-test" } as never,
      resolveReceiptLedgerLines: () => ({ ok: true, lines: fullLedger() }),
    });
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  const output = JSON.parse(printed.join("\n"));
  assert.equal(output.subject.task_id, TASK_ID);
  assert.equal(output.subject.pr_url, PR_URL);
  assert.deepEqual(output.predicate.review.reviewer_outcome, { value: "reviewer_completed" });
});

test("receiptCommand rejects an unknown flag before any network call — fail loud, no gh spawn", async () => {
  const { receiptCommand } = await import("../src/run-task.js");
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  let ghCalled = false;
  let code: number;
  try {
    code = await receiptCommand("9003", ["--bogus"], {
      gh: () => {
        ghCalled = true;
        throw new Error("must not be called — bad-arg refusal happens before any gh call");
      },
      config: { root: "/tmp/rmd-receipt-command-test" } as never,
      resolveReceiptLedgerLines: () => ({ ok: true, lines: [] }),
    });
  } finally {
    console.error = realError;
  }
  assert.equal(code, 2);
  assert.equal(ghCalled, false);
  assert.ok(errors.some((e) => e.includes("unexpected argument '--bogus'")));
});

test("receiptCommand refuses (never guesses) when the PR body carries no Remudero-Task trailer", async () => {
  const { receiptCommand } = await import("../src/run-task.js");
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await receiptCommand("9002", ["--repo", "remudero"], {
      gh: () => ({
        number: 9002,
        html_url: "https://github.com/craigoley/remudero/pull/9002",
        head: { sha: "cafebabe", ref: "some-branch" },
        body: "no trailer here",
      }),
      config: { root: "/tmp/rmd-receipt-command-test" } as never,
      resolveReceiptLedgerLines: () => ({ ok: true, lines: [] }),
    });
  } finally {
    console.error = realError;
  }
  assert.equal(code, 1);
  assert.ok(errors.some((e) => e.includes("no Remudero-Task trailer")));
});
