import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMANDS } from "../src/run-task.js";

// ── W1-T213: the docs-claims checks (MASTER-PLAN §12A, plan/claims.yaml) ────────────────────
//
// RECON R-30, VERIFIED at intake: hand-written docs contradicted the code on four counts —
// README.md claimed the repo "currently contains the WS-0 spike" (it is WS-1, complete, and
// `run-task.ts` is real, not a thing that "becomes" real); CONTRIBUTING.md named `ci` as a
// required status check (the required aggregator is `ci-gate`, per docs/review-gate.md and
// branch protection); the operator guide never mentioned `--repo`, a real parsed flag; and the
// operator guide documented far fewer verbs than the COMMANDS registry implements. None of this
// was caught by plan/claims.yaml, whose six seeded claims point at code/tests and, for prose,
// only at docs/review-gate.md — README.md, CONTRIBUTING.md and the operator guide were entirely
// unguarded.
//
// This suite is the fix: one exported pure check per contradiction (so a falsifier fixture can
// prove each one actually turns RED, the same discipline test/claims-check.test.ts holds
// scripts/claims-check.mjs to), each wired into plan/claims.yaml as its own claim so a doc that
// drifts back to the false wording fails CI by name instead of surviving in prose.
//
// The verb-coverage check DERIVES its obligation from the COMMANDS registry (src/run-task.ts,
// W1-T47) rather than enumerating verbs by hand, so a verb added later is caught automatically
// without this task needing to be redone.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** README.md must not claim the repo is still the WS-0 spike, or that run-task.ts "becomes" real. */
export function checkWsStageClaim(readmeText: string): { ok: boolean; reason?: string } {
  if (/currently contains the \*\*WS-0 spike\*\*/i.test(readmeText)) {
    return { ok: false, reason: 'README.md claims the repo "currently contains the WS-0 spike"' };
  }
  if (/run-task\.ts[^.]*\bbecomes?\b/i.test(readmeText)) {
    return { ok: false, reason: 'README.md claims run-task.ts "becomes" real rather than describing it as it is' };
  }
  return { ok: true };
}

/** CONTRIBUTING.md must name `ci-gate` (not standalone `ci`) as the required aggregator check. */
export function checkRequiredCheckClaim(contributingText: string): { ok: boolean; reason?: string } {
  if (/\*\*`ci`\*\*\s*[—-]\s*typecheck/.test(contributingText)) {
    return { ok: false, reason: "CONTRIBUTING.md lists bare `ci` as its own required status check" };
  }
  if (!/`ci-gate`/.test(contributingText)) {
    return { ok: false, reason: "CONTRIBUTING.md never names ci-gate as the required aggregator check" };
  }
  return { ok: true };
}

/** The operator guide must document the real, parsed `--repo` flag. */
export function checkRepoCoverage(operatorGuideText: string): { ok: boolean; reason?: string } {
  if (!/--repo\b/.test(operatorGuideText)) {
    return { ok: false, reason: "docs/operator-guide.md never mentions --repo, a real parsed flag (run-task.ts)" };
  }
  return { ok: true };
}

/** Every COMMANDS registry verb must be named (`rmd <verb>`) somewhere in the operator guide. */
export function checkVerbCoverage(
  operatorGuideText: string,
  commands: readonly { name: string }[],
): { ok: boolean; missing: string[] } {
  const missing = commands.filter((c) => !operatorGuideText.includes(`rmd ${c.name}`)).map((c) => c.name);
  return { ok: missing.length === 0, missing };
}

/** docs/ci-gate.md must not exist as a one-line probe artifact masquerading as documentation. */
export function checkCiGateDocNotAProbe(ciGateDocExists: boolean): { ok: boolean; reason?: string } {
  if (ciGateDocExists) {
    return { ok: false, reason: "docs/ci-gate.md exists — it must be removed or carry real content" };
  }
  return { ok: true };
}

// ── The real docs: each check currently holds ────────────────────────────────────────────────

test("docs-claims: README.md does not claim the repo currently contains the WS-0 spike", async () => {
  const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
  const result = checkWsStageClaim(readme);
  assert.ok(result.ok, result.reason);
});

test("docs-claims: CONTRIBUTING.md names ci-gate (not bare ci) as the required aggregator check", async () => {
  const contributing = await readFile(join(REPO_ROOT, "CONTRIBUTING.md"), "utf8");
  const result = checkRequiredCheckClaim(contributing);
  assert.ok(result.ok, result.reason);
});

test("docs-claims: docs/operator-guide.md documents the --repo flag", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkRepoCoverage(guide);
  assert.ok(result.ok, result.reason);
});

test("docs-claims: docs/operator-guide.md's command table covers every COMMANDS registry verb", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkVerbCoverage(guide, COMMANDS);
  assert.ok(result.ok, `operator-guide.md is missing verb(s): ${result.missing.join(", ")}`);
});

test("docs-claims: docs/ci-gate.md is removed, not a one-line probe artifact", () => {
  const result = checkCiGateDocNotAProbe(existsSync(join(REPO_ROOT, "docs", "ci-gate.md")));
  assert.ok(result.ok, result.reason);
});

// ── Falsifiers: each check must actually go RED, not just parse ─────────────────────────────

test("docs-claims falsifier: a reverted README.md (stale WS-0-only wording) turns the WS-stage check RED", () => {
  const stale =
    "This repo currently contains the **WS-0 spike**: a one-shot proof.\n" +
    "`src/lib/` are primitives that become `run-task.ts` in WS-1.\n";
  assert.equal(checkWsStageClaim(stale).ok, false);
});

test("docs-claims falsifier: a reverted CONTRIBUTING.md (bare `ci` required check) turns the required-check check RED", () => {
  const stale = "gated by two **required** status checks:\n\n- **`ci`** — typecheck + the full test suite.\n";
  assert.equal(checkRequiredCheckClaim(stale).ok, false);
});

test("docs-claims falsifier: an operator guide missing --repo turns the --repo-coverage check RED", () => {
  const stale = "| `rmd drain [--until <id>] [--max <n>] [--dry-run]` | ... |\n";
  assert.equal(checkRepoCoverage(stale).ok, false);
});

test("docs-claims falsifier: an operator guide missing a real COMMANDS verb turns verb coverage RED, naming it", () => {
  const guideMissingOne = "covers `rmd run-task` and `rmd drain` only";
  const commands = [{ name: "run-task" }, { name: "drain" }, { name: "sweep" }];
  const result = checkVerbCoverage(guideMissingOne, commands);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["sweep"]);
});

test("docs-claims falsifier: a docs/ci-gate.md probe artifact reappearing turns the ci-gate-doc check RED", () => {
  assert.equal(checkCiGateDocNotAProbe(true).ok, false);
});
