import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  execWhitelistedProof,
  judgeReview,
  MODULE_LOAD_ERROR_RE,
  nameFilteredOutcome,
  parseWhitelistedProof,
  postReviewStatusGuarded,
  ProofCannotLoadError,
  refreshProofToolchain,
  registerReviewerCheckout,
  vitestNameFilteredOutcome,
} from "../src/lib/review.js";

const loadError = "Error: Cannot find package '@vercel/functions' imported from tests/unit/example.test.ts";
const vitestLoadFailure = `TAP version 13\n1..1\nnot ok 1 - tests/unit/example.test.ts # time=1ms {\n` +
  `    ${loadError}\n}\n`;
const nodeLoadFailure = `TAP version 13\nnot ok 1 - test/example.test.ts\n` +
  `  error: Cannot find module 'missing-dep'\n# tests 1\n# fail 1\n# duration_ms 12\n`;

test("a name-filtered run whose files all fail to load is cannot-load", () => {
  assert.equal(MODULE_LOAD_ERROR_RE.test(loadError), true);
  assert.equal(MODULE_LOAD_ERROR_RE.test("AssertionError: expected true"), false);
  assert.equal(vitestNameFilteredOutcome(vitestLoadFailure), "cannot-load");
  assert.equal(nameFilteredOutcome(nodeLoadFailure), "cannot-load");
  assert.equal(vitestNameFilteredOutcome("TAP version 13\n1..1\nok 1 - tests/unit/example.test.ts # time=1ms {\n}\n"), "no-match");
  assert.equal(nameFilteredOutcome("TAP version 13\nok 1 - test/example.test.ts\n# tests 1\n# duration_ms 12\n"), "no-match");
});

test("a proof that cannot load after a refresh is cannot-evaluate and never fails the review", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-load-"));
  try {
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "// fixture\n");
    writeFileSync(join(dir, "tests", "unit", "example.test.ts"), 'test("load proof", () => {})\n');
    const proof = parseWhitelistedProof("unit test: load proof", { owner: "craigoley", repo: "remudero-console" });
    assert.ok(proof);
    let runs = 0;
    let refreshes = 0;
    const spawn = () => {
      runs++;
      throw Object.assign(new Error(loadError), { status: 1, stdout: vitestLoadFailure, stderr: loadError });
    };
    assert.throws(() => execWhitelistedProof(proof, dir, 1000, spawn, {
      preflightBrowsers: () => {},
      refreshToolchain: () => { refreshes++; },
    }), ProofCannotLoadError);
    assert.equal(runs, 2);
    assert.equal(refreshes, 1);

    const verdict = judgeReview([{ claim: "load proof works", proof: "unit test: load proof" }], {
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n",
      report: "load proof works",
      headCheckoutDir: dir,
      target: { owner: "craigoley", repo: "remudero-console" },
      execProof: () => { throw new ProofCannotLoadError(loadError); },
    });
    assert.equal(verdict.criteria[0]?.proof_exec, "cannot_evaluate");
    assert.notEqual(verdict.state, "failure");
    assert.match(verdict.summary, /cannot-evaluate/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a name-filtered proof run is scoped to its own test file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-scope-"));
  try {
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    mkdirSync(join(dir, "tests", "e2e"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "// fixture\n");
    writeFileSync(join(dir, "tests", "unit", "example.test.ts"), 'test("scoped proof", () => {})\n');
    writeFileSync(join(dir, "tests", "e2e", "unrelated.test.ts"), 'test("other", () => {})\n');
    const proof = parseWhitelistedProof("unit test: scoped proof", { owner: "craigoley", repo: "remudero-console" });
    assert.ok(proof);
    const seen: string[][] = [];
    const result = execWhitelistedProof(proof, dir, 1000, (_command, args) => {
      seen.push([...args]);
      return "TAP version 13\n1..1\nok 1 - tests/unit/example.test.ts # time=1ms {\n    ok 1 - scoped proof # time=1ms\n}\n";
    }, { preflightBrowsers: () => {} });
    assert.equal(result, "pass");
    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.includes("tests/unit/example.test.ts"));
    assert.equal(seen[0]?.includes("tests/"), false);
    assert.equal(seen[0]?.some((a) => a.includes("e2e")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a diff-named Vitest file wins over other title hits and bare search excludes e2e", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-diff-scope-"));
  try {
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    mkdirSync(join(dir, "tests", "e2e"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "// fixture\n");
    writeFileSync(join(dir, "tests", "unit", "chosen.test.ts"), 'test("shared title", () => {})\n');
    writeFileSync(join(dir, "tests", "unit", "other.test.ts"), 'test("shared title", () => {})\n');
    writeFileSync(join(dir, "tests", "e2e", "browser.test.ts"), 'test("shared title", () => {})\n');
    const proof = parseWhitelistedProof("unit test: shared title", { owner: "craigoley", repo: "remudero-console" })!;
    proof.diffTestFiles = ["tests/unit/chosen.test.ts"];
    let selected: readonly string[] = [];
    const run = () => execWhitelistedProof(proof, dir, 1000, (_command, args) => {
      selected = args;
      return "TAP version 13\n1..1\nok 1 - tests/unit/chosen.test.ts # time=1ms {\n    ok 1 - shared title # time=1ms\n}\n";
    }, { preflightBrowsers: () => {} });
    assert.equal(run(), "pass");
    assert.deepEqual(selected.filter((arg) => arg.endsWith(".test.ts")), ["tests/unit/chosen.test.ts"]);
    proof.diffTestFiles = [];
    assert.equal(run(), "pass");
    assert.equal(selected.some((arg) => arg.includes("e2e")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a refresh uses the real canonical root behind a linked install", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-refresh-"));
  const linked = mkdtempSync(join(tmpdir(), "rmd-proof-linked-"));
  try {
    registerReviewerCheckout(dir);
    registerReviewerCheckout(linked);
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n');
    assert.equal(refreshProofToolchain(dir), true, "the default really runs the package manager in an isolated fixture");
    symlinkSync(join(dir, "node_modules"), join(linked, "node_modules"));
    writeFileSync(join(linked, "package-lock.json"), "{}\n");
    let attempts = 0;
    assert.equal(refreshProofToolchain(linked, (() => { attempts++; }) as never), false);
    assert.equal(attempts, 0);
    writeFileSync(join(dir, "package-lock.json"), '{"name":"fixture","version":"1.0.1","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.1"}}}\n');
    assert.equal(refreshProofToolchain(linked, ((_command: string, _args: string[], options: { cwd: string }) => {
      assert.equal(options.cwd, dir, "refresh the canonical checkout, never install through the symlink");
      attempts++;
    }) as never), true);
    assert.equal(attempts, 1);
    assert.equal(refreshProofToolchain(dir, (() => { throw new Error("install failed"); }) as never), false);
  } finally {
    rmSync(linked, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cannot-evaluate posts pending and escalates once for the same head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  try {
    const states: string[] = [];
    let issues = 0;
    const opts = {
      owner: "craigoley", repo: "remudero-console", sha: "a".repeat(40),
      state: "pending" as const,
      description: `remudero-review: cannot-evaluate — ${loadError}`,
      taskId: "CONSOLE-T1", prUrl: "https://github.com/craigoley/remudero-console/pull/1866",
      ledgerPath, runId: "run-load-proof", evidence: "no_evidence" as const,
      fetchLifecycle: () => ({ merged: false, closed: false }),
      post: (status: { state: string }) => { states.push(status.state); },
      issues: {
        listOpen: () => [],
        create: () => { issues++; return "https://github.com/craigoley/remudero-console/issues/1"; },
      },
    };
    assert.equal((await postReviewStatusGuarded(opts)).posted, true);
    assert.equal((await postReviewStatusGuarded(opts)).posted, true);
    assert.deepEqual(states, ["pending", "pending"]);
    assert.equal(issues, 1);
    const ledger = readFileSync(ledgerPath, "utf8");
    assert.equal(ledger.match(/"step":"review.cannot_evaluate_escalated"/g)?.length, 1);
    assert.match(ledger, /cannot-evaluate|cannot_evaluate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
