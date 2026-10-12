import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint, approveProposal, classifyProposal, deriveTaskReferent,
  type DraftedCandidate, type Proposal, type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, RETIREMENT_REASONS } from "../src/lib/plan.js";
import { approveCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const proof = "test/a-retired-tasks-proposal-cannot-be-ratified.test.ts";
const subject = "W1-T900001";
const ids = [`verify-human-automate:${subject}`, `proof-debt:${subject}`, `proof-debt:${subject}:0`];
const fragmentYaml = `- id: NEW-1
  title: "repair the discarded zygomatic aperture observation"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: high
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/inbox.ts, test/a-retired-tasks-proposal-cannot-be-ratified.test.ts]
  acceptance:
    - claim: "explicit retirement prevents ratification"
      proof: "unit test: ${proof}"
`;

function taskYaml(fields: string): string {
  return `- id: ${subject}
  title: "the subject of a stale proposal"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  attempts: 0
  ${fields}
`;
}

function fixture(id: string, fields: string) {
  const proposal: Proposal = { id, summary: "repair the discarded observation", evidenceAnchors: [] };
  const draft: DraftedCandidate = {
    proposalId: id, fragmentYaml,
    stampLine: `- ${id} (repair discarded observation) — RATIFIED 2026-10-06 -> NEW-1.`,
    anchorFingerprint: anchorFingerprint([]),
  };
  const ctx: ReadinessContext = {
    plan: loadPlanFromYaml(taskYaml(fields), "retirement-fixture"),
    isMerged: () => false, isRatified: () => false,
    grepAnchorTrue: () => true, openProposalIds: new Set(),
  };
  return { proposal, draft, ctx };
}

for (const id of ids) test(`${proof}: ${id} retires and approve invokes no writer`, () => {
  const root = gitRepo();
  try {
    for (const retirement of RETIREMENT_REASONS) {
      const { proposal, draft, ctx } = fixture(id, `status: blocked\n  retirement: ${retirement}`);
      const before = JSON.stringify(proposal);
      const classification = classifyProposal(proposal, draft, ctx);
      assert.equal(classification.state, "retired", `${id}: ${retirement}`);
      assert.equal(deriveTaskReferent(id), subject);
      assert.match(classification.retiredReason!, new RegExp(`${subject} was explicitly ${retirement}`));
      let writes = 0;
      const result = approveProposal(classification, {
        createRatificationBranch() { writes++; throw new Error("retired proposal reached the writer"); },
        openPlanPr() { writes++; throw new Error("retired proposal reached PR creation"); },
      }, { ledgerPath: join(root.dir, "ledger.ndjson"), runId: `retired-${id}-${retirement}` });
      assert.equal(result.ok, false);
      assert.equal(writes, 0);
      assert.equal(JSON.stringify(proposal), before);
    }
  } finally { root.cleanup(); }
});

test(`${proof}: retirement requires a present blocked task with an explicit retirement`, () => {
  for (const id of ids) {
    for (const fields of ["status: queued", "status: blocked", "status: queued\n  retirement: closed"]) {
      const { proposal, draft, ctx } = fixture(id, fields);
      assert.equal(classifyProposal(proposal, draft, ctx).state, "ready", `${id}: ${fields}`);
      ctx.plan = loadPlanFromYaml("[]", "missing-subject");
      assert.equal(classifyProposal(proposal, draft, ctx).state, "ready");
    }
    const { proposal, draft, ctx } = fixture(id, "status: blocked\n  retirement: closed");
    ctx.isRatified = () => true;
    assert.equal(classifyProposal(proposal, draft, ctx).state, "ratified");
    ctx.isRatified = () => false;
    ctx.isDeclined = () => "operator declined";
    assert.equal(classifyProposal(proposal, draft, ctx).state, "declined");
  }
  for (const id of [`verify-human-automate:${subject}:0`, `unknown:${subject}`]) {
    const { proposal, draft, ctx } = fixture(id, "status: blocked\n  retirement: closed");
    assert.equal(deriveTaskReferent(id), undefined);
    assert.equal(classifyProposal(proposal, draft, ctx).state, "ready");
  }
});

test(`${proof}: approve reads retirement from the origin/main worktree before minting or writing`, async () => {
  const root = gitRepo();
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  const shim = ghShim([{ when: "api", stdout: "[]" }]);
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(seed.dir, "plan", "tasks.d", "retired.yaml"), taskYaml("status: blocked\n  retirement: withdrawn"));
    writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# master plan\n");
    seed.git("add", ".");
    seed.git("commit", "--quiet", "-m", "chore: seed retired subject");
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    const clone = gitRepo({ cloneFrom: origin.dir });
    mkdirSync(join(root.dir, "repos"), { recursive: true });
    const repoDir = join(root.dir, "repos", "remudero");
    renameSync(clone.dir, repoDir);
    mkdirSync(join(root.dir, "state"), { recursive: true });
    process.env.PATH = `${shim.dir}:${savedPath}`;
    for (const id of ids.slice(0, 2)) {
      const { proposal, draft, ctx } = fixture(id, "status: queued");
      assert.equal(classifyProposal(proposal, draft, ctx).state, "ready", "stale plan permits the draft");
      const registry = JSON.stringify({ proposals: [proposal] });
      writeFileSync(join(root.dir, "state", "inbox-proposals.json"), registry);
      writeFileSync(join(root.dir, "state", "inbox-drafts.json"), JSON.stringify({ [id]: draft }));
      await assert.rejects(
        approveCommand([id], { config: { root: root.dir, claudeBin: "/usr/bin/true" } as never }),
        /refusing to ratify .*W1-T900001.*withdrawn.*worktree plan/,
      );
      assert.equal(readFileSync(join(root.dir, "state", "inbox-proposals.json"), "utf8"), registry);
    }
    const ledger = readFileSync(join(root.dir, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledger.filter((l) => l.step === "approve.error" && l.error.includes("withdrawn")).length, 2);
    assert.equal(ledger.some((l) => ["approve.id_materialized", "approve.shards_written", "ratify.approved"].includes(l.step)), false);
    assert.equal(origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"), "");
    assert.deepEqual(readdirSync(join(repoDir, "plan", "tasks.d")), ["retired.yaml"]);
    assert.equal(shim.calls().some((c) => c.includes("--method POST") || c.includes("-X POST")), false);
  } finally {
    process.env.PATH = savedPath;
    seed.cleanup(); origin.cleanup(); root.cleanup();
  }
});
