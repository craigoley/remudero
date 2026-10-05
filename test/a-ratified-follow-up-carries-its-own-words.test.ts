import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import {
  approveProposal,
  classifyProposal,
  fileRatificationBatch,
  fileRatificationDraft,
  inboxDraftExampleFragmentYaml,
  planRatificationBatch,
  RatificationDraftRefusedError,
  type Proposal,
  type RatificationPayload,
} from "../src/lib/inbox.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import { loadCorpus } from "../scripts/citation-anchor-census.mjs";

const ID = "W1-T5507";
const proposal: Proposal = {
  id: "followup:DAEMON-1789548928143-PR-5737-task-0",
  summary: 'Keep the follow-up’s own words, including "quotes", YAML: punctuation and the reason a worker needs them.\n' +
    "A second paragraph records the concrete failure and the repair the follow-up requested, without substituting its title. " +
    "— from W1-T4700 (run DAEMON-1789548928143, https://github.com/craigoley/remudero/pull/5737)",
  evidenceAnchors: [],
  originatingItemId: "PR-5737",
};
const stampLine = `- ${proposal.id} (carry the follow-up) — RATIFIED 2026-10-03 -> ${ID}`;
const fragment = inboxDraftExampleFragmentYaml().replace("NEW-1", ID);
const known = new Set(["remudero", "none"]);

function worktree(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-t5541-"));
  fs.writeFileSync(join(root, "MASTER-PLAN.md"), "# Master plan\n");
  return root;
}

function ready(fragmentYaml = fragment) {
  const result = classifyProposal(proposal, {
    proposalId: proposal.id, fragmentYaml, stampLine, anchorFingerprint: "",
  }, {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => true,
    isRatified: () => false,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
  });
  assert.equal(result.state, "ready", JSON.stringify(result.reasons));
  return result;
}

test("W1-T5541: a rationale-less draft is written with the follow-up text", () => {
  const root = worktree();
  let written: string[] = [];
  const result = approveProposal(ready(), {
    createRatificationBranch(payload) {
      // The CLI materializer forwards only these three fields.
      written = fileRatificationDraft(root, {
        proposalId: payload.proposalId, fragmentYaml: payload.fragmentYaml, stampLine: payload.stampLine,
      }, fs, join, known);
      return "fixture-branch";
    },
    openPlanPr: () => "https://github.com/craigoley/remudero/pull/1",
  }, { ledgerPath: join(root, "ledger.jsonl"), runId: "fixture" });
  assert.equal(result.ok, true);
  assert.equal(written.length, 1);
  const yaml = fs.readFileSync(join(root, written[0]), "utf8");
  const task = parse(yaml)[0];
  assert.equal(task.rationale,
    "From the 2026-09-16 follow-up on PR-5737, ratified via rmd approve:\n" + proposal.summary);
  assert.ok(yaml.split("\n").every((line) => line.length <= 100));
  const corpus = loadCorpus({ cwd: root });
  assert.equal(corpus.shardCount, 1);
  assert.equal(corpus.units.length, 2);
  assert.equal(corpus.units[1].text, task.rationale);
});

test("W1-T5541: a directory in files or a grep proof is refused", () => {
  for (const entry of ["missing/", "existing.dir", ".", "existing.dir/", "extensionless"]) {
    for (const surface of ["files", "grep"]) {
      const root = worktree();
      fs.mkdirSync(join(root, "existing.dir"));
      fs.mkdirSync(join(root, "extensionless"));
      const task = parse(fragment)[0];
      if (surface === "files") task.files = [entry];
      else task.acceptance[0].proof = `grep: concrete evidence in ${entry}`;
      const effects: string[] = [];
      assert.throws(() => fileRatificationDraft(root, {
        proposalId: proposal.id, fragmentYaml: stringify([task]), stampLine,
      }, {
        readFileSync: fs.readFileSync,
        mkdirSync: () => { effects.push("mkdir"); },
        writeFileSync: () => { effects.push("write"); },
      }, join, known), (error: unknown) =>
        error instanceof RatificationDraftRefusedError &&
        error.message.includes(`[draft-directory-${surface}]`) && error.message.includes(entry));
      assert.deepEqual(effects, []);
      assert.equal(fs.readFileSync(join(root, "MASTER-PLAN.md"), "utf8"), "# Master plan\n");
    }
  }
});

test("W1-T5541: whitespace rationale is replaced and an authored rationale is preserved", () => {
  for (const rationale of [" \n\t", "The author’s concrete rationale.\nKeep its second line too.", "Authored reason.\n\n", "Authored reason.  "]) {
    const task = parse(fragment)[0];
    task.rationale = rationale;
    const root = worktree();
    const batch = planRatificationBatch([ready(stringify([task]))], "# Master plan\n");
    assert.equal(batch.ok, true);
    const result = fileRatificationBatch(root, batch.accepted, (payload) => ({
      proposalId: payload.proposalId, fragmentYaml: payload.fragmentYaml, stampLine: payload.stampLine,
    }), fs, join, known);
    const filed = parse(fs.readFileSync(join(root, result.writtenPaths[0]), "utf8"))[0];
    assert.equal(filed.rationale,
      "From the 2026-09-16 follow-up on PR-5737, ratified via rmd approve:\n" +
      (rationale.trim() ? rationale : proposal.summary));
    delete filed.rationale;
    delete task.rationale;
    assert.deepEqual(filed, task);
  }
});

test("W1-T5541: a batch directory refusal precedes materialization and every write", () => {
  const root = worktree();
  fs.mkdirSync(join(root, "existing.dir"));
  const task = parse(fragment)[0];
  task.files = ["existing.dir"];
  const payload = (fragmentYaml: string): RatificationPayload => ({ proposalId: proposal.id, fragmentYaml, stampLine });
  let materialized = 0;
  assert.throws(() => fileRatificationBatch(root, [payload(fragment), payload(stringify([task]))],
    (value) => { materialized++; return value; }, fs, join, known), RatificationDraftRefusedError);
  assert.equal(materialized, 0);
  assert.equal(fs.existsSync(join(root, "plan")), false);
});

test("W1-T5541: the writer fills null rationale and preserves surrounding authored YAML", () => {
  const root = worktree();
  const authored = fragment + "\n  rationale:\n  note: keep this note verbatim\n";
  const paths = fileRatificationDraft(root, {
    proposalId: proposal.id, fragmentYaml: authored, stampLine, proposal,
  }, fs, join, known);
  const yaml = fs.readFileSync(join(root, paths[0]), "utf8");
  assert.ok(yaml.startsWith(fragment + "\n  rationale: >-\n"));
  assert.ok(yaml.endsWith("  note: keep this note verbatim\n"));
  assert.equal(parse(yaml)[0].rationale,
    "From the 2026-09-16 follow-up on PR-5737, ratified via rmd approve:\n" + proposal.summary);
  fileRatificationDraft(root, { proposalId: proposal.id, fragmentYaml: yaml, stampLine, proposal }, fs, join, known);
  assert.equal(fs.readFileSync(join(root, paths[0]), "utf8"), yaml);
});

test("W1-T5541: every task in a fragment carries prose and file-only grep proofs still file", () => {
  const root = worktree();
  const source = { ...proposal, originatingItemId: undefined };
  fs.writeFileSync(join(root, "evidence.txt"), "concrete evidence\n");
  const first = parse(fragment)[0];
  first.files = ["evidence.txt"];
  first.acceptance[0].proof = "grep: concrete evidence in evidence.txt";
  const second = { ...structuredClone(first), id: "W1-T5508", title: "A second task retains its own rationale", rationale: "Authored reason.\n" };
  const paths = fileRatificationDraft(root, {
    proposalId: source.id, fragmentYaml: stringify([first, second]),
    stampLine: stampLine + "/W1-T5508", proposal: source,
  }, fs, join, known);
  assert.equal(paths.length, 2);
  for (const [index, path] of paths.entries()) {
    const task = parse(fs.readFileSync(join(root, path), "utf8"))[0];
    assert.equal(task.rationale,
      "From the 2026-09-16 follow-up on https://github.com/craigoley/remudero/pull/5737, ratified via rmd approve:\n" +
      (index === 0 ? source.summary : second.rationale));
  }
  assert.equal(loadCorpus({ cwd: root }).units.length, 3);
});
