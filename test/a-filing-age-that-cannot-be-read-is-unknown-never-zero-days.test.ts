/**
 * #7911 — A FILING AGE THAT CANNOT BE READ IS UNKNOWN, NEVER "0 DAYS".
 *
 * `shardAgeDays` dated a parked record from the add-commit of `plan/tasks.d/<id>-*.yaml` and
 * returned 0 both when no such commit exists (the record is embedded in plan/tasks.yaml, like
 * W3-T7 and W1-T12e) and when git itself failed. The proposal then told the operator the record
 * "was filed `verify: human` 0 days ago": an unknown stated as a measurement, and one that reads
 * as "filed today". An unknown age is now `null` with its reason, and a measured 0 stays a number.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { plainTemplate } from "../src/lib/inbox-plain.js";
import { verifyHumanAgeBandKey } from "../src/lib/measurement-cadence.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  automationProposalFromJudgedShard,
  buildVerifyHumanJudgePrompt,
  proposalFromJudgedShard,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
} from "../src/lib/verify-human-judge.js";
import { parkedVerifyHumanShards } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const DAY_MS = 86_400_000;

/** Ruling-shaped (it declares DECISIONS.md), so it stays on the operator-facing sweep. */
const ruling = (id: string): string => `- id: ${id}
  title: "should the fleet commit under its own identity? (${id})"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  files: [DECISIONS.md]
  status: queued
  rationale: "A preference about how the operator's repo presents itself."
  acceptance:
    - claim: "the operator states which identity he wants"
      proof: "unit test: test/x.test.ts"
`;

const clockAt = (nowMs: number) =>
  ({ now: () => nowMs, iso: () => new Date(nowMs).toISOString() }) as unknown as Parameters<typeof parkedVerifyHumanShards>[2];

/** One commit carrying a SHARDED record (W1-T9001) and one EMBEDDED in plan/tasks.yaml (W1-T9003). */
function seededRepo(): { dir: string; addedAtMs: number } {
  const repo = gitRepo({ kind: "vh-filing-age", seedCommit: false });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9001-sharded.yaml"), ruling("W1-T9001"));
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), ruling("W1-T9003"));
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "chore: seed");
  return { dir: repo.dir, addedAtMs: Number(repo.git("log", "-1", "--format=%ct")) * 1000 };
}

function parkedById(root: string, nowMs: number): Map<string, ShardUnderJudgement> {
  const shards = parkedVerifyHumanShards(loadPlan(join(root, "plan", "tasks.yaml")), root, clockAt(nowMs));
  return new Map(shards.map((s) => [s.id, s]));
}

const NEEDS: VerifyHumanVerdict = { decision: "needs_operator", reason: "only the operator can choose his identity" };
const AUTOMATE: VerifyHumanVerdict = { decision: "automate", reason: "an agent can settle and record this" };

const unknownShard: ShardUnderJudgement = {
  id: "W3-T7",
  title: "an embedded record",
  rationale: "",
  acceptance: [],
  ageDays: null,
  ageUnknownReason: "no commit adds plan/tasks.d/W3-T7-*.yaml",
  depsAllMerged: true,
  citedInSrc: false,
};

test("#7911: a record embedded in plan/tasks.yaml has an unknown filing age, never 0 days", () => {
  const { dir, addedAtMs } = seededRepo();
  const byId = parkedById(dir, addedAtMs + 3 * DAY_MS);

  // Positive control on the same corpus: git IS readable here, and the sharded record dates.
  assert.equal(byId.get("W1-T9001")?.ageDays, 3, "the sharded record's add-commit is three days old");
  const embedded = byId.get("W1-T9003");
  assert.ok(embedded, "the embedded record must still be judged");
  assert.equal(embedded.ageDays, null, "no add-commit for a shard file is an UNKNOWN age, not 0");
  assert.match(embedded.ageUnknownReason ?? "", /no commit adds plan\/tasks\.d\/W1-T9003-\*\.yaml/);
});

test("#7911: a root git cannot read has an unknown filing age whose reason says git failed", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}vh-no-git-`));
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), ruling("W1-T9001"));
  const shard = parkedById(root, 0).get("W1-T9001");
  assert.ok(shard, "an unreadable age must not throw the record out of the sweep");
  assert.equal(shard.ageDays, null, "a failed git read is an UNKNOWN age, not 0");
  assert.match(shard.ageUnknownReason ?? "", /git log failed/, "and it names a different cause than a missing add-commit");
});

test("#7911: a shard filed today is a measured 0 days, distinct from an unknown age", () => {
  const { dir, addedAtMs } = seededRepo();
  const sharded = parkedById(dir, addedAtMs + 3_600_000).get("W1-T9001");
  assert.strictEqual(sharded?.ageDays, 0, "an hour after its add-commit the age is a measured 0");
  assert.equal(sharded?.ageUnknownReason, undefined, "a measured age carries no unknown reason");
});

test("#7911: the prompt and both proposals say an unknown age is unknown, never a number of days", () => {
  const prompt = buildVerifyHumanJudgePrompt(unknownShard);
  const needs = proposalFromJudgedShard(unknownShard, NEEDS);
  const automate = automationProposalFromJudgedShard(unknownShard, AUTOMATE);
  for (const [where, text] of [["prompt", prompt], ["needs_operator proposal", needs.summary], ["automate proposal", automate.summary]]) {
    assert.doesNotMatch(text, /\b\d+ days\b|null days/, `the ${where} must not state a number of days it never read`);
    assert.match(text, /filing age unknown: no commit adds plan\/tasks\.d\/W3-T7-\*\.yaml/, `the ${where} must carry the reason`);
  }
  assert.match(prompt, /^AGE: an unknown number of days since filing/m);
  assert.match(needs.summary, /^W3-T7 was filed `verify: human` an unknown number of days ago \(/);
  assert.match(plainTemplate(needs).whatHappened, /a wait of some time/, "the inbox's plain message must not report a wait of 0 days");

  const noReason = proposalFromJudgedShard({ ...unknownShard, ageUnknownReason: undefined }, NEEDS);
  assert.match(noReason.summary, /filing age unknown: no filing date was read/, "an unknown with no stated reason still says unknown");

  const today = proposalFromJudgedShard({ ...unknownShard, ageDays: 0, ageUnknownReason: undefined }, NEEDS);
  assert.match(today.summary, /^W3-T7 was filed `verify: human` 0 days ago and a judge/, "a measured 0 keeps today's wording");
  assert.match(plainTemplate(today).whatHappened, /a wait of 0 days/);
});

test("#7911: an unknown age never earns an age-band re-ask", () => {
  assert.equal(verifyHumanAgeBandKey(unknownShard), undefined, "an unknown age sits in no age band");
  assert.ok(verifyHumanAgeBandKey({ ...unknownShard, ageDays: 61, ageUnknownReason: undefined }), "control: a 61-day age does");
});
