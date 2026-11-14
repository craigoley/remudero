import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { landTaskFilesAsync, taskFilesLandingBranchAsync, type LandTaskFilesOpts, type TaskFileInput } from "#src/lib/feedback-landing.js";
import { isGardenLandWaiting, prepareGardenTaskIds, type GardenTaskIdMinter } from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { gardenCheckoutAsync } from "#test/helpers/run-task-test.js";

const TARGET = { owner: "acme", repo: "remudero" };
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "fixture refusal" }], unreadable: [] };
const TIMEOUT: PlanPrPreflightResult = { ...GREEN, timedOut: [{ check: "proof-discrimination", firstLine: "fixture timeout" }] };
const pathOf = (id: string) => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string, note = "") => `- id: ${id}\n  repo: remudero\n  origin: fixture:${id}\n  note: ${note}\n`;
const input = (id: string): TaskFileInput => ({
  relPath: pathOf(id), content: shard(id), newFile: true,
  claim: `the task ${id} is filed`, proof: `grep: id: ${id} in ${pathOf(id)}`,
});
type Row = { step: string } & Record<string, unknown>;

function world(t: TestContext, planDir = "plan") {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w1-t12456-"));
  const origin = gitRepo({ scope: t, bare: true, kind: "staging-origin" });
  const author = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "staging-author" });
  const commit = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(author.dir, path, ".."), { recursive: true });
      writeFileSync(join(author.dir, path), content);
    }
    author.git("add", "-A");
    author.git("commit", "--quiet", "-m", "chore: seed fixture");
    author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  };
  commit({
    [`${planDir}/tasks.yaml`]: "[]\n", [`${planDir}/tasks.d/W1-T90001-fixture.yaml`]: shard("W1-T90001"), "world.txt": stateRoot,
    ...(planDir === "plan" ? {} : { ".remudero/layout.json": JSON.stringify({ planDir }) }),
  });
  const repo = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "staging-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const rows: Row[] = [];
  const log = (step: string, fields: Record<string, unknown> = {}) => void rows.push({ step, ...fields });
  const verdicts = new Map<string, PlanPrPreflightResult>();
  const gh = { open: [{ url: "https://github.com/acme/remudero/pull/8000" }] };
  const options: LandTaskFilesOpts = {
    stateRoot, targetRepository: TARGET, log,
    gh: () => JSON.stringify(gh.open),
    planPrPreflight: async (_sha, pr) => [...verdicts].find(([id]) => pr.body.includes(`id: ${id} in`))?.[1] ?? GREEN,
  };
  const anchor = (id: string, branch: string, message?: string) => {
    const tree = author.git("rev-parse", "HEAD^{tree}");
    const sha = origin.git("commit-tree", tree, "-m", message ?? formatReservationAnchorMessage({ branch, startedAt: "2026-11-13T00:00:00Z" }));
    origin.git("update-ref", taskIdReservationRef(id), sha);
    return sha;
  };
  const refSha = (id: string) => origin.git("for-each-ref", "--format=%(objectname)", taskIdReservationRef(id));
  return {
    stateRoot, repo, rows, options, verdicts, anchor, refSha, commit,
    land: (inputs: TaskFileInput[]) => withLiveWritesAllowed(() => landTaskFilesAsync(repo.dir, inputs, options)),
  };
}

type World = ReturnType<typeof world>;

async function file(w: World) {
  const released: string[] = [];
  let count = 0;
  const mint = Object.assign((branch: string) => {
    const id = `W1-T${95001 + count++}`;
    w.anchor(id, branch);
    return id;
  }, { releaseAsync: async (id: string) => void released.push(id) }) as GardenTaskIdMinter;
  const ws = await gardenCheckoutAsync({
    name: "scout", repoDir: w.repo.dir, worktreesRoot: join(w.stateRoot, "worktrees"),
    owner: TARGET.owner, repo: TARGET.repo, taskFilesOnly: true, taskFilesLanding: w.options,
    log: w.options.log!, preflight: () => GREEN,
    fetcher: async () => ({ html_url: "https://github.com/acme/remudero/pull/1", number: 1 }),
  });
  try {
    const ids = await prepareGardenTaskIds(ws, 2, mint, true);
    const inputs = ids.map(input);
    for (const i of inputs) writeFileSync(join(ws.root, i.relPath), i.content);
    w.verdicts.set(ids[0]!, RED);
    const body = `File tasks.\n\n## Acceptance\n${inputs.map((i) => `- claim: ${i.claim}\n  proof: ${i.proof}`).join("\n")}`;
    const result = await withLiveWritesAllowed(() => ws.land({ paths: inputs.map((i) => i.relPath), title: "chore(plan): file tasks", body }));
    return { ids, result, released };
  } finally {
    await ws.dispose();
  }
}

test("W1-T12456 criterion 1: a partial staging refusal releases only the refused new file's id", async (t) => {
  const w = world(t);
  const { ids: [refused, kept], result, released } = await file(w);
  assert.ok(isGardenLandWaiting(result));
  assert.deepEqual(result.waiting.paths, [pathOf(kept!)]);
  assert.equal(w.refSha(refused!), "");
  assert.notEqual(w.refSha(kept!), "");
  assert.deepEqual(released, [], "the gardener keeps ids while part of the filing waits");
});

test("W1-T12456 criterion 2: preflight and prior-byte refusals release ids; a timeout keeps its id", async (t) => {
  const w = world(t);
  const branch = await taskFilesLandingBranchAsync(TARGET);
  const red = "W1-T95011", prior = "W1-T95012", timeout = "W1-T95013", mixed = "W1-T95014";
  for (const id of [red, prior, timeout, mixed]) w.anchor(id, branch);
  w.verdicts.set(red, RED);
  w.verdicts.set(timeout, TIMEOUT);
  w.verdicts.set(mixed, { ...RED, timedOut: TIMEOUT.timedOut });
  const refusedPath = join(w.stateRoot, "state/task-files-landing-refused", pathOf(prior));
  mkdirSync(join(refusedPath, ".."), { recursive: true });
  writeFileSync(refusedPath, shard(prior));
  writeFileSync(`${refusedPath}.meta.json`, JSON.stringify({ reason: "a prior preflight refused it" }));
  const result = await w.land([red, prior, timeout, mixed].map(input));
  assert.deepEqual(result.refused.map((r) => r.path), [red, prior, timeout, mixed].map(pathOf));
  assert.deepEqual(result.refused.slice(0, 2).map((r) => [r.reserved_id, r.id_release]), [[red, "released"], [prior, "released"]]);
  assert.equal(w.refSha(red), "");
  assert.equal(w.refSha(prior), "");
  assert.notEqual(w.refSha(timeout), "");
  assert.equal(result.refused[2]?.timedOut, true);
  assert.equal(result.refused[2]?.id_release, undefined);
  assert.notEqual(w.refSha(mixed), "", "a timeout in a verdict with another failed check also keeps its id");
  assert.equal(result.refused[3]?.timedOut, true);
  assert.equal(result.refused[3]?.id_release, undefined);
  const repeated = await w.land([input(red), input(prior)]);
  assert.deepEqual(repeated.refused.map((r) => r.id_release), ["already_absent", "already_absent"]);
});

test("W1-T12456 criterion 3: another holder, an unreadable anchor and an edit of main release nothing", async (t) => {
  const w = world(t);
  const branch = await taskFilesLandingBranchAsync(TARGET);
  const other = "W1-T95021", unreadable = "W1-T95022", edit = "W1-T90001";
  const otherSha = w.anchor(other, "another-branch");
  const unreadableSha = w.anchor(unreadable, branch);
  const editSha = w.anchor(edit, branch);
  w.options.gitAsync = async (args, opts) => {
    if (args[0] === "log" && args.includes(unreadableSha)) throw new Error("cannot read the anchor");
    return execFileSync("git", ["-C", w.repo.dir, ...args], { encoding: "utf8", env: opts?.env ?? process.env, stdio: "pipe" });
  };
  for (const id of [other, unreadable, edit]) w.verdicts.set(id, RED);
  const result = await w.land([input(other), input(unreadable), { ...input(edit), newFile: undefined, content: shard(edit, "edited") }]);
  assert.deepEqual(result.refused.map((r) => r.id_release), ["kept_other_holder", "unreadable", undefined]);
  assert.deepEqual([w.refSha(other), w.refSha(unreadable), w.refSha(edit)], [otherSha, unreadableSha, editSha]);
  assert.deepEqual(w.rows.filter((r) => r.step === "task_id.reservation_released"), []);
});

test("W1-T12456 criterion 4: landing refusals and the gardener row retain reservation release metadata", async (t) => {
  const w = world(t);
  const { ids: [refused] } = await file(w);
  const row = w.rows.find((r) => r.step === "scout.garden_sealed_landing");
  assert.equal(row?.outcome, "waiting");
  assert.deepEqual(row?.refused, [{
    path: pathOf(refused!), reason: "the plan preflight refused it: [proof-discrimination] fixture refusal",
    reserved_id: refused, id_release: "released",
  }]);
  const again = await w.land([input(refused!)]);
  assert.equal(again.refused[0]?.reserved_id, refused);
  assert.equal(again.refused[0]?.id_release, "already_absent");
});

test("W1-T12456 criterion 2: bytes origin/main already holds release the id when no other file holds it", async (t) => {
  const w = world(t);
  const branch = await taskFilesLandingBranchAsync(TARGET);
  const id = "W1-T95031", shared = "W1-T95032";
  w.anchor(id, branch);
  w.anchor(shared, branch);
  w.commit({ [pathOf(id)]: shard(id), [pathOf(shared)]: shard(shared), "plan/tasks.d/duplicate-holder.yaml": shard(shared, "dup") });
  const result = await w.land([input(id), input(shared)]);
  assert.match(result.refused[0]!.reason, /origin\/main already holds these bytes/);
  assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [id, "released"]);
  assert.equal(w.refSha(id), "");
  assert.equal(result.refused[1]?.id_release, undefined, "another file on main holds the id, so it is kept");
  assert.notEqual(w.refSha(shared), "");
});

test("refusing different bytes for a new file already in the staging queue keeps its reservation", async (t) => {
  const w = world(t);
  const id = "W1-T95041";
  const sha = w.anchor(id, await taskFilesLandingBranchAsync(TARGET));
  assert.deepEqual((await w.land([input(id)])).waiting, [pathOf(id)]);
  const result = await w.land([{ ...input(id), content: shard(id, "different bytes") }]);
  assert.match(result.refused[0]!.reason, /another edit .* waits for its landing/);
  assert.deepEqual(result.waiting, [pathOf(id)]);
  assert.equal(w.refSha(id), sha);
  assert.equal(result.refused[0]?.id_release, undefined);
});

test("W1-T12456 criterion 2: a relocated plan keeps an id held by another file", async (t) => {
  const w = world(t, "roadmap");
  const branch = await taskFilesLandingBranchAsync(TARGET);
  const sole = "W1-T95051", shared = "W1-T95052";
  const relocated = (id: string): TaskFileInput => ({ ...input(id), relPath: `roadmap/tasks.d/${id}-fixture.yaml` });
  w.anchor(sole, branch);
  const sharedSha = w.anchor(shared, branch);
  w.commit({
    [relocated(sole).relPath]: shard(sole), [relocated(shared).relPath]: shard(shared),
    "roadmap/tasks.yaml": shard(shared, "another holder outside tasks.d"),
  });
  const result = await w.land([relocated(sole), relocated(shared)]);
  assert.deepEqual(result.refused.map((r) => r.path), [relocated(sole).relPath, relocated(shared).relPath]);
  for (const refusal of result.refused) assert.match(refusal.reason, /origin\/main already holds these bytes/);
  assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [sole, "released"]);
  assert.equal(w.refSha(sole), "", "the relocated plan is searched and its sole holder may release");
  assert.equal(result.refused[1]?.id_release, undefined);
  assert.equal(w.refSha(shared), sharedSha, "another file in the configured plan keeps the reservation");
});

test("W1-T12456 criterion 2: a failed holder search distinguishes no matches from unreadable main", async (t) => {
  for (const [name, error, releases] of [
    ["exit code 1", { code: 1 }, true],
    ["exit status 1", { status: 1 }, true],
    ["unreadable tree", { code: 128 }, false],
  ] as const) {
    await t.test(name, async (t) => {
      const w = world(t);
      const id = "W1-T95061";
      const sha = w.anchor(id, await taskFilesLandingBranchAsync(TARGET));
      w.commit({ [pathOf(id)]: shard(id) });
      let searches = 0;
      w.options.gitAsync = async (args, opts) => {
        if (args[0] === "grep") {
          searches++;
          throw Object.assign(new Error(name), error);
        }
        return execFileSync("git", ["-C", w.repo.dir, ...args], { encoding: "utf8", env: opts?.env ?? process.env, stdio: "pipe" });
      };
      const result = await w.land([input(id)]);
      assert.equal(searches, 1);
      assert.equal(result.refused.length, 1);
      assert.match(result.refused[0]!.reason, /origin\/main already holds these bytes/);
      assert.equal(result.refused[0]?.id_release, releases ? "released" : undefined);
      assert.equal(w.refSha(id), releases ? "" : sha);
    });
  }
});
