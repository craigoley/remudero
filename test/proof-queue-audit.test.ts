/**
 * test/proof-queue-audit.test.ts — W1-T1053.
 *
 * NOTHING RESOLVED THE QUEUE'S PROOFS AGAINST THE FILESYSTEM: a queued task whose proof resolves
 * to ZERO tests read identical, to every existing instrument, to one that will pass at review
 * time (W1-T229, 13 days queued before a human caught it by hand). This proves the fix two ways:
 *
 *   (i)  PURE CLASSIFIER — {@link proofQueueAudit} (lib/proof-queue-audit.ts) over fixture tasks
 *        with injected `resolveNameFilteredCandidates`/`pathExists`, no I/O: every cause fires
 *        exactly on the shape it names, a forward-referencing whole-file path is NEVER reported,
 *        and an `unresolvable` resolver answer (ignorance, not evidence) is never read as an
 *        offense either.
 *   (ii) THE CALLER — `proofQueueAuditCommand` (src/run-task.ts), the whole-queue caller this
 *        check never had, over a small fixture plan + injected merge-evidence dump (no real git,
 *        no network): the open+unmerged population is correctly scoped (excludes blocked/merged/
 *        done AND anything the injected dump already credits), the printed report names every
 *        offender split by cause, and the command EXITS 0 regardless — a report, never a gate.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Task } from "../src/lib/plan.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import {
  proofQueueAudit,
  PROOF_QUEUE_AUDIT_CAUSES,
  type ProofQueueAuditOpts,
} from "../src/lib/proof-queue-audit.js";
import { proofQueueAuditCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── (i) pure classifier — fixture tasks, injected predicates, no I/O ────────────────────────

function fixtureTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: {},
    budget_usd: 10,
    risk: "low",
    origin: "architect",
    status: "queued",
    attempts: 0,
    ...overrides,
  } as Task;
}

/** Every candidate lookup answers "absent" (a readable, non-empty corpus was searched and found
 *  nothing) unless a raw name is listed in `resolved` — deterministic, no grep. */
function fakeResolver(resolved: Set<string> = new Set()): ProofQueueAuditOpts["resolveNameFilteredCandidates"] {
  return (rawName: string): NameFilterResolution =>
    resolved.has(rawName) ? { status: "resolved", files: ["test/x.test.ts"] } : { status: "absent" };
}

test("proofQueueAudit: refused-parse fires on a grep: proof with no `in <path>` clause, never on free prose", () => {
  const noClause = fixtureTask({
    id: "W9-A1",
    acceptance: [{ claim: "x", proof: "grep: no in-path clause here" }],
  });
  const prose = fixtureTask({
    id: "W9-A2",
    acceptance: [{ claim: "x", proof: "trust me, it works" }],
  });
  const report = proofQueueAudit([noClause, prose]);
  assert.deepEqual(report.byCause["refused-parse"], ["W9-A1"], "only the dialect-prefixed refusal is reported");
  assert.equal(report.offenders.length, 1);
  assert.equal(report.offenders[0].taskId, "W9-A1");
});

test("proofQueueAudit: `demonstration:` is a legitimate non-execution, never refused-parse (W1-T277)", () => {
  const demo = fixtureTask({
    id: "W9-A3",
    verify: "human",
    acceptance: [{ claim: "an operator watches a live demo", proof: "demonstration: kill -9 the live daemon" }],
  });
  const report = proofQueueAudit([demo]);
  assert.deepEqual(report.offenders, []);
});

test("proofQueueAudit: a whole-file test-path proof naming a file that does not exist yet is NEVER reported (forward reference, CLAUDE.md)", () => {
  const forwardRef = fixtureTask({
    id: "W9-B1",
    acceptance: [{ claim: "x", proof: "unit test: test/does-not-exist-w1-t1053-fixture.test.ts" }],
  });
  // Even with predicates configured to answer as hostile as possible (everything absent), the
  // path-form proof must never reach either predicate — nameFiltered is unset for this shape.
  const report = proofQueueAudit([forwardRef], {
    resolveNameFilteredCandidates: fakeResolver(),
    pathExists: () => false,
  });
  assert.deepEqual(report.offenders, [], "a forward-referencing whole-file path proof must stay legitimate");
  assert.equal(report.criterionCount, 1, "the criterion is still counted as examined");
});

test("proofQueueAudit: a name-filtered proof matching zero tests IS reported, in the W1-T229 shape", () => {
  const zeroMatch = fixtureTask({
    id: "W1-T229-shape",
    acceptance: [{ claim: "x", proof: "unit test: case added to test/review.test.ts" }],
  });
  const report = proofQueueAudit([zeroMatch], { resolveNameFilteredCandidates: fakeResolver() });
  assert.deepEqual(report.byCause["name-filtered-zero-match"], ["W1-T229-shape"]);
  assert.equal(report.offenders[0].cause, "name-filtered-zero-match");
});

test("proofQueueAudit: a name-filtered proof resolving to >=1 real candidate is NOT reported", () => {
  const resolves = fixtureTask({
    id: "W9-B2",
    acceptance: [{ claim: "x", proof: "unit test: a title that really exists" }],
  });
  const report = proofQueueAudit([resolves], {
    resolveNameFilteredCandidates: fakeResolver(new Set(["a title that really exists"])),
  });
  assert.deepEqual(report.offenders, []);
});

test("proofQueueAudit: an `unresolvable` resolver answer is IGNORANCE, never reported as an offense", () => {
  const cannotLook = fixtureTask({
    id: "W9-B3",
    acceptance: [{ claim: "x", proof: "unit test: some title" }],
  });
  const report = proofQueueAudit([cannotLook], {
    resolveNameFilteredCandidates: () => ({ status: "unresolvable", reason: "no readable test corpus" }),
  });
  assert.deepEqual(report.offenders, [], "unresolvable must never be read as positive evidence of absence");
});

test("proofQueueAudit: a grep: proof whose `in <path>` names an absent path IS reported", () => {
  const absentPath = fixtureTask({
    id: "W9-C1",
    acceptance: [{ claim: "x", proof: "grep: TODO in src/lib/this-file-does-not-exist-w1-t1053.ts" }],
  });
  const report = proofQueueAudit([absentPath], { pathExists: () => false });
  assert.deepEqual(report.byCause["grep-path-absent"], ["W9-C1"]);
});

test("proofQueueAudit: a grep: proof whose path exists is NOT reported", () => {
  const realPath = fixtureTask({
    id: "W9-C2",
    acceptance: [{ claim: "x", proof: "grep: proofQueueAudit in src/lib/proof-queue-audit.ts" }],
  });
  const report = proofQueueAudit([realPath], { pathExists: () => true });
  assert.deepEqual(report.offenders, []);
});

test("proofQueueAudit: absent predicates mean 'no opinion' — nothing is reported for the cause they would have answered", () => {
  const zeroMatch = fixtureTask({ id: "W9-D1", acceptance: [{ claim: "x", proof: "unit test: some other title" }] });
  const absentPath = fixtureTask({ id: "W9-D2", acceptance: [{ claim: "x", proof: "grep: X in no/such/path.ts" }] });
  const report = proofQueueAudit([zeroMatch, absentPath], {}); // no predicates at all
  assert.deepEqual(report.offenders, []);
});

test("proofQueueAudit: `satisfied_by` criteria carry no proof text to resolve and are skipped", () => {
  const architectOnly = fixtureTask({
    id: "W9-E1",
    acceptance: [{ claim: "x", proof: "grep: no in-path clause", satisfied_by: "#1234" }],
  });
  const report = proofQueueAudit([architectOnly], { pathExists: () => false });
  assert.deepEqual(report.offenders, []);
  assert.equal(report.criterionCount, 0);
});

test("proofQueueAudit: byCause dedupes a task with two offending criteria of the same cause to one id", () => {
  const twice = fixtureTask({
    id: "W9-F1",
    acceptance: [
      { claim: "a", proof: "grep: A in no/such/a.ts" },
      { claim: "b", proof: "grep: B in no/such/b.ts" },
    ],
  });
  const report = proofQueueAudit([twice], { pathExists: () => false });
  assert.equal(report.offenders.length, 2, "both criteria are individually recorded");
  assert.deepEqual(report.byCause["grep-path-absent"], ["W9-F1"], "but the task id appears once in the split");
});

test("proofQueueAudit: reports a count plus offending ids split by all three causes at once", () => {
  const refused = fixtureTask({ id: "W9-G1", acceptance: [{ claim: "a", proof: "grep: no in-path clause" }] });
  const zeroMatch = fixtureTask({ id: "W9-G2", acceptance: [{ claim: "b", proof: "unit test: nope not this one" }] });
  const pathGone = fixtureTask({ id: "W9-G3", acceptance: [{ claim: "c", proof: "grep: X in no/such/path.ts" }] });
  const clean = fixtureTask({ id: "W9-G4", acceptance: [{ claim: "d", proof: "unit test: test/proof-queue-audit.test.ts" }] });
  const report = proofQueueAudit([refused, zeroMatch, pathGone, clean], {
    resolveNameFilteredCandidates: fakeResolver(),
    pathExists: () => false,
  });
  assert.equal(report.taskCount, 4);
  assert.equal(report.criterionCount, 4);
  assert.equal(report.offenders.length, 3);
  for (const cause of PROOF_QUEUE_AUDIT_CAUSES) assert.equal(report.byCause[cause].length, 1, `expected exactly one ${cause}`);
  assert.deepEqual(report.byCause["refused-parse"], ["W9-G1"]);
  assert.deepEqual(report.byCause["name-filtered-zero-match"], ["W9-G2"]);
  assert.deepEqual(report.byCause["grep-path-absent"], ["W9-G3"]);
});

// ── (ii) the caller — proofQueueAuditCommand over a fixture plan, no real git/network ──────────

function fixtureTaskYaml(id: string, status: string, proof: string): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  acceptance:",
    '    - claim: "the thing holds"',
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

/** `%s%x00%b%x01` — the exact wire shape `defaultMergeEvidenceLog` (src/run-task.ts) produces,
 *  mirrored from test/plan-proof-debt.test.ts's own `dumpOf` and test/lint-plan-merge-evidence
 *  test's identical helper, so the injected dep is byte-shaped like the real reader. */
function dumpOf(...entries: Array<[subject: string, body?: string]>): string {
  return entries.map(([s, b]) => `${s}\x00${b ?? ""}`).join("\x01") + "\x01";
}

// Built by concatenation, deliberately, so the CONTIGUOUS string never appears verbatim in this
// file's own source — a real, in-repo `grep -F` (the resolver under test) would otherwise find
// its own proof text sitting in test/proof-queue-audit.test.ts and "resolve" it right back,
// exactly the false-negative this fixture exists to rule out.
const ZERO_MATCH_TITLE = ["a fixture title that will", "never match any real test", "kx4471q"].join(" ");

function buildFixturePlan(): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t1053-audit-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  const body =
    fixtureTaskYaml("W9-OPEN-BAD-GREP", "queued", "grep: TODO in test/does-not-exist-w1-t1053.ts") +
    fixtureTaskYaml(
      "W9-OPEN-FORWARD-REF",
      "queued",
      "unit test: test/does-not-exist-w1-t1053-fixture.test.ts",
    ) +
    fixtureTaskYaml("W9-OPEN-ZERO-MATCH", "queued", `unit test: ${ZERO_MATCH_TITLE}`) +
    fixtureTaskYaml("W9-BLOCKED-BAD-GREP", "blocked", "grep: TODO in test/does-not-exist-w1-t1053.ts") +
    fixtureTaskYaml("W9-MERGED-ELSEWHERE-BAD-GREP", "queued", "grep: TODO in test/does-not-exist-w1-t1053.ts");
  writeFileSync(tasksPath, body, "utf8");
  return { tasksPath, dir };
}

async function runAuditCapturing(
  args: string[],
  deps: Parameters<typeof proofQueueAuditCommand>[1] = {},
): Promise<{ exitCode: number; stdout: string }> {
  const origLog = console.log;
  const origError = console.error;
  const lines: string[] = [];
  console.log = (m: string) => lines.push(m);
  console.error = (m: string) => lines.push(m);
  try {
    const exitCode = await proofQueueAuditCommand(args, deps);
    return { exitCode, stdout: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test("proofQueueAuditCommand: an unknown flag is refused, exit 2, nothing audited", async () => {
  const { exitCode } = await runAuditCapturing(["--bogus"]);
  assert.equal(exitCode, 2);
});

test("proofQueueAuditCommand: an unreadable --plan is refused, exit 2", async () => {
  const { exitCode } = await runAuditCapturing(["--plan", join(REPO_ROOT, "test", "no-such-w1-t1053-plan.yaml")]);
  assert.equal(exitCode, 2);
});

test("proofQueueAuditCommand: scopes to open+unmerged, names every offender split by cause, exits 0 over a plan full of offenders", async () => {
  const { tasksPath, dir } = buildFixturePlan();
  try {
    const dump = dumpOf(["feat(x): ship it (#1)", "body\n\nRemudero-Task: W9-MERGED-ELSEWHERE-BAD-GREP"]);
    const { exitCode, stdout } = await runAuditCapturing(["--plan", tasksPath], {
      readMergeEvidenceLog: () => ({ dump, ref: "fixture-ref" }),
    });
    // A REPORT, NOT A GATE: this fixture is deliberately full of offenders, and the command must
    // still exit 0 — the load-bearing claim of the whole task.
    assert.equal(exitCode, 0, "the audit must exit 0 regardless of how many offenders it names");

    // Scope: blocked and merged-elsewhere tasks are excluded from the population entirely.
    assert.doesNotMatch(stdout, /W9-BLOCKED-BAD-GREP/, "a blocked task must never enter the population");
    assert.doesNotMatch(
      stdout,
      /W9-MERGED-ELSEWHERE-BAD-GREP/,
      "a task with merge evidence on the injected dump must never enter the population",
    );
    assert.match(stdout, /3 open\+unmerged task\(s\)/, "exactly the 3 remaining fixture tasks form the population");

    // Forward reference stays legitimate — never named as an offender anywhere in the report.
    assert.doesNotMatch(stdout, /W9-OPEN-FORWARD-REF/, "a forward-referencing whole-file proof must never be reported");

    // The two real offenders are named, under the causes their proofs actually carry.
    assert.match(stdout, /grep-path-absent\s+1 task\(s\): W9-OPEN-BAD-GREP/);
    assert.match(stdout, /name-filtered-zero-match\s+1 task\(s\): W9-OPEN-ZERO-MATCH/);
    assert.match(stdout, /refused-parse\s+0 task\(s\): \(none\)/);
    assert.match(stdout, /2 unresolvable proof\(s\) across 2 task\(s\)/);

    // The report says, in its own words, that it is not a gate.
    assert.match(stdout, /REPORT, not a gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proofQueueAuditCommand: fails open on unresolvable merge evidence (shallow checkout) — still exits 0, audits nothing", async () => {
  const { tasksPath, dir } = buildFixturePlan();
  try {
    const { exitCode, stdout } = await runAuditCapturing(["--plan", tasksPath], {
      readMergeEvidenceLog: () => {
        throw new Error("shallow clone — truncated history would misread absent commits as absent evidence");
      },
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /merge evidence unavailable/);
    assert.doesNotMatch(stdout, /W9-OPEN-BAD-GREP/, "nothing is audited when the population cannot be scoped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── grep-provable wiring (the task's own acceptance criterion 5) ───────────────────────────────

test("proofQueueAuditCommand is registered as `rmd proof-queue-audit` in the COMMANDS registry", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(source, /name:\s*"proof-queue-audit"/, "the verb must be a real, listed rmd command, not dormant code");
  assert.match(source, /proofQueueAudit\(/, "the caller must invoke the classifier directly");
});
