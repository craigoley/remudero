import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  checkCommitMessage,
  commitlintStep,
  CONVENTIONAL_LIMITS,
  CONVENTIONAL_RULE_COVERAGE,
  emitterChecksStep,
  normalizeSubjectCase,
  shapeCommitMessage,
  spawnFailureDetail,
  splitRangeCommitMessages,
  typecheckStep,
  wrapBodyLines,
} from "../src/lib/commit-message.js";
import { commitMessageContractLines, outputContractLines } from "../src/lib/compaction.js";
import { renderFixPrompt } from "../src/run-task.js";

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

test("the FIX-RUNG prompt carries the same commit contract as the implement prompt — fix workers were told nothing", () => {
  // ROOT CAUSE of #427/#428: renderFixPrompt had push guidance but NO commit-message
  // guidance, so a fix-rung worker authored a 111-char round-3 header and blocked the PR.
  // PR #407 shipped the rule to outputContractLines only. One shared literal now, so the
  // two prompts cannot drift again.
  const fix = renderFixPrompt({
    task: { id: "W1-T999", title: "a task" },
    round: 2,
    branch: "run-W1-T999-1",
    evidence: { review: { unmetCriteria: [], summary: "unmet" } },
  });
  for (const line of commitMessageContractLines()) {
    assert.ok(String(fix).includes(line), `fix prompt must carry: ${line}`);
  }
});

test("the contract states the NO-acronym-exemption rule the real gate enforces", () => {
  // The first version of this contract said a leading acronym "is fine". Measured against
  // the real CLI that is FALSE, and this suite already proves it — shipping guidance that
  // contradicts an adjacent passing test is how a worker gets told to do the wrong thing.
  const text = commitMessageContractLines().join("\n");
  assert.match(text, /NO acronym exemption/i);
  assert.doesNotMatch(text, /acronym[^.]*is fine/i);
  for (const bad of ["SSE stream severed", "URL round-trips"]) {
    assert.notEqual(lint(`feat(serve): ${bad}\n`).status, 0, `gate must reject: ${bad}`);
  }
});

// ── Redundant coverage for the spawn-failure contract (companion to
// test/preflight-spawn-failure.test.ts, which owns the full falsifier table). These three
// exist because CI's coverage job merged an lcov in which ONLY the spawn-failure lines read
// zero while this module's other lines were covered and every test passed — the documented
// zeroing class where a single file's coverage contribution can vanish nondeterministically
// under --experimental-test-coverage. Living in THIS suite, whose contribution demonstrably
// survives, they keep the contract's lines covered independently of that file's fate. ──

test("spawnFailureDetail speaks only on a null status, and names the runtime's reason", () => {
  assert.equal(spawnFailureDetail("commitlint", { status: 0 }), undefined);
  assert.equal(spawnFailureDetail("commitlint", { status: 1 }), undefined);
  const detail = spawnFailureDetail("commitlint", { status: null, error: "spawn ENOENT" });
  assert.match(detail ?? "", /SPAWN FAILURE/);
  assert.match(detail ?? "", /spawn ENOENT/);
  assert.match(
    spawnFailureDetail("typecheck", { status: null }) ?? "",
    /no exit status, no signal and no error message/,
    "a null status with no error message still speaks — and now reports that no signal was seen either",
  );
  // The state this residual was previously swallowing: a child KILLED by a signal reports a null
  // status with NO error, so before `signal` was propagated it rendered identically to the line
  // above. Duplicated into this suite for the same reason the block's header comment gives.
  assert.match(
    spawnFailureDetail("typecheck", { status: null, signal: "SIGKILL" }) ?? "",
    /KILLED by SIGKILL/,
    "a killed child names its signal rather than falling into the residual",
  );
});

test("commitlintStep routes a never-started child to SPAWN FAILURE, not a verdict about the commits", () => {
  const res = commitlintStep(REPO_ROOT, undefined, () => ({ status: null, stdout: "", stderr: "", error: "spawn ENOENT" }));
  assert.equal(res.ok, false);
  assert.match(res.detail, /SPAWN FAILURE/);
  assert.doesNotMatch(res.detail, /FAIL — /, "the bare range-FAIL shape is the misdiagnosis this contract removes");
});

test("typecheckStep routes a never-started child to SPAWN FAILURE, not a type verdict", () => {
  const res = typecheckStep(REPO_ROOT, () => ({ status: null, stdout: "", stderr: "", error: "EACCES" }));
  assert.equal(res.ok, false);
  assert.match(res.detail, /SPAWN FAILURE/);
  assert.match(res.detail, /EACCES/);
});

// ── W1-T416: emitter-checks certifies commit messages commitlint rejects ────────────
//
// `checkCommitMessage` used to implement THREE of `@commitlint/config-conventional`'s TEN
// error-level rules — header-max-length, subject-case, body-max-line-length — so
// `emitterChecksStep` could report PASS on a commit `commitlintStep` reported FAIL on, in
// the SAME `runPreflight` steps array, over the SAME range, in the same run. The durable
// fix is not a hand-added rule (which can drift again the moment config-conventional
// changes) but this corpus: every entry driven through BOTH the real CLI and
// `checkCommitMessage`, asserting they AGREE on pass/fail — a bump to config-conventional
// that changes a rule fails HERE rather than silently on some future commit.

/** One entry per `@commitlint/config-conventional` rule named in CONVENTIONAL_RULE_COVERAGE,
 *  plus one VALID control — required so agreement is not trivially satisfied by a checker
 *  that rejects everything. Each `rule` names the rule the message is chosen to exercise;
 *  `valid: true` marks the one control message that must PASS both sides. */
const EMITTER_COMMITLINT_PARITY: Array<{ rule: string; message: string; valid?: boolean }> = [
  { rule: "valid", message: "feat(serve): add fuzzy search to the board\n", valid: true },
  { rule: "header-max-length", message: `feat(serve): ${"x".repeat(100)}\n` },
  { rule: "header-trim", message: "fix(scope): do the thing \n" },
  { rule: "type-empty", message: "just fixing things\n" },
  { rule: "type-enum", message: "wip: tidy up\n" },
  { rule: "subject-empty", message: "fix(scope): \n" },
  { rule: "subject-case", message: "feat(serve): FIND layer\n" },
  { rule: "subject-full-stop", message: "fix(scope): do the thing.\n" },
  { rule: "body-max-line-length", message: `fix(scope): ok\n\n${"y".repeat(120)}\n` },
  // Incidental — NOT re-implemented, caught by a different check (CONVENTIONAL_RULE_COVERAGE).
  { rule: "type-case", message: "Feat(serve): do thing\n" },
  { rule: "footer-max-line-length", message: `chore(plan): file a task\n\nRefs: ${"x".repeat(110)}\n` },
];

test("EMITTER_COMMITLINT_PARITY: the corpus covers every rule CONVENTIONAL_RULE_COVERAGE names, plus a valid control", () => {
  const covered = new Set(EMITTER_COMMITLINT_PARITY.map((c) => c.rule));
  for (const entry of CONVENTIONAL_RULE_COVERAGE) {
    assert.ok(covered.has(entry.rule), `corpus is missing a case for ${entry.rule}`);
  }
  assert.ok(EMITTER_COMMITLINT_PARITY.some((c) => c.valid), "corpus must contain at least one VALID message");
});

test("EMITTER_COMMITLINT_PARITY: checkCommitMessage and the real commitlint CLI agree on every corpus entry", () => {
  for (const { rule, message, valid } of EMITTER_COMMITLINT_PARITY) {
    const cliOk = lint(message).status === 0;
    const emitterOk = checkCommitMessage(message).length === 0;
    if (valid) {
      assert.equal(cliOk, true, `control message for ${rule} must itself be valid per the real CLI`);
    }
    assert.equal(
      emitterOk,
      cliOk,
      `disagreement on ${JSON.stringify(rule)}: commitlint ${cliOk ? "PASS" : "FAIL"}, checkCommitMessage ${
        emitterOk ? "PASS" : "FAIL"
      } — ${JSON.stringify(message)}`,
    );
  }
});

// ── W1-T416: the range half — an empty-after-trim message must not vanish before either
// judgement is reached ──────────────────────────────────────────────────────────────

test("splitRangeCommitMessages: keeps a message that trims to empty rather than dropping it", () => {
  // `%x00%B` prefixes every commit's body with a NUL, so one commit whose body is nothing
  // but whitespace produces `\0   \n` — the leading NUL is the split artifact, `   \n` is
  // the (whitespace-only) message itself.
  assert.deepEqual(splitRangeCommitMessages("\0   \n"), [""]);
});

test("splitRangeCommitMessages: strips the leading split artifact, never reporting a phantom extra message", () => {
  assert.deepEqual(splitRangeCommitMessages("\0feat(x): one\n\0feat(x): two\n"), ["feat(x): one", "feat(x): two"]);
});

test("splitRangeCommitMessages: a blank line inside a body is never mistaken for a message boundary", () => {
  const [only] = splitRangeCommitMessages("\0feat(x): one\n\nsecond paragraph\n");
  assert.equal(only, "feat(x): one\n\nsecond paragraph");
});

test("splitRangeCommitMessages: a genuinely empty range (zero commits) returns zero messages, not one phantom empty message", () => {
  assert.deepEqual(splitRangeCommitMessages(""), []);
});

test("an empty commit message fails emitterChecksStep — neither half catches it alone", () => {
  // Reproduces the escape design (iii) argues cannot be split into two PRs: keeping the
  // filter (old readRangeCommitMessages) drops the message before any rule sees it; keeping
  // the filter removed but the OLD three-rule checkCommitMessage would let a zero-length
  // header pass header-max-length, treat the empty header as the subject, and skip
  // subject-case on the `subject !== ""` guard — zero violations either way. Both fixes
  // together are required, which is why this task is one PR.
  const spawn = ((file: string, args: string[]) => {
    if (args.some((a) => a === "log")) return { status: 0, stdout: "\0   \n", stderr: "" };
    throw new Error(`unexpected spawn: ${file} ${args.join(" ")}`);
  }) as Parameters<typeof emitterChecksStep>[2];
  const result = emitterChecksStep(REPO_ROOT, { from: "origin/main", to: "HEAD" }, spawn);
  assert.equal(result.ok, false, "an empty-after-trim commit message must FAIL emitter-checks, not vanish");
  assert.match(result.detail, /type-empty|subject-empty/);
});

test("CONVENTIONAL_RULE_COVERAGE: records TEN rules as data, matching @commitlint/config-conventional's error-level rule count", () => {
  assert.equal(CONVENTIONAL_RULE_COVERAGE.length, 10);
  const checked = CONVENTIONAL_RULE_COVERAGE.filter((r) => r.status === "checked").length;
  const incidental = CONVENTIONAL_RULE_COVERAGE.filter((r) => r.status === "incidental").length;
  assert.equal(checked, 8, "eight rules are checked directly by checkCommitMessage");
  assert.equal(incidental, 2, "two rules (type-case, footer-max-line-length) are caught incidentally, not re-implemented");
});
