/**
 * test/staged-install.test.ts — W1-T4933: a managed checkout's node_modules is reinstalled when its
 * lockfile hash moved, STAGED and SWAPPED — the live tree is never emptied in place.
 *
 * The npm run itself is the one injected seam (`runInstall`); every other step — the hash compare, the
 * staging copy, the verification, the renames, the marker — runs on real files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  StagedInstallFailedError,
  managedCheckoutInstallEscalation,
  stagedInstall,
  type StagedInstallFailure,
} from "../src/lib/staged-install.js";
import { refreshManagedCheckout, refreshReviewSubjectInstall } from "../src/run-task.js";
import { acquireDrainLock } from "../src/lib/drain-lock.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "console", version: "0.0.0", dependencies: deps });

/** A checkout at `<root>/repos/console` whose node_modules was installed from OLDER inputs than its lockfile. */
function lockfileDriftTree(root: string): string {
  const repoDir = join(root, "repos", "console");
  mkdirSync(join(repoDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repoDir, "package.json"), pkg({ dep: "^1.0.0", "@vercel/functions": "^2.0.0" }));
  writeFileSync(join(repoDir, "package-lock.json"), '{"lockfileVersion":3,"note":"2026-09-27"}\n');
  writeFileSync(join(repoDir, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  writeFileSync(join(repoDir, "node_modules", "old-tree.txt"), "installed 2026-09-24\n");
  writeFileSync(installHashMarkerPath(repoDir), "hash-of-the-2026-09-24-inputs");
  return repoDir;
}

/** What a successful `npm ci` leaves in the staging dir: a node_modules holding every direct dependency. */
function installsAll(stagingDir: string): void {
  for (const name of ["dep", "@vercel/functions"]) {
    mkdirSync(join(stagingDir, "node_modules", name), { recursive: true });
    writeFileSync(join(stagingDir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "2.0.0" }));
  }
  writeFileSync(join(stagingDir, "node_modules", "new-tree.txt"), "installed 2026-10-01\n");
}

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4933-`));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A working clone sitting exactly at its bare origin's main, which holds `files` — refreshManagedCheckout reads it as `current`. */
const currentWithOrigin = (files: Record<string, string>): string => {
  const origin = gitRepo({ bare: true, kind: "w1-t4933-origin" });
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w1-t4933-clone" });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(clone.dir, name), body);
  clone.git("add", "-A");
  clone.git("commit", "--quiet", "-m", "seed");
  clone.git("push", "--quiet", "origin", "HEAD:main");
  clone.git("fetch", "--quiet", "origin");
  return clone.dir;
};

test("W1-T4933: a current checkout with a stale install is reinstalled on a lockfile change", () => {
  withRoot((root) => {
    // A real clone sitting exactly at origin/main — refreshManagedCheckout returns `current` and (before this task) never installed.
    const repoDir = currentWithOrigin({
      ".gitignore": "node_modules\n",
      "package.json": pkg({ dep: "^1.0.0", "@vercel/functions": "^2.0.0" }),
      "package-lock.json": '{"lockfileVersion":3,"note":"2026-09-27"}\n',
    });
    mkdirSync(join(repoDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "old-tree.txt"), "installed 2026-09-24\n");
    writeFileSync(installHashMarkerPath(repoDir), "hash-of-the-2026-09-24-inputs");

    const steps: string[] = [];
    const out = refreshManagedCheckout(
      repoDir,
      join(root, "state", "refresh.lock"),
      (step) => void steps.push(step),
      (dir) => void stagedInstall(dir, { runInstall: installsAll, log: (step) => void steps.push(step) }),
    );
    out.release();

    assert.equal(out.kind, "current", "the code was already at origin/main");
    assert.ok(existsSync(join(repoDir, "node_modules", "new-tree.txt")), "the install now matches the lockfile");
    assert.equal(existsSync(join(repoDir, "node_modules", "old-tree.txt")), false, "the 2026-09-24 tree is gone");
    assert.equal(readFileSync(installHashMarkerPath(repoDir), "utf8"), hashInstallInputs(repoDir), "the marker names the lockfile it was built from");
    assert.deepEqual(steps, ["managed_checkout.install_refreshed"]);
  });
});

test("W1-T4933: a staged install never empties the live node_modules while it runs", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    const live = join(repoDir, "node_modules");
    const seen: Array<{ phase: string; oldTreeServing: boolean; depResolvable: boolean }> = [];
    const probe = (phase: string) =>
      seen.push({ phase, oldTreeServing: existsSync(join(live, "old-tree.txt")), depResolvable: existsSync(join(live, "dep", "package.json")) });
    const out = stagedInstall(repoDir, {
      runInstall: (stagingDir) => {
        probe("during-install");
        assert.ok(!stagingDir.startsWith(live), "npm ci runs in a sibling dir, never inside the live tree");
        installsAll(stagingDir);
        probe("after-install");
      },
      verify: (stagingDir, names) => {
        probe("during-verify");
        return names.filter((name) => !existsSync(join(stagingDir, "node_modules", name, "package.json")));
      },
    });
    assert.equal(out, "refreshed");
    assert.deepEqual(
      seen,
      ["during-install", "after-install", "during-verify"].map((phase) => ({ phase, oldTreeServing: true, depResolvable: true })),
      "the old tree served every dependency until the swap",
    );
    assert.ok(existsSync(join(live, "new-tree.txt")));
    assert.deepEqual(readdirSync(join(repoDir, "..")).filter((n) => n.startsWith(".rmd-staged-install")), [], "no staging or previous tree is left behind");
  });
});

test("W1-T4933: a matching lockfile hash is a no-op that never runs npm", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    writeFileSync(installHashMarkerPath(repoDir), hashInstallInputs(repoDir));
    const out = stagedInstall(repoDir, { runInstall: () => assert.fail("a matching hash must not reinstall") });
    assert.equal(out, "noop");
    assert.ok(existsSync(join(repoDir, "node_modules", "old-tree.txt")));
  });
});

test("W1-T4933: a failed staged install keeps the old tree and escalates once per lockfile hash", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    const escalations: StagedInstallFailure[] = [];
    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    const attempt = () =>
      stagedInstall(repoDir, {
        runInstall: (stagingDir) => {
          installsAll(stagingDir); // half a tree exists in staging when npm dies
          throw new Error("npm ci exited 1: ETIMEDOUT registry.npmjs.org");
        },
        log: (step, extra) => void rows.push([step, extra]),
        escalate: (failure) => void escalations.push(failure),
      });

    assert.throws(attempt, (e: unknown) => e instanceof StagedInstallFailedError && /ETIMEDOUT/.test(e.message));
    assert.ok(existsSync(join(repoDir, "node_modules", "old-tree.txt")), "the old tree is still the one serving");
    assert.equal(existsSync(join(repoDir, "node_modules", "new-tree.txt")), false, "no half-installed tree was swapped in");
    assert.equal(readFileSync(installHashMarkerPath(repoDir), "utf8"), "hash-of-the-2026-09-24-inputs", "the marker still names the old inputs");
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0]?.hash, hashInstallInputs(repoDir));
    assert.equal(rows.filter(([step]) => step === "managed_checkout.install_failed").length, 1);
    assert.deepEqual(readdirSync(join(repoDir, "..")).filter((n) => n.startsWith(".rmd-staged-install")), [], "the staging dir is removed");

    assert.throws(attempt, StagedInstallFailedError);
    assert.equal(escalations.length, 1, "the same lockfile hash does not escalate a second time");
    assert.equal(rows.filter(([step]) => step === "managed_checkout.install_failed").length, 2, "but every failure is ledgered");

    writeFileSync(join(repoDir, "package-lock.json"), '{"lockfileVersion":3,"note":"a later lockfile"}\n');
    assert.throws(attempt, StagedInstallFailedError);
    assert.equal(escalations.length, 2, "a NEW lockfile hash is a new escalation");
  });
});

test("W1-T4933: a staged tree that does not resolve a direct dependency is never swapped in", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    assert.throws(
      () =>
        stagedInstall(repoDir, {
          runInstall: (stagingDir) => {
            installsAll(stagingDir);
            rmSync(join(stagingDir, "node_modules", "@vercel"), { recursive: true });
          },
        }),
      /does not resolve @vercel\/functions/,
    );
    assert.ok(existsSync(join(repoDir, "node_modules", "old-tree.txt")));
  });
});

test("W1-T4933: workspace package.json files are staged so npm ci sees the same workspaces", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "core", workspaces: ["packages/*"], dependencies: { dep: "^1.0.0" } }));
    mkdirSync(join(repoDir, "packages", "api-client"), { recursive: true });
    writeFileSync(join(repoDir, "packages", "api-client", "package.json"), '{"name":"@x/api-client"}');
    writeFileSync(join(repoDir, "packages", "api-client", "index.ts"), "export {};\n");
    let staged: string[] = [];
    stagedInstall(repoDir, {
      runInstall: (stagingDir) => {
        staged = [existsSync(join(stagingDir, "packages", "api-client", "package.json")) ? "pkg" : "", existsSync(join(stagingDir, "packages", "api-client", "index.ts")) ? "src" : ""];
        installsAll(stagingDir);
      },
    });
    assert.deepEqual(staged, ["pkg", ""], "the workspace manifest is copied, its sources are not");
  });
});

test("W1-T4933: a symlinked node_modules is never swapped", () => {
  withRoot((root) => {
    const repoDir = join(root, "repos", "console");
    mkdirSync(join(root, "shared", "node_modules"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), pkg({}));
    execFileSync("ln", ["-s", join(root, "shared", "node_modules"), join(repoDir, "node_modules")]);
    const rows: string[] = [];
    const out = stagedInstall(repoDir, { runInstall: () => assert.fail("a linked tree is not ours to replace"), log: (step) => void rows.push(step) });
    assert.equal(out, "skipped_symlink");
    assert.deepEqual(rows, ["managed_checkout.install_skipped"]);
  });
});

test("W1-T4933: the escalation names the repo and the hash and offers an actionable option", () => {
  const e = managedCheckoutInstallEscalation({ repoDir: "/r/repos/remudero-console", hash: "a".repeat(64), error: "ETIMEDOUT" }, "W1-T1", "run-1");
  assert.match(e.summary, /remudero-console/);
  assert.match(e.summary, /aaaaaaaaaaaa/);
  assert.ok(e.options.some((o) => o.label === e.recommendation));
});

test("W1-T4933: a failed install on a current checkout keeps the dispatch going and ledgers why", () => {
  withRoot((root) => {
    const repoDir = currentWithOrigin({ "README.md": "x\n" });
    mkdirSync(join(repoDir, "node_modules"));
    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    const out = refreshManagedCheckout(repoDir, join(root, "state", "refresh.lock"), (s, x) => void rows.push([s, x]), () => {
      throw new Error("npm ci exited 1");
    });
    out.release();
    assert.equal(out.kind, "current");
    assert.match(String(rows.find(([s]) => s === "managed_checkout.install_kept_stale")?.[1]?.reason), /npm ci exited 1/);
  });
});

test("W1-T4933: the reviewer's refresh installs under the checkout lock, skips a held lock, and survives a failed install", () => {
  withRoot((root) => {
    const repoDir = lockfileDriftTree(root);
    const lockPath = join(root, "state", "managed-checkout-console.lock");
    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    const log = (s: string, x?: Record<string, unknown>) => void rows.push([s, x]);
    const installs: string[] = [];

    refreshReviewSubjectInstall(repoDir, lockPath, log, undefined, (dir) => {
      installs.push(dir);
      assert.ok(existsSync(lockPath), "the checkout lock is held while it installs");
    });
    assert.deepEqual(installs, [repoDir]);
    assert.equal(existsSync(lockPath), false, "and released afterwards");

    const peer = acquireDrainLock(lockPath, { info: { pid: process.ppid } as never });
    refreshReviewSubjectInstall(repoDir, lockPath, log, undefined, () => assert.fail("a peer holds the checkout"));
    peer.release();
    assert.match(String(rows.find(([s]) => s === "review.subject_install_skipped")?.[1]?.reason), /another dispatch holds/);

    refreshReviewSubjectInstall(repoDir, lockPath, log, undefined, () => {
      throw new Error("npm ci exited 1");
    });
    assert.match(String(rows.find(([s]) => s === "review.subject_install_kept_stale")?.[1]?.reason), /npm ci exited 1/);
    assert.equal(existsSync(lockPath), false, "a failed install never strands the lock");
  });
});
