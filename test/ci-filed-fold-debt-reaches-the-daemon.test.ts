import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  FOLD_DEBT_DROPPED_STEP,
  FOLD_DEBT_INGESTED_STEP,
  FOLD_DEBT_MAIN_ARTIFACT,
  FOLD_DEBT_PR_ARTIFACT,
  FOLD_DEBT_PULL_MAX_READS,
  foldDebtArtifactsRestArgs,
  foldDebtRunIdsFromLedger,
  pullsForCommitRestArgs,
} from "../src/lib/fold-debt-pull.js";
import { mutationVerdictArtifactZipRestArgs, zipTextMembers } from "../src/lib/mutation-verdict-pull.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runSweep } from "./helpers/sweep-test.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { foldDebtEntryId, renderFoldDebtEntry } from "../scripts/claude-md-budget-ratchet.mjs";

// ── W1-T7853: fold debt a CI run files reaches the daemon's feedback inbox ───────────────────────
//
// The CLAUDE.md budget ratchet files `plan/feedback/fold-debt-<file>-<bytes>.yaml` in a CI runner's
// throwaway checkout, on the PR lane (light-gates) and on main's push lane (`ci` shard 1), and nothing
// carried it out. These tests drive the real step bodies from .github/workflows/ci.yml, entries made by
// the real ratchet's own renderer, and the real `buildSweepEffects` + `runSweep` pull.

const OWNER = "acme";
const REPO = "widgets";
const CI_YML = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const jobs = (parseYaml(CI_YML) as { jobs: Record<string, { steps: Step[] }> }).jobs;

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t7853-${kind}-`));
}

/** A fold-debt entry exactly as the ratchet renders one. */
function entry(bytes: number): { id: string; text: string } {
  const id = foldDebtEntryId("CLAUDE.md", bytes) as string;
  return { id, text: renderFoldDebtEntry(id, "CLAUDE.md", bytes, 46000, [`CLAUDE.md is ${bytes} bytes > cap 44000 bytes`], "2026-10-13T00:00:00.000Z") };
}

/** A GitHub Actions artifact zip made by the real `zip` binary, members at the archive root as upload-artifact stores them. */
function artifactZip(members: Record<string, string>): Buffer {
  const dir = scratch("zip");
  for (const [name, text] of Object.entries(members)) writeFileSync(join(dir, name), text);
  const out = join(dir, "artifact.zip");
  const res = spawnSync("zip", ["-q", "-X", out, ...Object.keys(members)], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return readFileSync(out);
}

interface Hosted { id: number; lane: "main" | "pr"; runId: number; headSha: string; zip: Buffer }
type Pull = { number: number; state: "open" | "closed"; merged_at: string | null; head: { sha: string } };

/** GitHub as the sweep reads it: two artifact lists, the PR a commit belongs to, and the zips. */
function fakeGithub(hosted: Hosted[], pulls: Record<string, Pull[]> = {},
  opts: { listThrows?: boolean; zipThrows?: Set<number>; pullsThrow?: Set<string> } = {}) {
  const calls: string[] = [];
  const nameOf = (lane: Hosted["lane"]) => (lane === "main" ? FOLD_DEBT_MAIN_ARTIFACT : FOLD_DEBT_PR_ARTIFACT);
  return {
    calls,
    pulls,
    readJson: (args: string[]) => {
      calls.push(String(args[1]));
      for (const lane of ["main", "pr"] as const) {
        if (args[1] !== foldDebtArtifactsRestArgs(OWNER, REPO, nameOf(lane))[1]) continue;
        if (opts.listThrows) throw new Error("list 500");
        return { artifacts: hosted.filter((h) => h.lane === lane).map((h) => ({
          id: h.id, name: nameOf(lane), expired: false, created_at: `2026-10-13T00:00:${String(h.id % 60).padStart(2, "0")}Z`,
          workflow_run: { id: h.runId, head_sha: h.headSha } })) };
      }
      const sha = Object.keys(pulls).concat(hosted.map((h) => h.headSha)).find((s) => args[1] === pullsForCommitRestArgs(OWNER, REPO, s)[1]);
      assert.ok(sha !== undefined, `an unexpected read: ${args[1]}`);
      if (opts.pullsThrow?.has(sha)) throw new Error("pulls 502");
      return pulls[sha] ?? [];
    },
    readZip: (args: string[]) => {
      calls.push(String(args[1]));
      const h = hosted.find((x) => args[1] === mutationVerdictArtifactZipRestArgs(OWNER, REPO, x.id)[1]);
      assert.ok(h, `an unlisted artifact was downloaded: ${args[1]}`);
      if (opts.zipThrows?.has(h.id)) throw new Error("zip 500");
      return h.zip;
    },
  };
}

/** The daemon: the real effect built the way it builds it, over a checkout, then real `runSweep` passes. */
function daemon(gh: ReturnType<typeof fakeGithub>, ledger: Array<Record<string, unknown>>,
  opts: { land?: false | ((root: string) => { landed: boolean; error?: string }) } = {}) {
  const root = gitRepo({ kind: "w1-t7853-checkout" }).dir;
  const landed: string[] = [];
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: OWNER,
    repo: REPO,
    config: { root: REPO } as never,
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "t7853",
    plan: { tasks: [], byId: new Map() } as never,
    log: (step, fields) => void logs.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
    policy: DEFAULT_SWEEP_POLICY,
    repoRoot: root,
    ghJsonImpl: gh.readJson,
    ghBufferImpl: gh.readZip,
    ...(opts.land === false ? {} : { landFeedbackImpl: (r: string) => { landed.push(r); return opts.land ? opts.land(r) : { landed: true }; } }),
  });
  const pass = (surface?: "light" | "full") =>
    runSweep([], {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson", runId: "t7853",
      readLedger: () => [...ledger], appendLine: (_p, line) => void ledger.push(line), now: () => 1_000,
      log: (step) => void logs.push({ step: String(step), fields: {} }),
      pullFoldDebt: effects.pullFoldDebt,
      repairAdmissionSurface: surface,
    }, DEFAULT_SWEEP_POLICY);
  const inbox = () => (existsSync(join(root, "plan", "feedback")) ? readdirSync(join(root, "plan", "feedback")).sort() : []);
  return { root, pass, landed, logs, inbox };
}

const rows = (ledger: Array<Record<string, unknown>>, step: string) => ledger.filter((l) => l.step === step);

function step(job: string, pick: (s: Step) => boolean): { step: Step; index: number } {
  const steps = jobs[job]!.steps;
  const index = steps.findIndex(pick);
  assert.ok(index >= 0, `job ${job} has the step`);
  return { step: steps[index]!, index };
}

test("W1-T7853: both CI runs that file fold debt upload it as an artifact", () => {
  const mutationUpload = Object.values(jobs).flatMap((j) => j.steps ?? []).find((s) => s.with?.name === "mutation-verdict-ledger");
  assert.ok(mutationUpload?.uses, "the mutation verdict's upload is the pin this transport reuses");
  const lanes = [
    { job: "commitlint", artifact: FOLD_DEBT_PR_ARTIFACT, after: (s: Step) => s.id === "claude-md-budget-ratchet" },
    { job: "ci", artifact: FOLD_DEBT_MAIN_ARTIFACT, after: (s: Step) => s.name === "Test" && /run_main_ceiling_gate claude-md-budget-ratchet/.test(s.run ?? "") },
  ];
  for (const lane of lanes) {
    const filer = step(lane.job, lane.after);
    const upload = step(lane.job, (s) => s.with?.name === lane.artifact);
    const collect = jobs[lane.job]!.steps[upload.index - 1]!;
    assert.ok(upload.index > filer.index, `${lane.artifact} uploads after the step that files`);
    assert.equal(upload.step.uses, mutationUpload.uses, "the same pinned upload action");
    assert.equal(upload.step.with?.path, "${{ runner.temp }}/fold-debt");
    assert.equal(upload.step.with?.["if-no-files-found"], "ignore", "a run that filed nothing uploads nothing");
    for (const s of [collect, upload.step]) assert.match(s.if ?? "", /always\(\)/, `${s.name} runs even when a gate failed`);
    assert.match(collect.run ?? "", /git ls-files .*--others/, "the step before the upload collects what this run filed");
    if (lane.job === "ci") {
      for (const s of [collect, upload.step]) {
        assert.match(s.if ?? "", /github\.event_name == 'push'/);
        assert.match(s.if ?? "", /matrix\.shard == 1/);
      }
    }

    // The collect step's real body, in a checkout holding a committed entry, a newly filed one and a non-debt file.
    const repo = gitRepo({ kind: "w1-t7853-runner" });
    const feedback = join(repo.dir, "plan", "feedback");
    mkdirSync(feedback, { recursive: true });
    writeFileSync(join(feedback, "fold-debt-CLAUDE-md-44001.yaml"), entry(44001).text);
    repo.git("add", "plan/feedback");
    repo.git("commit", "-q", "-m", "a landed entry");
    writeFileSync(join(feedback, "fold-debt-CLAUDE-md-44123.yaml"), entry(44123).text);
    writeFileSync(join(feedback, "a-human-note.yaml"), "id: a-human-note\n");
    const runnerTemp = scratch("runner-temp");
    const res = spawnSync("bash", ["-e", "-c", collect.run!], { cwd: repo.dir, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: runnerTemp } });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readdirSync(join(runnerTemp, "fold-debt")), ["fold-debt-CLAUDE-md-44123.yaml"],
      "only the entry this run filed: a landed entry is never shipped again from every later run");
    const quiet = gitRepo({ kind: "w1-t7853-runner-quiet" });
    const quietTemp = scratch("runner-temp-quiet");
    const none = spawnSync("bash", ["-e", "-c", collect.run!], { cwd: quiet.dir, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: quietTemp } });
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(readdirSync(join(quietTemp, "fold-debt")), [], "a run that filed nothing collects nothing");
  }
});

test("W1-T7853: a push-lane fold-debt artifact is written and landed", async () => {
  const debt = entry(44123);
  const gh = fakeGithub([{ id: 11, lane: "main", runId: 501, headSha: "m1", zip: artifactZip({ [`${debt.id}.yaml`]: debt.text }) }]);
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger);
  await d.pass();
  assert.equal(readFileSync(join(d.root, "plan", "feedback", `${debt.id}.yaml`), "utf8"), debt.text, "written byte for byte");
  assert.deepEqual(d.landed, [d.root], "and landed from the checkout it was written into");
  const ingested = rows(ledger, FOLD_DEBT_INGESTED_STEP);
  assert.equal(ingested.length, 1);
  const { lane, workflow_run_id, artifact_id, entry_ids, written, existing, refused, landed } = ingested[0]!;
  assert.deepEqual({ lane, workflow_run_id, artifact_id, entry_ids, written, existing, refused, landed },
    { lane: "main", workflow_run_id: "501", artifact_id: 11, entry_ids: [debt.id], written: [debt.id], existing: [], refused: [], landed: true });
  assert.equal(gh.calls.filter((c) => c.includes("/commits/")).length, 0, "main's own debt needs no merge lookup");
});

test("W1-T7853: a PR-lane fold-debt entry waits for its merge", async () => {
  const [open, closed, superseded] = [entry(44201), entry(44202), entry(44203)];
  const gh = fakeGithub([
    { id: 21, lane: "pr", runId: 601, headSha: "p1", zip: artifactZip({ [`${open.id}.yaml`]: open.text }) },
    { id: 22, lane: "pr", runId: 602, headSha: "p2", zip: artifactZip({ [`${closed.id}.yaml`]: closed.text }) },
    { id: 23, lane: "pr", runId: 603, headSha: "p3", zip: artifactZip({ [`${superseded.id}.yaml`]: superseded.text }) },
  ], {
    p1: [{ number: 9001, state: "open", merged_at: null, head: { sha: "p1" } }],
    p2: [{ number: 9002, state: "closed", merged_at: null, head: { sha: "p2" } }],
    p3: [{ number: 9003, state: "closed", merged_at: "2026-10-13T01:00:00Z", head: { sha: "p3-later" } }],
  });
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger);
  await d.pass();
  assert.deepEqual(d.inbox(), [], "an open PR's debt is not filed, and neither is an unmerged or superseded run's");
  assert.deepEqual(d.landed, []);
  assert.equal(gh.calls.filter((c) => c.endsWith("/zip")).length, 0, "nothing is downloaded before its merge is known");
  assert.deepEqual(rows(ledger, FOLD_DEBT_DROPPED_STEP).map((r) => [r.workflow_run_id, r.pr_number, String(r.reason)]), [
    ["602", 9002, "PR #9002 closed unmerged"],
    ["603", 9003, "PR #9003 merged at head p3-later, not at this run's head p3"],
  ]);
  assert.equal(rows(ledger, FOLD_DEBT_INGESTED_STEP).length, 0, "the open PR's entry stays listed for a later pass");

  gh.pulls.p1 = [{ number: 9001, state: "closed", merged_at: "2026-10-13T02:00:00Z", head: { sha: "p1" } }];
  gh.calls.length = 0;
  await d.pass();
  assert.deepEqual(d.inbox(), [`${open.id}.yaml`], "merged at the run's own head: the debt is main's now");
  assert.deepEqual(d.landed, [d.root]);
  assert.deepEqual(rows(ledger, FOLD_DEBT_INGESTED_STEP).map((r) => [r.workflow_run_id, r.pr_number, r.entry_ids]), [["601", 9001, [open.id]]]);
  assert.ok(!gh.calls.some((c) => c.includes("/commits/p2/") || c.includes("/commits/p3/")), "a dropped run is never read again");
});

test("W1-T7853: an ingested run and an existing entry are not filed twice", async () => {
  const debt = entry(44301);
  const zip = artifactZip({ [`${debt.id}.yaml`]: debt.text });
  const gh = fakeGithub([
    { id: 31, lane: "main", runId: 701, headSha: "m1", zip },
    { id: 32, lane: "main", runId: 702, headSha: "m2", zip },
  ]);
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger);
  mkdirSync(join(d.root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(d.root, "plan", "feedback", `${debt.id}.yaml`), "id: already-triaged\n");
  await d.pass();
  assert.equal(readFileSync(join(d.root, "plan", "feedback", `${debt.id}.yaml`), "utf8"), "id: already-triaged\n", "exclusive create: never overwritten");
  assert.deepEqual(d.landed, [], "nothing new on disk, nothing to land");
  assert.deepEqual(rows(ledger, FOLD_DEBT_INGESTED_STEP).map((r) => [r.workflow_run_id, r.written, r.existing]),
    [["701", [], [debt.id]], ["702", [], [debt.id]]]);
  assert.deepEqual([...foldDebtRunIdsFromLedger(ledger)].sort(), ["701", "702"]);

  gh.calls.length = 0;
  await d.pass();
  assert.deepEqual(gh.calls.filter((c) => c.endsWith("/zip")), [], "an ingested run is never downloaded again");
  assert.equal(rows(ledger, FOLD_DEBT_INGESTED_STEP).length, 2);
});

test("W1-T7853: a malformed member is refused, a failed list ingests nothing, and a light pass reads nothing", async () => {
  const debt = entry(44401);
  const gh = fakeGithub([{ id: 41, lane: "main", runId: 801, headSha: "m1", zip: artifactZip({
    [`${debt.id}.yaml`]: debt.text, "notes.txt": "not an entry", "fold-debt-CLAUDE-md-44402.yaml": "id: fold-debt-CLAUDE-md-44402\n",
  }) }]);
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger);
  await d.pass("light");
  assert.deepEqual(gh.calls, [], "a light pass makes no read");
  await d.pass();
  assert.deepEqual(d.inbox(), [`${debt.id}.yaml`], "only the well-formed entry is written");
  const [row] = rows(ledger, FOLD_DEBT_INGESTED_STEP);
  assert.deepEqual((row!.refused as Array<{ name: string }>).map((r) => r.name).sort(), ["fold-debt-CLAUDE-md-44402.yaml", "notes.txt"]);

  const failing = fakeGithub([], {}, { listThrows: true });
  const failedLedger: Array<Record<string, unknown>> = [];
  const f = daemon(failing, failedLedger);
  await f.pass();
  assert.deepEqual(failedLedger.filter((l) => String(l.step).startsWith("sweep.fold_debt_pull.")), [], "a failed list is never guessed past");
  assert.ok(f.logs.some((l) => l.step === "sweep.fold_debt_pull.error" && l.fields.phase === "list"));
});

test("W1-T7853: the pull is bounded per pass, and the default land is the real feedback landing", async () => {
  const hosted: Hosted[] = Array.from({ length: FOLD_DEBT_PULL_MAX_READS + 2 }, (_, i) => {
    const e = entry(45000 + i);
    return { id: 50 + i, lane: "main", runId: 900 + i, headSha: `m${i}`, zip: artifactZip({ [`${e.id}.yaml`]: e.text }) };
  });
  const gh = fakeGithub(hosted);
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger, { land: false });
  await d.pass();
  assert.equal(gh.calls.filter((c) => c.endsWith("/zip")).length, FOLD_DEBT_PULL_MAX_READS, "a backlog spreads across passes");
  // `landFeedbackImpl` omitted means the real landing: this checkout has no origin, so it cannot land, and says so.
  const [first] = rows(ledger, FOLD_DEBT_INGESTED_STEP);
  assert.equal(first!.landed, false);
  assert.equal(typeof first!.land_error, "string");
  await d.pass();
  assert.equal(rows(ledger, FOLD_DEBT_INGESTED_STEP).length, FOLD_DEBT_PULL_MAX_READS + 2, "the rest land on the next pass");
});

test("W1-T7853: the shared zip reader returns every member it can read", () => {
  const members = zipTextMembers(artifactZip({ "a.yaml": "a", "b.yaml": "b" }));
  assert.deepEqual(members.map((m) => [m.name, m.text]).sort(), [["a.yaml", "a"], ["b.yaml", "b"]]);
  assert.throws(() => zipTextMembers(Buffer.from("not a zip")), /not a zip/);
});

test("W1-T7853: every failed lookup, read, unzip, write and land is named, and only a transient one is retried", async () => {
  const [a, b, c] = [entry(46001), entry(46002), entry(46003)];
  const hosted: Hosted[] = [
    { id: 61, lane: "pr", runId: 1001, headSha: "q1", zip: artifactZip({ [`${a.id}.yaml`]: a.text }) },
    { id: 62, lane: "main", runId: 1002, headSha: "n2", zip: artifactZip({ [`${b.id}.yaml`]: b.text }) },
    { id: 63, lane: "main", runId: 1003, headSha: "n3", zip: Buffer.from("not a zip") },
    { id: 64, lane: "main", runId: 1004, headSha: "n4", zip: artifactZip({ "fold-debt-CLAUDE-md-46004.yaml": "id: [unclosed\n" }) },
    { id: 65, lane: "main", runId: 1005, headSha: "n5", zip: artifactZip({ [`${c.id}.yaml`]: c.text }) },
  ];
  const gh = fakeGithub(hosted, { q1: [{ number: 9101, state: "closed", merged_at: "2026-10-13T03:00:00Z", head: { sha: "q1" } }] },
    { zipThrows: new Set([62]), pullsThrow: new Set(["q1"]) });
  const ledger: Array<Record<string, unknown>> = [];
  const d = daemon(gh, ledger, { land: () => { throw new Error("push refused"); } });
  writeFileSync(join(d.root, "plan"), "a file where the inbox directory belongs");
  await d.pass();
  const errors = d.logs.filter((l) => l.step === "sweep.fold_debt_pull.error").map((l) => [l.fields.phase, l.fields.workflow_run_id]);
  assert.deepEqual(errors, [["artifact", "1002"], ["write", "1005"], ["artifact", "1001"]],
    "a failed download, a failed write and a failed merge lookup are each named");
  const refused = rows(ledger, FOLD_DEBT_INGESTED_STEP).map((r) => [r.workflow_run_id, (r.refused as Array<{ reason: string }>).map((x) => x.reason.split(":")[0])]);
  assert.deepEqual(refused, [["1003", ["unzip"]], ["1004", ["unparseable"]]], "a bad zip and a bad entry are read once and refused");

  // The transient ones are read again: the inbox is a directory now, the lookup and the download answer.
  const retry = fakeGithub(hosted, gh.pulls);
  const again = daemon(retry, ledger, { land: () => { throw new Error("push refused"); } });
  await again.pass();
  assert.deepEqual(again.inbox(), [`${b.id}.yaml`, `${c.id}.yaml`, `${a.id}.yaml`].sort(), "every transient failure is retried and filed");
  assert.ok(!retry.calls.some((x) => x.includes("/artifacts/63/") || x.includes("/artifacts/64/")), "a refused artifact is never downloaded again");
  const landed = rows(ledger, FOLD_DEBT_INGESTED_STEP).filter((r) => (r.written as string[]).length > 0);
  assert.ok(landed.length > 0 && landed.every((r) => r.landed === false && r.land_error === "push refused"), "a land that throws is recorded, not raised");
});
