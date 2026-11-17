// W1-T13429: the task-file landing never releases the reservation of an id that a task file on the target's main
// declares. A record that landed keeps its refs/rmd-id ref for ever, because a gate reads that ref for every record
// on main. A refused new file that no task file on main declares still releases its id. Each test runs real git
// against two bare origins: the public repository, which holds the reservation anchors, and the plan destination at
// `<root>/repos/<name>`, which holds none. GitHub and the plan preflight verdict are fakes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { landTaskFilesAsync, taskFilesLandingBranchAsync, type LandTaskFilesOpts, type TaskFileInput } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { formatReservationAnchorMessage, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";

const PUBLIC = { owner: "acme", repo: "remudero" };
const OPS = { owner: "acme", repo: "remudero-ops" };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "fixture refusal" }], unreadable: [] };
const TIMEOUT: PlanPrPreflightResult = { ...GREEN, timedOut: [{ check: "proof-discrimination", firstLine: "fixture timeout" }] };
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const otherPathOf = (id: string): string => `plan/tasks.d/${id}-landed-under-another-name.yaml`;
const shard = (id: string, note = ""): string =>
  [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", `  origin: "fixture:${id}"`, ...(note ? [`  note: ${note}`] : []), ""].join("\n");
const input = (id: string): TaskFileInput => ({
  relPath: pathOf(id), content: shard(id), newFile: true, claim: `the task ${id} is filed`, proof: `grep: id: ${id} in ${pathOf(id)}`,
});
type Row = Record<string, unknown> & { step: string };
type Call = { at: "public" | "ops"; args: string[] };
type Target = typeof PUBLIC;

/** The public repository and the plan destination, each a bare origin and a clone; the host file names the destination. */
function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13429-`));
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
  const open = new Map<string, Array<{ url: string }>>();
  const landingGh = (args: string[]): string => {
    const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1]! : "none";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(open.get(repo) ?? []);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/${repo}/pull/9001`;
      open.set(repo, [{ url }]);
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
    return "[]";
  };
  const red = new Set<string>();
  const timedOut = new Set<string>();
  const planPrPreflight = async (_sha: string, pr: { body: string }): Promise<PlanPrPreflightResult> => {
    const has = (ids: Set<string>) => [...ids].some((id) => pr.body.includes(`id: ${id} in`));
    return has(timedOut) ? TIMEOUT : has(red) ? RED : GREEN;
  };
  const calls: Call[] = [];
  /** A git call this returns an error for fails with that error, as a git that exits non-zero does. */
  let fault: ((c: Call) => object | undefined) | undefined;
  const gitIn = (at: Call["at"], dir: string) => async (args: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<string> => {
    calls.push({ at, args });
    const error = fault?.({ at, args });
    if (error !== undefined) throw Object.assign(new Error(`fixture: git ${args[0]} fails`), error);
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: o?.env ?? process.env, stdio: "pipe" });
  };
  /** Write `refs/rmd-id/<id>` on the public origin as the reserver does: an anchor whose holder line names `branch`. */
  const anchor = (id: string, branch: string): string => {
    const sha = pub.origin.git("commit-tree", EMPTY_TREE, "-m", formatReservationAnchorMessage({ branch, startedAt: "2026-11-17T00:00:00Z" }));
    pub.origin.git("update-ref", taskIdReservationRef(id), sha);
    return sha;
  };
  const refSha = (id: string): string => pub.origin.git("for-each-ref", "--format=%(objectname)", taskIdReservationRef(id));
  const options = (target: Target, reservation: boolean): LandTaskFilesOpts => ({
    stateRoot: root, targetRepository: target, log, gh: landingGh, planPrPreflight,
    gitAsync: target === OPS ? gitIn("ops", ops.clone.dir) : gitIn("public", pub.clone.dir),
    ...(reservation ? { reservationGitAsync: gitIn("public", pub.clone.dir) } : {}),
  });
  const cloneOf = (target: Target) => (target === OPS ? ops.clone : pub.clone);
  return {
    root, rows, red, timedOut, calls, anchor, refSha,
    failWhen: (f: (c: Call) => object | undefined) => void (fault = f),
    steps: (step: string) => rows.filter((r) => r.step === step),
    opsRefs: (): string => ops.origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id"),
    seal: (target: Target) => void open.set(`${target.owner}/${target.repo}`, [{ url: `https://github.com/${target.owner}/${target.repo}/pull/8000` }]),
    unseal: (target: Target) => void open.set(`${target.owner}/${target.repo}`, []),
    /** Commit `files` to the target's main, as a merged pull request does. */
    commitMain: (target: Target, files: Record<string, string>) => {
      const clone = cloneOf(target);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(clone.dir, path, ".."), { recursive: true });
        writeFileSync(join(clone.dir, path), content);
      }
      clone.git("add", "-A");
      clone.git("commit", "--quiet", "-m", "chore: main moves");
      clone.git("push", "--quiet", "origin", "HEAD:main");
    },
    /** Record `content` as bytes an earlier landing set aside at `relPath`. */
    setAsideBefore: (relPath: string, content: string) => {
      const refusedPath = join(root, "state/task-files-landing-refused", relPath);
      mkdirSync(join(refusedPath, ".."), { recursive: true });
      writeFileSync(refusedPath, content);
      writeFileSync(`${refusedPath}.meta.json`, JSON.stringify({ reason: "a prior preflight refused it" }));
    },
    land: (target: Target, inputs: TaskFileInput[], reservation = target === OPS) =>
      withLiveWritesAllowed(() => landTaskFilesAsync(cloneOf(target).dir, inputs, options(target, reservation))),
  };
}

type World = ReturnType<typeof world>;
const asideRow = (w: World, id: string): Row | undefined => w.steps("task_files_landing.set_aside").find((r) => r.path === pathOf(id));
const isGrep = (c: Call): boolean => c.args[0] === "grep";
const released = (w: World): unknown[] => w.steps("task_id.reservation_released").map((r) => r.reserved_id);

/** Stage a new file behind a sealed landing pull request, so a later call can set it aside. */
async function stageBehindSeal(w: World, target: Target, id: string): Promise<void> {
  w.seal(target);
  assert.deepEqual((await w.land(target, [input(id)])).waiting, [pathOf(id)], "the new file waits behind the open landing pull request");
  w.unseal(target);
}

test("W1-T13429 criterion 1: bytes the target's main already holds keep the reservation the landing branch holds", async (t) => {
  const w = world(t);
  const id = "W1-T96101";
  const sha = w.anchor(id, await taskFilesLandingBranchAsync(PUBLIC));
  w.commitMain(PUBLIC, { [pathOf(id)]: shard(id) });
  const result = await w.land(PUBLIC, [input(id)]);
  assert.deepEqual(result.refused.map((r) => r.path), [pathOf(id)]);
  assert.match(result.refused[0]!.reason, /origin\/main already holds these bytes/);
  assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [id, "kept_main_holds_path"]);
  assert.match(String(result.refused[0]?.id_release_detail), /origin\/main holds plan\/tasks\.d\/W1-T96101-fixture\.yaml/, "the refusal says why it kept the id");
  assert.equal(w.refSha(id), sha, "the reservation ref is unchanged");
  assert.deepEqual(released(w), [], "no task_id.reservation_released row");
});

test("W1-T13429 criterion 2: an id a task file on the target's main declares is never released", async (t) => {
  const branch = await taskFilesLandingBranchAsync(PUBLIC);

  await t.test("a stage refusal of a new file whose id main declares at another path", async (t) => {
    const w = world(t);
    const id = "W1-T96201";
    const sha = w.anchor(id, branch);
    w.commitMain(PUBLIC, { [otherPathOf(id)]: shard(id, "landed under another name") });
    w.red.add(id);
    const result = await w.land(PUBLIC, [input(id)]);
    assert.match(result.refused[0]!.reason, /the plan preflight refused it/);
    assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [id, "kept_main_holds_path"]);
    assert.match(String(result.refused[0]?.id_release_detail), /W1-T96201-landed-under-another-name\.yaml/, "it names the file on main");
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("bytes set aside before, whose id main declares at another path", async (t) => {
    const w = world(t);
    const id = "W1-T96202";
    const sha = w.anchor(id, branch);
    w.commitMain(PUBLIC, { [otherPathOf(id)]: shard(id) });
    w.setAsideBefore(pathOf(id), shard(id));
    const result = await w.land(PUBLIC, [input(id)]);
    assert.match(result.refused[0]!.reason, /the same bytes were set aside before/);
    assert.equal(result.refused[0]?.id_release, "kept_main_holds_path");
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("bytes main holds at the refused file's own path and at another path", async (t) => {
    const w = world(t);
    const id = "W1-T96203";
    const sha = w.anchor(id, branch);
    w.commitMain(PUBLIC, { [pathOf(id)]: shard(id), [otherPathOf(id)]: shard(id, "a second holder") });
    const result = await w.land(PUBLIC, [input(id)]);
    assert.match(result.refused[0]!.reason, /origin\/main already holds these bytes/);
    assert.equal(result.refused[0]?.id_release, "kept_main_holds_path");
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("a set-aside of a new file whose id main declares at another path", async (t) => {
    const w = world(t);
    const id = "W1-T96204";
    const sha = w.anchor(id, branch);
    await stageBehindSeal(w, PUBLIC, id);
    w.commitMain(PUBLIC, { [otherPathOf(id)]: shard(id, "landed under another name") });
    w.red.add(id);
    const later = await w.land(PUBLIC, []);
    assert.deepEqual(later.setAside.map((r) => r.path), [pathOf(id)], "the later call sets the file aside");
    assert.deepEqual([asideRow(w, id)?.reserved_id, asideRow(w, id)?.id_release], [id, "kept_main_holds_path"]);
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("a set-aside of a new file whose own path main now holds", async (t) => {
    const w = world(t);
    const id = "W1-T96205";
    const sha = w.anchor(id, branch);
    await stageBehindSeal(w, PUBLIC, id);
    w.commitMain(PUBLIC, { [pathOf(id)]: shard(id, "filed another way") });
    await w.land(PUBLIC, []);
    assert.equal(asideRow(w, id)?.id_release, "kept_main_holds_path");
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("a search of main that cannot be read keeps the id, at the stage and at the set-aside", async (t) => {
    const w = world(t);
    const refused = "W1-T96206", aside = "W1-T96207";
    const refusedSha = w.anchor(refused, branch);
    const asideSha = w.anchor(aside, branch);
    await stageBehindSeal(w, PUBLIC, aside);
    w.failWhen((c) => (isGrep(c) ? { code: 128 } : undefined));
    w.red.add(refused);
    w.red.add(aside);
    w.commitMain(PUBLIC, { "world.txt": "main moves\n" });
    const result = await w.land(PUBLIC, [input(refused)]);
    assert.ok(w.calls.some(isGrep), "the search ran and failed");
    assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [refused, "kept_main_holds_path"]);
    assert.match(String(result.refused[0]?.id_release_detail), /could not be read/);
    assert.deepEqual(result.setAside.map((r) => r.path), [pathOf(aside)]);
    assert.equal(asideRow(w, aside)?.id_release, "kept_main_holds_path");
    assert.match(String(asideRow(w, aside)?.id_release_detail), /could not be read/);
    assert.deepEqual([w.refSha(refused), w.refSha(aside)], [refusedSha, asideSha]);
    assert.deepEqual(released(w), []);
  });
});

test("W1-T13429 criterion 3: a landed ops record handed to the landing again keeps its public reservation", async (t) => {
  const w = world(t);
  const opsBranch = await taskFilesLandingBranchAsync(OPS);
  const id = "W1-T96301";
  const sha = w.anchor(id, opsBranch);
  // The record lands in the destination through its landing pull request, which then merges.
  w.seal(OPS);
  assert.deepEqual((await w.land(OPS, [input(id)])).waiting, [pathOf(id)]);
  w.unseal(OPS);
  w.commitMain(OPS, { [pathOf(id)]: shard(id) });
  assert.deepEqual((await w.land(OPS, [])).waiting, [], "the landing sees the record on main and stops waiting for it");
  // A garden hands the landing the same bytes again, twice.
  for (const pass of [1, 2]) {
    const again = await w.land(OPS, [input(id)]);
    assert.deepEqual(again.refused.map((r) => r.path), [pathOf(id)], `pass ${pass}`);
    assert.match(again.refused[0]!.reason, /origin\/main already holds these bytes/);
    assert.deepEqual([again.refused[0]?.reserved_id, again.refused[0]?.id_release], [id, "kept_main_holds_path"]);
  }
  assert.equal(w.refSha(id), sha, "the public refs/rmd-id ref stays in place");
  assert.deepEqual(released(w), [], "no task_id.reservation_released row");
  assert.deepEqual(w.calls.filter((c) => c.args[0] === "push" && c.args.some((a) => a.includes("refs/rmd-id"))), [], "no reservation was pushed away");
  assert.equal(w.opsRefs(), "", "the destination never held a reservation");
});

test("W1-T13429 criterion 4: a refused new file main does not declare still releases its id", async (t) => {
  const branch = await taskFilesLandingBranchAsync(PUBLIC);

  await t.test("refused by the plan preflight or by bytes set aside before, the landing branch holds it", async (t) => {
    const w = world(t);
    const red = "W1-T96401", prior = "W1-T96402";
    for (const id of [red, prior]) w.anchor(id, branch);
    w.red.add(red);
    w.setAsideBefore(pathOf(prior), shard(prior));
    const result = await w.land(PUBLIC, [input(red), input(prior)]);
    assert.deepEqual(result.refused.map((r) => [r.reserved_id, r.id_release]), [[red, "released"], [prior, "released"]]);
    assert.deepEqual([w.refSha(red), w.refSha(prior)], ["", ""]);
    assert.deepEqual(released(w), [red, prior]);
  });

  await t.test("another holder and an unreadable anchor keep it", async (t) => {
    const w = world(t);
    const other = "W1-T96403", unreadable = "W1-T96404";
    const otherSha = w.anchor(other, "another-branch");
    const unreadableSha = w.anchor(unreadable, branch);
    w.failWhen((c) => (c.args[0] === "log" && c.args.includes(unreadableSha) ? { code: 128 } : undefined));
    w.red.add(other);
    w.red.add(unreadable);
    const result = await w.land(PUBLIC, [input(other), input(unreadable)]);
    assert.deepEqual(result.refused.map((r) => r.id_release), ["kept_other_holder", "unreadable"]);
    assert.deepEqual([w.refSha(other), w.refSha(unreadable)], [otherSha, unreadableSha]);
    assert.deepEqual(released(w), []);
  });

  await t.test("a preflight that ran out of its budget keeps it", async (t) => {
    const w = world(t);
    const id = "W1-T96405";
    const sha = w.anchor(id, branch);
    w.timedOut.add(id);
    const result = await w.land(PUBLIC, [input(id)]);
    assert.equal(result.refused[0]?.timedOut, true);
    assert.equal(result.refused[0]?.id_release, undefined);
    assert.equal(w.refSha(id), sha);
    assert.deepEqual(released(w), []);
  });

  await t.test("a search that finds no match releases, as git grep's exit 1 says", async (t) => {
    for (const error of [{ code: 1 }, { status: 1 }]) {
      const w = world(t);
      const id = "W1-T96406";
      w.anchor(id, branch);
      w.failWhen((c) => (isGrep(c) ? error : undefined));
      w.red.add(id);
      const result = await w.land(PUBLIC, [input(id)]);
      assert.ok(w.calls.some(isGrep), "the search ran");
      assert.equal(result.refused[0]?.id_release, "released", JSON.stringify(error));
      assert.equal(w.refSha(id), "");
    }
  });

  await t.test("a set-aside of a new file main does not declare releases it", async (t) => {
    const w = world(t);
    const id = "W1-T96407";
    w.anchor(id, branch);
    await stageBehindSeal(w, PUBLIC, id);
    w.red.add(id);
    w.commitMain(PUBLIC, { "world.txt": "main moves\n" });
    await w.land(PUBLIC, []);
    assert.deepEqual([asideRow(w, id)?.reserved_id, asideRow(w, id)?.id_release], [id, "released"]);
    assert.equal(w.refSha(id), "");
  });

  await t.test("a destination landing releases in the public repository", async (t) => {
    const w = world(t);
    const id = "W1-T96408";
    w.anchor(id, await taskFilesLandingBranchAsync(OPS));
    w.red.add(id);
    const result = await w.land(OPS, [input(id)]);
    assert.deepEqual([result.refused[0]?.reserved_id, result.refused[0]?.id_release], [id, "released"]);
    assert.equal(w.refSha(id), "");
    assert.deepEqual(released(w), [id]);
    assert.ok(w.calls.some((c) => c.at === "ops" && isGrep(c)), "the search read the destination's main");
  });
});
