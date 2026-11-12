// W1-T12222: a gardener checkout that declares it files only task files reserves each new id against the
// branch of the sealed landing, and lands its new task files there. Every test drives the production path:
// `gardenCheckoutAsync` (or `daemonGardenWorkspace`) over real git against a bare origin, with fakes only for
// GitHub and for the plan preflight verdict. The preflight fake runs the gate's own holder check.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { isLandingRef, landTaskFilesAsync, stagedTaskFiles, taskFilesLandingBranchAsync } from "#src/lib/feedback-landing.js";
import {
  gardenStatePath, initialGardenState, isGardenLandWaiting, prepareGardenTaskIds, runGardenAsync,
  type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec, type GardenTaskIdMinter,
} from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import {
  formatReservationHolderLine, parseReservationHolderLine, RESERVATION_PUSH_GRACE_MS, reservationHolderDrift,
} from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { daemonGardenWorkspace, gardenCheckoutAsync, type GardenCheckoutOpts, type GardenName } from "#test/helpers/run-task-test.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Conflict = { id: string; reason: string };
const gate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href)) as {
  evaluateReservationHolderConflicts: (
    ids: string[], occurrences: Map<string, Array<{ file: string; line: number }>>,
    reservation: { reachable: boolean; ids: Set<string>; holders: Map<string, { status: "known"; branch: string }> },
    filerBranch: string | undefined, cwd: string,
  ) => Conflict[];
};

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const fileBody = (id: string): string => `File one task.\n\n## Acceptance\n- claim: the task ${id} is filed\n  proof: grep: id: ${id} in ${pathOf(id)}`;
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const PROOF_RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "the proof does not discriminate" }], unreadable: [] };
type Row = Record<string, unknown> & { step: string };

/** A minter that records the branch each id is reserved against, as the reservation ref's holder line does. */
function minter() {
  const minted: Array<{ id: string; branch: string }> = [];
  const released: string[] = [];
  const next = (branch: string): string => {
    const id = `W1-T${95001 + minted.length}`;
    minted.push({ id, branch });
    return id;
  };
  const mint = Object.assign(next, {
    async: async (branch: string) => next(branch),
    release: (id: string) => void released.push(id),
    releaseAsync: async (id: string) => void released.push(id),
  }) as GardenTaskIdMinter;
  return { mint, minted, released };
}

/** A bare origin whose main holds `files`, a clone the gardens check out from, and GitHub as the landing sees it. */
function world(t: TestContext, files: Record<string, string> = { "plan/tasks.yaml": "[]\n", [pathOf("W1-T90001")]: shard("W1-T90001"), "docs/notes.txt": "# notes\n" }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12222-`));
  const origin = gitRepo({ bare: true, kind: "w1-t12222-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12222-author" });
  // The landing caches a green tree by its hash for the process, so each world's tree is its own.
  for (const [rel, text] of Object.entries({ ...files, "world.txt": `${root}\n` })) {
    mkdirSync(join(author.dir, rel, ".."), { recursive: true });
    writeFileSync(join(author.dir, rel), text);
  }
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12222-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => {
    for (const r of [origin, author, repo]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push({ ...extra, step });
  const ids = minter();
  const gh = { open: [] as Array<{ url: string }>, creates: [] as string[], own: [] as string[] };
  const landingGh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(gh.open);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push(url);
      gh.open = [{ url }];
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
    return "[]";
  };
  const preflight = { red: new Set<string>(), asks: [] as Array<{ headRef?: string; added: string[]; conflicts: Conflict[] }> };
  /** The plan preflight as CI runs task-id-existence: each id the landing adds must be held by its head branch. */
  const planPrPreflight = async (_sha: string, pr: { title: string; body: string; headRef?: string }): Promise<PlanPrPreflightResult> => {
    const added = ids.minted.filter((m) => pr.body.includes(`id: ${m.id} in`)).map((m) => m.id);
    const reservation = { reachable: true, ids: new Set(added), holders: new Map(ids.minted.map((m) => [m.id, { status: "known" as const, branch: m.branch }])) };
    const conflicts = gate.evaluateReservationHolderConflicts(added, new Map(added.map((id) => [id, [{ file: pathOf(id), line: 1 }]])), reservation, pr.headRef, repo.dir);
    preflight.asks.push({ headRef: pr.headRef, added, conflicts });
    if (conflicts.length > 0) return { ok: false, failures: conflicts.map((c) => ({ check: "task-id-existence" as const, firstLine: `task-id-existence: FAILED ${c.id} ${c.reason}` })), unreadable: [] };
    return added.some((id) => preflight.red.has(id)) ? PROOF_RED : GREEN;
  };
  let tick = T0;
  const clock = clockFromMillisFn(() => (tick += 1000));
  const taskFilesLanding = { stateRoot: root, gh: landingGh, planPrPreflight };
  const checkoutOpts = (name: GardenName, only: boolean): GardenCheckoutOpts => ({
    name, repoDir: repo.dir, worktreesRoot: join(root, "worktrees"), owner: "acme", repo: "remudero", log, clock,
    preflight: () => GREEN,
    // The REST create of a garden's own PR.
    fetcher: async () => {
      const number = 700 + gh.own.length;
      gh.own.push(`https://github.com/acme/remudero/pull/${number}`);
      return { html_url: gh.own.at(-1), number };
    },
    taskFilesLanding,
    ...(only ? { taskFilesOnly: true as const } : {}),
  });
  const pending = join(root, "state", "task-files-landing-pending", "plan", "tasks.d");
  return {
    root, stateDir: join(root, "state"), origin, repo, rows, gh, clock, ids, preflight, checkoutOpts,
    steps: (step: string) => rows.filter((r) => r.step === step),
    heads: () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
    staged: () => (existsSync(pending) ? readdirSync(pending).filter((f) => f.endsWith(".yaml")).sort() : []),
    /** A landing PR that is open seals the landing branch. */
    seal: () => void (gh.open = [{ url: "https://github.com/acme/remudero/pull/8000" }]),
    /** The sealed PR merged without the waiting files; the next landing call opens a PR that carries them. */
    landWaiting: async () => {
      gh.open = [];
      return withLiveWritesAllowed(() => landTaskFilesAsync(repo.dir, [], { ...taskFilesLanding, targetRepository: { owner: "acme", repo: "remudero" }, log }));
    },
  };
}

/** Reserve one id through the checkout, write its new task file, and land it. */
async function fileOne(ws: Awaited<ReturnType<typeof gardenCheckoutAsync>>, mint: GardenTaskIdMinter) {
  const [id] = await prepareGardenTaskIds(ws, 1, mint, true);
  writeFileSync(join(ws.root, pathOf(id!)), shard(id!));
  const result = await withLiveWritesAllowed(() => ws.land({ paths: [pathOf(id!)], title: "chore(plan): file one task", body: fileBody(id!) }));
  return { id: id!, result };
}

test("W1-T12222 criterion 1: a checkout that declares it files only task files gives the landing branch as the reservation branch", async (t) => {
  const w = world(t);
  const ws = await gardenCheckoutAsync(w.checkoutOpts("ci-friction", true));
  try {
    assert.equal(ws.branch, await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero" }), "the branch is the one the landing pushes");
    assert.ok(isLandingRef(ws.branch!) && ws.branch!.startsWith("task-files-landing"), `a landing branch: ${ws.branch}`);
    await prepareGardenTaskIds(ws, 1, w.ids.mint, true);
    assert.deepEqual(w.ids.minted.map((m) => m.branch), [ws.branch], "the id is reserved against the landing branch");
  } finally {
    await ws.dispose();
  }
});

test("W1-T12222 criterion 2: the sealed landing accepts a new task file from such a checkout, and the preflight with the landing branch as head accepts its id", async (t) => {
  const w = world(t);
  const ws = await gardenCheckoutAsync(w.checkoutOpts("ci-friction", true));
  try {
    const { id, result } = await fileOne(ws, w.ids.mint);
    assert.deepEqual([result, w.gh.creates.length], [w.gh.creates[0], 1], "the land returns the landing PR that carries the new file");
    assert.equal(typeof result, "string");
    assert.equal(w.gh.own.length, 0, "the new file opens no PR of its own");
    assert.ok(w.heads().includes(ws.branch!), "the landing branch is pushed");
    assert.equal(w.origin.git("show", `${ws.branch}:${pathOf(id)}`), shard(id).trimEnd(), "the landing branch carries the new file");
    const asks = w.preflight.asks.filter((a) => a.added.includes(id));
    assert.ok(asks.length > 0, "the plan preflight tested the new file");
    for (const ask of asks) {
      assert.equal(ask.headRef, ws.branch, "the preflight runs with the landing branch as head, as CI does");
      assert.deepEqual(ask.conflicts, [], "the holder of the id is the head branch, so the gate accepts it");
    }
  } finally {
    await ws.dispose();
  }
});

test("W1-T12222 criterion 3: such a checkout refuses a land with a path outside plan/tasks.d and opens no pull request for it", async (t) => {
  const w = world(t);
  const ws = await gardenCheckoutAsync(w.checkoutOpts("scout", true));
  try {
    writeFileSync(join(ws.root, "docs/notes.txt"), "# notes\n\ntended\n");
    const docs = await withLiveWritesAllowed(() => ws.land({ paths: ["docs/notes.txt"], title: "chore(docs): tend the notes", body: fileBody("W1-T95999") }));
    assert.equal(docs, undefined, "a docs path is not landed");
    const [id] = await prepareGardenTaskIds(ws, 1, w.ids.mint, true);
    writeFileSync(join(ws.root, pathOf(id!)), shard(id!));
    const mixed = await withLiveWritesAllowed(() => ws.land({ paths: [pathOf(id!), "docs/notes.txt"], title: "chore(plan): file one task", body: fileBody(id!) }));
    assert.equal(mixed, undefined, "a land with one path outside plan/tasks.d is refused whole");
    assert.equal(w.gh.creates.length + w.gh.own.length, 0, "no pull request opens");
    assert.deepEqual(w.heads(), ["main"], "nothing is pushed");
    assert.deepEqual(w.staged(), [], "nothing waits in the landing");
    assert.deepEqual(w.steps("scout.garden_sealed_landing").map((r) => r.outcome), ["refused", "refused"]);
  } finally {
    await ws.dispose();
  }
});

test("W1-T12222 criterion 4: while a new file waits behind an open landing pull request, `reservationHolderDrift` reads its reservation as held", async (t) => {
  const w = world(t);
  const first = await gardenCheckoutAsync(w.checkoutOpts("hot-file", true));
  try {
    const opened = (await fileOne(first, w.ids.mint)).result;
    assert.deepEqual([typeof opened, opened, w.gh.creates.length], ["string", w.gh.creates[0], 1], "the first new file opens the landing PR");
  } finally {
    await first.dispose();
  }
  const second = await gardenCheckoutAsync(w.checkoutOpts("hot-file", true));
  try {
    const { id, result } = await fileOne(second, w.ids.mint);
    assert.ok(isGardenLandWaiting(result), "the second new file waits behind the open landing PR");
    assert.deepEqual(stagedTaskFiles(w.root).find((f) => f.relPath === pathOf(id)), { relPath: pathOf(id) }, "it waits, carried by no PR yet");
    const holder = w.ids.minted.find((m) => m.id === id)!.branch;
    const parsed = parseReservationHolderLine(formatReservationHolderLine({ branch: holder, startedAt: new Date(T0).toISOString() }));
    const presence = w.heads().includes(holder) ? "present" : "absent";
    assert.equal(presence, "present", "the holder is the landing branch, on the remote while its PR is open");
    const late = clockFromMillisFn(() => T0 + 30 * 24 * 3_600_000);
    assert.equal(reservationHolderDrift(parsed, presence, late), "held", "held for as long as the landing PR is open, however long");
    // The one gap: after a landing PR merges, its branch is absent until the next push (the sweep's next full pass,
    // or the next land of a task file). The reservation stays held for RESERVATION_PUSH_GRACE_MS of that gap.
    assert.equal(RESERVATION_PUSH_GRACE_MS, 2 * 3_600_000, "the longest absent gap a reservation is held: 2 hours");
    t.diagnostic(`longest gap with the landing branch absent that keeps the id held: ${RESERVATION_PUSH_GRACE_MS / 3_600_000} hours`);
    assert.equal(reservationHolderDrift(parsed, "absent", clockFromMillisFn(() => T0 + RESERVATION_PUSH_GRACE_MS - 1)), "held");
    assert.equal(reservationHolderDrift(parsed, "absent", clockFromMillisFn(() => T0 + RESERVATION_PUSH_GRACE_MS + 1)), "reclaimable");
  } finally {
    await second.dispose();
  }
});

/** A one-class garden that files one new task file per filing, through a checkout that files only task files. */
function filingGarden(w: ReturnType<typeof world>) {
  const cheap = { n: 0 };
  let opened = 0;
  const spec: GardenSpec<"file", { n: number }, GardenAction<"file">, GardenCheckout> = {
    name: "filing", classes: ["file"], decision: ["file"],
    cheapFingerprint: () => String(cheap.n), inventory: () => ({ n: cheap.n }), fingerprint: (i) => String(i.n),
    candidates: () => [{ class: "file", target: "a finding", reason: "the fixture finds it" }],
    scorecard: () => ({}),
    prepare: (ws, _plan, async) => prepareGardenTaskIds(ws, 1, w.ids.mint, async),
    apply: (ws, _plan, _scorecard, heldIds) => {
      const id = heldIds![0]!;
      writeFileSync(join(ws.root, pathOf(id)), shard(id));
      return { paths: [pathOf(id)], title: "chore(plan): file one task", body: fileBody(id) };
    },
  };
  const deps: GardenerDeps = {
    stateDir: w.stateDir, repoRoot: w.repo.dir, seed: 1, clock: w.clock,
    log: (step, extra = {}) => void w.rows.push({ ...extra, step }),
    openWorkspace: () => (opened++, gardenCheckoutAsync(w.checkoutOpts("flow-remedy", true))),
    prState: () => "open",
    escalate: () => "https://github.com/acme/remudero/issues/1",
    mergedPlanLint: () => undefined,
  };
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(gardenStatePath(w.stateDir, "filing"), JSON.stringify({ ...initialGardenState(["file"]), classes: { file: { alpha: 1000, beta: 1 } } }));
  const state = () => JSON.parse(readFileSync(gardenStatePath(w.stateDir, "filing"), "utf8")) as Record<string, unknown>;
  const pass = () => withLiveWritesAllowed(() => runGardenAsync(spec, deps));
  return { cheap, state, pass, opened: () => opened };
}

test("W1-T12222 criterion 5: a new file that the landing sets aside releases its id, and a new file that waits does not", async (t) => {
  const refused = world(t);
  refused.preflight.red.add("W1-T95001");
  await filingGarden(refused).pass();
  assert.deepEqual(refused.ids.minted.map((m) => m.id), ["W1-T95001"]);
  assert.equal(refused.staged().length, 0, "the refused file does not wait");
  assert.deepEqual(refused.ids.released, ["W1-T95001"], "its id is released through the gardener's release path");

  const waits = world(t);
  waits.seal();
  const g = filingGarden(waits);
  await g.pass();
  assert.deepEqual(waits.staged(), ["W1-T95001-fixture.yaml"], "the file waits behind the open landing PR");
  assert.deepEqual((g.state().waiting as { paths: string[] }).paths, [pathOf("W1-T95001")]);
  assert.deepEqual(waits.ids.released, [], "the id of a waiting file stays reserved");
});

test("W1-T12222 criterion 6: a gardener does not file the same finding twice while its file waits", async (t) => {
  const w = world(t);
  w.seal();
  const g = filingGarden(w);
  await g.pass();
  g.cheap.n = 1;
  await g.pass();
  assert.equal(g.opened(), 1, "no second checkout: the waiting lane plans nothing");
  assert.deepEqual(w.ids.minted.map((m) => m.id), ["W1-T95001"], "no second id is reserved");
  assert.deepEqual(w.staged(), ["W1-T95001-fixture.yaml"], "no second file is staged");
  const landing = await w.landWaiting();
  assert.deepEqual(landing.landed, [pathOf("W1-T95001")]);
  g.cheap.n = 2;
  await g.pass();
  assert.equal(w.gh.creates.length, 1);
  assert.equal((g.state().pending as { prUrl: string }).prUrl, w.gh.creates[0], "the landing PR that carries the file becomes the pending PR");
  assert.deepEqual(w.ids.minted.map((m) => m.id), ["W1-T95001"], "the finding is still filed once");
});

test("W1-T12222 criterion 7: a checkout that does not declare it opens its own pull request for a new task file, as it does today", async (t) => {
  const w = world(t);
  const ws = await gardenCheckoutAsync(w.checkoutOpts("gate", false));
  try {
    assert.match(ws.branch ?? "", /^gate-garden-\d+$/);
    const { result } = await fileOne(ws, w.ids.mint);
    assert.deepEqual([typeof result, result, w.gh.own.length], ["string", w.gh.own[0], 1], "the new task file opens its own PR");
    assert.deepEqual(w.ids.minted.map((m) => m.branch), [ws.branch], "the id is reserved against the garden branch");
    assert.ok(w.heads().includes(ws.branch!), "the garden branch is pushed");
    assert.equal(w.gh.creates.length, 0, "nothing rides the landing");
    assert.deepEqual(w.staged(), []);
  } finally {
    await ws.dispose();
  }
});

test("W1-T12222 criterion 8: `daemonGardenWorkspace` declares the route for the gardeners that file only task files", async (t) => {
  const w = world(t);
  const ctx = { config: { root: w.root } as Parameters<typeof daemonGardenWorkspace>[0]["config"], repoRoot: w.repo.dir, owner: "acme", repo: "remudero",
    log: (step: string, extra: Record<string, unknown> = {}) => void w.rows.push({ ...extra, step }) };
  const landingBranch = await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero" });
  // Every land of these four is a task file, and their pass is `runGardenAsync`, which holds a wait.
  const declared: GardenName[] = ["ci-friction", "hot-file", "flow-remedy", "scout"];
  // The gate gardener also lands ci-gate.yml rows. flow, selector-shadow (with flake-incident) and host-resource read
  // a land through `landedPrUrl`, which refuses a wait, so they keep their own PR. plan files no new task.
  const own: GardenName[] = ["gate", "flow", "selector-shadow", "host-resource", "plan"];
  for (const name of [...declared, ...own]) {
    const ws = await daemonGardenWorkspace(ctx, name)();
    try {
      if (declared.includes(name)) {
        assert.equal(ws.branch, landingBranch, `${name} reserves on the landing branch`);
        writeFileSync(join(ws.root, "docs/notes.txt"), "# notes\n\ntended\n");
        const out = await withLiveWritesAllowed(() => ws.land({ paths: ["docs/notes.txt"], title: "chore(docs): tend the notes", body: fileBody("W1-T95999") }));
        assert.equal(out, undefined, `${name} refuses a path outside plan/tasks.d`);
      } else {
        assert.match(ws.branch ?? "", new RegExp(`^${name}-garden-\\d+$`), `${name} keeps its own branch`);
      }
    } finally {
      await ws.dispose();
    }
  }
  assert.deepEqual(w.heads(), ["main"], "no refused land pushed anything");
  assert.deepEqual(w.steps("scout.garden_sealed_landing").map((r) => r.outcome), ["refused"]);
});
