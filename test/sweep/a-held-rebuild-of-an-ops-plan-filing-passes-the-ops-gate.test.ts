import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { TaskFileInput } from "#src/lib/feedback-landing.js";
import { planRoundExhaustedRemedy, type ParkedPrHost } from "#src/lib/parked-pr-remedy.js";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T14454. OBSERVED 2026-11-23: the sweep closed the status reconciliation remudero-ops #427 when its plan-scoped
// round was spent and filed a held rebuild record (W1-T13047) through the task-files landing #429. ops-gate refused
// that landing: the record carried no verify, no risk, and a `manual-check:` proof for the plan files whose path names
// no task id. These tests judge the record the sweep emits by the gate's own shape rules.

/** Copied from remudero-ops scripts/ops-gate.rb (lines 44, 45, 46 and 54 on 2026-11-23), kept here as text, never read across repos. */
const OPS_GATE_LINES = {
  required: "  REQUIRED_KEYS = %w[id title repo type verify risk status attempts acceptance].freeze",
  nonEmpty: "  NON_EMPTY_KEYS = %w[title repo type verify status attempts].freeze",
  risks: "  RISKS = %w[low medium high].freeze",
  proofPrefixes: "  PROOF_PREFIXES = [\"unit test:\", \"grep:\"].freeze",
};

const words = (line: string): string[] => {
  const m = /%w\[([^\]]*)\]/.exec(line);
  assert.ok(m, `the copied ops-gate.rb line must still carry a %w[] list: ${line}`);
  return m[1]!.trim().split(/\s+/);
};
const REQUIRED_KEYS = words(OPS_GATE_LINES.required);
const NON_EMPTY_KEYS = words(OPS_GATE_LINES.nonEmpty);
const RISKS = words(OPS_GATE_LINES.risks);
const PROOF_PREFIXES = [...OPS_GATE_LINES.proofPrefixes.matchAll(/"([^"]+)"/g)].map(m => m[1]!);

const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** ops-gate.rb's rule_problems for one task, the shape rules a new record must pass, as text. */
function opsGateShapeProblems(task: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_KEYS.filter(k => k !== "id")) if (!(key in task)) problems.push(`is missing the required key '${key}'`);
  for (const key of NON_EMPTY_KEYS) if (key in task && blank(task[key])) problems.push(`'${key}' is empty`);
  if ("risk" in task && !RISKS.includes(task.risk as string)) problems.push("'risk' is not low, medium or high");
  const items = task.acceptance;
  if (!Array.isArray(items) || items.length === 0) return [...problems, "'acceptance' is not a non-empty list"];
  items.forEach((item: { claim?: unknown; proof?: unknown }, i) => {
    if (typeof item?.claim !== "string" || item.claim.trim() === "") problems.push(`acceptance item ${i + 1} has no 'claim'`);
    if (typeof item?.proof !== "string" || item.proof.trim() === "") problems.push(`acceptance item ${i + 1} has no 'proof'`);
    else if (!PROOF_PREFIXES.some(p => (item.proof as string).startsWith(p))) {
      problems.push(`acceptance item ${i + 1} has a 'proof' that does not start with 'unit test:' or 'grep:'`);
    }
  });
  return problems;
}

/** A `grep: <pattern> in <path>` proof, run the way the review executor runs it: `grep -arn -- <pattern> <path>`. */
function grepProofHolds(root: string, proof: string): boolean {
  const body = /^grep: (.+) in (\S+)$/.exec(proof.trim());
  assert.ok(body, `a dialect grep proof: ${proof}`);
  return spawnSync("grep", ["-arn", "--", body[1]!, body[2]!], { cwd: root, stdio: "ignore" }).status === 0;
}

const PR = 427;
const PR_URL = `https://github.com/o/remudero-ops/pull/${PR}`;
const HEAD = "4".repeat(40);
const NOW_ISO = "2026-11-23T11:35:00.000Z";
const REFUSAL = "scripts/lint-plan-precheck.mjs is absent from the tree";
const WITH_ID = "plan/tasks.d/W1-T13900-a-filed-task.yaml";
/** Both shapes of a plan file whose path names no task id: a lower-case record name and an index. */
const NO_ID = ["plan/tasks.d/w1-t13049-flake-incident.yaml", "plan/MASTER-INDEX.md"];
const PLAN_FILES = [WITH_ID, ...NO_ID];
const HELD_ID = "W1-T99427";

const scratch = (t: TestContext, name: string): string => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

/** The production sweep's parkedPr effect files the held rebuild; only its GitHub and git writes are spied. */
async function rebuild(t: TestContext): Promise<{ landed: TaskFileInput; held: Record<string, unknown> }> {
  const landed: TaskFileInput[][] = [];
  const rows: Record<string, unknown>[] = [];
  const root = scratch(t, "held-plan-rebuild-sweep");
  const effects = buildSweepEffects({ owner: "o", repo: "remudero-ops", repoRoot: root,
    config: { claudeBin: "claude", root } as never, ledgerPath: join(root, "ledger.ndjson"), runId: "w1-t14454",
    plan: { tasks: [], byId: new Map() } as never, log: () => {}, reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => assert.fail("no GitHub read") });
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  const host: ParkedPrHost = { ...effects.parkedPr,
    reserveTaskId: () => HELD_ID,
    landTaskFiles: async files => { landed.push([...files]); return { prUrl: "https://github.com/o/remudero-ops/pull/429" }; },
    closePr: async () => {},
    readPrFiles: async () => PLAN_FILES,
  };
  const out = await planRoundExhaustedRemedy({ prNumber: PR, prUrl: PR_URL, headSha: HEAD, isPlanFiling: true, unmetCriteria: [] },
    { redChecks: ["ops-gate"], violations: [], refusal: REFUSAL }, [], host,
    { runId: "w1-t14454", ledgerTaskId: `PR-${PR}`, nowIso: NOW_ISO, append: row => { rows.push(row); } });
  assert.equal(out.error, undefined, out.reason);
  assert.equal(landed.length, 1, "one landing files the held rebuild");
  assert.equal(landed[0]!.length, 1, "the landing carries the held rebuild record alone");
  const file = landed[0]![0]!;
  const seq = parse(file.content) as Record<string, unknown>[];
  assert.ok(Array.isArray(seq) && seq.length === 1, "the record file holds one task");
  return { landed: file, held: seq[0]! };
}

test("W1-T14454 criterion 1: the held plan rebuild carries verify: auto and a risk with a note, and passes the ops gate's required keys", async (t: TestContext) => {
  assert.deepEqual(REQUIRED_KEYS, ["id", "title", "repo", "type", "verify", "risk", "status", "attempts", "acceptance"]);
  const { landed, held } = await rebuild(t);
  assert.equal(held.verify, "auto", "verify: auto, as the public loader would default it");
  assert.equal(held.risk, "medium");
  assert.match(landed.content, /^ {2}risk: medium # .*W1-T13047.*$/m, "the risk carries an inline note naming W1-T13047");
  assert.deepEqual(opsGateShapeProblems(held), [], "ops-gate.rb's shape rules find nothing to refuse");
  assert.deepEqual(Object.keys(held), ["id", "title", "repo", "type", "verify", "risk", "files", "status", "attempts", "acceptance",
    "needs_input", "rationale"], "the two keys sit beside the other required keys, and nothing else is added");
  // verify: auto does not release it: plan.ts's needsInputRefusal holds any task whose needs_input question is unanswered.
  const asked = held.needs_input as { question?: unknown; source_pr?: unknown };
  assert.ok(typeof asked.question === "string" && asked.question.length > 0 && asked.source_pr === PR_URL,
    "the needs_input question that holds the rebuild for the operator is there");

  // The port is load-bearing: the record without the two keys is refused as origin/main's record was on #429.
  const { verify: _verify, risk: _risk, ...asOnMain } = held;
  assert.deepEqual(opsGateShapeProblems(asOnMain), ["is missing the required key 'verify'", "is missing the required key 'risk'"]);
});

test("W1-T14454 criterion 2: a plan file with no task id is proven by a grep: proof naming its path, and nothing emits manual-check", async (t: TestContext) => {
  assert.deepEqual(PROOF_PREFIXES, ["unit test:", "grep:"]);
  const { landed, held } = await rebuild(t);
  assert.doesNotMatch(landed.content, /manual-check/, "no proof of the record is a manual check");
  const proofs = (held.acceptance as { proof: string }[]).map(c => c.proof);
  assert.equal(proofs.length, PLAN_FILES.length, "one criterion per plan file");
  for (const proof of [...proofs, landed.proof]) {
    assert.ok(PROOF_PREFIXES.some(p => proof.startsWith(p)), `every proof starts with grep: or unit test: (${proof})`);
  }
  const root = scratch(t, "held-plan-rebuild-grep");
  for (const path of NO_ID) {
    const named = proofs.filter(p => /^grep: .+ in (\S+)$/.exec(p)?.[1] === path);
    assert.equal(named.length, 1, `exactly one grep: proof names ${path}`);
    // The proof runs the executor's grep: it fails while the plan file is absent and holds once the rebuild lands it.
    assert.equal(grepProofHolds(root, named[0]!), false, `${named[0]} does not hold while ${path} is absent`);
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), "- id: W1-T13049\n  title: the plan change of the pull request\n");
    assert.equal(grepProofHolds(root, named[0]!), true, `${named[0]} holds once ${path} carries the plan change`);
  }
  assert.ok(proofs.includes(`grep: id: W1-T13900 in ${WITH_ID}`), "a path with a task id keeps its id proof");
});

test("W1-T14454 criterion 3: invariant:a-rebuild-still-asks-the-operator, the question, source_pr, files and title are as on origin/main", async (t: TestContext) => {
  const { landed, held } = await rebuild(t);
  assert.equal(held.title, `Rebuild the plan filing of pull request ${PR} (held rebuild)`);
  assert.deepEqual(held.files, [...PLAN_FILES].sort());
  assert.deepEqual(held.needs_input, {
    question: `Pull request ${PR_URL} is a plan filing that cannot merge without your input: the plan-scoped round is exhausted, ` +
      "so the plan filing is closed and rebuilt as a held task. What it needs: the plan-scoped round on this plan filing is " +
      `exhausted. Red gates: ops-gate. Refusal: ${REFUSAL}`,
    source_pr: PR_URL, asked_at: NOW_ISO,
  });
  assert.deepEqual((held.acceptance as { claim: string }[]).map(c => c.claim),
    [...PLAN_FILES].sort().map(path => `${path} carries the plan change of ${PR_URL}, and the plan gates pass on it`));
  assert.deepEqual([held.id, held.repo, held.type, held.status, held.attempts], [HELD_ID, "remudero-ops", "implement", "queued", 0]);
  assert.equal(landed.relPath, `plan/tasks.d/${HELD_ID}-rebuild-the-plan-filing-of-pull-request-${PR}.yaml`);
  assert.equal(landed.proof, `grep: id: ${HELD_ID} in ${landed.relPath}`);
});
