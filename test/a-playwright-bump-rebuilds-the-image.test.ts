/**
 * test/a-playwright-bump-rebuilds-the-image.test.ts — W1-T4061.
 *
 * `deploy/Dockerfile` resolves `PW_VERSION` from `/app/package-lock.json`'s
 * `packages['node_modules/playwright-core'].version` and installs that Chromium build into the
 * image (its REQ 15). Root `package-lock.json` changed 12 times in the 30 days to 2026-09-22,
 * almost all unrelated dependency bumps — watching the WHOLE file the way IMAGE_BAKED_PATHS is
 * watched would rebuild and recycle about a dozen times a month for nothing (the auto-recycle PR
 * of that day deliberately left it out). But a playwright-core bump IS a real image change
 * nothing detects, and it is the known cause of "every browser proof fails and the review calls
 * it executed and FAILED" (the Playwright-bump incident the operator memory records).
 *
 * So: watch the FIELD, not the FILE. Both the workflow's build guard (acr-build.yml) and the
 * watchdog tick's drift reading (deployer.ts) key off whether the pinned playwright-core version
 * moved, not off whether package-lock.json's bytes moved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  IMAGE_BAKED_PATHS,
  ROOT_LOCKFILE_PATH,
  extractPlaywrightCoreVersion,
  newestPlaywrightVersionChangeSha,
  playwrightCoreVersionChanged,
  playwrightCoreVersionCommitsBehind,
} from "../src/lib/deployer.js";

const REPO_ROOT = join(import.meta.dirname, "..");

function lockfile(playwrightCoreVersion: string | undefined, otherDepVersion = "1.0.0"): string {
  return JSON.stringify({
    packages: {
      "": { name: "remudero" },
      "node_modules/left-pad": { version: otherDepVersion },
      ...(playwrightCoreVersion === undefined
        ? {}
        : { "node_modules/playwright-core": { version: playwrightCoreVersion } }),
    },
  });
}

const OLD_LOCK = lockfile("1.40.0");
const UNRELATED_BUMP_LOCK = lockfile("1.40.0", "1.0.1"); // left-pad moved, playwright-core did not
const PLAYWRIGHT_BUMP_LOCK = lockfile("1.41.0");

// ── (1) the workflow guard: a playwright-core bump starts the image build ────────────────────

test("W1-T4061: a playwright-core bump starts the image build", () => {
  // The pure comparison the workflow's own guard step is built on: given the two lockfile texts
  // either side of a push, a moved playwright-core version reads as "build".
  assert.equal(playwrightCoreVersionChanged(OLD_LOCK, PLAYWRIGHT_BUMP_LOCK), true);

  // And the workflow itself wires that same field into a guard that gates the real `az acr build`
  // step — grepped rather than executed (no shell/az available here), but pinned to the exact
  // field name so a rename on either side breaks this test instead of silently drifting apart.
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "acr-build.yml"), "utf8");
  assert.match(workflow, /Decide whether this push needs a new image/);
  assert.match(workflow, /packages\["node_modules\/playwright-core"\]/);
  assert.match(workflow, /oldVersion !== newVersion/);
  // Gated: the actual build step does not run unconditionally on every push touching the paths.
  assert.match(workflow, /name: Build and push \(ACR\)[\s\S]*?if: github\.event_name != 'push' \|\| steps\.image_guard\.outputs\.build == 'true'/);
  // Root package-lock.json is now itself a trigger path, so the guard has something to run on.
  const paths = /\n {4}paths:\n((?: {6}- .+\n)+)/.exec(workflow)?.[1] ?? "";
  assert.match(paths, /- package-lock\.json\n/);
});

// ── (2) an unrelated lockfile change neither builds nor counts as drift ──────────────────────

test("W1-T4061: an unrelated lockfile change is not image drift", () => {
  // Same file, different dependency — the playwright-core field itself never moved.
  assert.equal(playwrightCoreVersionChanged(OLD_LOCK, UNRELATED_BUMP_LOCK), false);

  const runGit = (args: readonly string[]): string => {
    if (args[0] === "show" && args[1] === "aaaa:package-lock.json") return OLD_LOCK;
    if (args[0] === "show" && args[1] === "origin/main:package-lock.json") return UNRELATED_BUMP_LOCK;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.equal(playwrightCoreVersionCommitsBehind("aaaa", runGit), 0, "an unrelated bump is zero drift, not undefined");

  // An unparseable or version-less lockfile on either side must fail CLOSED (no drift), never
  // read as a change by accident.
  assert.equal(playwrightCoreVersionChanged("not json", PLAYWRIGHT_BUMP_LOCK), false);
  assert.equal(playwrightCoreVersionChanged(OLD_LOCK, lockfile(undefined)), false);
  assert.equal(extractPlaywrightCoreVersion("not json"), undefined);
});

// ── (3) a playwright-core bump counts as image drift for the recycle tick ────────────────────

test("W1-T4061: a playwright-core bump is image drift", () => {
  const runGit = (args: readonly string[]): string => {
    if (args[0] === "show" && args[1] === "aaaa:package-lock.json") return OLD_LOCK;
    if (args[0] === "show" && args[1] === "origin/main:package-lock.json") return PLAYWRIGHT_BUMP_LOCK;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.equal(playwrightCoreVersionCommitsBehind("aaaa", runGit), 1, "a real version move is one drift commit");

  // UNKNOWN, never zero — the same contract bakedPathCommitsBehind keeps for the image sha.
  assert.equal(playwrightCoreVersionCommitsBehind(undefined, runGit), undefined);
  assert.equal(
    playwrightCoreVersionCommitsBehind("aaaa", () => {
      throw new Error("git: not a repository");
    }),
    undefined,
  );

  // Root package-lock.json is deliberately NOT in IMAGE_BAKED_PATHS — that is the whole point:
  // watching the whole file would rebuild ~12x/month for nothing.
  assert.equal(IMAGE_BAKED_PATHS.includes(ROOT_LOCKFILE_PATH), false);
});

// ── Reachability: newestPlaywrightVersionChangeSha walks history for the VERSION move, not the
//    newest touch of the file (an unrelated bump landing after the real one must not shadow it).

test("W1-T4061: the newest playwright-core version-change commit is found even behind a later unrelated bump", () => {
  const history: Record<string, string> = {
    // newest-first, matching `git log --format=%H`'s own order. `unrelated2` bumps left-pad
    // AFTER the real playwright-core move (`playwrightBump`) without touching the pin again —
    // it must not shadow the commit that actually moved it.
    unrelated2: lockfile("1.41.0", "1.0.1"),
    playwrightBump: lockfile("1.41.0", "1.0.0"),
    unrelated1: lockfile("1.40.0", "1.0.0"),
  };
  const parents: Record<string, string | undefined> = {
    unrelated2: "playwrightBump",
    playwrightBump: "unrelated1",
    unrelated1: undefined,
  };
  const runGit = (args: readonly string[]): string => {
    if (args[0] === "log") return Object.keys(history).join("\n") + "\n";
    if (args[0] === "show") {
      const spec = args[1] ?? "";
      const [ref] = spec.split(":");
      if (ref?.endsWith("^")) {
        const sha = ref.slice(0, -1);
        const parent = parents[sha];
        if (!parent) throw new Error(`no parent for ${sha}`);
        return history[parent]!;
      }
      const content = history[ref as string];
      if (content === undefined) throw new Error(`unknown ref ${ref}`);
      return content;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.equal(
    newestPlaywrightVersionChangeSha(runGit),
    "playwrightBump",
    "the later unrelated bump must not shadow the real playwright-core move",
  );
});

test("W1-T4061: no playwright-core version change anywhere in history reads as undefined, not a stale sha", () => {
  const runGit = (args: readonly string[]): string => {
    if (args[0] === "log") return "onlyUnrelated\n";
    if (args[0] === "show") return UNRELATED_BUMP_LOCK; // same for the commit AND (fake) its parent
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.equal(newestPlaywrightVersionChangeSha(runGit), undefined);
  assert.equal(
    newestPlaywrightVersionChangeSha(() => {
      throw new Error("git: not a repository");
    }),
    undefined,
  );
});
