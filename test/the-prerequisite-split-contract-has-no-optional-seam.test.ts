import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderPrerequisitePrPrompt } from "../src/lib/prompt-render.js";

const PROOF = "test/the-prerequisite-split-contract-has-no-optional-seam.test.ts";
const PROMPT_ARGS = {
  task: { id: "W1-T5810", title: "require prerequisite inputs" },
  branch: "run-W1-T5810-1730000000000",
  prUrl: "https://github.com/acme/remudero/pull/4242",
  instrumentPaths: ["scripts/diff-coverage.mjs"],
  srcPaths: ["src/run-task.ts"],
};
// Compiled by the test below, never invoked: omission must be a type error.
function rejectedCalls() {
  // @ts-expect-error W1-T5810: the renderer requires the minted branch.
  renderPrerequisitePrPrompt(PROMPT_ARGS);
}

test(`${PROOF}: a renderer type check rejects the omitted branch argument`, () => {
  const compiler = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const checked = spawnSync(process.execPath, [
    compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--esModuleInterop",
    "--module", "nodenext", "--target", "ES2022", "--lib", "ES2023,DOM", fileURLToPath(import.meta.url),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test(`${PROOF}: the prerequisite prompt always names the minted branch`, () => {
  const prerequisiteBranch = "run-unfiled-42";
  const prompt = renderPrerequisitePrPrompt({ ...PROMPT_ARGS, prerequisiteBranch });
  assert.match(prompt, /git switch -c run-unfiled-42 origin\/main/);
  assert.match(prompt, /gh pr create --head run-unfiled-42/);
  assert.match(prompt, /## Acceptance/);
});
