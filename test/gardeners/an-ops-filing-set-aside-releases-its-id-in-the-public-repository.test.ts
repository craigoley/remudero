// W1-T13169: a new task file the landing sets aside, or refuses at staging, while it lands in the plan destination
// releases its id reservation in the public repository, where refs/rmd-id lives. Each test runs real git against two
// bare origins: the public repository, which holds the reservation anchors, and the destination at
// `<root>/repos/<name>`, which holds none. GitHub and the plan preflight verdict are fakes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { landTaskFilesAsync, taskFilesLandingBranchAsync, type LandTaskFilesOpts, type TaskFileInput } from "#src/lib/feedback-landing.js";
import { isGardenLandWaiting, prepareGardenTaskIds, type GardenTaskIdMinter } from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath, resolvePlanDestination } from "#src/lib/plan-destination.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";
import { gardenCheckoutAsync } from "#test/helpers/run-task-test.js";

const PUBLIC = { owner: "acme", repo: "remudero" };
const OPS = { owner: "acme", repo: "remudero-ops" };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "fixture refusal" }], unreadable: [] };
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string, note = ""): string =>
  [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", `  origin: "fixture:${id}"`, ...(note ? [`  note: ${note}`] : []), ""].join("\n");
const input = (id: string): TaskFileInput => ({
  relPath: pathOf(id), content: shard(id), newFile: true, claim: `the task ${id} is filed`, proof: `grep: id: ${id} in ${pathOf(id)}`,
});
type Row = Record<string, unknown> & { step: string };
type Call = { at: "public" | "ops"; args: string[] };

/** The public repository and the plan destination, each a bare origin and a clone; the host file names the destination. */
function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13169-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(planDestinationPath(stateDir), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds: ["task"] }));
  // The landing caches a green tree by its hash for the process, so each world's tree is its own.
  const pub = originWithClone(join(root, "public"), { seed: { "plan/tasks.yaml": "[]\n", [pathOf("W1-T90001")]: shard("W1-T90001"), "world.txt": `${root}\n` } });
  const ops = originWithClone(join(root, "repos", OPS.repo), { seed: { "plan/tasks.yaml": "[]\n", [pathOf("W1-T90002")]: shard("W1-T90002"), "world.txt": `${root} ops\n` } });
  for (const clone of [pub.clone, ops.clone]) {
    clone.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    clone.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  }
  t.after(() => {
    for (const r of [pub.origin, ops.origin]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push({ ...extra, step });
  const gh = { open: new Map<string, Array<{ url: string }>>(), state: new Map<string, string>(), creates: [] as string[] };
  const landingGh = (args: string[]): string => {
    const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1]! : "none";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(gh.open.get(repo) ?? []);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/${repo}/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push(url);
      gh.open.set(repo, [{ url }]);
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: gh.state.get(args[2]!) ?? "OPEN" });
    return "[]";
  };
  const red = new Set<string>();
  const planPrPreflight = async (_sha: string, pr: { body: string }): Promise<PlanPrPreflightResult> =>
    [...red].some((id) => pr.body.includes(`id: ${id} in`)) ? RED : GREEN;
  const calls: Call[] = [];
  const gitIn = (at: Call["at"], dir: string) => async (args: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<string> => {
    calls.push({ at, args });
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: o?.env ?? process.env, stdio: "pipe" });
  };
  /** Write `refs/rmd-id/<id>` on the public origin as the reserver does: an anchor whose holder line names `branch`. */
  const anchor = (id: string, branch: string): string => {
    const sha = pub.origin.git("commit-tree", EMPTY_TREE, "-m", formatReservationAnchorMessage({ branch, startedAt: "2026-11-16T00:00:00Z" }));
    pub.origin.git("update-ref", taskIdReservationRef(id), sha);
    return sha;
  };
  const refSha = (id: string): string => pub.origin.git("for-each-ref", "--format=%(objectname)", taskIdReservationRef(id));
  const opsRefs = (): string => ops.origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id");
  let moves = 0;
  /** The options a landing into `target` gets; `reservation` is the public repository's git, when the caller passes one. */
  const options = (target: typeof PUBLIC, reservation: boolean): LandTaskFilesOpts => ({
    stateRoot: root, targetRepository: target, log, gh: landingGh, planPrPreflight,
    gitAsync: target === OPS ? gitIn("ops", ops.clone.dir) : gitIn("public", pub.clone.dir),
    ...(reservation ? { reservationGitAsync: gitIn("public", pub.clone.dir) } : {}),
  });
  return {
    root, stateDir, pub, ops, rows, gh, red, calls, anchor, refSha, opsRefs, landingGh, planPrPreflight,
    steps: (step: string) => rows.filter((r) => r.step === step),
    seal: (target: typeof PUBLIC) => void gh.open.set(`${target.owner}/${target.repo}`, [{ url: `https://github.com/${target.owner}/${target.repo}/pull/8000` }]),
    unseal: (target: typeof PUBLIC) => void gh.open.set(`${target.owner}/${target.repo}`, []),
    /** The destination's main moves on, so the landing tests each staged file again on a new tree. */
    moveOpsMain: () => {
      writeFileSync(join(ops.clone.dir, "world.txt"), `${root} ops\nmove ${++moves}\n`);
      ops.clone.git("commit", "--quiet", "-am", `move main ${moves}`);
      ops.clone.git("push", "--quiet", "origin", "HEAD:main");
    },
    land: (target: typeof PUBLIC, inputs: TaskFileInput[], reservation = true) =>
      withLiveWritesAllowed(() => landTaskFilesAsync(target === OPS ? ops.clone.dir : pub.clone.dir, inputs, options(target, reservation))),
  };
}

type World = ReturnType<typeof world>;
const asideRow = (w: World, id: string): Row | undefined => w.steps("task_files_landing.set_aside").find((r) => r.path === pathOf(id));

test("W1-T13169 criterion 1: a destination filing the landing sets aside releases its reservation in the public repository", async (t) => {
  // The plan preflight refused it in a later batch.
  const w = world(t);
  const opsBranch = await taskFilesLandingBranchAsync(OPS);
  const id = "W1-T95101";
  w.anchor(id, opsBranch);
  w.seal(OPS);
  const staged = await w.land(OPS, [input(id)]);
  assert.deepEqual(staged.waiting, [pathOf(id)], "the new file waits behind the open landing PR of the destination");
  w.unseal(OPS);
  w.red.add(id);
  w.moveOpsMain();
  const batch = await w.land(OPS, []);
  assert.deepEqual(batch.setAside.map((r) => r.path), [pathOf(id)], "the later call sets the file aside");
  assert.equal(w.refSha(id), "", "the reservation in the public repository is released");
  assert.deepEqual([asideRow(w, id)?.reserved_id, asideRow(w, id)?.id_release], [id, "released"]);
  assert.deepEqual(w.steps("task_id.reservation_released").map((r) => r.reserved_id), [id]);
  assert.equal(w.opsRefs(), "", "the destination never held a reservation");

  // Its landing pull request was closed without a merge.
  const closed = world(t);
  const shut = "W1-T95102";
  closed.anchor(shut, opsBranch);
  const opened = await closed.land(OPS, [input(shut)]);
  assert.match(String(opened.prUrl), /acme\/remudero-ops\/pull\//, "the file rides the destination's landing PR");
  closed.unseal(OPS);
  closed.gh.state.set(opened.prUrl!, "CLOSED");
  const later = await closed.land(OPS, []);
  assert.deepEqual(later.setAside.map((r) => r.path), [pathOf(shut)]);
  assert.equal(closed.refSha(shut), "", "the reservation in the public repository is released");
  assert.equal(asideRow(closed, shut)?.id_release, "released");
});

test("W1-T13169 criterion 2: a destination filing refused at staging releases its reservation in the public repository", async (t) => {
  const w = world(t);
  const opsBranch = await taskFilesLandingBranchAsync(OPS);
  const refused = "W1-T95201", kept = "W1-T95202";
  w.anchor(refused, opsBranch);
  w.anchor(kept, opsBranch);
  w.seal(OPS);
  w.red.add(refused);
  const result = await w.land(OPS, [input(refused), input(kept)]);
  assert.deepEqual(result.refused.map((r) => [r.path, r.reserved_id, r.id_release]), [[pathOf(refused), refused, "released"]]);
  assert.deepEqual(result.waiting, [pathOf(kept)]);
  assert.equal(w.refSha(refused), "", "the refused file's id is released in the public repository");
  assert.notEqual(w.refSha(kept), "", "the id of the file that waits is kept");
  assert.deepEqual(w.steps("task_id.reservation_released").map((r) => r.reserved_id), [refused]);
});

test("W1-T13169 criterion 3: invariant:release-reads-the-reservation-repository, and no false release without that repository", async (t) => {
  const w = world(t);
  const opsBranch = await taskFilesLandingBranchAsync(OPS);
  const id = "W1-T95301";
  const sha = w.anchor(id, opsBranch);
  w.seal(OPS);
  w.red.add(id);
  await w.land(OPS, [input(id)]);
  assert.equal(w.refSha(id), "");
  const reservationCalls = w.calls.filter((c) => c.args.some((a) => a.includes("refs/rmd-id") || a === sha));
  assert.ok(reservationCalls.length >= 3, "the release listed, fetched and released the reservation");
  assert.deepEqual(reservationCalls.filter((c) => c.at !== "public"), [], "every reservation call ran in the public repository");
  assert.ok(reservationCalls.some((c) => c.args[0] === "ls-remote") && reservationCalls.some((c) => c.args[0] === "fetch")
    && reservationCalls.some((c) => c.args[0] === "log") && reservationCalls.some((c) => c.args[0] === "push"));

  // A destination landing given no git of the public repository asks nothing of the destination and records no release.
  const bare = world(t);
  const refused = "W1-T95302", aside = "W1-T95303";
  bare.anchor(refused, opsBranch);
  bare.anchor(aside, opsBranch);
  bare.seal(OPS);
  bare.red.add(refused);
  const atStaging = await bare.land(OPS, [input(refused), input(aside)], false);
  bare.unseal(OPS);
  bare.red.add(aside);
  bare.moveOpsMain();
  await bare.land(OPS, [], false);
  assert.deepEqual([atStaging.refused[0]?.id_release, asideRow(bare, aside)?.id_release], ["unreadable", "unreadable"], "never already_absent");
  assert.match(String(atStaging.refused[0]?.id_release_detail), /plan destination/);
  assert.match(String(asideRow(bare, aside)?.id_release_detail), /plan destination/);
  assert.deepEqual(bare.steps("task_id.reservation_released"), [], "no task_id.reservation_released row");
  assert.deepEqual(bare.calls.filter((c) => c.args.some((a) => a.includes("refs/rmd-id"))), [], "no reservation call ran in the destination");
  assert.notEqual(bare.refSha(refused), "", "the public reservation is not touched");
  assert.notEqual(bare.refSha(aside), "");
});

test("W1-T13169 criterion 4: the production garden checkout passes the public repository's git to a destination landing", async (t) => {
  const w = world(t);
  const released: string[] = [];
  let count = 0;
  const mint = Object.assign((branch: string) => {
    const id = `W1-T${95401 + count++}`;
    w.anchor(id, branch);
    return id;
  }, { releaseAsync: async (id: string) => void released.push(id) }) as GardenTaskIdMinter;
  const at = resolvePlanDestination("task", w.stateDir, { ...PUBLIC, checkoutDir: w.pub.clone.dir });
  assert.equal(at.outcome, "destination");
  w.seal(OPS);
  const ws = await gardenCheckoutAsync({
    name: "scout", repoDir: w.pub.clone.dir, worktreesRoot: join(w.root, "worktrees"), ...PUBLIC, taskFilesOnly: true,
    taskFilesLanding: { stateRoot: w.root, gh: w.landingGh, planPrPreflight: w.planPrPreflight },
    log: (step, extra = {}) => void w.rows.push({ ...extra, step }), preflight: () => GREEN,
    fetcher: async () => ({ html_url: "https://github.com/acme/remudero-ops/pull/1", number: 1 }),
    ...(at.outcome === "destination" ? { taskDestination: at } : {}),
  });
  try {
    assert.equal(ws.branch, await taskFilesLandingBranchAsync(OPS), "the id is reserved on the destination's landing branch");
    const ids = await prepareGardenTaskIds(ws, 2, mint, true);
    const inputs = ids.map(input);
    for (const i of inputs) writeFileSync(join(ws.root, i.relPath), i.content);
    w.red.add(ids[0]!);
    const body = `File tasks.\n\n## Acceptance\n${inputs.map((i) => `- claim: ${i.claim}\n  proof: ${i.proof}`).join("\n")}`;
    const result = await withLiveWritesAllowed(() => ws.land({ paths: inputs.map((i) => i.relPath), title: "chore(plan): file tasks", body }));
    assert.ok(isGardenLandWaiting(result));
    assert.deepEqual(result.waiting.paths, [pathOf(ids[1]!)], "the kept file waits in the destination's landing");
    assert.equal(w.refSha(ids[0]!), "", "the refused file's id is released in the public repository");
    assert.notEqual(w.refSha(ids[1]!), "");
    assert.deepEqual(w.steps("task_id.reservation_released").map((r) => r.reserved_id), [ids[0]]);
    assert.equal(w.opsRefs(), "");
  } finally {
    await ws.dispose();
  }
});

test("W1-T13169 criterion 5: a landing into the public repository releases as before, with the holder check and the main-holds-path keep", async (t) => {
  const w = world(t);
  const pubBranch = await taskFilesLandingBranchAsync(PUBLIC);
  const mine = "W1-T95501", theirs = "W1-T95502";
  w.anchor(mine, pubBranch);
  const otherSha = w.anchor(theirs, "someone-garden-1");
  w.seal(PUBLIC);
  w.red.add(mine);
  w.red.add(theirs);
  const result = await w.land(PUBLIC, [input(mine), input(theirs)], false);
  assert.deepEqual(result.refused.map((r) => r.id_release), ["released", "kept_other_holder"]);
  assert.equal(w.refSha(mine), "");
  assert.equal(w.refSha(theirs), otherSha, "the reservation of another branch is left as it is");
  assert.ok(w.calls.every((c) => c.at === "public"));

  // A destination landing keeps another holder's reservation too: the holder is still the landing branch.
  const other = world(t);
  const held = "W1-T95503";
  const heldSha = other.anchor(held, "someone-garden-2");
  other.seal(OPS);
  other.red.add(held);
  const ops = await other.land(OPS, [input(held)]);
  assert.equal(ops.refused[0]?.id_release, "kept_other_holder");
  assert.equal(other.refSha(held), heldSha);

  // Main now holds a file at the path, so the id lives on main and is kept.
  const onMain = world(t);
  const landed = "W1-T95504";
  const sha = onMain.anchor(landed, pubBranch);
  onMain.seal(PUBLIC);
  assert.deepEqual((await onMain.land(PUBLIC, [input(landed)], false)).waiting, [pathOf(landed)]);
  writeFileSync(join(onMain.pub.clone.dir, pathOf(landed)), shard(landed, "filed another way"));
  onMain.pub.clone.git("add", "-A");
  onMain.pub.clone.git("commit", "--quiet", "-m", "file it another way");
  onMain.pub.clone.git("push", "--quiet", "origin", "HEAD:main");
  onMain.unseal(PUBLIC);
  await onMain.land(PUBLIC, [], false);
  assert.equal(asideRow(onMain, landed)?.id_release, "kept_main_holds_path");
  assert.equal(onMain.refSha(landed), sha);
});
