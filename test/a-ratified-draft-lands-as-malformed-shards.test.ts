import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  fileRatificationDraft,
  filingBlockers,
  inboxDraftExampleFragmentYaml,
  knownPlanRepos,
  lintDraftedFragment,
  RatificationDraftRefusedError,
  ratificationPrBody,
} from "../src/lib/inbox.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { changedFilesBlockDrift, hasChangedFilesBlock } from "../src/lib/plan-pr-emitter.js";
import { lintTask } from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";
import { isolatedCheckout } from "./helpers/isolated-checkout.js";

// W1-T4700. PR #7608 (`rmd approve verify-human-automate:W1-T4471`) filed shards shaped like
// MALFORMED below: `repo: master-plan` (no such repository), `verify` an object rather than
// auto/human, and no acceptance. `lintDraftedFragment` and `lintTask` both read ZERO violations for
// it, and the approve path wrote every task in the fragment whatever its stamp named.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROPOSAL = "verify-human-automate:W1-T4471";
const KNOWN = new Set(["none", "remudero"]);

const malformed = (id: string, title: string): string =>
  [
    `- id: ${id}`,
    `  title: ${title}`,
    "  repo: master-plan",
    "  depends_on: []",
    "  type: implement",
    "  verify:",
    '    proof: "grep: MASTER-PLAN.md contains an open ratification candidate for §7/P25; skeleton task created"',
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  origin: plan/tasks.yaml",
    "  files:",
    "    - plan/tasks.yaml",
    "    - MASTER-PLAN.md",
  ].join("\n");

const MALFORMED = malformed("W1-T4695", "Instantiate ratification skeleton for MASTER-PLAN §7/P25 open plan");

const wellFormed = (id: string, n: number): string =>
  inboxDraftExampleFragmentYaml()
    .replace("- id: NEW-1", `- id: ${id}`)
    .replace("Tighten the empty-input guard in parseWidget", `Tighten guard number ${n} in parseWidget`)
    .replaceAll("parseWidget rejects an empty input", `parseWidget rejects empty input ${n}`);

const FIVE_IDS = ["W1-T4695", "W1-T4696", "W1-T4697", "W1-T4698", "W1-T4699"];
const TWO_ID_STAMP = `- ${PROPOSAL} (Ratification skeleton for MASTER-PLAN §7/P25 open plan) — RATIFIED 2026-09-28 -> W1-T4695/W1-T4696`;

function shapeMessages(violations: readonly { check: string; message: string }[]): string[] {
  return violations.filter((v) => v.check === "shard-shape").map((v) => v.message);
}

test("#7608's shard is refused by lintDraftedFragment, naming the verify object, the unknown repo and the missing acceptance", () => {
  // No fourth argument: the default names the repositories from the fleet registry itself.
  const violations = lintDraftedFragment(MALFORMED, PROPOSAL);
  const shape = violations.filter((v) => v.check === "shard-shape");
  assert.equal(shape.length, 3, `expected three shard-shape defects, got ${JSON.stringify(violations)}`);
  assert.ok(shape.every((v) => v.severity === "block"), "a drafted shard is new, so every defect must block");
  const text = shapeMessages(violations).join("\n");
  assert.match(text, /verify must be "auto" or "human", got \{"proof"/);
  assert.match(text, /repo "master-plan" is not a repository the plan knows/);
  assert.match(text, /implement task not at verify: human needs at least one acceptance criterion/);
});

test("the repositories the plan knows come from the fleet registry and the managed set, never from the plan's own repo values", () => {
  const known = knownPlanRepos(REPO_ROOT);
  assert.ok(known, "the checkout's .remudero/daemon-instances.yaml must be readable");
  assert.ok(known.has("remudero"), "the self repo is a registry instance");
  assert.ok(known.has("none"), "`none` is status.ts's no-repo sentinel");
  assert.equal(known.has("master-plan"), false);
  assert.equal(known.has("remudero/master-plan"), false);
  assert.equal(knownPlanRepos(mkdtempSync(join(tmpdir(), "rmd-no-registry-"))), undefined, "no registry names nothing, so the rule is silent");
  const malformedRoot = mkdtempSync(join(tmpdir(), "rmd-bad-registry-"));
  try {
    mkdirSync(join(malformedRoot, ".remudero"));
    writeFileSync(join(malformedRoot, ".remudero", "daemon-instances.yaml"), "not: a registry\n", "utf8");
    assert.equal(knownPlanRepos(malformedRoot), undefined, "a malformed registry names nothing either");
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }
});

test("the canonical draft example still lints clean, with and without a stamp naming its one id", () => {
  assert.deepEqual(lintDraftedFragment(inboxDraftExampleFragmentYaml(), "P1"), []);
  assert.deepEqual(lintDraftedFragment(inboxDraftExampleFragmentYaml(), "P1", "- P1 (widget guard) — RATIFIED 2026-09-28 -> NEW-1"), []);
});

test("a legacy shard already on main keeps its shape defects at WARN — only a new or newly-violating shard blocks", () => {
  const [task] = parseTasksFromYaml(MALFORMED, "legacy");
  const head = lintTask(task, { knownRepos: KNOWN });
  assert.equal(head.ok, true, "whole-plan lint must not fail a shard already on main");
  assert.equal(shapeMessages(head.violations).length, 3);
  // Unchanged against its base: inherited, not introduced.
  assert.deepEqual(shapeMessages(filingBlockers(head.violations, head.violations, false)), []);
  // Newly added: every defect blocks.
  assert.equal(shapeMessages(filingBlockers(head.violations, undefined, true)).length, 3);
  // A changed shard that INTRODUCES a defect blocks on that defect alone.
  const [base] = parseTasksFromYaml(MALFORMED.replace("repo: master-plan", "repo: remudero"), "legacy-base");
  const introduced = shapeMessages(filingBlockers(head.violations, lintTask(base, { knownRepos: KNOWN }).violations, false));
  assert.deepEqual(introduced.length, 1);
  assert.match(introduced[0], /repo "master-plan"/);
});

function recordingFs() {
  const writes: string[] = [];
  return {
    writes,
    fs: {
      mkdirSync: (dir: string) => void writes.push(`mkdir ${dir}`),
      writeFileSync: (path: string) => void writes.push(`write ${path}`),
      readFileSync: () => "- other (x) — open\n",
    },
  };
}

test("the approve path refuses a five-task fragment under a two-id stamp and writes nothing", () => {
  const fragment = FIVE_IDS.map((id, i) => wellFormed(id, i + 1)).join("\n");
  const { writes, fs } = recordingFs();
  assert.throws(
    () => fileRatificationDraft("/wt", { fragmentYaml: fragment, proposalId: PROPOSAL, stampLine: TWO_ID_STAMP }, fs, join, KNOWN),
    (e: unknown) => e instanceof RatificationDraftRefusedError && /"-> <ids>" list must name exactly/.test(e.message),
  );
  assert.deepEqual(writes, []);
});

test("the falsifier: #7608's own fragment — five malformed tasks under a two-id stamp — is refused on a real worktree, which is left untouched", () => {
  const wt = mkdtempSync(join(tmpdir(), "rmd-t4700-"));
  try {
    writeFileSync(join(wt, "MASTER-PLAN.md"), `- ${PROPOSAL} (open)\n`, "utf8");
    const fragment = FIVE_IDS.map((id, i) => malformed(id, `Placeholder task ${i + 1} for P25`)).join("\n");
    const deps = { mkdirSync, writeFileSync, readFileSync };
    assert.throws(
      () => fileRatificationDraft(wt, { fragmentYaml: fragment, proposalId: PROPOSAL, stampLine: TWO_ID_STAMP }, deps, join, KNOWN),
      (e: unknown) =>
        e instanceof RatificationDraftRefusedError &&
        /shard-shape/.test(e.message) &&
        /repo "master-plan"/.test(e.message),
    );
    assert.equal(existsSync(join(wt, "plan")), false, "no shard may be written");
    assert.equal(readFileSync(join(wt, "MASTER-PLAN.md"), "utf8"), `- ${PROPOSAL} (open)\n`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("the ratify PR body lists exactly the files the approve path wrote — MASTER-PLAN.md only when the stamp changed it", () => {
  const stamp = `- ${PROPOSAL} (widget guards) — RATIFIED 2026-09-28 -> W1-T4695/W1-T4696`;
  const fragment = [wellFormed("W1-T4695", 1), wellFormed("W1-T4696", 2)].join("\n");
  const deps = { mkdirSync, writeFileSync, readFileSync };
  const bodyOpts = { baseRef: "fixture-base", proofCheck: () => 0 };
  for (const withBullet of [false, true]) {
    const wt = mkdtempSync(join(tmpdir(), "rmd-t4700-body-"));
    try {
      const before = withBullet ? `# plan\n- ${PROPOSAL} (open)\n` : "# plan\n";
      writeFileSync(join(wt, "MASTER-PLAN.md"), before, "utf8");
      const written = fileRatificationDraft(wt, { fragmentYaml: fragment, proposalId: PROPOSAL, stampLine: stamp }, deps, join, KNOWN);
      assert.equal(written.filter((p) => p.startsWith("plan/tasks.d/")).length, 2);
      assert.equal(written.includes("MASTER-PLAN.md"), withBullet);
      assert.equal(readFileSync(join(wt, "MASTER-PLAN.md"), "utf8") !== before, withBullet);
      for (const p of written) assert.ok(existsSync(join(wt, p)), `${p} must exist on disk`);
      const body = ratificationPrBody(stamp, ["W1-T4695", "W1-T4696"], written, bodyOpts);
      assert.ok(hasChangedFilesBlock(body));
      assert.deepEqual(changedFilesBlockDrift(body, written), { missing: [], extra: [] });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }
});

async function lintBase(root: string, base: string): Promise<{ exitCode: number; output: string }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (message?: unknown) => void lines.push(String(message));
  try {
    const exitCode = await lintPlanCommand(["--plan", join(root, "plan", "tasks.yaml"), "--base", base], { repoRoot: root, offline: true });
    return { exitCode, output: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

test("the real lint-plan --base pass: editing a legacy-shaped shard on main stays green, filing a new one like it fails", async () => {
  const fixture = isolatedCheckout(REPO_ROOT);
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", fixture.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" }).trim();
    const shard = (id: string) => join(fixture.root, "plan", "tasks.d", `${id}-legacy-shape-fixture.yaml`);
    mkdirSync(join(fixture.root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(shard("W1-T4695"), `${malformed("W1-T4695", '"legacy shape fixture"')}\n`, "utf8");
    git("add", "plan/tasks.d");
    git("commit", "-q", "-m", "fixture(plan): a legacy-shaped shard already on main");
    const legacyBase = git("rev-parse", "HEAD");

    writeFileSync(shard("W1-T4695"), `${malformed("W1-T4695", '"legacy shape fixture, retitled"')}\n`, "utf8");
    git("commit", "-q", "-am", "fixture(plan): edit the legacy shard");
    const edited = await lintBase(fixture.root, legacyBase);
    assert.match(edited.output, /1 new\/changed vs/, "the changed shard was really linted");
    assert.match(edited.output, /⚠ W1-T4695: \[shard-shape\]/, "inherited defects stay visible as warnings");
    assert.doesNotMatch(edited.output, /✗ W1-T4695/, "and never block");
    assert.equal(edited.exitCode, 0, edited.output);

    const newBase = git("rev-parse", "HEAD");
    writeFileSync(shard("W1-T4696"), `${malformed("W1-T4696", '"a new shard in the same shape"')}\n`, "utf8");
    git("add", "plan/tasks.d");
    git("commit", "-q", "-m", "fixture(plan): file a new shard shaped like #7608");
    const filed = await lintBase(fixture.root, newBase);
    assert.equal(filed.exitCode, 1, filed.output);
    assert.match(filed.output, /W1-T4696[\s\S]*\[shard-shape\][^\n]*repo "master-plan"/);
  } finally {
    fixture.cleanup();
  }
});
