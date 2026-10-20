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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { plainTemplate } from "../src/lib/inbox-plain.js";
import { verifyHumanAgeBandKey } from "../src/lib/measurement-cadence.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  automationProposalFromJudgedShard,
  buildVerifyHumanJudgePrompt,
  proposalFromJudgedShard,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
} from "../src/lib/verify-human-judge.js";
import { createTaskFilingHistoryInvocation, resolveTaskFilingHistory, FILING_HISTORY_LIMITS,
  type FilingHistoryOptions } from "../src/lib/task-filing-history.js";
import { hostWorktreeGit } from "../src/lib/worktree-git.js";
import { parkedVerifyHumanShards } from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

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

test("#7911: a committed embedded record and a sharded record both retain measured filing ages", () => {
  const { dir, addedAtMs } = seededRepo();
  const byId = parkedById(dir, addedAtMs + 3 * DAY_MS);

  // Positive control on the same corpus: git IS readable here, and the sharded record dates.
  assert.equal(byId.get("W1-T9001")?.ageDays, 3, "the sharded record's add-commit is three days old");
  const embedded = byId.get("W1-T9003");
  assert.ok(embedded, "the embedded record must still be judged");
  assert.equal(embedded.ageDays, 3, "the exact embedded record has a readable introduction too");
  assert.equal(embedded.ageUnknownReason, undefined);
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

/** Committers are explicit and deliberately need not have monotone timestamps. */
function gitHistory(dir: string, when: string, args: string[]): string {
  const { name, email } = GIT_REPO_FIXTURE_IDENTITY;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  return execFileSync("git", ["-C", dir, ...args], { env, stdio: "pipe", encoding: "utf8" });
}

function commitHistory(dir: string, when: string, message: string): void {
  for (const args of [["add", "-A"], ["commit", "--quiet", "--allow-empty", "-m", message]]) gitHistory(dir, when, args);
}

test("W1-T10210: exact record history survives embedded moves and renames", async t => {
  const repo = gitRepo({ kind: "exact-filing-history", seedCommit: false });
  t.after(() => repo.cleanup());
  const dir = repo.dir, id = "W1-T9003";
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  const unrelated = ruling("W1-T90031") + ruling("W1-T8000").replace(
    "A preference about how the operator's repo presents itself.", `dependency/prose reference ${id}, not its record`);
  writeFileSync(join(dir, "plan", "tasks.yaml"), unrelated);
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T9001-control.yaml"), ruling("W1-T9001"));
  commitHistory(dir, "2020-01-01T12:00:00Z", "plan exists before the exact record");
  writeFileSync(join(dir, "plan", "tasks.yaml"), unrelated + ruling(id));
  commitHistory(dir, "2020-01-11T12:00:00Z", "introduce the exact embedded record");
  const now = Date.parse("2020-02-10T12:00:00Z");
  assert.equal(parkedById(dir, now).get("W1-T9001")?.ageDays, 40, "readable-history positive control");
  await t.test("embedded introduction", () => assert.equal(parkedById(dir, now).get(id)?.ageDays, 30, "date the record, not the earlier plan file or near-id"));
  commitHistory(dir, "2020-01-30T12:00:00Z", "unrelated later timestamp");
  writeFileSync(join(dir, "plan", "tasks.yaml"), unrelated);
  const oldPath = join(dir, "plan", "tasks.d", "odd-name.yaml");
  writeFileSync(oldPath, ruling(id));
  commitHistory(dir, "2020-01-15T12:00:00Z", "move the exact record into a shard");
  await t.test("embedded-to-shard move", () => assert.equal(parkedById(dir, now).get(id)?.ageDays, 30, "a move preserves introduction"));
  renameSync(oldPath, join(dir, "plan", "tasks.d", "not-the-id.yml"));
  commitHistory(dir, "2020-01-05T12:00:00Z", "rename with an older numeric timestamp");
  await t.test("rename and non-monotone timestamp", () => assert.equal(parkedById(dir, now).get(id)?.ageDays, 30, "neither rename date nor oldest numeric timestamp is birth"));
  writeFileSync(join(dir, "plan", "tasks.d", `${id}-misleading.yaml`), ruling("W1-T9999"));
  commitHistory(dir, "2020-02-07T12:00:00Z", "a matching filename holds a different identity");
  await t.test("wrong-id filename", () => assert.equal(parkedById(dir, now).get(id)?.ageDays, 30, "a wrong-id filename cannot replace exact record provenance"));
});

function historyCase(): { repo: ReturnType<typeof gitRepo>; plan: Plan; readAge: () => ShardUnderJudgement | undefined } {
  const repo = gitRepo({ kind: "filing-history-unavailable", seedCommit: false });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), ruling("W1-T9003"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9001-control.yaml"), ruling("W1-T9001"));
  commitHistory(repo.dir, "2020-01-01T12:00:00Z", "initial exact records");
  const plan = loadPlan(join(repo.dir, "plan", "tasks.yaml"));
  return { repo, plan, readAge: () => parkedVerifyHumanShards(plan, repo.dir, clockAt(Date.parse("2020-01-01T13:00:00Z")))
    .find(shard => shard.id === "W1-T9003") };
}

test("W1-T10210: unknown history is distinct from a measured same-day zero", async t => {
  await t.test("same-day embedded history is a measured zero", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    assert.equal(f.readAge()?.ageDays, 0); assert.equal(f.readAge()?.ageUnknownReason, undefined);
  });
  await t.test("uncommitted exact record is unknown despite readable history", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), ruling("W1-T9003") + ruling("W1-T9005"));
    const shards = parkedById(f.repo.dir, Date.parse("2020-01-02T12:00:00Z"));
    assert.equal(shards.get("W1-T9001")?.ageDays, 1, "positive control in the same repository");
    assert.equal(shards.get("W1-T9005")?.ageDays, null);
    assert.ok(shards.get("W1-T9005")?.ageUnknownReason);
  });
  await t.test("a matching filename containing only a different id is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(f.repo.dir, "plan", "tasks.d", "W1-T9003-wrong.yaml"), ruling("W1-T90031"));
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "remove exact record but keep a misleading filename");
    assert.equal(f.readAge()?.ageDays, null);
  });
  await t.test("duplicate structured identity is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.d", "W1-T9003-copy.yaml"), ruling("W1-T9003"));
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "ambiguous duplicated record");
    assert.equal(f.readAge()?.ageDays, null); assert.match(f.readAge()?.ageUnknownReason ?? "", /duplicate|ambiguous/);
  });
  await t.test("deletion followed by reintroduction is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), "[]\n");
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "delete record");
    writeFileSync(join(f.repo.dir, "plan", "tasks.d", "W1-T9003-again.yaml"), ruling("W1-T9003"));
    commitHistory(f.repo.dir, "2020-01-03T12:00:00Z", "reintroduce record");
    assert.equal(f.readAge()?.ageDays, null); assert.match(f.readAge()?.ageUnknownReason ?? "", /reintroduc|ambiguous/);
  });
  await t.test("unsupported plan-container shape is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), "tasks: []\n");
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "unsupported container");
    assert.equal(f.readAge()?.ageDays, null); assert.match(f.readAge()?.ageUnknownReason ?? "", /unsupported|shape/);
  });
  await t.test("shallow ancestry is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "a later snapshot");
    const shallow = gitRepo({ kind: "filing-history-shallow", seedCommit: false }); child.after(() => shallow.cleanup());
    shallow.git("fetch", "--quiet", "--depth=1", f.repo.dir, "HEAD");
    shallow.git("checkout", "--quiet", "--detach", "FETCH_HEAD");
    assert.equal(shallow.git("rev-parse", "--is-shallow-repository").trim(), "true");
    const age = parkedVerifyHumanShards(f.plan, shallow.dir, clockAt(Date.parse("2020-01-03T12:00:00Z")))
      .find(shard => shard.id === "W1-T9003");
    assert.equal(age?.ageDays, null); assert.match(age?.ageUnknownReason ?? "", /shallow|incomplete/);
  });
  await t.test("a missing original parent is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    const parent = f.repo.git("rev-parse", "HEAD").trim();
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "child of missing parent");
    rmSync(join(f.repo.dir, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
    assert.equal(f.readAge()?.ageDays, null); assert.ok(f.readAge()?.ageUnknownReason);
  });
  await t.test("an unreadable historical blob is unknown", child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    const blob = f.repo.git("rev-parse", "HEAD:plan/tasks.yaml").trim();
    rmSync(join(f.repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    assert.equal(f.readAge()?.ageDays, null); assert.ok(f.readAge()?.ageUnknownReason);
  });
});

test("W1-T10210: callers share one aggregate filing-history budget", async t => {
  const { dir, addedAtMs } = seededRepo(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = loadPlan(join(dir, "plan", "tasks.yaml"));
  commitHistory(dir, "2020-01-01T12:00:00Z", "a second commit consumes the same invocation allowance");
  await t.test("qualified-history positive control", () => {
    const positive = parkedVerifyHumanShards(plan, dir, clockAt(addedAtMs + 3 * DAY_MS));
    assert.deepEqual(positive.map(s => s.ageDays), [3, 3], "both exact identities qualify without exhaustion");
  });
  for (const resource of ["commitVisits", "blobReads", "decodedBytes", "metadataBytes", "stateEntries"] as const) {
    await t.test(resource, () => {
      const calls: string[][] = [];
      const options: FilingHistoryOptions = { limits: { [resource]: resource === "commitVisits" || resource === "blobReads" ? 1 : 0 },
        readGit: (root, args, opts) => { calls.push([...args]); return hostWorktreeGit(root, args, opts); } };
      const shards = parkedVerifyHumanShards(plan, dir, clockAt(addedAtMs + 3 * DAY_MS), undefined, options);
      assert.equal(shards.length, 2);
      for (const shard of shards) { assert.equal(shard.ageDays, null); assert.match(shard.ageUnknownReason ?? "", /budget/); }
      const expectedPins = resource === "decodedBytes" || resource === "metadataBytes" ? 0 : 1;
      assert.equal(calls.filter(a => a[0] === "rev-parse" && a[1] === "--verify").length, expectedPins,
        "a second candidate must not reset or retry the exhausted invocation");
      if (resource === "blobReads") assert.equal(calls.filter(a => a[0] === "cat-file").length, 0, "debit before object reads");
    });
  }
});

test("W1-T10210: provenance and reuse stay bound to one immutable revision", t => {
  const f = historyCase(); t.after(() => f.repo.cleanup());
  const revision = f.repo.git("rev-parse", "HEAD").trim();
  const ctx = createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"]);
  const birth = resolveTaskFilingHistory("W1-T9003", ctx);
  assert.deepEqual(birth, { state: "qualified", revision, completeness: "complete", commit: revision,
    path: "plan/tasks.yaml", source: "embedded", committerSeconds: Date.parse("2020-01-01T12:00:00Z") / 1000 });
  const work = { ...ctx.usage };
  writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), "[]\n");
  commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "remove record after pin");
  assert.deepEqual(resolveTaskFilingHistory("W1-T9003", ctx), birth);
  assert.equal(resolveTaskFilingHistory("OTHER", ctx).state, "unknown");
  assert.deepEqual(ctx.usage, work, "neither reuse nor an out-of-population request creates more work");
  assert.equal(resolveTaskFilingHistory("W1-T9003", createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"])).state, "unknown");
  const invalid = createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"], { limits: { commitVisits: FILING_HISTORY_LIMITS.commitVisits + 1 } });
  assert.match((resolveTaskFilingHistory("W1-T9003", invalid) as { reason: string }).reason, /invalid/);
  assert.equal(invalid.usage.commitVisits, 0, "the test seam cannot enlarge a production allowance");
});

test("W1-T10210: merges retain a common introduction and reject independent births", t => {
  const common = historyCase(); t.after(() => common.repo.cleanup());
  const first = common.repo.git("rev-parse", "HEAD").trim();
  common.repo.git("branch", "other", first);
  writeFileSync(join(common.repo.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(common.repo.dir, "plan", "tasks.d", "moved.yml"), ruling("W1-T9003"));
  commitHistory(common.repo.dir, "2020-01-02T12:00:00Z", "move on main");
  common.repo.git("checkout", "--quiet", "other");
  commitHistory(common.repo.dir, "2020-01-03T12:00:00Z", "same introduction on the other parent");
  common.repo.git("checkout", "--quiet", "main");
  gitHistory(common.repo.dir, "2020-01-04T12:00:00Z", ["merge", "--quiet", "--no-edit", "--no-ff", "-s", "ours", "other"]);
  const commonResult = resolveTaskFilingHistory("W1-T9003", createTaskFilingHistoryInvocation(common.repo.dir, ["W1-T9003"]));
  assert.equal(commonResult.state, "qualified");
  if (commonResult.state === "qualified") assert.equal(commonResult.commit, first, "inspect all original parents without dating the merge or move");

  const independent = gitRepo({ kind: "independent-filing-births", seedCommit: false }); t.after(() => independent.cleanup());
  mkdirSync(join(independent.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(independent.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(independent.dir, "plan", "tasks.d", "W1-T9001-control.yaml"), ruling("W1-T9001"));
  commitHistory(independent.dir, "2020-01-01T12:00:00Z", "before either introduction");
  independent.git("branch", "other");
  for (const [branch, day] of [["main", "11"], ["other", "12"]]) {
    independent.git("checkout", "--quiet", branch!);
    writeFileSync(join(independent.dir, "plan", "tasks.yaml"), ruling("W1-T9003"));
    commitHistory(independent.dir, `2020-01-${day}T12:00:00Z`, `independent introduction on ${branch}`);
  }
  independent.git("checkout", "--quiet", "main");
  gitHistory(independent.dir, "2020-01-13T12:00:00Z", ["merge", "--quiet", "--no-edit", "--no-ff", "-s", "ours", "other"]);
  const shards = parkedById(independent.dir, Date.parse("2020-02-10T12:00:00Z"));
  assert.equal(shards.get("W1-T9001")?.ageDays, 40, "same-corpus positive control survives the merge");
  assert.equal(shards.get("W1-T9003")?.ageDays, null);
  assert.match(shards.get("W1-T9003")?.ageUnknownReason ?? "", /incomparable|ambiguous/);
});

test("W1-T10210: replacement refs cannot manufacture a later introduction", t => {
  const f = historyCase(); t.after(() => f.repo.cleanup());
  commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", "child of the real introduction");
  f.repo.git("replace", "--graft", "HEAD");
  const result = resolveTaskFilingHistory("W1-T9003", createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"]));
  assert.equal(result.state, "qualified");
  if (result.state === "qualified") assert.equal(result.committerSeconds, Date.parse("2020-01-01T12:00:00Z") / 1000);
  f.repo.git("replace", "-d", "HEAD");
  writeFileSync(join(f.repo.dir, ".git", "info", "grafts"), f.repo.git("rev-parse", "HEAD").trim() + "\n");
  const grafted = resolveTaskFilingHistory("W1-T9003", createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"]));
  assert.equal(grafted.state, "unknown");
});

test("W1-T10210: unsupported historical encoding, aliases and oversized blobs remain unknown", async t => {
  for (const [name, content, reason] of [
    ["invalid UTF-8", Buffer.from([0xff]), /UTF-8/],
    ["YAML aliases", "- &record {id: W1-T9003}\n- *record\n", /aliases/],
    ["not a record list", "- just-a-string\n", /record shape/],
    ["malformed YAML", "- id: [\n", /YAML/],
    ["oversized blob", "- id: W1-T9003\n  rationale: " + "x".repeat(4 * 1024 ** 2 + 1) + "\n", /budget/],
  ] as const) await t.test(name, child => {
    const f = historyCase(); child.after(() => f.repo.cleanup());
    writeFileSync(join(f.repo.dir, "plan", "tasks.yaml"), content);
    commitHistory(f.repo.dir, "2020-01-02T12:00:00Z", name);
    const result = resolveTaskFilingHistory("W1-T9003", createTaskFilingHistoryInvocation(f.repo.dir, ["W1-T9003"]));
    assert.equal(result.state, "unknown");
    if (result.state === "unknown") assert.match(result.reason, reason);
  });
});

test("W1-T10210: finite defaults cover a production-shaped immutable history", t => {
  const repo = gitRepo({ kind: "filing-history-population", seedCommit: false }); t.after(() => repo.cleanup());
  const data = (value: string): string => `data ${Buffer.byteLength(value)}\n${value}\n`;
  const { name, email } = GIT_REPO_FIXTURE_IDENTITY;
  let stream = `commit refs/heads/main\ncommitter ${name} <${email}> 1577880000 +0000\n` + data("population root");
  stream += "M 100644 inline plan/tasks.yaml\n" + data("[]\n");
  for (let i = 0; i < 4096; i++) stream += `M 100644 inline plan/tasks.d/record-${i}.yaml\n` + data(ruling(`P${i}`));
  stream += "\n";
  for (let i = 1; i < 1024; i++) stream += `commit refs/heads/main\ncommitter ${name} <${email}> ${1577880000 + i} +0000\n` + data(`unchanged plan ${i}`) + "\n";
  stream += "done\n";
  execFileSync("git", ["-C", repo.dir, "fast-import", "--quiet"], { input: stream, stdio: "pipe" });
  const ctx = createTaskFilingHistoryInvocation(repo.dir, ["P0", "P4095"]);
  const started = performance.now();
  assert.equal(resolveTaskFilingHistory("P0", ctx).state, "qualified");
  const usage = { ...ctx.usage };
  assert.equal(resolveTaskFilingHistory("P4095", ctx).state, "qualified");
  assert.deepEqual(ctx.usage, usage, "a second candidate reuses the completed immutable scan");
  assert.equal(ctx.usage.commitVisits, 1024); assert.equal(ctx.usage.blobReads, 4097);
  for (const key of Object.keys(FILING_HISTORY_LIMITS) as (keyof typeof FILING_HISTORY_LIMITS)[])
    assert.ok(ctx.usage[key] <= FILING_HISTORY_LIMITS[key]);
  t.diagnostic(JSON.stringify({ population: { commits: 1024, containers: 4097 }, usage: ctx.usage, measuredMs: performance.now() - started }));
});
