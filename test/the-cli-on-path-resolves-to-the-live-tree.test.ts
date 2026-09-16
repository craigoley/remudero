import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

/**
 * W1-T3684 — `rmd`'s package root used to be decided PURELY by where the invoked script
 * physically sat (`bin/rmd`'s own symlink-following `dirname` walk), never by which tree
 * `deploy/entrypoint.sh` had actually checked out. So the baked `/app` snapshot a container
 * image ships — which `src/lib/image-drift.ts` (W1-T1021) correctly calls "inert rather than
 * authoritative" for everything the entrypoint itself runs — stayed the thing an operator's bare
 * `rmd` invocation resolved to, arbitrarily many commits behind the live mount the daemon
 * actually runs from. MEASURED (W1-T3684's own note): a rule `task-linter.ts` enforced 124
 * commits ago was invisible to a `grep` of the baked copy, so `rmd lint-plan` could report clean
 * on a shard the daemon then refused at dispatch.
 *
 * This suite proves `deploy/entrypoint.sh`'s fix: once a live tree is checked out, it prepends
 * that tree's `bin/` to PATH before `exec`ing anything, so a bare `rmd` lookup resolves there —
 * not to wherever it resolved before. REAL git and a REAL spawn of the script, for the same
 * reason `test/entrypoint-boot.test.ts` uses both: the fix is entirely about what a real checkout
 * and a real PATH lookup actually do, and a stub of either could not discover a regression in it.
 * Only `npm` is stubbed (the same stub `entrypoint-boot.test.ts` uses), because installing real
 * dependencies here would buy nothing but minutes.
 */

const BOOT_SPAWN_TIMEOUT_MS = 60_000;

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function commit(cwd: string, message: string): string {
  spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Marker a fixture's own `bin/rmd` prints, so a test can tell "the live tree's binary ran" from
 *  "some other rmd ran" without depending on the real CLI at all. */
const LIVE_MARKER = "LIVE-TREE-RMD-RAN";

/**
 * A git origin carrying `bin/rmd`, shaped by `rmdMode`:
 *  - "executable": a real, runnable stub that prints {@link LIVE_MARKER} and exits 0.
 *  - "not-executable": the same file, but 0644 — present, unusable.
 *  - "absent": no `bin/rmd` at all.
 */
function makeOrigin(rmdMode: "executable" | "not-executable" | "absent"): string {
  const origin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cli-on-path-origin-`));
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  if (rmdMode !== "absent") {
    mkdirSync(join(origin, "bin"), { recursive: true });
    const rmdPath = join(origin, "bin", "rmd");
    writeFileSync(rmdPath, `#!/usr/bin/env bash\nprintf '%s\\n' "${LIVE_MARKER}"\n`);
    chmodSync(rmdPath, rmdMode === "executable" ? 0o755 : 0o644);
  }
  git(origin, ["add", "-A"]);
  commit(origin, "c1");
  return origin;
}

function writeNpmStub(dir: string): void {
  const npm = ["#!/usr/bin/env bash", 'if [ "$1" = "ci" ]; then mkdir -p node_modules/.bin; printf "#!/bin/sh\\n" > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi', "exit 0", ""].join("\n");
  writeFileSync(join(dir, "npm"), npm, { mode: 0o755 });
  chmodSync(join(dir, "npm"), 0o755);
}

/** Same scrub `test/entrypoint-boot.test.ts` applies and documents (W1-T2994): every `RMD_*`
 *  control is a variable this script itself branches on, so a fixture must set what it needs
 *  explicitly rather than inheriting whatever the surrounding process happens to carry. */
function ambientWithoutRmdControls(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RMD_")));
}

interface Boot {
  status: number;
  stdout: string;
  stderr: string;
}

function boot(home: string, origin: string, opts: { env?: Record<string, string>; cmd?: string[] } = {}): Boot {
  const stubs = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cli-on-path-stub-`));
  writeNpmStub(stubs);
  const r = spawnSync("bash", [SCRIPT, ...(opts.cmd ?? ["true"])], {
    encoding: "utf8",
    timeout: BOOT_SPAWN_TIMEOUT_MS,
    cwd: REPO_ROOT,
    env: {
      ...ambientWithoutRmdControls(),
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(opts.env ?? {}),
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const treeOf = (home: string) => join(home, "Remudero", "remudero");
const headOf = (home: string) => git(treeOf(home), ["rev-parse", "HEAD"]);
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cli-on-path-home-`));
}

// ── CLAIM 1: a live tree present -> `rmd` on PATH loads THAT tree, not the baked snapshot ─────

test("with a live tree present, the rmd on PATH loads that tree rather than the baked snapshot", () => {
  const home = freshHome();
  const origin = makeOrigin("executable");

  // "rmd" as a BARE word — exactly the PATH lookup an operator's interactive invocation performs.
  // Nothing on the stub PATH this fixture supplies carries anything named "rmd": if the process
  // this spawns exits 0 and prints the fixture's marker, the entrypoint itself is what put it
  // there, by prepending the live tree's bin/ before `exec`ing.
  const run = boot(home, origin, { cmd: ["rmd"] });
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);
  assert.equal(run.stdout.trim(), LIVE_MARKER, "the executed rmd must be the live tree's own bin/rmd");
  assert.match(
    run.stderr,
    new RegExp(`rmd on PATH -> ${treeOf(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin/rmd`),
    "the boot log must name exactly which bin/rmd it pointed PATH at",
  );
});

// ── CLAIM 2: no live tree -> resolution falls back exactly as it does today (untouched) ───────

test("with no live tree present, resolution falls back to the baked snapshot exactly as it does today", () => {
  const home = freshHome();
  const origin = makeOrigin("executable");

  // RMD_SKIP_BOOTSTRAP=1 execs "$@" before the clone even runs (see the entrypoint's own top
  // block), so this is the one case in which no live tree exists at all — not merely an unusable
  // one. The fix must never touch PATH here.
  const run = boot(home, origin, {
    env: { RMD_SKIP_BOOTSTRAP: "1" },
    cmd: ["bash", "-c", "command -v rmd >/dev/null 2>&1 && echo FOUND || echo NOT_FOUND"],
  });
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);
  assert.equal(existsSync(treeOf(home)), false, "sanity: this fixture must genuinely have no live tree yet");
  assert.equal(run.stdout.trim(), "NOT_FOUND", "PATH must resolve rmd exactly as before this change — to nothing, on this fixture's PATH");
  assert.doesNotMatch(run.stderr, /rmd on PATH ->/, "the PATH-pointing step must never run with no live tree to point at");
});

// ── CLAIM 3: an unusable live-tree bin/rmd is a loud ERROR, never a silent fallback ────────────

test("an unusable live tree cli is an error not a silent fallback", () => {
  for (const mode of ["not-executable", "absent"] as const) {
    const home = freshHome();
    const origin = makeOrigin(mode);

    const run = boot(home, origin);
    assert.notEqual(run.status, 0, `[${mode}] a broken/missing live bin/rmd must refuse the boot, not continue on it`);
    assert.match(
      run.stderr,
      /has no usable bin\/rmd \(missing or not executable\) — refusing to silently fall back to a snapshot of unknown age/,
      `[${mode}] the refusal must name itself, not fail some other way`,
    );
    assert.doesNotMatch(run.stderr, /rmd on PATH ->/, `[${mode}] PATH must never be pointed at an unusable bin/rmd`);
  }
});

// ── CLAIM 4: the cli states which tree it loaded and that tree's revision ─────────────────────

test("the cli states the tree it loaded and its revision", () => {
  const home = freshHome();
  const origin = makeOrigin("executable");

  const run = boot(home, origin);
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);
  const head = headOf(home);
  const shortHead = head.slice(0, 7);
  const escapedTree = treeOf(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Both facts an operator chasing staleness needs — WHICH tree, and WHICH commit — must be
  // answerable from the boot log in one place, without diffing two checkouts by hand.
  assert.match(
    run.stderr,
    new RegExp(`rmd on PATH -> ${escapedTree}/bin/rmd \\(tree ${escapedTree}, ${shortHead}`),
    "the boot log must name both the tree path and its resolved revision together",
  );
  // The existing "checkout:" line already names the FULL sha; this pins that it still does, so a
  // reader has the long form available too.
  assert.match(run.stderr, new RegExp(`checkout: ${head} \\(main\\)`));
});
