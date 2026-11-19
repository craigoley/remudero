import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  landingIdentity,
  landPlanReconcileShards,
  landPlanReconcileShardsAsync,
  planReconcileLanding,
  type LandContentInput,
  type LandFeedbackAsyncOpts,
  type LandFeedbackResult,
  type LandingRepository,
  type PlanReconcileLand,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "#src/lib/measurement-cadence.js";
import { reconcileShardStatus } from "#src/lib/plan-reconcile.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T13816: the cadence reads shards from the daemon's own checkout, which can lag origin/main.
// Each test reads a shard from a stale clone, lets main change it, and lands against a real bare
// origin through the production cadence input. Only `gh` and the PR preflight are faked.

const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t13816-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const ok = () => ({ ok: true, failures: [], unreadable: [] });
const FIXTURE_PR = "https://github.com/o/r/pull/13816";
const ghRoutes = [{ when: "pr list", stdout: "[]" }, { when: "pr create", stdout: FIXTURE_PR }];

// W1-T13790's shard at its filing (b3cf1e609) and after the #19632 amendment (b4c0f5757), trimmed
// to the lines around both amendment hunks; the acceptance block is left out.
const T13790 = "plan/tasks.d/W1-T13790-a-failing-file-is-the-one-its-own-tap-block-names.yaml";
const T13790_FILED = [
  "- id: W1-T13790",
  "  title: \"A red's failing test file is the one its own top-level TAP block names, never a test path quoted in its error text, so base reproduction, head reproduction and main bisection run the file that failed\"",
  "  repo: remudero",
  "  depends_on: []",
  "  priority: 1",
  "  type: implement",
  "  verify: auto",
  "  origin: \"operator-session#main-red-19469-2026-11-18\"",
  "  files:",
  "    - src/lib/base-reproduction.ts",
  "    - scripts/test-with-retry.mjs",
  "    - test/a-failing-file-is-the-one-its-own-tap-block-names.test.ts",
  "  status: queued",
  "  attempts: 0",
  "  design: |",
  "    4. No change to decideBaseReproduction, localProbeVerdict or the rung.",
  "    5. The test uses the measured excerpt (lines from job 135054821069, trimmed to the two failure blocks",
  "       and the FLAKE-RETRY lines) as a fixture string.",
  "  falsifier: |",
  "    Keep today's free-text read for TAP tails: criteria 1, 2 and 6 fail. Keep matching any location: text",
  "",
].join("\n");
const AMENDED_FILES_ENTRY = "    - test/a-red-the-pr-caused-is-fixed-not-refreshed.test.ts";
const AMENDED_NOTE = [
  "    AMENDED (2026-11-19): test/a-red-the-pr-caused-is-fixed-not-refreshed.test.ts (PR 14196 tests 15 and 16) used a",
  "    tail `not ok 6 - FILE` then `ok 7 - OTHER` and passed only because the free-text read counted the passing OTHER;",
  "    under the column-0 rule its OTHER line becomes `not ok 7 - OTHER`, keeping what those tests assert.",
].join("\n");
const T13790_AMENDED = T13790_FILED
  .replace("    - test/a-failing-file-is-the-one-its-own-tap-block-names.test.ts\n",
    `    - test/a-failing-file-is-the-one-its-own-tap-block-names.test.ts\n${AMENDED_FILES_ENTRY}\n`)
  .replace("       and the FLAKE-RETRY lines) as a fixture string.\n", `       and the FLAKE-RETRY lines) as a fixture string.\n${AMENDED_NOTE}\n`);

const shard = (id: string, status = "queued", extra = ""): string => `- id: ${id}\n  title: ${id} fixture\n  status: ${status}\n${extra}`;
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const idOf = (path: string): string => path.match(/(W1-T\d+)/)![1];
const flip = (text: string): string => {
  const out = reconcileShardStatus(text, idOf(text), () => true).text;
  assert.ok(out !== undefined);
  return out;
};

interface World {
  origin: GitRepo;
  seed: GitRepo;
  /** Write (or, with `null`, delete) files on main and push them. */
  main(files: Record<string, string | null>, message: string): string;
  pending(files: Record<string, string>): void;
  /** A checkout cut from origin now: it never moves again, like the daemon's lagging checkout. */
  laggingCopy(): string;
  blob(ref: string, path: string): string | undefined;
}

function world(kind: string): World {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  function commit(repo: GitRepo, files: Record<string, string | null>, message: string): void {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(repo.dir, path);
      if (content === null) rmSync(abs);
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", message);
  }
  return {
    origin,
    seed,
    main(files, message) {
      commit(seed, files, message);
      seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
      return seed.git("rev-parse", "HEAD");
    },
    pending(files) {
      const repo = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-pending` });
      commit(repo, files, "prior reconcile");
      repo.git("push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
    },
    laggingCopy() {
      return gitRepo({ cloneFrom: origin.dir, kind: `${kind}-checkout` }).dir;
    },
    blob(ref, path) {
      try {
        return execFileSync("git", ["-C", origin.dir, "cat-file", "-p", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return undefined;
      }
    },
  };
}

/** The production composition: read shards from the checkout, decide with the credit, land through the real landing. */
async function reconcileFromLaggingCopy(
  checkout: string,
  paths: readonly string[],
  opts: { sync?: boolean; preflight?: (sha: string) => void } = {},
): Promise<{ results: LandFeedbackResult[]; inputs: LandContentInput[][]; drift: number }> {
  const results: LandFeedbackResult[] = [];
  const inputs: LandContentInput[][] = [];
  const preflight = (sha: string) => {
    opts.preflight?.(sha);
    return ok();
  };
  const lander: PlanReconcileLand = (root, batch, landOpts) => {
    inputs.push([...batch]);
    if (opts.sync) {
      const landed = landPlanReconcileShards(root, batch, { ...landOpts, planPrPreflight: preflight });
      results.push(landed);
      return landed;
    }
    return landPlanReconcileShardsAsync(root, batch, landOpts).then((r) => (results.push(r), r));
  };
  const landOpts = (): LandFeedbackAsyncOpts => ({
    targetRepository: TARGET,
    landingOwner: OWNER,
    planPrPreflight: async (sha) => preflight(sha),
  });
  const landing = planReconcileLanding(checkout, landOpts, lander);
  const cadence = buildPlanReconcileCadenceInput({
    checkoutRoot: checkout,
    readShards: () => paths.map((rel) => ({ taskId: idOf(rel), path: join(checkout, rel), text: readFileSync(join(checkout, rel), "utf8") })),
    creditedMergedIds: () => new Set(paths.map(idOf)),
    threshold: 1,
    lint: () => new Map(),
    land: landing.land,
  });
  const report = await withGhShim(ghRoutes, () => withLiveWritesAllowed(async () => {
    const r = planReconcileCadence(cadence);
    await landing.settled();
    return r;
  }));
  assert.equal(results[0]?.prUrl, FIXTURE_PR);
  return { results, inputs, drift: report.drift };
}

/** Lines the landing tip adds or removes against main for one path, without diff headers. */
function changedLines(w: World, path: string): string[] {
  return w.origin.git("diff", "--unified=0", "main", BRANCH, "--", path).split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
}

test("W1-T13816 criterion 1: the W1-T13790 amendment that merged after the read survives the reconcile", async () => {
  const w = world("t13816-c1");
  w.main({ [T13790]: T13790_FILED }, "file W1-T13790");
  const checkout = w.laggingCopy();
  w.main({ [T13790]: T13790_AMENDED }, "amend W1-T13790 (#19632)");
  assert.equal(readFileSync(join(checkout, T13790), "utf8"), T13790_FILED, "the checkout still holds the filing version");

  const { results, inputs } = await reconcileFromLaggingCopy(checkout, [T13790], { sync: true });

  assert.equal(results.length, 1);
  assert.equal(results[0].landed, true, results[0].error);
  assert.equal(results[0].refused, undefined);
  assert.equal(inputs[0][0].content, flip(T13790_FILED), "the cadence's own flip is of the stale read");
  const landed = w.blob(BRANCH, T13790) ?? "";
  assert.match(landed, /^ {2}status: merged$/m);
  assert.ok(landed.includes(`${AMENDED_FILES_ENTRY}\n`), "the amended files entry is still there");
  assert.ok(landed.includes(AMENDED_NOTE), "the AMENDED (2026-11-19) note is still there");
  assert.equal(landed, flip(T13790_AMENDED));
});

test("W1-T13816 criterion 2: each landed shard differs from main by exactly the status line", async () => {
  const w = world("t13816-c2");
  const moved = pathOf("W1-T501"), still = pathOf("W1-T502"), earlier = pathOf("W1-T503");
  w.main({ [moved]: shard("W1-T501"), [still]: shard("W1-T502"), [earlier]: shard("W1-T503") }, "base");
  const checkout = w.laggingCopy();
  w.main({
    [moved]: shard("W1-T501", "queued", "  note: |\n    main's amendment after the read\n"),
    [earlier]: shard("W1-T503", "queued", "  note: main amended a shard outside this batch\n"),
  }, "main amends two shards");
  w.pending({ [moved]: shard("W1-T501", "merged"), [still]: shard("W1-T502", "merged"), [earlier]: shard("W1-T503", "merged") });

  const { results } = await reconcileFromLaggingCopy(checkout, [moved, still]);

  assert.equal(results[0].landed, true, results[0].error);
  assert.equal(results[0].pushed, true, "the stale landing tip was replaced");
  assert.deepEqual(w.origin.git("diff", "--name-only", "main", BRANCH).split("\n").sort(), [moved, still]);
  for (const path of [moved, still]) {
    assert.deepEqual(changedLines(w, path), ["-  status: queued", "+  status: merged"], path);
  }
});

test("W1-T13816 criterion 3: a shard main moved off queued, retired or deleted is refused by name, the rest land", async () => {
  const w = world("t13816-c3");
  const running = pathOf("W1-T601"), retired = pathOf("W1-T602"), gone = pathOf("W1-T603"), fine = pathOf("W1-T604");
  w.main({ [running]: shard("W1-T601"), [retired]: shard("W1-T602"), [gone]: shard("W1-T603"), [fine]: shard("W1-T604") }, "base");
  const checkout = w.laggingCopy();
  w.main({
    [running]: shard("W1-T601", "running"),
    [retired]: shard("W1-T602", "queued", "  retirement: superseded\n"),
    [gone]: null,
  }, "main changes three shards after the read");
  w.pending({ [running]: shard("W1-T601", "merged"), [retired]: shard("W1-T602", "merged"), [gone]: shard("W1-T603", "merged") });

  const { results } = await reconcileFromLaggingCopy(checkout, [running, retired, gone, fine]);

  const [result] = results;
  assert.equal(result.landed, true, result.error);
  assert.deepEqual(result.files, [fine]);
  assert.deepEqual(result.refused?.map((r) => r.path).sort(), [running, retired, gone].sort());
  for (const r of result.refused ?? []) assert.ok(r.reason.includes(r.path), `the reason names ${r.path}: ${r.reason}`);
  assert.match(result.refused?.find((r) => r.path === gone)?.reason ?? "", /main no longer has/);
  assert.match(result.refused?.find((r) => r.path === running)?.reason ?? "", /status-not-queued/);
  assert.match(result.refused?.find((r) => r.path === retired)?.reason ?? "", /retired/);
  assert.deepEqual(w.origin.git("diff", "--name-only", "main", BRANCH).split("\n"), [fine]);
  assert.equal(w.blob(BRANCH, running), shard("W1-T601", "running"), "main's status stands");
  assert.equal(w.blob(BRANCH, retired), shard("W1-T602", "queued", "  retirement: superseded\n"), "main's retirement stands");
  assert.equal(w.blob(BRANCH, gone), undefined, "main's deletion stands");
});

test("W1-T13816 criterion 4: the rebuild after a lost lease edits main's newer text", async () => {
  const w = world("t13816-c4");
  const path = pathOf("W1-T701");
  const firstMain = w.main({ [path]: shard("W1-T701") }, "base");
  const checkout = w.laggingCopy();
  const amended = shard("W1-T701", "queued", "  note: first amendment\n");
  const secondMain = shard("W1-T701", "queued", "  note: first amendment\n  plan_refs:\n    - W1-T1\n");
  w.main({ [path]: amended }, "main amends before the first build");
  const shas: string[] = [];
  const builds: string[] = [];
  const preflight = (sha: string): void => {
    shas.push(sha);
    builds.push(execFileSync("git", ["-C", checkout, "cat-file", "-p", `${sha}:${path}`], { encoding: "utf8" }));
    if (shas.length !== 1) return;
    // Between the first tree build and its push: main changes the shard again and the landing
    // branch appears, so the leased push fails and the landing rebuilds its tree.
    w.main({ [path]: secondMain }, "main amends again before the push");
    w.seed.git("push", "--quiet", "origin", `${firstMain}:refs/heads/${BRANCH}`);
  };

  const { results } = await reconcileFromLaggingCopy(checkout, [path], { preflight });

  const [result] = results;
  assert.equal(result.landed, true, result.error);
  assert.equal(shas.length, 2, "the push was leased, lost, rebuilt and pushed again");
  assert.ok(result.leaseMoved, "the result records the moved lease");
  assert.deepEqual(builds, [flip(amended), flip(secondMain)], "each tree build edited main's text at that build");
  assert.equal(w.blob(BRANCH, path), flip(secondMain), "the rebuilt tree holds main's newer text with only the status line changed");
  assert.deepEqual(changedLines(w, path), ["-  status: queued", "+  status: merged"]);
});

test("W1-T13816 criterion 5: an input with no edit stages its content as today", async () => {
  const w = world("t13816-c5");
  const path = pathOf("W1-T801"), pendingPath = pathOf("W1-T802");
  w.main({ [path]: shard("W1-T801") }, "base");
  const root = w.laggingCopy();
  w.main({ [path]: shard("W1-T801", "queued", "  note: main's edit\n") }, "main edits the shard");
  // The ops-catalog reconcile's shape: bytes it read at its pinned commit, no edit.
  const content = shard("W1-T801", "merged");
  const pending = shard("W1-T802", "merged");
  w.pending({ [pendingPath]: pending });

  const result = await withGhShim(ghRoutes, () => withLiveWritesAllowed(() => landPlanReconcileShardsAsync(root, [{ relPath: path, content }], {
    targetRepository: TARGET,
    landingOwner: OWNER,
    planPrPreflight: async () => ok(),
  })));

  assert.equal(result.landed, true, result.error);
  assert.equal(result.prUrl, FIXTURE_PR);
  assert.equal(result.refused, undefined);
  assert.equal(w.blob(BRANCH, path), content, "the given bytes land unchanged; main's copy is not read");
  assert.equal(w.blob(BRANCH, pendingPath), pending, "the no-edit landing still carries its earlier content");
});

test("W1-T13816 criterion 6: invariant main-text-only, no staged byte comes from the copy the cadence read", async () => {
  const w = world("t13816-c6");
  const ids = ["W1-T901", "W1-T902", "W1-T903", "W1-T904"];
  const readCopy = (id: string): string => shard(id, "queued", `  note: READ-COPY-ONLY ${id}\n`);
  w.main(Object.fromEntries(ids.map((id) => [pathOf(id), readCopy(id)])), "base");
  const checkout = w.laggingCopy();
  const onMain: Record<string, string> = {
    "W1-T901": shard("W1-T901", "queued", "  note: main rewrote the note\n"),
    "W1-T902": `- id: W1-T902\n  files:\n    - src/main-only.ts\n  status: queued\n  title: W1-T902 reordered on main\n`,
    "W1-T903": shard("W1-T903", "queued", "  note: READ-COPY-ONLY W1-T903\n  attempts: 2\n"),
    "W1-T904": shard("W1-T904"),
  };
  w.main(Object.fromEntries(ids.map((id) => [pathOf(id), onMain[id]])), "main changes every shard after the read");
  const stalePending = pathOf("W1-T905"), goodPending = pathOf("W1-T906");
  const missingPending = pathOf("W1-T907"), retiredPending = pathOf("W1-T908");
  const pendingMain = shard("W1-T905", "queued", "  note: main amended a prior batch\n");
  const goodMain = shard("W1-T906", "queued", "  note: valid pending status edit\n");
  const retiredMain = shard("W1-T908", "queued", "  retirement: superseded\n");
  w.main({ [stalePending]: pendingMain, [goodPending]: goodMain, [retiredPending]: retiredMain }, "file shards outside this batch");
  w.pending({
    [stalePending]: flip(readCopy("W1-T905")),
    [goodPending]: flip(goodMain),
    [missingPending]: shard("W1-T907", "merged"),
    [retiredPending]: shard("W1-T908", "merged", "  retirement: superseded\n"),
  });

  const { results, inputs } = await reconcileFromLaggingCopy(checkout, ids.map(pathOf));

  assert.equal(results[0].landed, true, results[0].error);
  assert.equal(inputs[0].length, ids.length);
  assert.equal(w.blob(BRANCH, stalePending), pendingMain, "an earlier landing's stale bytes are excluded");
  assert.equal(w.blob(BRANCH, goodPending), flip(goodMain), "an earlier status-only edit is retained");
  assert.equal(w.blob(BRANCH, missingPending), undefined, "pending carry cannot add a missing shard");
  assert.equal(w.blob(BRANCH, retiredPending), retiredMain, "pending carry cannot flip a retired shard");
  for (const input of inputs[0]) assert.equal(typeof input.edit, "function", `${input.relPath} carries the status edit`);
  for (const id of ids) {
    const landed = w.blob(BRANCH, pathOf(id)) ?? "";
    assert.equal(landed, reconcileShardStatus(onMain[id], id, () => true).text, `${id} is the edit of main's text`);
    for (const line of readCopy(id).split("\n").filter((l) => l !== "" && !onMain[id].split("\n").includes(l) && !/status:/.test(l))) {
      assert.ok(!landed.includes(line), `${id} holds no read-only line: ${line}`);
    }
  }
});
