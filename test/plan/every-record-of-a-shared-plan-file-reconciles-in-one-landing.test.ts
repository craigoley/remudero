import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { landingIdentity, landPlanReconcileShardsAsync, planReconcileLanding, type LandFeedbackResult, type LandingRepository, type PlanReconcileLand } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type PlanReconcileLint } from "#src/lib/measurement-cadence.js";
import { readPlanShards, reconcileRecordStatus } from "#src/lib/plan-reconcile.js";
import { planReconcileProofTemplate, planReconcileStatusCountProof, planReconcileStatusLineCount } from "#src/lib/plan-reconcile-batch.js";
import { statusFlipOnlyTaskIds } from "#src/lib/task-linter.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T15048. A file of plan/tasks.d can hold several records (W1-T9958's file holds W1-T9959 and W1-T9960). The
 * cadence landed one write per record keyed to the shared path, so the last flip of the file won, and the lint hold
 * mapped the path to its last record only. W1-T11183 (#21054) then skipped such files. Every flip of one file is now
 * composed into one replacement text, landed as one input, and that composed text is what the lint hold checks.
 *
 * A pure flip into a file that already holds a merged record adds no line the base lacks, so no line proof can
 * fail at base: the real `check-proof --base` exits 5 on it and the default plan-PR preflight refuses the batch.
 * The landing therefore carries a proof that counts the file's status lines, and criterion 1 lands W1-T9958's
 * shape through the default lander and its default preflight, with nothing stubbed.
 */

const record = (id: string, status: string, lead: "id" | "repo" = "id") => lead === "id"
  ? `- id: ${id}\n  title: "fixture ${id}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`
  : `- repo: remudero\n  title: "fixture ${id}"\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  id: ${id}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`;

const SHARED = "W1-T4-holds-three.yaml";

function fixturePlanDir(t: { after: (fn: () => void) => void }): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15048-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "W1-T1-alone.yaml"), record("W1-T1", "queued"));
  // W1-T4 already reads merged; W1-T5 opens with `- id:` and W1-T6 opens with another key.
  writeFileSync(join(dir, SHARED), "# a file holding three records\n" + record("W1-T4", "merged") + record("W1-T5", "queued") + record("W1-T6", "queued", "repo"));
  return { root, dir };
}

const statuses = (text: string) => Object.fromEntries((parseYaml(text) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]));

// The real landing world: a bare origin whose main holds a file shaped like W1-T9958's (its first record already
// reads merged, the other two are queued). The landing's default preflight runs the tree's own check-proof entry,
// so the fixture's entry loads the real CLI from this checkout.
const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t15048-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const FIXTURE_PR = "https://github.com/o/r/pull/15048";
const T9958 = "plan/tasks.d/W1-T9958-holds-three.yaml";
const T9958_TEXT = record("W1-T9958", "merged") + record("W1-T9959", "queued") + record("W1-T9960", "queued");
const CHECK_PROOF_ENTRY = join(REPO_ROOT, "src", "check-proof-main.ts");
const REAL_CHECK_PROOF_ENTRY = `import ${JSON.stringify(pathToFileURL(CHECK_PROOF_ENTRY).href)};\n`;

function sharedFileWorld(t: TestContext, kind: string): { origin: ReturnType<typeof gitRepo>; main: string; reader: string } {
  const origin = gitRepo({ scope: t, bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ scope: t, kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  const files = {
    "plan/tasks.yaml": "[]\n", [T9958]: T9958_TEXT, "src/x.ts": "export const x = 1;\n",
    "package.json": '{ "type": "module" }\n', "src/check-proof-main.ts": REAL_CHECK_PROOF_ENTRY,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed.dir, path)), { recursive: true });
    writeFileSync(join(seed.dir, path), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "base");
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  return { origin, main: seed.git("rev-parse", "HEAD"), reader: gitRepo({ scope: t, cloneFrom: origin.dir, kind: `${kind}-reader` }).dir };
}

/** The real `rmd check-proof <proof>` child in `cwd`, with `--base origin/main` unless `withBase` is false. */
function checkProof(cwd: string, proof: string, withBase = true): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CHECK_PROOF_ENTRY, proof, ...(withBase ? ["--base", "origin/main"] : [])], {
    cwd, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, "the check-proof child completes");
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

type LandingEvent = { step: string; extra?: Record<string, unknown> };

/** Credit W1-T9958 plus `credited`, and land through the default lander and its default plan-PR preflight. */
async function landSharedFile(t: TestContext, credited: readonly string[]) {
  const kind = `t15048-${credited.length}`;
  const w = sharedFileWorld(t, kind);
  const results: LandFeedbackResult[] = [];
  const events: LandingEvent[] = [];
  const lander: PlanReconcileLand = async (root, batch, landOpts) => {
    const landed = await landPlanReconcileShardsAsync(root, batch, landOpts);
    results.push(landed);
    return landed;
  };
  const log = (step: string, extra?: Record<string, unknown>): void => { events.push({ step, extra }); };
  const landing = planReconcileLanding(w.reader, () => ({ targetRepository: TARGET, landingOwner: OWNER, log }), lander);
  const cadence = buildPlanReconcileCadenceInput({
    checkoutRoot: w.reader,
    readShards: () => readPlanShards(join(w.reader, "plan", "tasks.d")),
    creditedMergedIds: () => new Set(["W1-T9958", ...credited]),
    land: landing.land,
  });
  const { report, calls } = await withGhShim([{ when: "pr list", stdout: "[]" }, { when: "pr create", stdout: FIXTURE_PR }], (shim) => withLiveWritesAllowed(async () => {
    const r = planReconcileCadence(cadence);
    await landing.settled();
    return { report: r, calls: shim.calls() };
  }));
  // The shim records `gh pr create`'s joined argv, so the body's last line runs on into `--repo o/r`.
  const proof = calls.find((line) => line.startsWith(`- ${T9958} `))?.split(" | ")[1]?.replace(/ --repo \S+$/, "");
  return { w, kind, report, results, events, proof };
}

async function assertSharedFileLandsWithTheRealPreflight(t: TestContext, credited: readonly string[]): Promise<void> {
  const { w, kind, report, results, events, proof } = await landSharedFile(t, credited);
  const label = `crediting ${credited.join(" and ")}`;
  assert.deepEqual(report.taskIds, credited, `${label}: ${JSON.stringify(report)}`);
  assert.equal(results.length, 1, label);
  assert.equal(results[0].landed, true, `${label}: ${results[0].error}`);
  assert.equal(results[0].refused, undefined, `THE CLAIM (${label}): the default preflight does not refuse the batch`);
  assert.equal(results[0].error, undefined, label);
  assert.deepEqual(results[0].files, [T9958], label);
  assert.ok(events.some((e) => e.step === "plan_pr.check_proof_child"), `${label}: the default preflight launched check-proof`);
  assert.equal(events.some((e) => e.step === "plan_pr.preflight_refused"), false, `${label}: ${JSON.stringify(events)}`);
  const unreadable = events.filter((e) => e.step === "plan_pr.preflight_unreadable")
    .flatMap((e) => (e.extra?.unreadable as Array<{ check: string; firstLine: string }> | undefined) ?? []);
  assert.deepEqual(unreadable.filter((u) => u.check === "proof-discrimination"), [], `${label}: check-proof judged every PR-body proof`);

  const baseText = w.origin.git("show", `${w.main}:${T9958}`);
  const landedText = w.origin.git("show", `${BRANCH}:${T9958}`);
  assert.deepEqual(statuses(landedText), { "W1-T9958": "merged", "W1-T9959": "merged", "W1-T9960": credited.length === 2 ? "merged" : "queued" }, label);
  // The fixture's git helper trims stdout, so both blobs are compared without their final newline.
  assert.equal(baseText, T9958_TEXT.trimEnd(), label);
  assert.equal(landedText, (record("W1-T9958", "merged") + record("W1-T9959", "merged") + record("W1-T9960", credited.length === 2 ? "merged" : "queued")).trimEnd(),
    `${label}: no other byte changes and every status line stays a pure flip`);
  assert.equal(planReconcileStatusLineCount(landedText, "merged"), planReconcileStatusLineCount(baseText, "merged") + credited.length,
    `${label}: positive control, the landing adds one merged status line per credited flip`);
  assert.equal(proof, `\`grep -aPzc "(?:\\n  status: merged(?=\\n)[\\s\\S]*?){${1 + credited.length}}" ${T9958}\``,
    `${label}: the PR body carries the file's merged status-line count proof`);

  // The proof the PR body carries, judged by the real check-proof: pass at the landed head, fail at its base.
  const judge = gitRepo({ scope: t, cloneFrom: w.origin.dir, kind: `${kind}-judge` });
  judge.git("checkout", "--quiet", "--detach", `origin/${BRANCH}`);
  const atHead = checkProof(judge.dir, proof!);
  assert.equal(atHead.code, 0, `${label}: ${atHead.out}`);
  assert.match(atHead.out, /^discrimination: discriminates/m, label);
  // Negative control: the line proof this replaces passes at base too, which is what refused the batch.
  const lineProof = checkProof(judge.dir, planReconcileProofTemplate(T9958));
  assert.equal(lineProof.code, 5, `${label}: ${lineProof.out}`);
  assert.match(lineProof.out, /^discrimination: executed_stale/m, label);
  judge.git("checkout", "--quiet", "--detach", "origin/main");
  const atBase = checkProof(judge.dir, proof!, false);
  assert.equal(atBase.code, 1, `${label}: the count proof fails at base: ${atBase.out}`);
  assert.match(atBase.out, /^verdict:\s+fail\b/m, label);
}

test("W1-T15048 criterion 1: every record of a shared shard lands in one composed input", async (t) => {
  const { root, dir } = fixturePlanDir(t);
  const before = readFileSync(join(dir, SHARED), "utf8");
  const linted: Array<{ only: string[]; status: Record<string, string | undefined> }> = [];
  const lint: PlanReconcileLint = (plan, only) => {
    linted.push({ only: [...only].sort(), status: Object.fromEntries(plan.tasks.filter((task) => only.has(task.id)).map((task) => [task.id, task.status])) });
    return new Map();
  };
  const landed: Array<Array<{ relPath: string; content: string; edit?: (current: string) => string | undefined }>> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: root,
    readShards: () => readPlanShards(dir),
    creditedMergedIds: () => new Set(["W1-T1", "W1-T4", "W1-T5", "W1-T6"]),
    land: (inputs) => { landed.push([...inputs]); },
    lint,
  });
  const result = planReconcileCadence(opts);

  assert.equal(result.status, "landed", JSON.stringify(result));
  assert.deepEqual([...result.taskIds].sort(), ["W1-T1", "W1-T5", "W1-T6"], "THE CLAIM: both queued records of the shared file are flipped");
  assert.equal(landed.length, 1, "one landing");
  const inputs = landed[0];
  const shared = inputs.filter((input) => input.relPath === relative(root, join(dir, SHARED)));
  assert.equal(shared.length, 1, `THE CLAIM: the shared file lands as ONE input: ${inputs.map((i) => i.relPath).join(" ")}`);
  assert.equal(inputs.length, 2, "positive control: the lone record's file lands beside it");
  assert.deepEqual(statuses(shared[0].content), { "W1-T4": "merged", "W1-T5": "merged", "W1-T6": "merged" },
    "THE CLAIM: the composed text carries every flip of the file");
  assert.equal(shared[0].content, before.replace(/^  status: queued$/gm, () => "  status: merged"), "no other byte of the file changes and each status flip stays pure");
  const lintRecordsBefore = record("W1-T7", "queued") + record("W1-T8", "queued");
  const lintRecordsAfter = record("W1-T7", "merged") + record("W1-T8", "merged");
  assert.deepEqual(statusFlipOnlyTaskIds([lintRecordsBefore], [lintRecordsAfter]), new Set(["W1-T7", "W1-T8"]),
    "the lint-plan status-only carve recognizes every pure shared-file flip, preserving the old-debt exemption");
  assert.equal(shared[0].edit?.(before), shared[0].content, "the landing's edit composes the same flips onto main's current text");
  const edit = shared[0].edit!;
  const mainMoved = before.replace("- id: W1-T5\n  title: \"fixture W1-T5\"", "- id: W1-T5\n  title: \"main retitled W1-T5\"");
  assert.deepEqual(statuses(edit(mainMoved)!), { "W1-T4": "merged", "W1-T5": "merged", "W1-T6": "merged" },
    "the edit keeps what main changed and still flips every record");
  assert.match(edit(mainMoved) ?? "", /main retitled W1-T5/);

  assert.equal(linted.length, 2, "the lint hold reads the plan before and after the flips");
  assert.deepEqual(linted[1].only, ["W1-T1", "W1-T5", "W1-T6"], "THE CLAIM: the lint hold checks every record the composed text flips");
  assert.deepEqual(linted[1].status, { "W1-T1": "merged", "W1-T5": "merged", "W1-T6": "merged" }, "THE CLAIM: the lint hold reads the composed text in full");
  assert.deepEqual(linted[0].status, { "W1-T1": "queued", "W1-T5": "queued", "W1-T6": "queued" }, "positive control: before the flips they read queued");

  // THE CLAIM, landed for real: W1-T9958's shape, either or both queued records credited, through the default
  // lander and its default preflight (feedback-landing's landContentAsync), judged by the real check-proof --base.
  await assertSharedFileLandsWithTheRealPreflight(t, ["W1-T9959"]);
  await assertSharedFileLandsWithTheRealPreflight(t, ["W1-T9959", "W1-T9960"]);
});

test("W1-T15048: real lint-plan exempts pure shared status flips with old debt", (t) => {
  const repo = gitRepo({ scope: t, kind: "t15048-lint-plan" });
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "plan/policy.yaml"), join(repo.dir, "plan/policy.yaml"));
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  const debtRecord = (id: string, status: string) => [
    `- id: ${id}`, `  title: "shared lint fixture ${id}"`, "  repo: remudero", "  depends_on: []",
    "  type: implement", "  design: |", "    NO-INVARIANTS: old lint debt fixture", "  verify: auto",
    "  priority: 1", "  risk: low", `  status: ${status}`, "  attempts: 0", "  budget_usd: 1",
    '  origin: "test-fixture:t15048"', "  files: [src/x.ts]", "  acceptance:", '    - claim: "existing debt"',
    '      proof: "free prose that lint-plan rejects"', "",
  ].join("\n");
  const sharedPath = "plan/tasks.d/W1-T7-shared.yaml";
  writeFileSync(join(repo.dir, sharedPath), debtRecord("W1-T7", "merged") + debtRecord("W1-T8", "queued") + debtRecord("W1-T9", "queued"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base with pre-existing lint debt");
  const base = repo.git("rev-parse", "HEAD");

  writeFileSync(join(repo.dir, sharedPath), debtRecord("W1-T7", "merged") + debtRecord("W1-T8", "merged") + debtRecord("W1-T9", "merged"));
  repo.git("add", sharedPath);
  repo.git("commit", "-qm", "pure shared status flips");
  const lint = () => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), "--repo-root", repo.dir, "--base", base], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LANG: "C", TZ: "UTC" },
  });
  const statusOnly = lint();
  assert.equal(statusOnly.error, undefined, "the real lint-plan child completes");
  assert.equal(statusOnly.status, 0, `${statusOnly.stdout}${statusOnly.stderr}`);
  assert.match(`${statusOnly.stdout}${statusOnly.stderr}`, /rmd lint-plan: 0 task\(s\) checked/);

  writeFileSync(join(repo.dir, sharedPath), debtRecord("W1-T7", "merged") + debtRecord("W1-T8", "merged").replace("shared lint fixture W1-T8", "changed shared lint fixture W1-T8") + debtRecord("W1-T9", "merged"));
  repo.git("add", sharedPath);
  repo.git("commit", "--no-verify", "-qm", "positive control changes a debt record");
  const positive = lint();
  assert.equal(positive.error, undefined, "the positive-control lint child completes");
  assert.notEqual(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  assert.match(`${positive.stdout}${positive.stderr}`, /proof-dialect/, `${positive.stdout}${positive.stderr}`);
});

test("W1-T15048: a blocking rule one record of a shared file gains holds the file's whole write", (t) => {
  const { root, dir } = fixturePlanDir(t);
  const lint: PlanReconcileLint = (plan, only) => new Map([...only].flatMap((id) => {
    const task = plan.tasks.find((x) => x.id === id);
    return id === "W1-T6" && task?.status === "merged"
      ? [[id, { violations: [{ check: "fixture-rule", severity: "block" }] }] as never] : [];
  }));
  const landed: string[][] = [];
  const result = planReconcileCadence(buildPlanReconcileCadenceInput({
    checkoutRoot: root,
    readShards: () => readPlanShards(dir),
    creditedMergedIds: () => new Set(["W1-T1", "W1-T5", "W1-T6"]),
    land: (inputs) => { landed.push(inputs.map((input) => input.relPath)); },
    lint,
  }));
  assert.deepEqual(result.held, [{ taskId: "W1-T6", rule: "fixture-rule" }], JSON.stringify(result));
  assert.deepEqual(landed, [[relative(root, join(dir, "W1-T1-alone.yaml"))]], "the shared file is held whole and the lone record still lands");
});

test("W1-T15048: a re-queue into a file that already holds a queued record carries a count proof check-proof discriminates", (t) => {
  // The class, not the probe: any pure flip whose landed lines all exist at base, here a W1-T14302 re-queue.
  const path = "plan/tasks.d/W1-T20-holds-two.yaml";
  const baseText = record("W1-T20", "queued") + record("W1-T21", "merged");
  const headText = record("W1-T20", "queued") + record("W1-T21", "queued");
  const proof = planReconcileStatusCountProof(path, baseText, headText);
  assert.equal(proof, `\`grep -aPzc "(?:\\n  status: queued(?=\\n)[\\s\\S]*?){2}" ${path}\``);
  assert.equal(planReconcileStatusCountProof(path, baseText, baseText), undefined, "no status gains a line: no count proof");
  assert.equal(planReconcileStatusCountProof(path, undefined, headText), undefined, "a new path keeps its template proof");
  assert.equal(planReconcileStatusCountProof("plan/tasks.d/a b.yaml", baseText, headText), undefined, "a path that is not one argv token");
  assert.equal(planReconcileStatusLineCount(`${record("W1-T22", "merged")}    status: merged\n  status: merged `, "merged"), 1,
    "only a whole two-space status line between newlines counts, as the proof's pattern does");

  const repo = gitRepo({ scope: t, kind: "t15048-requeue" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, path), baseText);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, path), headText);
  repo.git("commit", "--quiet", "-am", "re-queue W1-T21");
  const atHead = checkProof(repo.dir, proof!);
  assert.equal(atHead.code, 0, atHead.out);
  assert.match(atHead.out, /^discrimination: discriminates/m);
  const lineProof = checkProof(repo.dir, `grep: ^  status: queued$ in ${path}`);
  assert.equal(lineProof.code, 5, `negative control: the line proof passes at base too: ${lineProof.out}`);
});

test("W1-T15048: a shared flip is a pure status edit and is never flipped twice", () => {
  const flipped = reconcileRecordStatus(record("W1-T4", "merged") + record("W1-T5", "queued"), "W1-T5", () => true).text!;
  assert.match(flipped, /^ {2}status: merged$/m);
  assert.equal(reconcileRecordStatus(flipped, "W1-T5", () => true).skipped, "status-not-queued", "a marked record reads merged, so it is never flipped twice");
  assert.equal(reconcileRecordStatus(record("W1-T4", "merged") + record("W1-T5", "queued") + "", "W1-T6", () => true).skipped, "no-status-field", "an id the file does not hold is left alone");
});
