import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  draftRefusalAmendment,
  insertRefusalAmendment,
  refusalAmendmentComment,
  refusalAmendmentProof,
  type RefusalAmendmentIo,
  type RefusalCandidate,
  type WorkerRefusal,
} from "#src/lib/refusal-amendment.js";
import { parseWhitelistedProof } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const TASK = "W1-T90529";
const REL = "plan/tasks.d/W1-T90529-fixture.yaml";
const AT0 = "2026-01-01T00:00:00.000Z";
const AT1 = "2026-01-02T00:00:00.000Z";
const REFUSALS: readonly WorkerRefusal[] = [
  { criterion: 1, refusalClass: "premise-rotted", detail: "no line meets the condition" },
];
const BASE_SHARD = ["- id: " + TASK, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");

type PrInput = Parameters<RefusalAmendmentIo["openAmendmentPr"]>[0];

function candidate(runId: string): RefusalCandidate {
  return { taskId: TASK, runId, reportExcerpt: "REFUSED:", refusals: REFUSALS };
}

function shardWithRun(runId: string, at: string): string {
  const text = insertRefusalAmendment(BASE_SHARD, TASK, refusalAmendmentComment(TASK, runId, REFUSALS, at));
  assert.ok(text !== undefined);
  return text;
}

async function draft(text: string, runId: string): Promise<{ outcome: string; input?: PrInput }> {
  let input: PrInput | undefined;
  const io: RefusalAmendmentIo = {
    readShard: () => ({ relPath: REL, text }),
    probeExisting: () => undefined,
    openAmendmentPr: (i) => {
      input = i;
      return { prUrl: "https://example.invalid/pr/1" };
    },
    nowIso: () => AT1,
  };
  const result = await draftRefusalAmendment(candidate(runId), io);
  return { outcome: result.outcome, input };
}

/** The lines a proof's grep matches when the proof executor runs it over `text`. */
function grepLines(t: TestContext, proof: string, text: string): string[] {
  const parsed = parseWhitelistedProof(proof);
  assert.ok(parsed && parsed.kind === "grep", `a grep proof: ${proof}`);
  const dir = ownedFixtureDir(t, "refusal-proof").dir;
  const target = join(dir, parsed.args[parsed.args.length - 1]!);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  const run = spawnSync(parsed.command, parsed.args, { cwd: dir, encoding: "utf8" });
  assert.ok(run.status === 0 || run.status === 1, `grep ran: ${run.stderr}`);
  return run.stdout.split("\n").filter((l) => l !== "").map((l) => l.replace(/^(?:[^:]*:)?\d+:/, ""));
}

test("W1-T14529 criterion 1: the proof for run R1 matches no line of a shard that holds run R0's comment, and matches the inserted R1 comment line", async (t) => {
  const input = shardWithRun("RUN-R0", AT0);
  const drafted = await draft(input, "RUN-R1");
  assert.equal(drafted.outcome, "drafted");
  assert.ok(drafted.input);
  assert.equal(drafted.input.proof, refusalAmendmentProof(TASK, "RUN-R1", REL));
  assert.equal(grepLines(t, drafted.input.proof, input).length, 0, "the proof does not pass on the input shard");
  const matched = grepLines(t, drafted.input.proof, drafted.input.amendedText);
  assert.equal(matched.length, 1);
  assert.match(matched[0]!, /^ {2}# refusal-amendment \(W1-T90529, run RUN-R1, 2026-01-02T00:00:00\.000Z\): /);
  const taskOnly = `grep: refusal-amendment (${TASK} in ${REL}`;
  assert.ok(grepLines(t, taskOnly, input).length > 0, "a task-only pattern passes on the input shard");
});

test("W1-T14529 criterion 2: a run id with BRE special characters matches the amended comment line and no line with one of them replaced", async (t) => {
  const runId = "run.1*[x]^$\\z";
  const drafted = await draft(BASE_SHARD, runId);
  assert.ok(drafted.input);
  const proof = drafted.input.proof;
  const matched = grepLines(t, proof, drafted.input.amendedText);
  assert.equal(matched.length, 1);
  const line = matched[0]!;
  assert.ok(line.includes(`run ${runId},`));
  const start = line.indexOf(runId);
  for (const ch of [".", "*", "[", "]", "^", "$", "\\"]) {
    const at = start + runId.indexOf(ch);
    const altered = line.slice(0, at) + "Q" + line.slice(at + 1);
    assert.equal(grepLines(t, proof, altered + "\n").length, 0, `the pattern rejects ${ch} replaced`);
  }
});

test("W1-T14529 criterion 3: invariant:comment-text-unchanged the comment lines, branch, title, commit body, prIntro, claim and outcomes stay the same", async () => {
  const drafted = await draft(BASE_SHARD, "RUN-R1");
  assert.ok(drafted.input);
  const i = drafted.input;
  assert.equal(
    i.amendedText,
    [
      "- id: W1-T90529",
      "  repo: remudero",
      "  # refusal-amendment (W1-T90529, run RUN-R1, 2026-01-02T00:00:00.000Z): the worker refused criterion 1 " +
        "[premise-rotted] — proposed close-unbuilt: the premise no longer holds at HEAD — close this task unbuilt, " +
        "or restate the premise it should build on",
      "  #   worker evidence: no line meets the condition",
      "  #   this task is held from dispatch until its record changes; an Architect must make the change above",
      "  status: queued",
      "  attempts: 0",
      "",
    ].join("\n"),
  );
  assert.equal(i.branch, "refusal-amendment/W1-T90529");
  assert.equal(i.shardRelPath, REL);
  assert.equal(i.title, "chore(plan): propose an amendment for W1-T90529 from its worker's refusal");
  assert.equal(
    i.commitBody,
    "The worker for W1-T90529 refused instead of building, and the harness would otherwise have " +
      "re-dispatched it as a failed attempt until its breaker tripped. This filing records the " +
      "refusal beside the task and holds the task from dispatch until its record changes.",
  );
  assert.equal(
    i.prIntro,
    "AUTOMATED PLAN AMENDMENT (W1-T4838): the worker for W1-T90529 stated a categorized refusal " +
      "(run RUN-R1) rather than failing:\n\ncriterion 1 [premise-rotted]: no line meets the condition\n\n" +
      "This plan-only PR adds a comment beside the task proposing the change each category implies; " +
      "it edits no claim, proof or files field. An Architect makes the change — nothing here is merged unreviewed.",
  );
  assert.equal(i.claim, "the shard records the worker's refusal of W1-T90529 and the amendment it implies");
  assert.equal(i.proof, "grep: refusal-amendment (W1-T90529, run RUN-R1, in plan/tasks.d/W1-T90529-fixture.yaml");
  assert.equal((await draft(shardWithRun("RUN-R1", AT0), "RUN-R1")).outcome, "already_flagged");
  assert.equal((await draft("- id: W1-T90529\n  repo: remudero\n", "RUN-R1")).outcome, "text_drift");
  assert.equal((await draft(shardWithRun("RUN-R0", AT0), "RUN-R1")).outcome, "drafted");
});
