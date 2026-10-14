// test/an-alert-fix-pr-carries-proofs-the-reviewer-can-execute.test.ts
//
// W1-T8625. THE DEFECT, read on origin/main before anything here was written:
//   - `alertFixPrompt` asked for "an `Acceptance:` block of `- <claim> | <proof>` bullets" and never
//     named a dialect. review.ts executes a proof only when it opens with `unit test:` or `grep:`; any
//     other proof is prose and caps the verdict. Main-repair PR #11096 failed proof-discrimination on
//     exactly that shape.
//   - `dispatchAlertFixRun`'s author-time check (`checkAlertFixAcceptance` → `acceptanceAuthorTimeCheck`)
//     returns `ok: true` at its trailer arm for any body carrying `Remudero-Task:` — and every
//     alert-fix body carries one — so it never read the proofs, and a prose-proof body ledgered nothing.
//
// WHAT IS REAL HERE: the prompt, the grammar, the inert-proof helper, `parseAcceptanceBlock`,
// `parseWhitelistedProof` and `acceptanceAuthorTimeCheck` are the production functions. Only the
// dispatcher's effect boundary (worktree, spawn, gh reads) is faked, the same seam
// test/acceptance-block-diagnostics.test.ts drives.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACCEPTANCE_PROOF_GRAMMAR, PR_BODY_ACCEPTANCE_GRAMMAR, inertAcceptanceProofs } from "../src/lib/proof-grammar.js";
import { acceptanceAuthorTimeCheck, parseAcceptanceBlock, parseWhitelistedProof } from "../src/lib/review.js";
import { breMetacharsIn } from "../src/lib/task-linter.js";
import {
  alertFixPrompt,
  dispatchAlertFixRun,
  readAlertFixPrBody,
  type AlertFixDispatchDeps,
} from "../src/run-task.js";
import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "8625",
  severity: "medium",
  state: "open",
  createdAt: "2026-10-12T00:00:00Z",
  summary: "W1-T8625 fixture alert",
  url: "https://github.com/craigoley/remudero/security/code-scanning/8625",
  path: "src/lib/some-file.ts",
};

const PR_URL = "https://github.com/craigoley/remudero/pull/86251";

/** The placeholders the grammar's example bullets use, filled the way a worker filling them would. */
const PLACEHOLDERS: ReadonlyArray<[string, string]> = [
  ["<claim>", "the alert is fixed"],
  ["<exact title of a test this change adds>", "W1-T8625 fixture: the fixed path rejects the bad input"],
  ["<pattern>", "readFileIfExists("],
  ["<path>", "src/lib/fs-safe.ts"],
];

function instantiate(template: string): string {
  return PLACEHOLDERS.reduce((acc, [from, to]) => acc.split(from).join(to), template);
}

/** Every example bullet the text shows — lifted OUT OF THE PROMPT ITSELF, so a stale copy here cannot pass. */
function exampleBulletsIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(- <claim> \| (?:unit test|grep):.*)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "s-w1t8625",
    costUsd: 0.01,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as unknown as WorkerResult;
}

const MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };

/** The dispatch seams, with the opened PR's body served by BOTH body readers — the author-time check runs the REAL
 *  `acceptanceAuthorTimeCheck` over it, exactly as `checkAlertFixAcceptance` does in production. */
function depsServing(body: string, overrides: Partial<AlertFixDispatchDeps> = {}): AlertFixDispatchDeps {
  return {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => MOUNT,
    spawn: async () => workerResult(`REPORT\nPR_URL: ${PR_URL}\n`),
    ensureTaskTrailer: () => {},
    checkAcceptance: () => acceptanceAuthorTimeCheck(body),
    readPrBody: () => body,
    ...overrides,
  };
}

async function rowsAfterDispatch(deps: AlertFixDispatchDeps, label: string): Promise<Array<Record<string, unknown>>> {
  const root = mkdtempSync(join(tmpdir(), `rmd-w1t8625-${label}-`));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, ALERT, ledgerPath, `ALERT-FIX-W1T8625-${label}`, deps);
    return readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function inertDefectRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((r) => r.step === "alert-fix.acceptance_defect" && r.defect === "inert-proofs");
}

test("W1-T8625: the alert-fix prompt carries a proof grammar whose examples all execute", () => {
  const prompt = alertFixPrompt(ALERT, "alert-code-scanning-8625");

  // The prompt carries the shared PR-body grammar, every line of it.
  for (const line of PR_BODY_ACCEPTANCE_GRAMMAR) {
    assert.ok(prompt.includes(line), `alertFixPrompt is missing a PR-body grammar line: ${line.trim().slice(0, 70)}`);
  }
  // It names both executable dialects outright — the old bare `- <claim> | <proof>` line named none.
  assert.match(prompt, /unit test: /, "the prompt must name the `unit test:` dialect");
  assert.match(prompt, /grep: /, "the prompt must name the `grep:` dialect");
  assert.ok(!prompt.includes("`- <claim> | <proof>` bullets covering the fix"), "the dialect-less bullet instruction is gone");

  // The grep dialect rules are SHARED with the filing grammar, not a second drifting copy.
  for (const marker of ["BASIC regex", "grep the text your change ADDS", "must never contain ` in `"]) {
    const filing = ACCEPTANCE_PROOF_GRAMMAR.filter((l) => l.includes(marker));
    assert.equal(filing.length, 1, `sanity: the filing grammar carries the "${marker}" rule once`);
    assert.ok(PR_BODY_ACCEPTANCE_GRAMMAR.includes(filing[0]), `the PR-body grammar reuses the filing line verbatim: ${marker}`);
  }
  // Not the filing framing: an alert fix writes its test in the same PR.
  assert.ok(!PR_BODY_ACCEPTANCE_GRAMMAR.some((l) => l.includes("You are FILING work")), "the filing framing is not reused");

  // Every example bullet, instantiated, parses as an executable proof — under the reviewer's own parsers.
  const examples = exampleBulletsIn(prompt);
  assert.equal(examples.length, 2, `expected one example bullet per dialect, found ${examples.length}: ${examples.join(" / ")}`);
  const filled = examples.map(instantiate);
  for (const bullet of filled) assert.doesNotMatch(bullet, /<[^>]+>/, `an example placeholder was left unfilled: ${bullet}`);
  const body = `## Acceptance\n\n${filled.join("\n")}\n`;
  const criteria = parseAcceptanceBlock(body);
  assert.equal(criteria.length, examples.length, "each example bullet parses as its own criterion");
  const kinds: string[] = [];
  for (const c of criteria) {
    const parsed = parseWhitelistedProof(c.proof);
    assert.ok(parsed, `the grammar teaches a proof the real parser REFUSES: "${c.proof}"`);
    kinds.push(parsed.kind);
    if (parsed.kind === "grep") {
      const pattern = parsed.label.slice(0, parsed.label.lastIndexOf(" in "));
      assert.deepEqual(breMetacharsIn(pattern).blocking, [], `the example grep pattern carries blocking BRE metacharacters: "${pattern}"`);
    }
  }
  assert.deepEqual(kinds.sort(), ["grep", "test"], "one example per dialect");
  assert.deepEqual(inertAcceptanceProofs(body), [], "no example the grammar teaches is inert");
});

test("W1-T8625: an alert-fix body with a prose proof is ledgered as a defect", async () => {
  const body = "Fixes the alert.\n\nAcceptance:\n- the alert is fixed | the build passes\n\norigin: alert#code-scanning-8625\n";
  assert.equal(acceptanceAuthorTimeCheck(body).ok, true, "sanity: the existing author-time check passes this body");
  const rows = await rowsAfterDispatch(depsServing(body), "prose");
  assert.ok(rows.some((r) => r.step === "alert-fix.pr_opened"), "positive control: the dispatch reached the opened PR");
  const defects = inertDefectRows(rows);
  assert.equal(defects.length, 1, "a prose-proof body ledgers exactly one inert-proofs defect");
  assert.equal(defects[0].pr_url, PR_URL);
  assert.equal(defects[0].inert_count, 1);
  assert.deepEqual(defects[0].inert_proofs, ["the build passes"]);
});

test("W1-T8625: a prose proof naming a test path is still an inert proof", async () => {
  const prose = "test/a-spent-check-requeue-survives-ledger-rotation.test.ts passes";
  // The trap this guards: the reviewer's legacy bare-path match (W1-T65) ACCEPTS this text as a test proof.
  assert.notEqual(parseWhitelistedProof(prose), null, "positive control: parseWhitelistedProof alone accepts the bare path");
  const body = `Acceptance:\n- the alert is fixed | ${prose}\n- the guard holds | unit test: W1-T8625 fixture title\n`;
  assert.deepEqual(inertAcceptanceProofs(body), [prose], "a dialect-less proof is inert even when it names a test path");
  // A `demonstration:` proof never executes, so it is inert too; an empty proof has nothing to run.
  assert.deepEqual(
    inertAcceptanceProofs("Acceptance:\n- a demo | demonstration: a human checks the page\n- nothing |\n"),
    ["demonstration: a human checks the page", ""],
  );
  assert.deepEqual(inertAcceptanceProofs("no acceptance header in this body"), [], "no block means no proofs to count");

  const rows = await rowsAfterDispatch(depsServing(`Acceptance:\n- the alert is fixed | test/x.test.ts passes\n`), "path");
  const defects = inertDefectRows(rows);
  assert.equal(defects.length, 1, "the dispatcher ledgers the bare-path prose proof");
  assert.deepEqual(defects[0].inert_proofs, ["test/x.test.ts passes"]);
});

test("W1-T8625: a trailered alert-fix body with a prose proof is still ledgered", async () => {
  const body = "Acceptance:\n- the alert is fixed | the build passes\n\nRemudero-Task: alert-code-scanning-8625\n";
  const check = acceptanceAuthorTimeCheck(body);
  assert.equal(check.ok, true, "positive control: the trailer arm returns ok before it reads the block");
  assert.match(check.message, /trailer present/, "and it says so — it never looked at the proofs");
  const rows = await rowsAfterDispatch(depsServing(body), "trailer");
  const defects = inertDefectRows(rows);
  assert.equal(defects.length, 1, "the trailer arm must not short-circuit the inert-proof count");
  assert.deepEqual(defects[0].inert_proofs, ["the build passes"]);
});

test("W1-T8625: an alert-fix body whose proofs all execute ledgers no defect", async () => {
  const body =
    "Acceptance:\n" +
    "- the guard rejects the bad input | unit test: W1-T8625 fixture: the fixed path rejects the bad input\n" +
    "- the guard is wired | grep: readFileIfExists( in src/lib/fs-safe.ts\n" +
    "\nRemudero-Task: alert-code-scanning-8625\n";
  const rows = await rowsAfterDispatch(depsServing(body), "clean");
  assert.ok(rows.some((r) => r.step === "alert-fix.pr_opened"), "positive control: the dispatch reached the opened PR");
  assert.equal(rows.filter((r) => r.step === "alert-fix.acceptance_defect").length, 0, "an executable body ledgers no defect");
  assert.equal(rows.filter((r) => r.step === "alert-fix.acceptance_check_error").length, 0);
});

test("W1-T8625: an unreadable opened body is ledgered as a check error, never as a clean body", async () => {
  const rows = await rowsAfterDispatch(
    depsServing("unused", {
      readPrBody: () => {
        throw new Error("gh: could not resolve to a PullRequest");
      },
    }),
    "throws",
  );
  const errors = rows.filter((r) => r.step === "alert-fix.acceptance_check_error" && r.check === "inert-proofs");
  assert.equal(errors.length, 1, "a failed body read leaves a named row");
  assert.match(String(errors[0].error), /could not resolve to a PullRequest/);
  assert.equal(inertDefectRows(rows).length, 0, "a read failure is not a defect verdict");
});

test("W1-T8625: the real body reader reads the PR body over gh once", () => {
  const calls: string[][] = [];
  const body = readAlertFixPrBody(PR_URL, (args) => {
    calls.push(args);
    return { body: "Acceptance:\n- a | b\n" };
  });
  assert.deepEqual(calls, [["pr", "view", PR_URL, "--json", "body"]]);
  assert.equal(body, "Acceptance:\n- a | b\n");
  assert.equal(readAlertFixPrBody(PR_URL, () => ({})), "", "an absent body field reads as an empty body");
});
