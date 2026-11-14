import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  gardenStatePath,
  readGardenState,
  runGarden,
  runGardenAsync,
  type GardenAction,
  type GardenCheckout,
  type GardenCheckoutAsync,
  type GardenSpec,
} from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import * as worker from "#src/lib/worker.js";
import * as gardens from "#test/helpers/run-task-test.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

type Row = [string, Record<string, unknown> | undefined];
const PR = "https://github.com/acme/demo/pull/12550";

/** A temporary origin, a clone of it, and garden checkout options over that clone. */
function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12550-`));
  const origin = gitRepo({ bare: true, kind: "t12550-origin" });
  const seed = gitRepo({ kind: "t12550-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "t12550-clone" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const rows: Row[] = [];
  const opts: gardens.GardenCheckoutOpts = {
    name: "plan", repoDir: repo.dir, worktreesRoot: join(root, "worktrees"),
    owner: "acme", repo: "demo", clock: fixedClock(1794620000000),
    log: (step, extra) => { rows.push([step, extra]); },
    preflight: () => ({ ok: true, failures: [], unreadable: [] }),
  };
  const bin = join(root, "bin");
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  /** A git on PATH whose `worktree remove` fails with `stderr`; every other git call is the real one. */
  const stderrFile = join(root, "remove-stderr");
  const failingRemove = (stderr: string) => {
    writeFileSync(stderrFile, `${stderr}\n`);
    writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  *"worktree remove"*) cat '${stderrFile}' >&2; exit 128 ;;
  *) exec '${realGit}' "$@" ;;
esac
`, { mode: 0o755 });
  };
  return {
    name, root, repo, opts, rows, bin, failingRemove,
    close: () => {
      [origin, seed, repo].forEach((item) => item.cleanup());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function withPath<T>(dir: string, run: () => T): T {
  const prior = process.env.PATH;
  process.env.PATH = [dir, prior].join(":");
  const restore = () => {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

/** Remove the garden's worktree behind its back, the way a prune or a janitor does. */
function removeBehindItsBack(repoDir: string, root: string): void {
  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", root], { stdio: "ignore" });
}

describe("test/gardeners/garden-worktree-cleanup-treats-is-not-a-working-tree-as-already-removed.test.ts", () => {
  test("W1-T12550 criterion 1: an async garden checkout whose tree is already gone disposes without an error", async () => {
    const f = fixture("async");
    try {
      const ws = await gardens.gardenCheckoutAsync(f.opts);
      assert.ok(existsSync(worker.worktreeBasePath(ws.root)));
      removeBehindItsBack(f.repo.dir, ws.root);
      assert.equal(existsSync(ws.root), false);
      await ws.dispose();
      assert.equal(existsSync(worker.worktreeBasePath(ws.root)), false, "the base record dies with its tree");
      assert.deepEqual(f.rows.filter(([step]) => step === "plan.garden_worktree_already_removed"), [["plan.garden_worktree_already_removed", { path: ws.root }]]);

      const second = await gardens.gardenCheckoutAsync({ ...f.opts, clock: fixedClock(1794620000001) });
      removeBehindItsBack(f.repo.dir, second.root);
      mkdirSync(second.root);
      writeFileSync(join(second.root, "left-behind.txt"), "a killed add\n");
      await second.dispose();
      assert.equal(existsSync(second.root), false, "an unregistered directory at the garden's own path is removed");
    } finally { f.close(); }
  });

  test("W1-T12550 criterion 1: a sync garden checkout whose tree is already gone disposes without an error", () => {
    const f = fixture("sync");
    try {
      const ws = gardens.gardenCheckout(f.opts);
      removeBehindItsBack(f.repo.dir, ws.root);
      ws.dispose();
      assert.equal(existsSync(ws.root), false);
      assert.equal(existsSync(worker.worktreeBasePath(ws.root)), false);
      assert.equal(f.rows.filter(([step]) => step === "plan.garden_worktree_already_removed").length, 1);
    } finally { f.close(); }
  });

  test("W1-T12550 criterion 2: a locked tree, another path's absence and any other git error still throw from dispose", async () => {
    const f = fixture("guard");
    try {
      const ws = await gardens.gardenCheckoutAsync(f.opts);
      f.repo.git("worktree", "lock", "--reason", "held by a fixture", ws.root);
      await assert.rejects(ws.dispose(), /locked/);
      assert.ok(existsSync(ws.root), "a locked tree is left in place");
      f.repo.git("worktree", "unlock", ws.root);

      f.failingRemove("fatal: '/somewhere/else' is not a working tree");
      await withPath(f.bin, () => assert.rejects(ws.dispose(), /'\/somewhere\/else' is not a working tree/));
      f.failingRemove("fatal: unable to remove: timed out");
      await withPath(f.bin, () => assert.rejects(ws.dispose(), /timed out/));
      assert.ok(existsSync(ws.root), "no other failure removes the tree");
      assert.equal(f.rows.some(([step]) => step === "plan.garden_worktree_already_removed"), false);
      await ws.dispose();
      assert.equal(existsSync(ws.root), false);

      const sync = gardens.gardenCheckout({ ...f.opts, clock: fixedClock(1794620000002) });
      f.repo.git("worktree", "lock", sync.root);
      assert.throws(() => sync.dispose(), /locked/);
      f.repo.git("worktree", "unlock", sync.root);
      f.failingRemove("fatal: unable to remove: timed out");
      withPath(f.bin, () => assert.throws(() => sync.dispose(), /timed out/));
      sync.dispose();
    } finally { f.close(); }
  });

  type Class = "tend";
  const action: GardenAction<Class> = { class: "tend", target: "change.txt", reason: "fixture" };
  function passFixture(name: string) {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12550-pass-`));
    const rows: Row[] = [];
    let landed = true;
    const spec: GardenSpec<Class, null, GardenAction<Class>, GardenCheckout> = {
      name, classes: ["tend"],
      cheapFingerprint: () => "same", inventory: () => null, fingerprint: () => "same",
      metric: () => ({ trials: 0, successes: 0 }),
      candidates: () => [action], scorecard: () => ({}),
      apply: (ws) => {
        if (!landed) return undefined;
        writeFileSync(join(ws.root, "change.txt"), "tended\n");
        return { paths: ["change.txt"], title: "chore(plan): tend the fixture", body: "fixture" };
      },
    };
    const deps = {
      stateDir: dir, repoRoot: dir, clock: fixedClock(1794620000000), seed: 1,
      mergedPlanLint: () => undefined,
      log: (step: string, extra?: Record<string, unknown>) => { rows.push([step, extra]); },
    };
    return {
      dir, rows, spec, deps,
      noLanding: () => { landed = false; },
      state: () => readGardenState(gardenStatePath(dir, name), spec.classes),
      steps: (suffix: string) => rows.filter(([step]) => step === `${name}.${suffix}`),
      close: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("W1-T12550 criterion 3: a pass whose landing opened a pull request and whose real dispose fails records the pull request", async () => {
    const f = fixture("landed");
    const p = passFixture("landed-garden");
    try {
      let checkout: GardenCheckoutAsync | undefined;
      const result = await runGardenAsync(p.spec, {
        ...p.deps,
        openWorkspace: async () => {
          checkout = await gardens.gardenCheckoutAsync(f.opts);
          f.repo.git("worktree", "lock", checkout.root);
          return { ...checkout, land: async () => PR };
        },
      });
      assert.equal(result.ran, true);
      assert.equal(p.steps("garden_filing_failed").length, 0);
      const disposeFailed = p.steps("garden_dispose_failed");
      assert.equal(disposeFailed.length, 1);
      assert.equal(disposeFailed[0][1]?.pr_url, PR);
      assert.match(String(disposeFailed[0][1]?.reason), /locked/);
      assert.equal(p.steps("scorecard").at(-1)?.[1]?.pr_url, PR);
      const state = p.state();
      assert.equal(state.filingFailures, undefined, "no filing streak is raised");
      assert.equal(state.pending?.prUrl, PR);
      f.repo.git("worktree", "unlock", checkout!.root);
    } finally { p.close(); f.close(); }
  });

  test("W1-T12550 criterion 3: the sync pass also keeps a landed pull request over a dispose failure", () => {
    const p = passFixture("landed-sync");
    try {
      runGarden(p.spec, {
        ...p.deps,
        openWorkspace: (): GardenCheckout => ({ root: p.dir, land: () => PR, dispose: () => { throw new Error("fatal: cannot remove a locked working tree"); } }),
      });
      assert.equal(p.steps("garden_filing_failed").length, 0);
      assert.equal(p.steps("garden_dispose_failed").length, 1);
      assert.equal(p.state().pending?.prUrl, PR);
    } finally { p.close(); }
  });

  test("W1-T12550 criterion 4: a landing that fails or is refused reports its own reason, not the dispose error", async () => {
    const disposeError = "fatal: dispose broke";
    for (const [stage, expected] of [["throws", /the landing broke/], ["not-opened", /did not open/]] as const) {
      const p = passFixture(`refused-${stage}`);
      try {
        await runGardenAsync(p.spec, {
          ...p.deps,
          openWorkspace: async (): Promise<GardenCheckoutAsync> => ({
            root: p.dir,
            land: async () => { if (stage === "throws") throw new Error("the landing broke"); return undefined; },
            dispose: async () => { throw new Error(disposeError); },
          }),
        });
        const failed = p.steps("garden_filing_failed");
        assert.equal(failed.length, 1);
        assert.match(String(failed[0][1]?.reason), expected);
        assert.doesNotMatch(String(failed[0][1]?.reason), /dispose broke/);
        assert.equal(p.steps("garden_dispose_failed").length, 1);
      } finally { p.close(); }
    }
    const lint = passFixture("refused-lint");
    try {
      await runGardenAsync(lint.spec, {
        ...lint.deps,
        mergedPlanLint: () => ({ file: "plan/tasks.d/x.yaml", message: "duplicate key" }),
        openWorkspace: async (): Promise<GardenCheckoutAsync> => ({
          root: lint.dir, land: async () => assert.fail("a refused draft never lands"), dispose: async () => { throw new Error(disposeError); },
        }),
      });
      assert.equal(lint.steps("landing_refused").length, 1);
      assert.equal(lint.steps("garden_filing_failed").length, 0);
      assert.equal(lint.steps("garden_dispose_failed").length, 1);
    } finally { lint.close(); }
  });

  test("W1-T12550 criterion 2: a pass with nothing landed still fails its filing on a dispose error", async () => {
    const p = passFixture("unlanded");
    p.noLanding();
    try {
      await runGardenAsync(p.spec, {
        ...p.deps,
        openWorkspace: async (): Promise<GardenCheckoutAsync> => ({
          root: p.dir, land: async () => assert.fail("nothing to land"), dispose: async () => { throw new Error("fatal: a real leak"); },
        }),
      });
      const failed = p.steps("garden_filing_failed");
      assert.equal(failed.length, 1);
      assert.match(String(failed[0][1]?.reason), /a real leak/);
      assert.equal(p.steps("garden_dispose_failed").length, 1);
    } finally { p.close(); }
  });
});
