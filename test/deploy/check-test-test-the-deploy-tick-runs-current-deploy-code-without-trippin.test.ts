// @source-text-subject: test/the-deploy-tick-runs-current-deploy-code-without-tripping-its-guard.test.ts — this suite's subject is how that suite spawns the real CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T10409 — the deploy-tick suite's real-CLI case was a recurring CI fix round (12.3 PR minutes, 3 rounds).
 *
 * `the real deploy-run is not the install-separation no-op` runs the REAL CLI, tsx over a full copy of
 * src/, several times in one launcher tick. On a coverage shard every child inherited NODE_V8_COVERAGE, so
 * it also profiled and wrote out the whole copied tree. The tick crossed its 30 s spawn budget, and
 * spawnSync returned `status: null` (PR #13382, 30277 ms). The remedy is in how that case spawns: each
 * real-CLI spawn blanks the coverage session by assignment (node re-injects a deleted key into every
 * child) and carries a budget sized for a cold real-CLI tick. This suite holds both properties for every
 * spawn in that case, so a new spawn written the old way fails here, not in a shard.
 */

const SUITE = "test/the-deploy-tick-runs-current-deploy-code-without-tripping-its-guard.test.ts";
const REAL_CLI_CASE = 'test("W1-T4917: the real deploy-run is not the install-separation no-op"';
/** The smallest budget a real-CLI tick may carry: four times the 30 s it was observed to overrun. */
const MIN_REAL_CLI_BUDGET_MS = 120_000;

/** The text between the parentheses opened at `open`, matched by depth. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return "";
}

const BLANKS_COVERAGE = /NODE_V8_COVERAGE\s*:\s*(?:""|''|undefined)/;

/** Resolve an identifier to the text of its `const <id> = ...` declaration in `file`, if any. */
function constDecl(file: string, id: string): string | undefined {
  const m = new RegExp(`const ${id}\\b[^=]*=([^;]*)`, "s").exec(file);
  return m?.[1];
}

/** What is wrong with one spawn call's argument text, read against the whole suite for its helpers. */
function realCliSpawnDefects(args: string, file: string): string[] {
  const defects: string[] = [];
  const envHelper = /env:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(args)?.[1];
  const blanks = BLANKS_COVERAGE.test(args) || (envHelper !== undefined && BLANKS_COVERAGE.test(constDecl(file, envHelper) ?? ""));
  if (!blanks) defects.push("inherits the parent's NODE_V8_COVERAGE session");
  const budget = /timeout:\s*([\w$]+)/.exec(args)?.[1];
  const raw = budget === undefined ? undefined : /^[\d_]+$/.test(budget) ? budget : constDecl(file, budget)?.trim();
  const ms = raw === undefined ? NaN : Number(raw.replaceAll("_", ""));
  if (!(ms >= MIN_REAL_CLI_BUDGET_MS)) defects.push(`budget ${budget ?? "absent"} is below ${MIN_REAL_CLI_BUDGET_MS} ms`);
  return defects;
}

/** Every spawnSync call inside the real-CLI case, with what is wrong with each. */
function realCliCaseDefects(file: string): { spawns: number; defects: string[] } {
  const start = file.indexOf(REAL_CLI_CASE);
  assert.ok(start >= 0, `${SUITE} no longer carries the real-CLI case this suite guards`);
  const end = file.indexOf("\n});", start);
  const body = file.slice(start, end < 0 ? file.length : end);
  const defects: string[] = [];
  let spawns = 0;
  for (const m of body.matchAll(/\bspawnSync\s*\(/g)) {
    spawns += 1;
    for (const d of realCliSpawnDefects(callArgs(body, m.index + m[0].length - 1), file)) defects.push(`spawn ${spawns}: ${d}`);
  }
  return { spawns, defects };
}

test("W1-T10409: check:test:test/the-deploy-tick-runs-current-deploy-code-without-tripping-its-guard.test.ts:flaky is prevented, not retried", () => {
  const file = readFileSync(join(REPO_ROOT, SUITE), "utf8");
  const { spawns, defects } = realCliCaseDefects(file);
  assert.ok(spawns >= 2, `the real-CLI case spawns the launcher tick and the control; found ${spawns} spawn(s)`);
  assert.deepEqual(defects, [], "every real-CLI spawn blanks the coverage session and carries a real-CLI budget");
});

test("W1-T10409: the spawn shape that overran the 30 s budget is refused by name", () => {
  const before = '{ encoding: "utf8", cwd: f.root, timeout: 30000, env: { ...f.env, HOME: fixtureHome } }';
  assert.deepEqual(realCliSpawnDefects(before, ""), [
    "inherits the parent's NODE_V8_COVERAGE session",
    "budget 30000 is below 120000 ms",
  ]);
  assert.deepEqual(realCliSpawnDefects('{ timeout: 120_000, env: { ...f.env, NODE_V8_COVERAGE: "" } }', ""), []);
  const viaHelpers = "const BUDGET = 150_000;\nconst plain = (e) => ({ ...e });\n";
  assert.deepEqual(realCliSpawnDefects("{ timeout: BUDGET, env: plain(f.env) }", viaHelpers), [
    "inherits the parent's NODE_V8_COVERAGE session",
  ]);
  assert.deepEqual(realCliSpawnDefects("{ env: { NODE_V8_COVERAGE: undefined } }", ""), ["budget absent is below 120000 ms"]);
});

test("W1-T10999: check:test:test/the-deploy-tick-runs-current-deploy-code-without-tripping-its-guard.test.ts is prevented, not retried", async () => {
  await withTempDir("deploy-sweep", async (root) => {
    // A real CLI child inherits the test context, but never loads the test setup's global marker.
    // Its private TMPDIR stands in for the shared root; no sweep here can see another session.
    const code = `
      import assert from "node:assert/strict";
      import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { TEST_PROCESS_MARKER, sweepStaleTempDirs, sweepStaleTempDirsAsync }
        from "#src/lib/tmp.js";
      assert.equal(globalThis[TEST_PROCESS_MARKER], undefined);
      const shiftedNow = () => Date.now() + 2 * 86_400_000;
      for (const sweep of [sweepStaleTempDirs, sweepStaleTempDirsAsync]) {
        const fixture = join(tmpdir(), "rmd-deploy-code-fixture");
        const installer = join(fixture, "install-host-units.sh");
        mkdirSync(fixture);
        writeFileSync(installer, "fixture");
        const aged = new Date(Date.now() - 2 * 86_400_000);
        utimesSync(fixture, aged, aged);
        const result = await sweep({ now: shiftedNow });
        if (process.env.NODE_TEST_CONTEXT) {
          assert.match(result.refused, /test process/);
          assert.equal(existsSync(installer), true, "the child must preserve the deploy fixture");
          assert.deepEqual(result.removed, []);
          const explicit = await sweep({ root: tmpdir(), now: shiftedNow });
          assert.equal(explicit.refused, undefined);
          assert.deepEqual(explicit.removed, ["rmd-deploy-code-fixture"]);
        } else {
          assert.equal(result.refused, undefined);
          assert.deepEqual(result.removed, ["rmd-deploy-code-fixture"]);
        }
        assert.equal(existsSync(fixture), false, "an authorized sweep still reclaims stale dirs");
      }
    `;
    for (const context of [process.env.NODE_TEST_CONTEXT, "test-setup", undefined, ""]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, NODE_TEST_CONTEXT: context, NODE_V8_COVERAGE: "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(child.status, 0, `context=${String(context)}: ${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    }
  });
});
