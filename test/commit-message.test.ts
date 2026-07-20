import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CONVENTIONAL_LIMITS,
  normalizeSubjectCase,
  shapeCommitMessage,
  wrapBodyLines,
} from "../src/lib/commit-message.js";
import { outputContractLines } from "../src/lib/compaction.js";

// ── W1-T136/W1-T137 class: machine-built commit messages must pass the REAL gate ──
//
// Every assertion below that matters is proved against the actual `commitlint` CLI and
// the project's own config — the same subprocess shape test/commitlint-config.test.ts
// uses — so this suite cannot drift from the gate by reimplementing its rules. A bump to
// @commitlint/config-conventional that changes a limit fails HERE rather than silently on
// some future PR.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

test("shapeCommitMessage: the #405 header — 124 chars AND an upper-case subject — is REJECTED raw and PASSES once shaped", () => {
  // Verbatim from PR #405 (W1-T157), which redded `commitlint` with two problems:
  // header-max-length (124 > 100) and subject-case (`FIND layer …`).
  const raw =
    "feat(serve): FIND layer — fuzzy search, faceted filters, sortable columns, cmd+K palette, URL-persisted view state (W1-T157)\n";
  const rawResult = lint(raw);
  assert.notEqual(rawResult.status, 0, "the FALSIFIER: the real #405 header must be rejected by the real gate");
  assert.match(rawResult.stdout + rawResult.stderr, /header-max-length|subject-case/);

  const shaped = shapeCommitMessage(
    "feat(serve)",
    "FIND layer — fuzzy search, faceted filters, sortable columns, cmd+K palette, URL-persisted view state (W1-T157)",
  );
  assert.equal(lint(shaped.message).status, 0, `shaped message must pass commitlint:\n${shaped.message}`);
  assert.ok(shaped.header.length <= CONVENTIONAL_LIMITS.headerMaxLength);
});

test("shapeCommitMessage: header length is measured in CHARACTERS, not bytes (the em-dash trap)", () => {
  // An em-dash is 3 bytes and 1 character. commitlint counts characters. A byte-based cap
  // would trim a legal header, and a byte-based CHECK would pass an illegal one.
  const subject = "find layer " + "— ".repeat(60);
  const shaped = shapeCommitMessage("feat(serve)", subject);
  assert.ok(
    shaped.header.length <= CONVENTIONAL_LIMITS.headerMaxLength,
    `header must be <= ${CONVENTIONAL_LIMITS.headerMaxLength} CHARS, got ${shaped.header.length}`,
  );
  assert.ok(
    Buffer.byteLength(shaped.header) > shaped.header.length,
    "this fixture must actually contain multi-byte characters, else it proves nothing",
  );
  assert.equal(lint(shaped.message).status, 0);
});

test("shapeCommitMessage: trimmed subject overflow is PRESERVED in the body, never discarded", () => {
  const tail = "URL-persisted shareable view state across reloads";
  const shaped = shapeCommitMessage(
    "feat(serve)",
    `find layer with fuzzy search and faceted filters and sortable columns and a command palette and ${tail}`,
  );
  assert.equal(shaped.trimmed, true, "this fixture must actually overflow");
  assert.ok(shaped.message.includes("view state"), "overflow must survive into the body, not be dropped");
  assert.equal(lint(shaped.message).status, 0);
});

test("shapeCommitMessage: every body line respects body-max-line-length (the #399 footer failure)", () => {
  // PR #399 failed `footer-max-line-length` on a single long body line.
  const shaped = shapeCommitMessage(
    "chore(plan)",
    "file a task",
    "Fixture: 909M across 3 entries in ~/Remudero/worktrees/ measured post-restart, including a 453M orphan (dead pid 97514) that git no longer registers and that pruneStaleRuns therefore cannot see.",
  );
  for (const line of shaped.message.split("\n")) {
    assert.ok(
      line.length <= CONVENTIONAL_LIMITS.bodyMaxLineLength,
      `line exceeds ${CONVENTIONAL_LIMITS.bodyMaxLineLength}: ${JSON.stringify(line)}`,
    );
  }
  assert.equal(lint(shaped.message).status, 0);
});

test("normalizeSubjectCase: lower-cases a leading capital AND a leading acronym — the gate exempts neither", () => {
  assert.equal(normalizeSubjectCase("FIND layer — fuzzy search"), "find layer — fuzzy search");
  assert.equal(normalizeSubjectCase("Add a thing"), "add a thing");
  // An all-caps leading word is lower-cased WHOLE, so it reads as English rather than `sSE`.
  assert.equal(normalizeSubjectCase("SSE stream severed"), "sse stream severed");
  assert.equal(normalizeSubjectCase("URL round-trips"), "url round-trips");
});

test("the real gate rejects EVERY leading-capital form — the acronym exemption that seems reasonable is wrong", () => {
  // This test exists because an earlier draft exempted leading acronyms on the theory that
  // subject-case judges the subject's overall case. Measured against the real CLI, it does
  // not: all four of these FAIL, which is why normalizeSubjectCase exempts nothing.
  for (const bad of ["FIND layer — fuzzy search", "SSE stream severed", "URL round-trips", "Add a thing"]) {
    assert.notEqual(lint(`feat(serve): ${bad}\n`).status, 0, `expected the gate to REJECT: ${bad}`);
    assert.equal(
      lint(`feat(serve): ${normalizeSubjectCase(bad)}\n`).status,
      0,
      `expected the normalized form to PASS: ${normalizeSubjectCase(bad)}`,
    );
  }
});

test("shapeCommitMessage: a prefix with no room for a subject THROWS rather than emitting a message that fails later", () => {
  assert.throws(
    () => shapeCommitMessage(`chore(${"x".repeat(120)})`, "anything"),
    /header-max-length/,
    "a caller bug must surface here, not as a red required check on an open PR",
  );
});

test("wrapBodyLines: breaks on whitespace only and never emits an over-long line", () => {
  const lines = wrapBodyLines("alpha beta gamma delta epsilon zeta eta theta", 12);
  for (const l of lines) assert.ok(l.length <= 12, `over-long: ${JSON.stringify(l)}`);
  assert.equal(lines.join(" "), "alpha beta gamma delta epsilon zeta eta theta", "no word may be lost or split");
});

test("the worker OUTPUT CONTRACT states the Conventional Commits rule — a worker is TOLD, not left to guess", () => {
  // ROOT CAUSE of #405: no prompt anywhere in src/ mentioned Conventional Commits, a type
  // prefix, or any length limit. The contract said only "commit with a concise message",
  // and the convention lived solely in CONTRIBUTING.md, which a worker never reads (there
  // is no root CLAUDE.md). The worker was not disobeying a rule — it was never given one.
  const contract = outputContractLines("W1-T999").join("\n");
  assert.match(contract, /Conventional Commits|type\(scope\)/, "the contract must name the convention");
  assert.match(contract, /100/, "the contract must state the header limit the gate enforces");
  assert.match(contract, /lower-case|lowercase/i, "the contract must state the subject-case rule");
});

test("the contract's own example commit header passes the real gate", () => {
  // Whatever example the contract shows a worker must itself be legal — an illegal
  // example would teach the failure it is meant to prevent.
  const contract = outputContractLines("W1-T999").join("\n");
  // Anchored to the literal `Example:` label — an unanchored pattern matches the
  // `type(scope): subject` SCHEMA line earlier in the contract, whose `type` is not a real
  // commitlint type, and would fail for the wrong reason.
  const example = /Example:\s*`([^`]+)`/.exec(contract);
  assert.ok(example, "the contract must carry a concrete example header for the worker to copy");
  assert.equal(lint(`${example[1]}\n`).status, 0, `the contract's example must pass commitlint: ${example[1]}`);
});
