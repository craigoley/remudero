// W1-T14657. A garden landing the plan-PR preflight refuses used to come back as `undefined`: the gardener knew only
// that "the PR did not open" and bisected the draft, one halving per pass, to find the action to drop; and a sealed
// landing of several task files that set one aside reported the whole landing as not landed. These suites drive the
// real plan gardener spec (the preflight's verdict stands in as the checkout's land result) and the production sealed
// landing over real git (a fake GitHub and a fake preflight verdict).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn, type Clock } from "#src/lib/clock.js";
import { gardenStatePath, isGardenLandRefused, runGarden, type GardenCheckout, type GardenerDeps, type GardenLandOpts, type GardenLandResult } from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { planGardenSpec } from "#src/lib/plan-gardener.js";
import { makeTempDir, RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { gardenCheckoutAsync, type GardenCheckoutOpts, type GardenName } from "#test/helpers/run-task-test.js";

const HOUR = 3_600_000;
const shardOf = (id: string) => `plan/tasks.d/${id}-x.yaml`;
const ids = (paths: readonly string[]) => paths.map((p) => /tasks\.d\/(W1-T\d+)-/.exec(p)![1]!);
const shard = (id: string, retirement?: string) => [
  `- id: ${id}`, `  title: "the task ${id}"`, "  repo: remudero", `  depends_on: [${id === "W1-T1" ? "" : "W1-T1"}]`, "  type: implement",
  `  status: ${retirement ? "blocked" : "queued"}`, ...(retirement ? [`  retirement: ${retirement}`] : []), "  files: [src/lib/x.ts]",
  "  acceptance:", '    - claim: "c"', `      proof: 'grep: never-written-${id} in src/lib/x.ts'`, "",
].join("\n");

interface Landing { paths: string[]; pr?: string }

/** A plan repository whose W1-T1 was retired, so every queued task depending on it is a `retire` candidate. */
function world(taskIds: string[]) {
  const repo = gitRepo({ kind: "w1-t14657-plan" });
  const root = repo.dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, shardOf("W1-T1")), shard("W1-T1", "retired"));
  for (const id of taskIds) writeFileSync(join(root, shardOf(id)), shard(id));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "file the tasks");
  writeFileSync(join(root, "state", "PLAN_OFF-merge"), "");
  writeFileSync(gardenStatePath(join(root, "state"), "plan"), JSON.stringify({ classes: { merge: { alpha: 3, beta: 1 }, retire: { alpha: 1000, beta: 1 } } }));
  let nowMs = Date.parse("2026-11-24T00:00:00Z");
  const clock: Clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  const lands: Landing[] = [];
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const merged = new Set<string>();
  const w = {
    root, lands, rows,
    /** What the checkout's land answers for a landing; the default opens a PR. */
    answer: (l: Landing): GardenLandResult => l.pr,
    merge: (l: Landing) => void merged.add(l.pr!),
    state: () => JSON.parse(readFileSync(gardenStatePath(join(root, "state"), "plan"), "utf8")) as Record<string, unknown>,
    steps: (step: string) => rows.filter((r) => r.step === step),
    pass: () => {
      nowMs += 25 * HOUR;
      return runGarden(spec, deps);
    },
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => void rows.push({ ...extra, step }),
    mergedPlanLint: () => undefined,
    prState: (url) => (merged.has(url) ? "merged" : "open"),
    openWorkspace: (): GardenCheckout => {
      const ws = join(makeTempDir("w1-t14657-checkout"), "tree");
      cpSync(join(root, "plan"), join(ws, "plan"), { recursive: true });
      return {
        root: ws,
        land: (o: GardenLandOpts) => {
          const l: Landing = { paths: [...o.paths].sort() };
          lands.push(l);
          const answered = w.answer(l);
          if (typeof answered === "string") l.pr = answered;
          return answered as string | undefined;
        },
        dispose: () => {},
      };
    },
  };
  let tick = 0;
  const spec = { ...planGardenSpec(deps), cheapFingerprint: () => String(++tick) };
  return w;
}

const refusal = (id: string) => ({ path: shardOf(id), reason: `the plan-PR preflight refused ${id}`, task_ids: [id] });

test("W1-T14657 criterion 1: a landing the preflight refuses names the task ids and paths, and the next pass drafts every other action with no bisection", () => {
  const w = world(["W1-T2", "W1-T3", "W1-T4"]);
  w.answer = (l) => {
    if (!l.paths.includes(shardOf("W1-T4"))) return `https://github.com/acme/remudero/pull/${100 + w.lands.length}`;
    return { refused: [refusal("W1-T4")] };
  };
  w.pass();
  assert.deepEqual(w.lands.map((l) => ids(l.paths)), [["W1-T2", "W1-T3", "W1-T4"]], "the pass drafts every retirement as one landing");
  const state = w.state() as { refusedActions?: Record<string, { path?: string }>; refusedSuspects?: unknown; filingFailures?: unknown };
  assert.deepEqual(Object.keys(state.refusedActions ?? {}), ["retire:W1-T4"], "only the action the preflight named is refused");
  assert.equal(state.refusedActions!["retire:W1-T4"]!.path, shardOf("W1-T4"));
  assert.equal(state.refusedSuspects, undefined, "no bisection starts");
  assert.equal(state.filingFailures, undefined, "a preflight refusing the check's own finding is no filing failure");
  assert.deepEqual(w.steps("plan.garden_landing_preflight_refused").map((r) => [r.paths, r.task_ids]), [[[shardOf("W1-T4")], ["W1-T4"]]]);
  w.pass();
  assert.deepEqual(w.lands.map((l) => ids(l.paths)), [["W1-T2", "W1-T3", "W1-T4"], ["W1-T2", "W1-T3"]], "the very next pass lands exactly the others");
  assert.ok(w.lands[1]!.pr !== undefined);
  assert.equal(w.steps("plan.garden_refusal_bisected").length, 0, "no pass bisected");
});

test("W1-T14657 criterion 2: a landing that opened for the paths it did not refuse keeps the refused action refused", () => {
  const w = world(["W1-T2", "W1-T3", "W1-T4"]);
  w.answer = () => ({ opened: "https://github.com/acme/remudero/pull/77", refused: [refusal("W1-T4")] });
  const pass = w.pass();
  assert.equal((pass as { prUrl?: string }).prUrl, "https://github.com/acme/remudero/pull/77", "the pass opened the landing PR for the others");
  const state = w.state() as { refusedActions?: Record<string, unknown>; pending?: { prUrl: string }; lastPass?: { fingerprint: string; landed?: string } };
  assert.equal(state.pending?.prUrl, "https://github.com/acme/remudero/pull/77");
  assert.deepEqual(Object.keys(state.refusedActions ?? {}), ["retire:W1-T4"], "landing the others does not clear the refused action");
});

test("W1-T14657 criterion 3: a refusal naming no action of the landing attributes nothing, and the filing fails as before", () => {
  const w = world(["W1-T2", "W1-T3"]);
  w.answer = () => ({ refused: [{ path: shardOf("W1-T9"), reason: "elsewhere", task_ids: ["W1-T9"] }] }) as unknown as GardenLandResult;
  w.pass();
  const state = w.state() as { refusedActions?: unknown; filingFailures?: { count: number } };
  assert.equal(state.refusedActions, undefined);
  assert.equal(state.filingFailures?.count, 1);
  assert.equal(w.steps("plan.garden_filing_failed").length, 1);
});

// ── the production sealed landing ──

const A = "W1-T90001";
const B = "W1-T90002";
const C = "W1-T90003";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const fixture = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

function sealedWorld(t: TestContext, red: Set<string>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14657-`));
  const origin = gitRepo({ bare: true, kind: "w1-t14657-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t14657-author" });
  for (const id of [A, B, C]) {
    mkdirSync(join(author.dir, "plan/tasks.d"), { recursive: true });
    writeFileSync(join(author.dir, pathOf(id)), fixture(id));
  }
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t14657-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => {
    for (const r of [origin, author, repo]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const creates: string[] = [];
  let open: Array<{ url: string }> = [];
  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(open);
    if (args[0] === "pr" && args[1] === "create") {
      creates.push(`https://github.com/acme/remudero/pull/${9000 + creates.length + 1}`);
      open = [{ url: creates.at(-1)! }];
      return creates.at(-1)!;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
    return "[]";
  };
  const planPrPreflight = async (_sha: string, pr: { body: string }): Promise<PlanPrPreflightResult> => {
    const id = [...red].find((r) => pr.body.includes(pathOf(r)));
    return id === undefined ? GREEN : { ok: false, failures: [{ check: "proof-discrimination", firstLine: `✗ ${id}: the proof does not discriminate`, task_ids: [id] }], unreadable: [] };
  };
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const opts: GardenCheckoutOpts = {
    name: "plan" as GardenName, repoDir: repo.dir, worktreesRoot: join(root, "worktrees"), owner: "acme", repo: "remudero",
    log: (step, extra = {}) => void rows.push({ ...extra, step }), clock: clockFromMillisFn(() => Date.parse("2026-11-11T12:00:00.000Z")),
    preflight: () => GREEN, fetcher: async () => ({ html_url: "https://github.com/acme/remudero/pull/700", number: 700 }),
    taskFilesLanding: { stateRoot: root, gh, planPrPreflight },
  };
  return { opts, creates, rows };
}

const tendBody = (...rels: string[]): string => `Tend task files.\n\n## Acceptance\n${rels.map((r) => `- claim: ${r} is tended\n  proof: grep: # tended in ${r}`).join("\n")}`;

test("W1-T14657 criterion 4: a sealed landing of several task files lands the paths it did not refuse and returns the refused ids and paths", async (t) => {
  const w = sealedWorld(t, new Set([B]));
  const ws = await gardenCheckoutAsync(w.opts);
  try {
    for (const id of [A, B, C]) writeFileSync(join(ws.root, pathOf(id)), `${readFileSync(join(ws.root, pathOf(id)), "utf8")}  # tended\n`);
    const paths = [A, B, C].map(pathOf);
    const result = await withLiveWritesAllowed(() => ws.land({ paths, title: "chore(plan): tend task files", body: tendBody(...paths) }));
    assert.ok(isGardenLandRefused(result), `the land reports a refusal, not ${JSON.stringify(result)}`);
    assert.equal(result.opened, w.creates[0], "the paths it did not refuse opened the landing PR");
    assert.deepEqual(result.refused.map((r) => [r.path, r.task_ids]), [[pathOf(B), [B]]], "the refused path and its task id come back");
    const landed = w.rows.filter((r) => r.step === "plan.garden_sealed_landing");
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.outcome, "opened");
    assert.equal(existsSync(join(ws.root, pathOf(B))), true);
  } finally {
    await ws.dispose();
  }
});

test("W1-T14657 criterion 4: a sealed landing whose every path is refused opens nothing and returns each refusal", async (t) => {
  const w = sealedWorld(t, new Set([A, B]));
  const ws = await gardenCheckoutAsync(w.opts);
  try {
    // Other bytes than the first test's: the landing remembers the trees it found green, process-wide.
    for (const id of [A, B]) writeFileSync(join(ws.root, pathOf(id)), `${readFileSync(join(ws.root, pathOf(id)), "utf8")}  # tended again\n`);
    const paths = [A, B].map(pathOf);
    const result = await withLiveWritesAllowed(() => ws.land({ paths, title: "chore(plan): tend task files", body: tendBody(...paths) }));
    assert.ok(isGardenLandRefused(result));
    assert.equal(result.opened, undefined);
    assert.deepEqual(result.refused.map((r) => r.path).sort(), paths.sort());
    assert.equal(w.creates.length, 0, "no PR opened");
  } finally {
    await ws.dispose();
  }
});

test("W1-T14657 criterion 5: a new task file the commit-time preflight refuses comes back as its path and task id; a red naming no landed task stays unlanded", async (t) => {
  const NEW = "W1-T90009";
  const red = (id: string): PlanPrPreflightResult => ({ ok: false, failures: [{ check: "lint-plan", firstLine: `✗ ${id}: refused`, task_ids: [id] }], unreadable: [] });
  for (const [named, expected] of [[NEW, { refused: [{ path: pathOf(NEW), reason: `the plan-PR preflight refused ${NEW}`, task_ids: [NEW] }] }], ["W1-T99999", undefined]] as const) {
    const w = sealedWorld(t, new Set());
    const ws = await gardenCheckoutAsync({ ...w.opts, preflight: () => red(named) });
    try {
      writeFileSync(join(ws.root, pathOf(NEW)), fixture(NEW));
      const result = await withLiveWritesAllowed(() => ws.land({ paths: [pathOf(NEW)], title: "chore(plan): file a task", body: tendBody(pathOf(NEW)) }));
      assert.deepEqual(result, expected);
    } finally {
      await ws.dispose();
    }
  }
});
