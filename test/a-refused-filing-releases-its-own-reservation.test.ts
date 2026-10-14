import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { prepareGardenTaskIds, runGarden, runGardenAsync, type GardenCheckout, type GardenerDeps, type GardenSpec, type GardenTaskIdMinter } from "../src/lib/gardener.js";
import { fileConsumerVia } from "../src/lib/host-resource-gardener.js";
import { RESERVATION_RELEASED_STEP, RESERVATION_RELEASE_SKIPPED_STEP, releaseTaskIdReservation, releaseTaskIdReservationAsync } from "../src/lib/task-id-release.js";
import { gitRemoteRefReserver, gitReservationRunnerAsync, reserveTaskIdRemote, taskIdReservationRef } from "../src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ciLearningTaskIdMinter } from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

// A filing that a gate refuses before any branch or PR carries its id gives the id's
// refs/rmd-id ref back — leased on the sha THIS run pushed, so no other writer's claim is touched.

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

type Row = { step: string; fields: Record<string, unknown> };

function realGit(cwd: string) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return Object.assign(run, { calls });
}

/** A bare origin, a filer clone that reserves W1-T<n> on it, and a SECOND clone that never saw the anchor object. */
function reservedOn(kind: string, n: number) {
  const origin = gitRepo({ bare: true, kind: `rmd-release-${kind}-origin` });
  const filer = gitRepo({ cloneFrom: origin.dir, kind: `rmd-release-${kind}-filer` });
  const other = gitRepo({ cloneFrom: origin.dir, kind: `rmd-release-${kind}-other` });
  const reserver = gitRemoteRefReserver({ run: realGit(filer.dir), filingBranch: `scout-garden-${kind}` });
  const won = reserveTaskIdRemote(n, reserver);
  assert.equal(won.taskId, `W1-T${n}`);
  const sha = reserver.wonAnchor!(won.taskId)!;
  assert.equal(origin.git("rev-parse", won.ref), sha, "positive control: the claim is on origin");
  return { origin, filer, other, taskId: won.taskId, ref: won.ref, sha };
}

const refOn = (origin: GitRepo, ref: string) => origin.git("for-each-ref", "--format=%(objectname)", ref);

test("a refused filing releases its own reservation ref and ledgers task_id.reservation_released with the reason", () => {
  const r = reservedOn("own", 9601);
  const rows: Row[] = [];
  const run = realGit(r.other.dir);
  const outcome = releaseTaskIdReservation(run, { taskId: r.taskId, sha: r.sha }, {
    reason: "scout gardener: drafted shard failed lint-plan's machine-filing admission", lane: "garden", log: (step, fields) => void rows.push({ step, fields }),
  });
  assert.equal(outcome, "released");
  assert.equal(refOn(r.origin, r.ref), "", "the ref is gone from origin");
  assert.deepEqual(rows, [{ step: RESERVATION_RELEASED_STEP, fields: {
    reserved_id: r.taskId, ref: r.ref, sha: r.sha, lane: "garden", outcome: "released",
    reason: "scout gardener: drafted shard failed lint-plan's machine-filing admission",
  } }]);
  const push = run.calls.find((c) => c[0] === "push");
  assert.deepEqual(push, ["push", `--force-with-lease=${r.ref}:${r.sha}`, "origin", `:${r.ref}`], "the delete is leased on the pushed sha");

  // Idempotent: a second release reads the absence and pushes nothing.
  const again = realGit(r.other.dir);
  assert.equal(releaseTaskIdReservation(again, { taskId: r.taskId, sha: r.sha }, { reason: "again", lane: "garden" }), "already_absent");
  assert.deepEqual(again.calls.filter((c) => c[0] === "push"), []);
});

test("a reservation release never deletes a claim another writer has since re-recorded", async () => {
  const r = reservedOn("foreign", 9611);
  const foreign = r.other.git("commit-tree", r.other.git("hash-object", "-t", "tree", "/dev/null"), "-m", "rmd-id reservation 1@other-host taken over");
  r.other.git("push", "-q", "--force", "origin", `${foreign}:${r.ref}`);
  const rows: Row[] = [];
  const outcome = await releaseTaskIdReservationAsync(gitReservationRunnerAsync(r.filer.dir), { taskId: r.taskId, sha: r.sha }, {
    reason: "refused", lane: "garden", log: (step, fields) => void rows.push({ step, fields }),
  });
  assert.equal(outcome, "foreign");
  assert.equal(refOn(r.origin, r.ref), foreign, "the other writer's claim survives");
  assert.equal(rows[0]?.step, RESERVATION_RELEASE_SKIPPED_STEP);
  assert.equal(rows[0]?.fields.outcome, "foreign");
});

test("a reservation release is leased, so a claim moved between its read and its push survives", () => {
  const r = reservedOn("race", 9621);
  const base = realGit(r.other.dir);
  let moved = "";
  const run = (args: string[]) => {
    if (args[0] === "push" && !moved) {
      moved = r.other.git("commit-tree", r.other.git("hash-object", "-t", "tree", "/dev/null"), "-m", "rmd-id reservation 2@racer");
      r.other.git("push", "-q", "--force", "origin", `${moved}:${r.ref}`);
    }
    return base(args);
  };
  const outcome = releaseTaskIdReservation(run, { taskId: r.taskId, sha: r.sha }, { reason: "refused", lane: "garden" });
  assert.equal(outcome, "foreign");
  assert.equal(refOn(r.origin, r.ref), moved, "the lease refused the delete of a ref that moved");
});

test("a garden minter releases exactly the reservation it pushed", async () => {
  const origin = gitRepo({ bare: true, kind: "rmd-release-minter-origin" });
  const work = gitRepo({ cloneFrom: origin.dir, kind: "rmd-release-minter-work" });
  work.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  work.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  mkdirSync(join(work.dir, "plan"), { recursive: true });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "[]\n");
  work.git("add", "plan/tasks.yaml");
  work.git("commit", "-q", "-m", "plan");
  work.git("push", "-q", "origin", "HEAD:refs/heads/main");
  const rows: Row[] = [];
  const mint = ciLearningTaskIdMinter(work.dir, (step, fields) => void rows.push({ step, fields }));
  const first = mint("scout-garden-minter");
  const second = mint("scout-garden-minter");
  assert.equal(refOn(origin, taskIdReservationRef(first)), mint.heldSha(first));
  mint.release!(first, "scout gardener: the landing's PR did not open");
  await mint.releaseAsync!(second, "scout gardener: the landing's PR did not open");
  assert.equal(refOn(origin, taskIdReservationRef(first)), "");
  assert.equal(refOn(origin, taskIdReservationRef(second)), "");
  assert.deepEqual(rows.filter((r) => r.step === RESERVATION_RELEASED_STEP).map((r) => [r.fields.reserved_id, r.fields.outcome]), [[first, "released"], [second, "released"]]);
  mint.release!(first, "twice");
  assert.equal(rows.filter((r) => r.step.startsWith("task_id.reservation_release")).length, 2, "a released id is forgotten, never released twice");
});

const PR = "https://github.com/acme/remudero/pull/7";
const action = { class: "file" as const, target: "fixture", reason: "file the remedy" };

function gardenFixture(t: { after: (fn: () => void) => void }, land: GardenCheckout["land"]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-release-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const released: Array<[string, string]> = [];
  const mint: GardenTaskIdMinter = Object.assign(() => "W1-T9631", {
    release: (id: string, reason: string) => void released.push([id, reason]),
    releaseAsync: async (id: string, reason: string) => void released.push([id, reason]),
  });
  const ws: GardenCheckout = { root, branch: "scout-garden-fixture", land, dispose: () => {} };
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: join(root, "state"), clock: fixedClock(Date.now()), seed: 1,
    openWorkspace: () => ws, mergedPlanLint: () => undefined, log: () => {},
  };
  const spec: GardenSpec<"file", number, typeof action, GardenCheckout> = {
    name: "release-fixture", classes: ["file"], cheapFingerprint: () => "cheap", inventory: () => 1,
    fingerprint: () => "full", metric: () => ({ trials: 0, successes: 0 }), candidates: () => [action], scorecard: () => ({}),
    prepare: (w, plan, async) => prepareGardenTaskIds(w, plan.actions.length, mint, async),
    apply: (w, _plan, _card, ids) => {
      writeFileSync(join(w.root, "change.txt"), ids![0]!);
      return { paths: ["change.txt"], title: "chore(plan): file fixture", body: "fixture" };
    },
  };
  return { deps, spec, released, root };
}

test("a garden filing refused before its PR opens releases the ids it reserved, and an opened one keeps them", async (t) => {
  const notOpened = gardenFixture(t, () => undefined);
  runGarden(notOpened.spec, notOpened.deps);
  assert.equal(notOpened.released.length, 1);
  assert.equal(notOpened.released[0]![0], "W1-T9631");
  assert.match(notOpened.released[0]![1], /release-fixture gardener: .*PR did not open/);

  const guarded = gardenFixture(t, () => PR);
  guarded.spec.landingRefusal = () => "fixture admission refusal";
  await runGardenAsync(guarded.spec, guarded.deps);
  assert.match(guarded.released[0]?.[1] ?? "", /machine-filing admission \(fixture admission refusal\)/);

  const linted = gardenFixture(t, () => PR);
  linted.deps.mergedPlanLint = () => ({ file: "plan/tasks.d/x.yaml", message: "duplicate id" });
  runGarden(linted.spec, linted.deps);
  assert.match(linted.released[0]?.[1] ?? "", /merged-plan lint refused plan\/tasks.d\/x.yaml: duplicate id/);

  const opened = gardenFixture(t, () => PR);
  assert.equal(runGarden(opened.spec, opened.deps).prUrl, PR);
  assert.deepEqual(opened.released, [], "an opened PR carries its id");

  const threw = gardenFixture(t, () => { throw new Error("pr create failed after the push"); });
  runGarden(threw.spec, threw.deps);
  assert.deepEqual(threw.released, [], "a landing that threw may have pushed, so its id is kept");
});

test("a host-resource filing whose PR does not open releases its reserved id", async (t) => {
  const f = gardenFixture(t, () => undefined);
  const mint: GardenTaskIdMinter = Object.assign(() => "W1-T9641", {
    release: (id: string, reason: string) => void f.released.push([id, reason]),
  });
  mkdirSync(join(f.root, "deploy"), { recursive: true });
  writeFileSync(join(f.root, "deploy", "rmd-host-cleanup.sh"), "# fixture\n");
  const ws: GardenCheckout = { root: f.root, branch: "host-resource-garden-fixture", land: () => undefined, dispose: () => {} };
  const url = await fileConsumerVia(() => ws, mint)({ host: "azure", device: "root", consumer: "worktrees", origin: "host-resource:azure:worktrees",
    attribution: { consumer: "worktrees", growthKbPerHour: 800000, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 } });
  assert.equal(url, undefined);
  assert.deepEqual(f.released.map(([id]) => id), ["W1-T9641"]);
  assert.match(f.released[0]![1], /^host-resource gardener: /);
});
