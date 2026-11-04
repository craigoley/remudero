import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// CI's mutation-ratchet job skips npm ci on a PLAN_ONLY or DOCS_ONLY diff, then runs this trigger
// mode anyway (ci.yml, "Determine whether this diff can move src/lib/classify.ts's mutation score").
// A top-level dependency import crashed that step on every non-source PR after #16275.
const HIDE_DEPENDENCY = `data:text/javascript,${encodeURIComponent(`
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(s, c, n) { if (s === '@swc/core') throw Object.assign(new Error('hidden: ' + s), { code: 'ERR_MODULE_NOT_FOUND' }); return n(s, c); }"));
`)}`;

test("mutation trigger without installed dependencies: a plan-only diff skips with exit 0", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mutation-trigger-no-deps-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changed = join(dir, "changed-files.txt");
  const output = join(dir, "github-output");
  writeFileSync(changed, "plan/feedback/example-20261103.yaml\n");
  writeFileSync(output, "");
  const run = spawnSync(process.execPath, ["--import", HIDE_DEPENDENCY, "scripts/mutation-ratchet.mjs", "--changed-files", changed], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(run.status, 0, `the trigger step exits 0 without @swc/core (stderr: ${run.stderr})`);
  assert.match(run.stdout, /mutation-ratchet: skip --/);
  assert.equal(readFileSync(output, "utf8"), "matched=false\n");
});

test("mutation trigger without installed dependencies: the hook really hides the parser", () => {
  const run = spawnSync(process.execPath, ["--import", HIDE_DEPENDENCY, "--input-type=module", "-e", "await import('@swc/core')"], {
    cwd: REPO_ROOT, encoding: "utf8",
  });
  assert.notEqual(run.status, 0, "positive control: @swc/core is unresolvable under the hook");
  assert.match(run.stderr, /hidden: @swc\/core/);
});
