import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { CHECK_PROOF_EXIT, checkProofChildArgv } from "#src/lib/check-proof.js";
import { landingIdentity, landPlanReconcileShards, planReconcileLanding, type LandFeedbackResult, type LandingRepository, type PlanReconcileLand } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type PlanReconcileLint } from "#src/lib/measurement-cadence.js";
import { SHARED_FLIP_MARK_RE, readPlanShards, reconcileRecordStatus, sharedFlipMark } from "#src/lib/plan-reconcile.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/**
 * W1-T15048. A file of plan/tasks.d can hold several records (W1-T9958's file holds W1-T9959 and W1-T9960). The
 * cadence landed one write per record keyed to the shared path, so the last flip of the file won, and the lint hold
 * mapped the path to its last record only. W1-T11183 (#21054) then skipped such files. Every flip of one file is now
 * composed into one replacement text, landed as one input, and that composed text is what the lint hold checks.
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

test("W1-T15048 criterion 1: every record of a shared shard lands in one composed input", (t) => {
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
  assert.equal(shared[0].content, before.replace(/^ {2}status: queued$/gm, () => "  status: merged").replace(/^(- id: W1-T5\n(?: {2}.*\n)*? {2}status: merged)$/m, `$1${sharedFlipMark("W1-T5")}`)
    .replace(/^( {2}status: merged)(\n {2}id: W1-T6)$/m, `$1${sharedFlipMark("W1-T6")}$2`), "no other byte of the file changes but each flip's own mark");
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

// The real landing, with the proof its PR body carries checked by the real `rmd check-proof --base` at the landed tree.
const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t15048-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const FIXTURE_PR = "https://github.com/o/r/pull/15048";
// Shaped like W1-T9958's file: the first record already reads merged, the other two are queued.
const T9958 = "plan/tasks.d/W1-T9958-holds-three.yaml";
const T9958_TEXT = record("W1-T9958", "merged") + record("W1-T9959", "queued") + record("W1-T9960", "queued");

function sharedFileWorld(kind: string): { origin: ReturnType<typeof gitRepo>; main: string; reader: string } {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  for (const [path, text] of Object.entries({ "plan/tasks.yaml": "[]\n", [T9958]: T9958_TEXT, "src/x.ts": "export const x = 1;\n" })) {
    mkdirSync(dirname(join(seed.dir, path)), { recursive: true });
    writeFileSync(join(seed.dir, path), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "base");
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  return { origin, main: seed.git("rev-parse", "HEAD"), reader: gitRepo({ cloneFrom: origin.dir, kind: `${kind}-reader` }).dir };
}

/** `rmd check-proof <proof> --base <base>` run at `ref`, as the landing's preflight runs it. */
function checkProofAt(originDir: string, ref: string, proof: string, base: string, kind: string): number | null {
  const at = gitRepo({ cloneFrom: originDir, kind });
  at.git("checkout", "--quiet", "--detach", at.git("rev-parse", "--verify", `${ref.length === 40 ? ref : `origin/${ref}`}^{commit}`));
  const run = spawnSync(process.execPath, checkProofChildArgv(proof, base), { cwd: at.dir, encoding: "utf8", env: { ...process.env, RMD_SELF_SYNC_DONE: "1" } });
  return run.status;
}

async function reconcileShared(kind: string, credited: readonly string[]) {
  const w = sharedFileWorld(kind);
  const results: LandFeedbackResult[] = [];
  const bodies: string[] = [];
  const lander: PlanReconcileLand = (root, batch, landOpts) => {
    const landed = landPlanReconcileShards(root, batch, { ...landOpts, planPrPreflight: (_sha, pr) => (bodies.push(pr.body), { ok: true, failures: [], unreadable: [] }) });
    results.push(landed);
    return landed;
  };
  const landing = planReconcileLanding(w.reader, () => ({ targetRepository: TARGET, landingOwner: OWNER }), lander);
  const cadence = buildPlanReconcileCadenceInput({
    checkoutRoot: w.reader,
    readShards: () => readPlanShards(join(w.reader, "plan", "tasks.d")),
    creditedMergedIds: () => new Set(["W1-T9958", ...credited]),
    land: landing.land,
  });
  const report = await withGhShim([{ when: "pr list", stdout: "[]" }, { when: "pr create", stdout: FIXTURE_PR }], () => withLiveWritesAllowed(async () => {
    const r = planReconcileCadence(cadence);
    await landing.settled();
    return r;
  }));
  const proof = bodies.at(-1)?.split("\n").find((line) => line.startsWith(`- ${T9958} `))?.split(" | ")[1];
  return { w, report, results, proof };
}

for (const credited of [["W1-T9959"], ["W1-T9959", "W1-T9960"]]) {
  test(`W1-T15048: a shared file whose first record already reads merged lands a proof that fails at main (crediting ${credited.join(" and ")})`, async () => {
    const kind = `t15048-${credited.length}`;
    const { w, report, results, proof } = await reconcileShared(kind, credited);
    assert.deepEqual(report.taskIds, credited, JSON.stringify(report));
    assert.equal(results.length, 1);
    assert.equal(results[0].landed, true, results[0].error);
    assert.equal(results[0].refused, undefined, "THE CLAIM: the batch is not refused");
    assert.deepEqual(results[0].files, [T9958]);
    const landedText = w.origin.git("show", `${BRANCH}:${T9958}`);
    assert.deepEqual(statuses(landedText), { "W1-T9958": "merged", "W1-T9959": "merged", "W1-T9960": credited.length === 2 ? "merged" : "queued" });
    assert.ok(proof !== undefined, "the PR body carries the shared file's proof");
    assert.match(proof!, /^grep: \^ {2}status: merged # plan reconcile: W1-T9959 credited\$ in /, `the proof is the flip's own status line: ${proof}`);
    assert.equal(checkProofAt(w.origin.dir, BRANCH, proof!, w.main, `${kind}-head`), CHECK_PROOF_EXIT.pass,
      "THE CLAIM: the real check-proof passes at the landing and fails at main, so it discriminates");
    assert.equal(checkProofAt(w.origin.dir, w.main, proof!, w.main, `${kind}-base`), CHECK_PROOF_EXIT.fail, "positive control: at main the proof fails");
  });
}

test("W1-T15048: a marked flip reads as merged again, and only the reconciler's own mark is read past", () => {
  assert.equal(SHARED_FLIP_MARK_RE.test(`  status: merged${sharedFlipMark("W1-T5")}`), true, "the mark after a merged status is the reconciler's");
  assert.equal(SHARED_FLIP_MARK_RE.test(`  status: queued${sharedFlipMark("W1-T5")}`), false, "a mark on a queued line is not read past");
  assert.equal(SHARED_FLIP_MARK_RE.test("  status: merged # someone's own note"), false, "another comment is not the mark");
  const flipped = reconcileRecordStatus(record("W1-T4", "merged") + record("W1-T5", "queued"), "W1-T5", () => true).text!;
  assert.match(flipped, /^ {2}status: merged # plan reconcile: W1-T5 credited$/m);
  assert.equal(reconcileRecordStatus(flipped, "W1-T5", () => true).skipped, "status-not-queued", "a marked record reads merged, so it is never flipped twice");
  assert.equal(reconcileRecordStatus(record("W1-T4", "merged") + record("W1-T5", "queued") + "", "W1-T6", () => true).skipped, "no-status-field", "an id the file does not hold is left alone");
});
