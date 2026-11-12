// W1-T12410: a new task file that the sealed landing sets aside gives back its reserved id, when the landing
// branch holds it. The landing tests drive `gardenCheckoutAsync` and `landTaskFilesAsync` over real git against a
// bare origin that holds real `refs/rmd-id/<id>` anchors; only GitHub and the plan preflight verdict are fakes.
// The flake-incident test drives `runFlakeIncidentGardener` with a minter that records each release.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { landTaskFilesAsync, taskFilesLandingBranchAsync } from "#src/lib/feedback-landing.js";
import { runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import { isGardenLandWaiting, prepareGardenTaskIds, type GardenLandResult, type GardenTaskIdMinter } from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import type { SelectorShadowTaskIdMinter } from "#src/lib/selector-shadow-gardener.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gardenCheckoutAsync, type GardenCheckoutOpts, type GardenName } from "#test/helpers/run-task-test.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TARGET = { owner: "acme", repo: "remudero" };
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string, note = ""): string =>
  [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", `  origin: ${JSON.stringify(`fixture:${id}`)}`, ...(note ? [`  note: ${note}`] : []), ""].join("\n");
const criterion = (id: string): string => `- claim: the task ${id} is filed\n  proof: grep: id: ${id} in ${pathOf(id)}`;
const fileBody = (...ids: string[]): string => `File the tasks.\n\n## Acceptance\n${ids.map(criterion).join("\n")}`;
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const PROOF_RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "the proof does not discriminate" }], unreadable: [] };
type Row = Record<string, unknown> & { step: string };

/** A bare origin whose main holds `files` and real reservation anchors, a clone the gardens check out from, and GitHub as the landing sees it. */
function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12410-`));
  const origin = gitRepo({ bare: true, kind: "w1-t12410-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12410-author" });
  const files: Record<string, string> = { "plan/tasks.yaml": "[]\n", [pathOf("W1-T90001")]: shard("W1-T90001"), "world.txt": `${root}\n` };
  const commit = (changes: Record<string, string>, message: string): void => {
    for (const [rel, text] of Object.entries(changes)) {
      mkdirSync(join(author.dir, rel, ".."), { recursive: true });
      writeFileSync(join(author.dir, rel), text);
    }
    author.git("add", "-A");
    author.git("commit", "--quiet", "-m", message);
    author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  };
  commit(files, "seed the plan");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12410-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => {
    for (const r of [origin, author, repo]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push({ ...extra, step });
  /** Write `refs/rmd-id/<id>` on origin as the reserver does: an anchor commit whose holder line names `branch`. */
  const anchor = (id: string, branch: string): string => {
    const sha = origin.git("commit-tree", EMPTY_TREE, "-m", formatReservationAnchorMessage({ branch, startedAt: new Date(T0).toISOString() }));
    origin.git("update-ref", taskIdReservationRef(id), sha);
    return sha;
  };
  const refSha = (id: string): string => origin.git("for-each-ref", "--format=%(objectname)", taskIdReservationRef(id));
  const minted: Array<{ id: string; branch: string }> = [];
  const released: string[] = [];
  const next = (branch: string): string => {
    const id = `W1-T${95001 + minted.length}`;
    minted.push({ id, branch });
    anchor(id, branch);
    return id;
  };
  const mint = Object.assign(next, {
    async: async (branch: string) => next(branch),
    release: (id: string) => void released.push(id),
    releaseAsync: async (id: string) => void released.push(id),
  }) as GardenTaskIdMinter;
  const gh = { open: [] as Array<{ url: string }>, creates: [] as string[], state: new Map<string, string>() };
  const landingGh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(gh.open);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push(url);
      gh.open = [{ url }];
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: gh.state.get(args[2]!) ?? "OPEN" });
    return "[]";
  };
  const red = new Set<string>();
  const planPrPreflight = async (_sha: string, pr: { body: string }): Promise<PlanPrPreflightResult> =>
    [...red].some((id) => pr.body.includes(`id: ${id} in`)) ? PROOF_RED : GREEN;
  let tick = T0;
  const clock = clockFromMillisFn(() => (tick += 1000));
  const taskFilesLanding = { stateRoot: root, gh: landingGh, planPrPreflight };
  const checkoutOpts = (name: GardenName): GardenCheckoutOpts => ({
    name, repoDir: repo.dir, worktreesRoot: join(root, "worktrees"), owner: "acme", repo: "remudero", log, clock,
    preflight: () => GREEN, fetcher: async () => ({ html_url: "https://github.com/acme/remudero/pull/1", number: 1 }),
    taskFilesLanding, taskFilesOnly: true,
  });
  let moves = 0;
  return {
    rows, gh, red, mint, minted, released, anchor, refSha, checkoutOpts,
    steps: (step: string) => rows.filter((r) => r.step === step),
    /** Main moves on, so the landing tests each file again on a new tree. */
    moveMain: () => commit({ "world.txt": `${root}\nmove ${++moves}\n` }, `move main ${moves}`),
    commitOnMain: (changes: Record<string, string>) => commit(changes, "change main"),
    seal: () => void (gh.open = [{ url: "https://github.com/acme/remudero/pull/8000" }]),
    /** The landing call the sweep makes once per pass, with no new input. */
    land: (inputs: Parameters<typeof landTaskFilesAsync>[1] = []) =>
      withLiveWritesAllowed(() => landTaskFilesAsync(repo.dir, inputs, { ...taskFilesLanding, targetRepository: TARGET, log })),
  };
}

type World = ReturnType<typeof world>;

/** One gardener pass: a checkout that files only task files reserves `count` ids, writes their files and lands them. */
async function file(w: World, name: GardenName, count = 1) {
  const ws = await gardenCheckoutAsync(w.checkoutOpts(name));
  try {
    const ids = await prepareGardenTaskIds(ws, count, w.mint, true);
    for (const id of ids) writeFileSync(join(ws.root, pathOf(id)), shard(id));
    const result = await withLiveWritesAllowed(() => ws.land({ paths: ids.map(pathOf), title: "chore(plan): file tasks", body: fileBody(...ids) }));
    return { ids, result, branch: ws.branch! };
  } finally {
    await ws.dispose();
  }
}

const asideRow = (w: World, id: string): Row | undefined => w.steps("task_files_landing.set_aside").find((r) => r.path === pathOf(id));

test("W1-T12410 criterion 1: a new task file a later landing call sets aside releases its id reservation when the landing branch holds it", async (t) => {
  // Its landing pull request was closed without a merge.
  const closed = world(t);
  const opened = await file(closed, "ci-friction");
  const [shut] = opened.ids;
  assert.equal(opened.result, closed.gh.creates[0], "the new file rides the landing PR it opened");
  assert.equal(opened.branch, await taskFilesLandingBranchAsync(TARGET));
  assert.notEqual(closed.refSha(shut!), "", "the reservation is on origin while the file waits");
  closed.gh.open = [];
  closed.gh.state.set(closed.gh.creates[0]!, "CLOSED");
  const later = await closed.land();
  assert.deepEqual(later.setAside.map((r) => r.path), [pathOf(shut!)], "the later call sets the file aside");
  assert.equal(closed.refSha(shut!), "", "the landing released the reservation");
  assert.deepEqual([asideRow(closed, shut!)?.reserved_id, asideRow(closed, shut!)?.id_release], [shut, "released"]);
  assert.deepEqual(closed.steps("task_id.reservation_released").map((r) => [r.reserved_id, r.lane]), [[shut, "task-files-landing"]]);

  // The plan preflight refused it in a later batch.
  const refused = world(t);
  refused.seal();
  const waited = await file(refused, "hot-file");
  const [held] = waited.ids;
  assert.ok(isGardenLandWaiting(waited.result), "the file waits behind the open landing PR");
  assert.deepEqual(refused.released, [], "the gardener's pass keeps the id of a file that waits");
  refused.gh.open = [];
  refused.red.add(held!);
  refused.moveMain();
  const batch = await refused.land();
  assert.deepEqual(batch.setAside.map((r) => r.path), [pathOf(held!)]);
  assert.equal(refused.refSha(held!), "", "the landing released the reservation the gardener's pass no longer can");
  assert.equal(asideRow(refused, held!)?.id_release, "released");
});

test("W1-T12410 criterion 2: in one land the landing keeps one new file and sets another aside; only the id of the file set aside is released", async (t) => {
  const w = world(t);
  w.seal();
  const first = await file(w, "scout");
  const [aside] = first.ids;
  assert.ok(isGardenLandWaiting(first.result));
  w.gh.open = [];
  w.red.add(aside!);
  w.moveMain();
  const second = await file(w, "scout");
  const [kept] = second.ids;
  assert.equal(second.result, w.gh.creates[0], "the land opens the landing PR with the file it keeps");
  assert.equal(asideRow(w, aside!)?.id_release, "released", "the same call set the first file aside");
  assert.equal(w.refSha(aside!), "", "the id of the file set aside is released");
  assert.notEqual(w.refSha(kept!), "", "the id of the file the landing keeps is not");
  assert.deepEqual(w.released, [], "the gardener's own release path freed nothing: its land opened");
});

test("W1-T12410 criterion 3: the landing keeps a reservation another branch holds, and the id of a new file whose path main now holds", async (t) => {
  // Another branch took the reservation over while the file waited.
  const other = world(t);
  other.seal();
  const [taken] = (await file(other, "flow")).ids;
  const theirs = other.anchor(taken!, "someone-garden-1");
  other.gh.open = [];
  other.red.add(taken!);
  other.moveMain();
  await other.land();
  assert.equal(asideRow(other, taken!)?.id_release, "kept_other_holder");
  assert.equal(other.refSha(taken!), theirs, "the reservation of another branch is left as it is");
  assert.deepEqual(other.steps("task_id.reservation_released"), []);

  // Main now holds a file at the path, so the id lives on main.
  const onMain = world(t);
  onMain.seal();
  const [landed] = (await file(onMain, "host-resource")).ids;
  const mine = onMain.refSha(landed!);
  onMain.commitOnMain({ [pathOf(landed!)]: shard(landed!, "filed another way") });
  onMain.gh.open = [];
  await onMain.land();
  assert.match(String(asideRow(onMain, landed!)?.reason), /origin\/main changed/);
  assert.equal(asideRow(onMain, landed!)?.id_release, "kept_main_holds_path");
  assert.equal(onMain.refSha(landed!), mine, "the reservation of an id main holds is kept");
});

test("W1-T12410 criterion 4: an edit of a task file main holds releases no reservation when the landing sets it aside", async (t) => {
  const w = world(t);
  const id = "W1-T90001";
  const sha = w.anchor(id, await taskFilesLandingBranchAsync(TARGET));
  w.seal();
  const staged = await w.land([{ relPath: pathOf(id), content: shard(id, "an edit"), claim: `the task ${id} is edited`, proof: `grep: an edit in ${pathOf(id)}` }]);
  assert.deepEqual(staged.waiting, [pathOf(id)], "the edit waits behind the open landing PR");
  w.commitOnMain({ [pathOf(id)]: shard(id, "main moved first") });
  w.gh.open = [];
  await w.land();
  const row = asideRow(w, id);
  assert.match(String(row?.reason), /origin\/main changed/, "the edit is set aside");
  assert.deepEqual([row?.reserved_id, row?.id_release], [undefined, undefined], "an edit names no id to release");
  assert.equal(w.refSha(id), sha, "the reservation is kept");
  assert.deepEqual(w.steps("task_id.reservation_released"), []);
});

const FLAKE_FILE = "test/operator-agent-scan-routes-never-block-the-loop.test.ts";
const FLAKE_TITLE = "after a rotation lands the emergency status answers within budget";
const FLAKE_NOW = Date.parse("2026-10-08T14:00:00Z");

/** One flake-incident pass over four unrelated PRs, with a land that answers `landed`. */
async function flakePass(landed: (paths: string[]) => GardenLandResult) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12410-flake-`));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    mkdirSync(join(root, FLAKE_FILE, ".."), { recursive: true });
    writeFileSync(join(root, FLAKE_FILE), "");
    const ledger = join(root, "state", "ledger.ndjson");
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendFileSync(ledger, JSON.stringify({ ts: new Date(FLAKE_NOW).toISOString(), step, ...extra }) + "\n");
    for (const pr of [10058, 10077, 10084, 10089]) {
      log("test.flake_retry", { file: FLAKE_FILE, headline: "recovered on retry", ci_run_id: pr * 10, shard: 3, source: "selector-shadow",
        retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr], titles: [FLAKE_TITLE] });
    }
    const minted: Array<{ id: string; branch: string }> = [];
    const released: string[] = [];
    const mintTaskId = Object.assign((branch: string) => {
      const id = `W1-T${9001 + minted.length}`;
      minted.push({ id, branch });
      return id;
    }, { releaseAsync: async (id: string) => void released.push(id) }) as SelectorShadowTaskIdMinter;
    const deps = {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(FLAKE_NOW), log,
      openWorkspace: async () => ({ root, branch: "task-files-landing-acme-remudero", land: async (opts: { paths: string[] }) => landed(opts.paths), dispose: async () => {} }),
    };
    await runFlakeIncidentGardener(deps, {
      mintTaskId, readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "import { x } from \"../src/lib/emergency-status.js\";\n",
    });
    const steps = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Row).step);
    return { minted, released, steps };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T12410 criterion 5: the flake-incident gardener releases its id when its land is refused or opens no PR, and keeps it when the filing opens or waits", async () => {
  const refused = await flakePass(() => undefined);
  assert.deepEqual(refused.minted.map((m) => m.branch), ["task-files-landing-acme-remudero"], "the id is reserved against the checkout's branch");
  assert.ok(refused.steps.includes("flake_incident.filing_failed"), "the land opened no PR");
  assert.deepEqual(refused.released, ["W1-T9001"], "its id goes back through the gardener's release path");

  const opened = await flakePass(() => "https://github.com/acme/remudero/pull/20001");
  assert.ok(opened.steps.includes("flake_incident.filed"));
  assert.deepEqual(opened.released, [], "a filing whose PR opened keeps its id");

  const waits = await flakePass((paths) => ({ waiting: { paths, stateRoot: "/state", filed: true } }));
  assert.ok(waits.steps.includes("flake_incident.filed"), "a filing that waits in the landing counts as filed");
  assert.deepEqual(waits.released, [], "a filing that waits keeps its id");
});
