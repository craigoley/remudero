import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveDoctrineForReader } from "../src/lib/learnings.js";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCEPTANCE_HEADER_RE, ACCEPTANCE_BULLET_RE, PROOF_DIALECT, parseWhitelistedProof } from "../src/lib/review.js";

// ── W1-T2762: the docs/proof-dialect.md generator + drift gate ──────────────────────────────
//
// THE PROOF DIALECT IS TAUGHT THREE TIMES AND TESTED ONCE: `ACCEPTANCE_PROOF_GRAMMAR`
// (src/lib/proof-grammar.ts) is the one copy test/proof-grammar.test.ts already runs through the
// real parser. CLAUDE.md's "Writing proofs and acceptance criteria" section and `rmd check-proof`'s
// `detail` string are the other two, hand-written, and untested against the parser. This suite is
// the fix's other half of test/cli-reference.test.ts's discipline, applied to the new page:
//
//   (1) Every PASS/REFUSED example scripts/generate-proof-dialect.mjs renders on the page is run
//       through the REAL parser (`parseWhitelistedProof`) — a broken example is caught BY NAME.
//   (2) `--check` byte-compares the committed page against a fresh regeneration and, on a mismatch,
//       NAMES the drifted section (mirrors test/cli-reference.test.ts's `driftedCommandNames`).
//   (3) CLAUDE.md's proof section is checked, statement by statement, against the SAME live
//       constants the page renders from — so a prose claim that stops being true is caught here
//       instead of surviving silently until the next incident.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-proof-dialect.mjs");
// W1-T3323: CLAUDE.md is an INDEX and the rule bodies live in `doctrine/`, so a raw read of
// the file no longer contains the prose this pins. `resolveDoctrineForReader` follows every
// pointer and fails LOUD on one that dangles, which is exactly the discipline W1-T3322 named:
// a test asserting a doctrine fact must fail when it cannot read that fact, never pass because
// the fact moved.
const CLAUDE_MD = resolveDoctrineForReader(() => readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"));

function runCheck(out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--check", "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runGenerate(out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/** Every `- PASS \`<proof>\`` example line on a rendered page. */
function extractPassExamples(pageText: string): string[] {
  return [...pageText.matchAll(/^- PASS `([^`]+)`$/gm)].map((m) => m[1]);
}

/** Every `- REFUSED \`<proof>\` ...` example line on a rendered page — the trailing "(when) -- message"
 *  is deliberately NOT captured, so this extraction survives a prose reword of either. */
function extractRefusedExamples(pageText: string): string[] {
  return [...pageText.matchAll(/^- REFUSED `([^`]+)`/gm)].map((m) => m[1]);
}

// ── (1) every example on the page runs through the real parser ──────────────────────────────

test("generate-proof-dialect: every PASS example on the generated page parses under the real parseWhitelistedProof", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-pass-"));
  try {
    const out = join(dir, "proof-dialect.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const rendered = readFileSync(out, "utf8");
    const passExamples = extractPassExamples(rendered);
    // Guard against a vacuous pass: a reword that drops the "PASS `...`" lines entirely must fail
    // loudly rather than silently verify an empty list.
    assert.ok(passExamples.length >= 2, `expected at least 2 PASS examples on the page, found ${passExamples.length}`);
    for (const proof of passExamples) {
      assert.ok(parseWhitelistedProof(proof), `the page teaches a proof the real parser REFUSES: "${proof}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-proof-dialect: every REFUSED example on the generated page is genuinely refused by the real parser", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-refused-"));
  try {
    const out = join(dir, "proof-dialect.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const rendered = readFileSync(out, "utf8");
    const refusedExamples = extractRefusedExamples(rendered);
    assert.ok(
      refusedExamples.length >= PROOF_DIALECT.grep.refusals.length,
      `expected at least ${PROOF_DIALECT.grep.refusals.length} REFUSED examples on the page, found ${refusedExamples.length}`,
    );
    for (const proof of refusedExamples) {
      assert.equal(
        parseWhitelistedProof(proof),
        null,
        `the page claims "${proof}" is REFUSED, but the real parser ACCEPTS it`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-proof-dialect: a broken PASS example is caught BY NAME, not silently skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-broken-"));
  try {
    const out = join(dir, "proof-dialect.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const original = readFileSync(out, "utf8");
    // Strip the `in <path>` clause from the grep PASS example -- the one hazard the grammar itself
    // warns about (a `grep:` proof with no target is refused, W1-T219).
    const tampered = original.replace(
      "- PASS `grep: someSymbol( in src/lib/review.ts`",
      "- PASS `grep: someSymbol(`",
    );
    assert.notEqual(tampered, original, "fixture setup: the grep PASS example must actually exist to tamper");
    const broken = extractPassExamples(tampered).filter((proof) => !parseWhitelistedProof(proof));
    assert.deepEqual(
      broken,
      ["grep: someSymbol("],
      "a PASS example that stops parsing must be caught and NAMED, not silently dropped from the check",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (2) --check: byte-compare + named drift ──────────────────────────────────────────────────

test("generate-proof-dialect: two independent regenerations are byte-identical (content-only, no timestamp)", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-roundtrip-"));
  try {
    const outA = join(dir, "a.md");
    const outB = join(dir, "b.md");
    const genA = runGenerate(outA);
    const genB = runGenerate(outB);
    assert.equal(genA.status, 0, genA.stdout + genA.stderr);
    assert.equal(genB.status, 0, genB.stdout + genB.stderr);
    assert.equal(readFileSync(outA, "utf8"), readFileSync(outB, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-proof-dialect --check: the REAL committed docs/proof-dialect.md is NOT stale", () => {
  const result = runCheck(join(REPO_ROOT, "docs", "proof-dialect.md"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- .*proof-dialect\.md matches the live parser constants/);
});

test("generate-proof-dialect --check: a MISSING file -> non-zero exit, tells the operator how to generate it", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-missing-"));
  try {
    const result = runCheck(join(dir, "proof-dialect.md"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
    assert.match(output, /npm run proof-dialect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-proof-dialect --check: a hand-edited bullet regex -> non-zero exit, NAMES `ACCEPTANCE_BULLET_RE`'s section", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-drift-bullet-"));
  try {
    const out = join(dir, "proof-dialect.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const original = readFileSync(out, "utf8");
    const tampered = original.replace(String(ACCEPTANCE_BULLET_RE), "/hand-edited-drift/");
    assert.notEqual(tampered, original, "fixture setup: the bullet regex must actually appear to tamper");
    writeFileSync(out, tampered);
    const result = runCheck(out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /Drifted section\(s\): Acceptance bullet \(`ACCEPTANCE_BULLET_RE`\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-proof-dialect --check: a hand-edited header regex -> non-zero exit, NAMES `ACCEPTANCE_HEADER_RE`'s section", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-dialect-drift-header-"));
  try {
    const out = join(dir, "proof-dialect.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const original = readFileSync(out, "utf8");
    const tampered = original.replace(String(ACCEPTANCE_HEADER_RE), "/hand-edited-drift/");
    assert.notEqual(tampered, original, "fixture setup: the header regex must actually appear to tamper");
    writeFileSync(out, tampered);
    const result = runCheck(out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /Drifted section\(s\): Acceptance header \(`ACCEPTANCE_HEADER_RE`\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (3) CLAUDE.md's proof section, checked statement-by-statement against the live descriptor ──

test("CLAUDE.md's proof section: the bullet markers it quotes agree with the live ACCEPTANCE_BULLET_RE", () => {
  assert.ok(
    CLAUDE_MD.includes("`ACCEPTANCE_BULLET_RE` accepts `-`, `*`, `1.`/`1)`"),
    "CLAUDE.md no longer quotes ACCEPTANCE_BULLET_RE's accepted markers the way this test expects -- " +
      "reword this test to match the new prose, then re-check the reworded claim against the live regex",
  );
  for (const marker of ["-", "*", "1.", "1)"]) {
    assert.ok(
      ACCEPTANCE_BULLET_RE.test(`${marker} claim`),
      `CLAUDE.md claims ACCEPTANCE_BULLET_RE accepts "${marker}", but the live regex refuses it`,
    );
  }
  assert.ok(
    !ACCEPTANCE_BULLET_RE.test("+ claim"),
    "a marker CLAUDE.md does NOT list (`+`) is accepted by the live regex -- the quoted list undersells what parses",
  );
});

test("CLAUDE.md's proof section: the `## Validation` non-header example it quotes is really refused by ACCEPTANCE_HEADER_RE", () => {
  assert.ok(
    CLAUDE_MD.includes("`## Validation` is not one"),
    "CLAUDE.md no longer quotes `## Validation` as a non-example of ACCEPTANCE_HEADER_RE -- " +
      "reword this test to match the new prose, then re-check the reworded claim against the live regex",
  );
  assert.ok(
    !ACCEPTANCE_HEADER_RE.test("## Validation"),
    'CLAUDE.md claims "## Validation" is not a recognised Acceptance header, but the live regex accepts it',
  );
});

test("CLAUDE.md's proof section: the `grep -arn --` executor invocation it quotes matches the real parsed argv", () => {
  assert.ok(
    CLAUDE_MD.includes("`grep -arn -- '<pattern>' <path>`"),
    "CLAUDE.md no longer quotes the executor's real grep invocation the way this test expects -- " +
      "reword this test to match the new prose, then re-check the reworded claim against the live parser",
  );
  const parsed = parseWhitelistedProof("grep: TODO in src/lib/review.ts");
  assert.ok(parsed && parsed.kind === "grep", "the example dialect grep proof must parse");
  assert.equal(parsed!.command, "grep");
  assert.deepEqual(
    parsed!.args.slice(0, 2),
    ["-arn", "--"],
    "CLAUDE.md claims the executor runs `grep -arn --`, but the real parsed argv starts differently",
  );
});
