// test/acceptance-block-diagnostics.test.ts
//
// THE DEFECT, reproduced at this sha before anything was written. `parseAcceptanceBlock` treats any
// indented line that is not `proof:` as the END of the block. A claim WRAPPED onto a second line —
// the most natural thing an author does to a long claim — therefore truncates silently:
//
//     written 3  ->  parsed 1, with an EMPTY proof        (wrapped)
//     written 3  ->  parsed 3, no empty proofs            (identical body, no wrap)
//
// The review then judges the PR against a criterion the author never meant to stand alone, and the
// criteria after the wrap are simply gone. That is the same overloaded-zero shape as the two `grep:`
// traps this repo has already paid for — a pattern wrapping across a YAML line matches nothing, and
// a case-mismatched pattern returns nothing. All three are LINE-ORIENTED PARSERS MEETING WRAPPED
// TEXT, and all three fail by returning FEWER things rather than raising.
//
// WHY A DIAGNOSTIC AND NOT A STRICTER PARSER. Making `parseAcceptanceBlock` reject would fail bodies
// that merge today, so the parser keeps its permissive contract and this reports the discrepancy
// instead. These tests therefore assert the parser is UNCHANGED as well as that the diagnostic sees
// the truncation.
//
// WHAT IS REAL HERE: `acceptanceBlockDiagnostics` and `parseAcceptanceBlock` are the production
// functions, called directly — there is no seam and nothing is injected. The CLI test drives
// `checkAcceptanceCommand`, the production command body, over a real temp file.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acceptanceAuthorTimeCheck,
  acceptanceBlockDiagnostics,
  narrowNameFilteredArgs,
  parseAcceptanceBlock,
  parseWhitelistedProof,
  PR_AUTHORING_PATHS,
  type AcceptanceAuthorTimeResult,
} from "../src/lib/review.js";
import {
  checkAcceptanceCommand,
  checkAlertFixAcceptance,
  dispatchAlertFixRun,
  type AlertFixDispatchDeps,
} from "../src/run-task.js";
import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const WRAPPED = `## Acceptance

- claim: a claim long enough that an author wrapped it onto
  a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

/** Byte-identical to WRAPPED except the first claim stays on one line. */
const UNWRAPPED = `## Acceptance

- claim: a claim long enough that an author wrapped it onto a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

/** The #1342/#1344 shape: a Validation section written where an Acceptance block belonged. */
const NO_HEADER = `## Validation

- claim: something was proved
  proof: unit test: test/foo.test.ts
`;

function tmpFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-accept-diag-"));
  const path = join(dir, "body.md");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a wrapped claim truncates the block, and the diagnostic reports exactly where", () => {
  // The parser's own (unchanged, permissive) behaviour first — this is the defect being surfaced.
  assert.equal(parseAcceptanceBlock(WRAPPED).length, 1, "the parser still resolves only the first criterion");
  assert.equal(parseAcceptanceBlock(WRAPPED)[0]?.proof, "", "and its proof is empty — nothing would execute");

  const d = acceptanceBlockDiagnostics(WRAPPED);
  assert.equal(d.headerFound, true);
  assert.equal(d.bulletsWritten, 3, "three bullets were written");
  assert.equal(d.criteriaParsed, 1, "only one survives the parse");
  assert.equal(d.emptyProofs, 1);
  assert.equal(d.truncatedAtBullet, 2, "the block ends before the second bullet");
  assert.equal(d.defective, true);
});

test("the identical body without the wrap is clean — the wrap is the whole difference", () => {
  const d = acceptanceBlockDiagnostics(UNWRAPPED);
  assert.equal(d.bulletsWritten, 3);
  assert.equal(d.criteriaParsed, 3, "all three survive when no claim wraps");
  assert.equal(d.emptyProofs, 0);
  assert.equal(d.truncatedAtBullet, undefined);
  assert.equal(d.defective, false);
  // Guards against a diagnostic that just always says "defective".
  assert.equal(parseAcceptanceBlock(UNWRAPPED).length, 3);
});

test("a Validation section where an Acceptance block belonged is reported as a missing header", () => {
  const d = acceptanceBlockDiagnostics(NO_HEADER);
  assert.equal(d.headerFound, false, "`## Validation` is not an Acceptance header");
  assert.equal(d.criteriaParsed, 0, "so the review would fail closed with nothing to judge");
  assert.equal(d.defective, true);
});

test("prose after the block is not miscounted as extra criteria", () => {
  // The real shape of every hand-authored body this week: an Acceptance block followed by a
  // `## Validation` section containing its own bullets. Those bullets are NOT criteria, and a
  // diagnostic that counted them would report a false truncation on a perfectly good body.
  const body = `${UNWRAPPED}
## Validation

- some validation note
- another validation note
`;
  const d = acceptanceBlockDiagnostics(body);
  assert.equal(d.bulletsWritten, 3, "counting stops at the end of the block, not at the end of the file");
  assert.equal(d.criteriaParsed, 3);
  assert.equal(d.defective, false);
});

test("the single-line pipe form the orchestrator emits round-trips clean", () => {
  // `renderAcceptanceBlock` (plan-pr-emitter.ts) emits exactly this shape; a diagnostic that called
  // the house format defective would be worse than the defect.
  const body = "Acceptance:\n- the claim | unit test: test/foo.test.ts\n- another claim | unit test: test/bar.test.ts\n";
  const d = acceptanceBlockDiagnostics(body);
  assert.equal(d.bulletsWritten, 2);
  assert.equal(d.criteriaParsed, 2);
  assert.equal(d.emptyProofs, 0);
  assert.equal(d.defective, false);
});

// ── the CLI verb: the production command body, over a real file ─────────────────────────────────

test("check-acceptance exits non-zero on a truncating body and zero on a clean one", () => {
  const bad = tmpFile(WRAPPED);
  const good = tmpFile(UNWRAPPED);
  try {
    assert.equal(checkAcceptanceCommand([bad.path]), 1, "a truncating body must refuse");
    assert.equal(checkAcceptanceCommand([good.path]), 0, "a clean body must pass");
  } finally {
    bad.cleanup();
    good.cleanup();
  }
});

test("check-acceptance refuses a missing argument and an unreadable file without throwing", () => {
  assert.equal(checkAcceptanceCommand([]), 2, "no file argument is a usage error, not a crash");
  assert.equal(checkAcceptanceCommand([join(tmpdir(), "rmd-no-such-body-xyzzy.md")]), 2, "unreadable file too");
});

test("check-acceptance reports a missing header through the CLI, not only through the diagnostic", () => {
  // Covers the command's own `!headerFound` branch — the #1342/#1344 shape reaching the verb an
  // author would actually run, rather than only the pure function beneath it.
  const f = tmpFile(NO_HEADER);
  try {
    assert.equal(checkAcceptanceCommand([f.path]), 1, "a body with no Acceptance header must refuse");
  } finally {
    f.cleanup();
  }
});

// ── W1-T952: THE AUTHOR-TIME CHECK — routing acceptanceBlockDiagnostics onto the ONE PR-open path
// (rmd alert-fix) whose body has no plan-side fallback, before CI/review pays for a round trip to
// discover the same defect a generic "no acceptance criteria to judge (fail closed)" refusal would.
// See design item (i)'s recorded coverage in `PR_AUTHORING_PATHS` (lib/review.ts) for which paths
// this reaches and which it structurally cannot.

test("W1-T952: every PR-authoring path is enumerated with its coverage stated", () => {
  assert.ok(PR_AUTHORING_PATHS.length >= 5, "design item (i)'s enumerated paths must all be present");
  for (const row of PR_AUTHORING_PATHS) {
    assert.equal(typeof row.path, "string");
    assert.ok(row.path.length > 0, "every row names its path");
    assert.equal(typeof row.reachable, "boolean", `${row.path}: reachable must be STATED, never omitted`);
    assert.equal(typeof row.wiredByThisChange, "boolean", `${row.path}: wiredByThisChange must be STATED, never omitted`);
    assert.ok(row.reason.length > 20, `${row.path}: coverage must be EXPLAINED, not merely asserted`);
  }
  // The load-bearing negative half of design item (i): an in-repo check cannot reach a hand-opened
  // PR — stated explicitly here, never silently omitted.
  const unreachable = PR_AUTHORING_PATHS.filter((r) => !r.reachable);
  assert.ok(unreachable.length >= 2, "the hand-gh-cli and MCP-client paths must both be named as unreachable");
  assert.ok(unreachable.every((r) => !r.wiredByThisChange), "an unreachable path can never be claimed wired");
  // Exactly one path is ACTUALLY wired by this change — the rest are recorded, not silently
  // claimed closed (the "silently covers only the in-repo path" failure design item (i) forbids).
  const wired = PR_AUTHORING_PATHS.filter((r) => r.wiredByThisChange);
  assert.equal(wired.length, 1, "exactly one path is wired by this change");
  assert.match(wired[0].path, /alert-fix/i);
});

test("W1-T952: the diagnostic names the specific defect not a generic failure", () => {
  const noHeader = acceptanceAuthorTimeCheck("just prose, no header, no trailer anywhere in this body");
  assert.equal(noHeader.ok, false);
  assert.equal(noHeader.defect, "no-header");

  const unparseable = acceptanceAuthorTimeCheck(WRAPPED);
  assert.equal(unparseable.ok, false);
  assert.equal(unparseable.defect, "unparseable");

  const emptyProofs = acceptanceAuthorTimeCheck("Acceptance:\n- a claim with no proof written anywhere\n");
  assert.equal(emptyProofs.ok, false);
  assert.equal(emptyProofs.defect, "empty-proofs");

  const noTrailer = acceptanceAuthorTimeCheck(UNWRAPPED, { expectedTaskId: "W1-T952" });
  assert.equal(noTrailer.ok, false);
  assert.equal(noTrailer.defect, "no-trailer", "a healthy body-level block is still a defect when the CALLER requires a specific task trailer");

  // Four DISTINCT names, not one generic "defective" boolean wearing four costumes.
  const defects = new Set([noHeader.defect, unparseable.defect, emptyProofs.defect, noTrailer.defect]);
  assert.equal(defects.size, 4, "each shape must produce ITS OWN name");

  // And the healthy control never gets a name at all.
  const healthy = acceptanceAuthorTimeCheck(UNWRAPPED);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.defect, undefined);
});

test("W1-T952: a resolvable trailer is the OTHER healthy shape — both trailer arms report ok with no defect", () => {
  // ARM 1 — the caller REQUIRES a specific task id and the body carries exactly it. The
  // no-trailer failure arm is already covered above; this is its passing twin, and without it the
  // only executed path through the `expectedTaskId` branch is the one that returns a defect.
  const matched = acceptanceAuthorTimeCheck("body prose\n\nRemudero-Task: W1-T952\n", { expectedTaskId: "W1-T952" });
  assert.equal(matched.ok, true, "a trailer equal to the expected id is healthy");
  assert.equal(matched.defect, undefined, "a healthy result never carries a defect name");
  assert.match(matched.message, /credits this task on merge/);

  // ARM 2 — no caller expectation, but the body carries a trailer, so criteria resolve from the
  // plan rather than from a body-level block. Distinct from the `UNWRAPPED` control above, which
  // is healthy because its BLOCK parses, not because a trailer exists.
  const resolvable = acceptanceAuthorTimeCheck("no acceptance header at all\n\nRemudero-Task: W1-T400\n");
  assert.equal(resolvable.ok, true, "a trailer alone is healthy — criteria resolve from plan/tasks.yaml");
  assert.equal(resolvable.defect, undefined);
  assert.match(resolvable.message, /criteria resolve from plan\/tasks\.yaml/);
  assert.match(resolvable.message, /W1-T400/, "the message names the trailer it actually found");

  // FALSIFIER — the same body with a DIFFERENT expected id is still a defect, so arm 1 is
  // asserting equality rather than mere presence.
  const mismatched = acceptanceAuthorTimeCheck("body prose\n\nRemudero-Task: W1-T952\n", { expectedTaskId: "W1-T999" });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.defect, "no-trailer");
  assert.match(mismatched.message, /found "Remudero-Task: W1-T952" instead/);
});

test("W1-T952: the REAL checkAcceptance binding reads the PR body over gh and delegates the verdict", () => {
  // Every dispatch test below injects `deps.checkAcceptance`, so the production binding — the one
  // thing that actually reads a PR body — would otherwise never execute. Inject only the `gh`
  // reader (appended LAST) and assert the argv AND the delegation.
  const calls: string[][] = [];
  const healthy = checkAlertFixAcceptance("https://github.com/craigoley/remudero/pull/4242", (args) => {
    calls.push(args);
    return { body: "no header here\n\nRemudero-Task: W1-T952\n" };
  });
  assert.deepEqual(
    calls,
    [["pr", "view", "https://github.com/craigoley/remudero/pull/4242", "--json", "body"]],
    "reads exactly the PR body, once, for the url it was handed",
  );
  assert.equal(healthy.ok, true, "the verdict is acceptanceAuthorTimeCheck's, not a second hand-rolled one");

  // A body the check refuses must come back refused THROUGH the binding — proving delegation
  // rather than an unconditional ok.
  const defective = checkAlertFixAcceptance("https://github.com/craigoley/remudero/pull/4243", () => ({
    body: "just prose, no header, no trailer anywhere in this body",
  }));
  assert.equal(defective.ok, false);
  assert.equal(defective.defect, "no-header");

  // A read that yields no `body` field at all is treated as an EMPTY body, never as ok — the
  // `?? ""` arm, which is what a deleted or unreadable PR looks like on this path.
  const absent = checkAlertFixAcceptance("https://github.com/craigoley/remudero/pull/4244", () => ({}));
  assert.equal(absent.ok, false, "an absent body is a defect, never silently healthy");
  assert.equal(absent.defect, "no-header");
});

// ── The wired call site: rmd alert-fix (dispatchAlertFixRun, src/run-task.ts) ───────────────────
// alertTaskId (alertFixPrompt) never resolves in plan/tasks.yaml — the body is the ONLY thing
// review can ever judge this lane's PR from, so this is the one path where the check's absence
// reproduces rationale (1)'s exact failure: every CI check green, review refuses closed.

function w1t952WorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-w1t952",
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

const W1T952_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "952",
  severity: "medium",
  state: "open",
  createdAt: "2026-08-17T00:00:00Z",
  summary: "W1-T952 fixture alert",
  url: "https://github.com/craigoley/remudero/security/code-scanning/952",
  path: "src/lib/some-file.ts",
};

const W1T952_MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };

function w1t952Deps(checkAcceptance: (prUrl: string) => AcceptanceAuthorTimeResult): AlertFixDispatchDeps {
  return {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => W1T952_MOUNT,
    spawn: async () => w1t952WorkerResult("REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/9521\n"),
    ensureTaskTrailer: () => {},
    checkAcceptance,
  };
}

test("W1-T952: a body with no acceptance header is refused at author time", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t952-refused-"));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const deps = w1t952Deps(() => acceptanceAuthorTimeCheck("just prose, no header, no trailer anywhere in this body"));
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, W1T952_ALERT, ledgerPath, "ALERT-FIX-W1T952-A", deps);
    const lines = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const defectLine = lines.find((l) => l.step === "alert-fix.acceptance_defect");
    assert.ok(defectLine, "a defective body must be refused (named in the ledger) at author time, before CI/review runs");
    assert.equal(defectLine.defect, "no-header");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The positive control, in the SAME suite invocation as the refusal above (design item iv) — an
// implementation that refuses EVERY body would satisfy the test above perfectly.
test("W1-T952: a checkAcceptance that THROWS is ledgered as an error, never swallowed and never fatal", async () => {
  // The catch arm around the diagnostics call. Without this the only executed paths are ok and
  // not-ok, and a reader would have to take on faith that a `gh` failure here degrades rather
  // than killing the lane after the worker has already been paid for.
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t952-throws-"));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const deps = w1t952Deps(() => {
      throw new Error("gh: could not resolve to a PullRequest");
    });
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, W1T952_ALERT, ledgerPath, "ALERT-FIX-W1T952-T", deps);
    const lines = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const errLine = lines.find((l) => l.step === "alert-fix.acceptance_check_error");
    assert.ok(errLine, "a throwing check must leave a NAMED ledger row, not silence");
    assert.match(errLine.error, /could not resolve to a PullRequest/, "the row carries the real cause, not a generic message");
    assert.equal(errLine.pr_url, "https://github.com/craigoley/remudero/pull/9521");
    // FALSIFIER-ish control: the throw must not have been reclassified as an ordinary defect, and
    // must not have aborted the lane before its own cleanup.
    assert.equal(
      lines.find((l) => l.step === "alert-fix.acceptance_defect"),
      undefined,
      "a THROW is not a defect verdict — the two rows are distinct outcomes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T952: a well-formed body is accepted in the same run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t952-accepted-"));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const deps = w1t952Deps(() => acceptanceAuthorTimeCheck("Acceptance:\n- the claim | unit test: test/foo.test.ts\n"));
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, W1T952_ALERT, ledgerPath, "ALERT-FIX-W1T952-B", deps);
    const lines = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.step === "alert-fix.pr_opened"), "sanity: the PR was opened");
    assert.ok(!lines.some((l) => l.step === "alert-fix.acceptance_defect"), "a well-formed body must NOT be refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T952 DESIGN (v): THE FILE-SHA-BRACKETED MUTATION CHECK ───────────────────────────────────
//
// "The check is: read the sha256 of the edited file, remove the diagnostics call, read the sha256
// again and require it to DIFFER, run the suite and require the rejection test to FAIL, restore,
// and require the sha to return to the original." (design note (v), verbatim.) Mirrors W1-T951's
// own mutation check (test/dispatch-lifetime-breaker.test.ts) in what it proves, over the call
// this task actually wired (`deps.checkAcceptance(report.prUrl)` in `dispatchAlertFixRun`,
// src/run-task.ts) rather than status.ts's durable-credit lookup — but NOT in how it applies the
// mutation, for the reason below.
//
// Spawned from THIS file, targeting THIS file's own refusal test by name — a real child `node
// --test` process, narrowed via the SAME house dialect `remudero-review`'s own proof executor
// uses for a bare `unit test: <name>` proof (parseWhitelistedProof/narrowNameFilteredArgs).
//
// WHY THE MUTANT IS WRITTEN INTO A SHADOW CHECKOUT, NEVER THE REAL src/run-task.ts. W1-T951's own
// check (and this test's first draft) `writeFileSync`s the mutant straight over the real,
// checked-out source and restores it in a `finally`. Node's test runner runs test FILES
// concurrently, each importing modules from the SAME on-disk tree; for the whole width of that
// window — here, up to the child's 90s timeout — any OTHER concurrently-running file that imports
// `src/run-task.js` reads the MUTATED bytes instead of the real ones. `test/triage.test.ts` does
// exactly that (`import { TRIAGE_WORKER_TOOLS, triageCommand } from "../src/run-task.js"`), and
// MEASURED in `coverage-ratchet` (not `ci`, which never overlaps the same way) it failed with the
// identical symptom W1-T963 already diagnosed and fixed for `src/lib/triage.ts` itself
// (test/triage-proof-dialect.test.ts, commit 596e7a3): four assertions in a file this diff never
// touches, `/grilling/`/`/proposed/`/`/rejected/` and the seeded-ambiguous case, tripped by a race
// with zero relation to their own diff. W1-T963's fix (`writeMutantModule`) does not apply
// directly here — it writes a copy that is `import()`-ed and called in-process, but this check
// must spawn a full, independent `node --test` against the REAL target test FILE (which resolves
// `../src/run-task.js` and a dozen other siblings by real relative path), not a single function
// export. So instead: `git ls-files` gives the exact tracked tree, copied into a throwaway
// `test/mutants-XXXX/` shadow checkout (same coverage-excluded, non-`.test.ts`-named home
// `writeMutantModule` uses, and for the same two reasons — `ci.yml`'s `test/**` coverage exclude
// and its `test/**/*.test.ts` run glob both skip it); `node_modules` is symlinked, never copied
// (large, and never mutated); and the ONE file this check edits is written straight into the
// shadow copy. The real `src/run-task.ts` is asserted below to have NEVER been written at all —
// stronger than "restored", since there is no window in which it ever changed.

test("W1-T952: removing the diagnostics call fails the refusal test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runTaskTsPath = join(repoRoot, "src", "run-task.ts");
  const targetTestFile = "test/acceptance-block-diagnostics.test.ts";
  const positiveTestName = "W1-T952: a body with no acceptance header is refused at author time";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(runTaskTsPath, "utf8");
  const originalSha = sha256(original);

  const needle = "        const check = deps.checkAcceptance(report.prUrl);\n";
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: the diagnostics call must appear EXACTLY once in run-task.ts, or this mutation is not targeting the real rung",
  );
  const mutated = original.replace(
    needle,
    '        const check: AcceptanceAuthorTimeResult = { ok: true, message: "W1-T952 MUTATION: diagnostics call removed" };\n',
  );
  assert.notEqual(sha256(mutated), originalSha, "the mutation must actually change the bytes it is applied to");

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  const shadowRoot = mkdtempSync(join(repoRoot, "test", "mutants-"));
  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    const tracked = execFileSync("git", ["-C", repoRoot, "ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((rel) => rel.length > 0);
    for (const rel of tracked) {
      const dst = join(shadowRoot, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(repoRoot, rel), dst);
    }
    symlinkSync(join(repoRoot, "node_modules"), join(shadowRoot, "node_modules"), "dir");
    // The ONE file this check mutates -- written into the shadow copy, never the real checkout.
    writeFileSync(join(shadowRoot, "src", "run-task.ts"), mutated);

    // NODE_TEST_CONTEXT (set by node's OWN test runner on the process running THIS test) is
    // inherited by a plain spawnSync env by default, and node's test runner treats its presence
    // as "this is a recursive run() call" and skips every file — stripped so the child is a
    // genuinely independent `node --test` invocation (the W1-T951 lesson, applied here too).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: shadowRoot, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    rmSync(shadowRoot, { recursive: true, force: true });
  }

  // The real, checked-out source was never written at all -- the race W1-T963 diagnosed has no
  // window to occur in here, because there is nothing to restore.
  assert.equal(
    sha256(readFileSync(runTaskTsPath, "utf8")),
    originalSha,
    "run-task.ts must never be modified by this check",
  );

  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `removing the diagnostics call must fail the refusal test -- child exited ${childResult!.status}\n` +
      `stdout:\n${childResult!.stdout}\nstderr:\n${childResult!.stderr}`,
  );
});
