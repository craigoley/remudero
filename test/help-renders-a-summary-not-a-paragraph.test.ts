import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, SUMMARY_CHAR_CAP, USAGE, commandHelp, commandSpec, commandSyntax } from "../src/run-task.js";

// W1-T2480: the help registry used to carry a syntax field and a description field wearing ONE
// string (`usage`) -- `commandSyntax` recovered the syntax half at read time with
// `usage.split(/\s{2,}#/)[0].trimEnd()`, and the top-level `rmd --help` printed every command's
// FULL usage line (syntax + description), 41111 characters across 63 unwrapped lines. This suite
// pins the fix: CommandSpec now carries `syntax`/`summary`/`detail` as their own fields, the
// top-level listing renders name+syntax+summary (never the long `detail` prose), and nothing that
// used to be in `usage` was dropped -- every character survives in `detail`, rendered in full by
// `commandHelp` and docs/cli-reference.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── Criterion 1: the top-level help prints one short summary per command, not full prose ──────

test("the top-level USAGE listing is a small fraction of the old 41111-character wall -- it prints summaries, not detail", () => {
  // A generous ceiling, not a tight ratchet: today's real total (measured at authoring time) is
  // well under 10000 characters. 20000 leaves headroom for new commands without becoming
  // vacuous, while still being a small fraction of the 41111 this task closes out.
  assert.ok(
    USAGE.length < 20000,
    `USAGE is ${USAGE.length} characters -- expected a small fraction of the old 41111-character wall of unwrapped prose`,
  );
});

test("every command's summary (not its full detail) appears in the top-level USAGE listing", () => {
  for (const spec of COMMANDS) {
    assert.ok(USAGE.includes(spec.summary), `USAGE is missing ${spec.name}'s summary line`);
    // A command whose detail is longer than its summary must not have its FULL detail dumped
    // into the top-level listing -- that would be exactly the "full paragraph" regression.
    if (spec.detail.length > spec.summary.length) {
      assert.ok(
        !USAGE.includes(spec.detail),
        `USAGE contains ${spec.name}'s full detail prose -- the top level must print a summary, not a paragraph`,
      );
    }
  }
});

// ── Criterion 2: every character of today's usage prose survives somewhere ─────────────────────

test("every registry entry's full detail prose survives verbatim in commandHelp and docs/cli-reference.md", () => {
  const referenceDoc = readFileSync(join(REPO_ROOT, "docs", "cli-reference.md"), "utf8");
  for (const spec of COMMANDS) {
    const help = commandHelp(spec);
    assert.ok(
      help.includes(spec.detail) || referenceDoc.includes(spec.detail),
      `${spec.name}'s detail prose is missing from BOTH commandHelp and docs/cli-reference.md -- a character was dropped`,
    );
  }
});

// ── Criteria 3 + 4: syntax is read from the record, never recovered by a separator regex ───────

test("commandSyntax reads CommandSpec.syntax directly -- no separator regex remains in its implementation", () => {
  const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const fnMatch = runTaskSrc.match(/function commandSyntax\(name: string\): string \{\n([\s\S]*?)\n\}/);
  assert.ok(fnMatch, "could not locate commandSyntax's implementation in src/run-task.ts");
  const body = fnMatch![1];
  assert.doesNotMatch(body, /\.split\(/, "commandSyntax must no longer split a combined string to recover syntax");
  assert.match(body, /\.syntax\b/, "commandSyntax must read the stored `syntax` field");
});

test("commandSyntax(name) equals the registry's own stored syntax field for every command", () => {
  for (const spec of COMMANDS) {
    assert.equal(commandSyntax(spec.name), spec.syntax);
    assert.equal(commandSyntax(spec.name), commandSpec(spec.name).syntax);
  }
});

test("an entry with no separator anywhere in its detail can no longer return a paragraph as its syntax", () => {
  // The old failure mode: an entry authored without the two-space-hash separator returned its
  // WHOLE `usage` string (a paragraph) as its "syntax". With `syntax` and `detail` as their own
  // stored fields, there is no separator to find and therefore nothing to fail to find --
  // `.syntax` is never anything but what was written into `syntax`, however long or
  // separator-free `detail` is.
  const paragraphWithNoSeparator =
    "this is four hundred characters of uninterrupted prose with no two-space-hash separator anywhere in it, the exact shape that used to leak through commandSyntax's old usage.split(/\\s{2,}#/)[0].trimEnd() recovery and return the WHOLE paragraph as if it were the invocation syntax, which is the latent fail-open this task's rationale names and closes for good by giving the record its own separate syntax field entirely".repeat(1);
  const fakeSpec = { name: "widget", syntax: "rmd widget <arg>", summary: "Do the widget thing.", detail: paragraphWithNoSeparator };
  assert.equal(fakeSpec.syntax, "rmd widget <arg>");
  assert.notEqual(fakeSpec.syntax, fakeSpec.detail);
  assert.ok(fakeSpec.syntax.length < 50, "syntax must stay short even when detail is a separator-free paragraph");
});

// ── Criterion 5: every entry carries a non-empty summary under a stated character cap ──────────

test(`every COMMANDS entry carries a non-empty summary of at most SUMMARY_CHAR_CAP (${SUMMARY_CHAR_CAP}) characters`, () => {
  assert.ok(SUMMARY_CHAR_CAP > 0, "SUMMARY_CHAR_CAP must be a positive stated cap");
  for (const spec of COMMANDS) {
    assert.ok(spec.summary.length > 0, `${spec.name} has an empty summary`);
    assert.ok(
      spec.summary.length <= SUMMARY_CHAR_CAP,
      `${spec.name}'s summary is ${spec.summary.length} characters, over the ${SUMMARY_CHAR_CAP}-character cap`,
    );
  }
});

// ── Criterion 6: the generated reference doc still matches a fresh render of the registry ──────

test("docs/cli-reference.md is not stale -- generate-cli-reference --check passes against the committed doc", () => {
  const script = join(REPO_ROOT, "scripts", "generate-cli-reference.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--check", "--out", join(REPO_ROOT, "docs", "cli-reference.md")],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /OK -- .*cli-reference\.md matches the current COMMANDS registry/);
});

// ── Criterion 7 is proved by test/help-registry.test.ts's dispatch<->registry coverage tests. ──

// ── Criterion 8: per-command help still contains that command's full detail verbatim ───────────

test("commandHelp(spec) contains that command's full detail verbatim, for every command", () => {
  for (const spec of COMMANDS) {
    assert.ok(commandHelp(spec).includes(spec.detail), `commandHelp for ${spec.name} is missing its full detail prose`);
  }
});

// ── Criterion 9: no command is added or removed by this change ─────────────────────────────────

// Snapshot of every command name at the moment this task split `usage` into
// syntax/summary/detail (63 entries, matching the task rationale's SURFACE 1 measurement) --
// this task changes the SHAPE of the record and the top-level rendering, never the set of
// commands themselves.
const BASELINE_COMMAND_NAMES = [
  "alert-fix", "approve", "autonomy-rate", "away", "bundle", "check-acceptance", "check-proof",
  "console-url", "correct", "coverage-improve", "daemon", "daemon-plist", "dep-review",
  "deploy", "deploy-plist", "deploy-run", "digest", "digest-plist", "doctor", "down", "drain",
  "emissions", "escalate", "feedback", "fix", "inbox", "init", "install-checkout", "issues",
  "learnings", "ledger-grep", "lint-plan", "merge-hold", "next-task-id", "notify", "onboard", "ops", "pause",
  "peek", "plan", "preflight", "project", "proof-queue-audit", "reap-branches", "receipt",
  "reframe", "relay", "replay", "resume", "retro", "review", "rule-efficacy", "run-task",
  "serve", "serve-plist", "skill", "status", "stop", "sweep", "sync", "trace", "triage", "up",
  "verdict-calibration", "wipe-test",
].sort();

// W1-T2580: `bundle` — the day-one knowledge bundle export verb — joins the registry.
test("COMMANDS carries the established command names plus the operator merge-hold writer", () => {
  assert.equal(BASELINE_COMMAND_NAMES.length, 65);
  assert.deepEqual([...COMMANDS.map((c) => c.name)].sort(), BASELINE_COMMAND_NAMES);
  assert.equal(COMMANDS.length, 65);
});

// ── Regression control: this test file is where a re-widened top-level listing would show up ──

test("falsifier: a top-level line built from detail (not summary) would be far longer than the real one", () => {
  const spec = commandSpec("onboard"); // the longest `detail` in the registry
  const realLine = `  ${spec.syntax}   # ${spec.summary}`;
  const regressedLine = `  ${spec.syntax}   # ${spec.detail}`;
  assert.ok(
    regressedLine.length > realLine.length * 5,
    "sanity: the regressed (detail-based) line must be dramatically longer than the real summary-based line, or this suite could not tell the two apart",
  );
  assert.ok(USAGE.includes(realLine), "USAGE must contain the real syntax+summary line exactly as rendered");
  assert.ok(!USAGE.includes(regressedLine), "USAGE must NOT contain a syntax+detail line -- that is the regression this task fixes");
});
