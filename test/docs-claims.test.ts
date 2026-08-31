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

/**
 * W1-T488: CLAUDE.md must state that a `unit test:` proof body is matched as a LITERAL
 * substring (after escaping) — the OPPOSITE of a `grep:` pattern, which is a BASIC REGEX.
 * Neither half in isolation proves the claim this task exists to fix: the asymmetry between
 * the two dialects is what silently misleads an author who reads both lines in sequence and
 * assumes they behave alike, so this requires "LITERAL substring" and "BASIC REGEX" to appear
 * close together (same bullet), not merely somewhere each in the whole file.
 */
export function checkUnitTestLiteralMatchClaim(claudeMdText: string): { ok: boolean; reason?: string } {
  if (!/unit test:/i.test(claudeMdText)) {
    return { ok: false, reason: "CLAUDE.md never mentions the `unit test:` dialect at all" };
  }
  if (!/LITERAL substring[\s\S]{0,400}BASIC REGEX|BASIC REGEX[\s\S]{0,400}LITERAL substring/.test(claudeMdText)) {
    return {
      ok: false,
      reason:
        "CLAUDE.md never states, in one place, that a `unit test:` proof body is matched as a LITERAL " +
        "substring while a `grep:` pattern is a BASIC REGEX — the asymmetry itself, not either half alone",
    };
  }
  return { ok: true };
}

/**
 * W1-T2334: derive, from the COMMANDS registry (never a hand-written list — the whole point,
 * mirroring `checkVerbCoverage` above), every verb whose OWN blurb claims read-only-ness
 * (`READ-ONLY`/`Read-only`, case-insensitive). This is the population `checkCliFreshness`
 * (src/lib/self-sync.ts) can silently fast-forward `main` in front of before the verb's first
 * line ever runs — see rationale (1)/(2) of the W1-T2334 task record. A verb added later that
 * also claims read-only-ness is picked up automatically; nothing here needs redoing.
 */
export function readOnlyClaimingVerbs(commands: readonly { name: string; detail: string }[]): string[] {
  return commands.filter((c) => /read-only/i.test(c.detail)).map((c) => c.name);
}

/**
 * The operator-facing guide must state, ONCE and prominently (design (ii) of the task record —
 * not pasted onto every read-only-claiming row), that the CLI ENTRY POINT — not the verb body —
 * can fast-forward this checkout's `main` (`git merge --ff-only origin/main`, checkCliFreshness)
 * before almost any verb dispatches, and must document `RMD_SELF_SYNC_DONE=1` as the idiom that
 * provably skips it. When the derived population is empty (no COMMANDS entry claims read-only-
 * ness at all) the check has nothing to guard and trivially holds — see the falsifier below for
 * proof this check DOES turn RED against the real defect wording.
 */
export function checkFastForwardEscapeHatchClaim(
  operatorGuideText: string,
  readOnlyVerbNames: readonly string[],
): { ok: boolean; reason?: string } {
  if (readOnlyVerbNames.length === 0) return { ok: true };
  if (!/RMD_SELF_SYNC_DONE/.test(operatorGuideText)) {
    return {
      ok: false,
      reason:
        "docs/operator-guide.md never documents RMD_SELF_SYNC_DONE=1 as the escape hatch that keeps " +
        `a verb claiming read-only-ness (${readOnlyVerbNames.join(", ")}) provably read-only, even ` +
        "though the CLI entry point (checkCliFreshness) can fast-forward main before it runs",
    };
  }
  if (!/ff-only|fast-forward/i.test(operatorGuideText)) {
    return {
      ok: false,
      reason:
        "docs/operator-guide.md documents RMD_SELF_SYNC_DONE but never states the entry-point " +
        "condition (git merge --ff-only origin/main) it is the escape hatch for",
    };
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

test("docs-claims: docs/operator-guide.md names the entry-point fast-forward and documents RMD_SELF_SYNC_DONE=1", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const verbs = readOnlyClaimingVerbs(COMMANDS);
  const result = checkFastForwardEscapeHatchClaim(guide, verbs);
  assert.ok(result.ok, result.reason);
});

test("docs-claims: the fast-forward-escape-hatch check derives its audited verbs from the COMMANDS registry", () => {
  const verbs = readOnlyClaimingVerbs(COMMANDS);
  assert.ok(verbs.length > 0, "expected at least one real COMMANDS entry to claim read-only-ness");
  // Both quoted verbatim in the task record's rationale (3) as the two operator-facing surfaces
  // that promised read-only-ness while the entry point could still fast-forward ahead of them.
  assert.ok(verbs.includes("emissions"), "emissions is the generated-surface example the task cites");
  assert.ok(verbs.includes("check-proof"), "check-proof is the hand-written-guide example the task cites");
});

test("docs-claims: docs/ci-gate.md is removed, not a one-line probe artifact", () => {
  const result = checkCiGateDocNotAProbe(existsSync(join(REPO_ROOT, "docs", "ci-gate.md")));
  assert.ok(result.ok, result.reason);
});

test("docs-claims: CLAUDE.md states a unit test: proof body is matched LITERALLY, against a grep: pattern's BASIC REGEX", async () => {
  const claudeMd = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const result = checkUnitTestLiteralMatchClaim(claudeMd);
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

test("docs-claims falsifier: readOnlyClaimingVerbs derives from detail text, never a hand-written list", () => {
  const commands = [
    { name: "a", detail: "READ-ONLY: does nothing" },
    { name: "b", detail: "writes a cache file" },
    { name: "c", detail: "Read-only: writes no ledger line" },
  ];
  assert.deepEqual(readOnlyClaimingVerbs(commands), ["a", "c"]);
});

test("docs-claims falsifier: the CURRENT unqualified wording (RECON R-2334, quoted verbatim at triage) turns the check RED", () => {
  // Verbatim at triage (rationale (3) of the task record), BEFORE this task's fix: the guide
  // claims check-proof is read-only about its own body and never mentions the entry-point
  // fast-forward or its escape hatch anywhere.
  const preFix =
    "| `rmd check-proof <proof>` | Run ONE acceptance proof ... Read-only: writes no cache, no " +
    "ledger line, no state file. |\n" +
    "Every item below is read-only or near enough, so the failure mode is not damage.\n";
  const result = checkFastForwardEscapeHatchClaim(preFix, ["check-proof"]);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /RMD_SELF_SYNC_DONE/);
});

test("docs-claims falsifier: RMD_SELF_SYNC_DONE named without the fast-forward condition still turns the check RED", () => {
  const partial = "Set RMD_SELF_SYNC_DONE=1 to skip the freshness check for some reason.\n";
  const result = checkFastForwardEscapeHatchClaim(partial, ["check-proof"]);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /ff-only|entry-point condition/);
});

test("docs-claims falsifier: a docs/ci-gate.md probe artifact reappearing turns the ci-gate-doc check RED", () => {
  assert.equal(checkCiGateDocNotAProbe(true).ok, false);
});

test("docs-claims falsifier: CLAUDE.md missing the unit-test/grep: dialect asymmetry turns the check RED", () => {
  const missingAsymmetry = "Write `unit test: <exact-title substring>`: the prefix is required.\n";
  assert.equal(checkUnitTestLiteralMatchClaim(missingAsymmetry).ok, false);
});

test("docs-claims falsifier: LITERAL substring and BASIC REGEX far apart (different bullets) turns the check RED", () => {
  const farApart =
    "A unit test: title is matched literally.\n" +
    "LITERAL substring semantics apply here.\n" +
    "x".repeat(500) +
    "\nElsewhere, a grep: pattern is a BASIC REGEX.\n";
  assert.equal(checkUnitTestLiteralMatchClaim(farApart).ok, false);
});
