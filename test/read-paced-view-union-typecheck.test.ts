import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReadModelView, ReadModelViewFactory } from "../src/lib/read-model-worker.js";

const PROOF = "test/read-paced-view-union-typecheck.test.ts";

function paced(view: ReadModelView | ReadModelViewFactory): boolean {
  return view.readPaced === true;
}

const view: ReadModelView = {
  name: "paced", version: 1, readPaced: true, materialize: () => [],
};
const factory: ReadModelViewFactory = {
  name: view.name, readPaced: true, create: () => view,
};
const unpacedView: ReadModelView = { name: "unpaced", version: 1, materialize: () => [] };
const unpacedFactory: ReadModelViewFactory = { name: "unpaced", create: () => unpacedView };

test(`${PROOF}: readPaced type-checks for concrete views and factories`, () => {
  const compiler = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const checked = spawnSync(process.execPath, [
    compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--esModuleInterop",
    "--module", "nodenext", "--target", "ES2022", "--lib", "ES2023,DOM", fileURLToPath(import.meta.url),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(paced(view), true);
  assert.equal(paced(factory), true);
  assert.equal(paced(unpacedView), false);
  assert.equal(paced(unpacedFactory), false);
});
