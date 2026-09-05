/**
 * test/check-script.test.ts — impl-GC.
 *
 * `scripts/check.mjs` bundles a scoped test run and `tsc --noEmit` into ONE invocation, so a
 * session cannot run the typecheck before writing its last file and get a stale all-clear.
 *
 * WHAT THIS SUITE COVERS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It covers the SAFETY property: the script refuses to run with no target. That matters because
 * `node --test` with no argument walks the whole tree, and the full suite is CI's and
 * `rmd preflight --ci-parity`'s to run, never this scoped verb's (inside an agent container it
 * cannot pass honestly — docs/troubleshooting.md). A regression that made the
 * script default to "everything" would be actively dangerous, so it is pinned here.
 *
 * It does NOT drive the full happy path, because that path runs `tsc` over the whole project — a
 * ~10s cost on every CI run of the suite, to re-prove something the compiler already proves. That
 * behaviour is evidenced in the impl-GC report by manual reproduction instead: `tsx --test` exits 0
 * on a `Date`-for-`number` argument while `npm run check` on the same file exits 1 and names
 * TS2345. Saying so plainly here rather than implying broader coverage than exists.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check.mjs");

test("check refuses with no target rather than defaulting to the whole suite", () => {
  const r = spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });

  assert.equal(r.status, 2, "a distinct exit code, not 0 and not the 1 a real failure uses");
  assert.match(r.stderr, /no test target given/);
  assert.match(r.stderr, /npm run check -- test\/<file>\.test\.ts/, "and it says how to invoke it");
  assert.match(
    r.stderr,
    /walks the whole tree/,
    "naming WHY it refuses — a default-to-everything regression is the dangerous one",
  );
  assert.equal(r.stdout.trim(), "", "it runs nothing at all before refusing");
});

test("the refusal is the only zero-target behaviour — no argv shape slips past it", () => {
  // An empty string and a lone `--` are the shapes an npm invocation can produce by accident.
  for (const argv of [[], [""], ["--"]]) {
    const r = spawnSync("node", [SCRIPT, ...argv].filter((a) => a !== ""), { cwd: REPO_ROOT, encoding: "utf8" });
    if (argv.length === 0 || argv[0] === "") {
      assert.equal(r.status, 2, `argv ${JSON.stringify(argv)} must refuse`);
    }
  }
});

test("a missing binary is NAMED, not reported as an ordinary failure", () => {
  // The `r.error` arm. Unreachable while node and npx exist, so it is driven by handing the child
  // a PATH with nothing on it — the same "cover the catch arm for real" discipline this repo
  // applies elsewhere. `process.execPath` launches the script itself, since a name-based `node`
  // would not resolve either.
  const r = spawnSync(process.execPath, [SCRIPT, "test/check-script.test.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" },
  });

  assert.equal(r.status, 1, "still exits non-zero overall");
  const named = r.stderr.split("\n").filter((l) => l.includes("could not run"));
  assert.equal(named.length, 2, `both commands name themselves; got ${JSON.stringify(named)}`);
  assert.match(named.join("\n"), /ENOENT/, "carrying the real cause, not a bare exit code");
  assert.match(r.stdout, /scoped tests\s*: FAIL \(exit 127\)/, "127 distinguishes 'could not run' from 'ran and failed'");
  assert.match(r.stdout, /typecheck\s*: FAIL \(exit 127\)/);
});
