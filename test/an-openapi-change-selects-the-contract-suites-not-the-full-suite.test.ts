import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { READ_MAP_FORMAT, readAffectedSuitesInput, selectAffectedSuites, type ReadMapInput } from "../src/lib/affected-suites.js";

const contracts = ["openapi/daemon.yaml", "packages/api-client/src/schema.d.ts"];
const proof = "test/an-openapi-change-selects-the-contract-suites-not-the-full-suite.test.ts";

function tree(path: string): Map<string, string> {
  const segments = path.split("/").map((part) => JSON.stringify(part)).join(", ");
  return new Map([
    ["test/direct.test.ts", `readFileSync("${path}", "utf8");`],
    ["test/helpers/contract.ts", `readFileSync(join(ROOT, ${segments}), "utf8");`],
    ["test/helpers/bridge.ts", 'export { contract } from "./contract.js";'],
    ["test/indirect.test.ts", 'import { contract } from "./helpers/bridge.js";'],
    ["src/route.ts", "export const route = 1;"],
    ["test/route.test.ts", 'import { route } from "../src/route.js";'],
    ["test/unrelated.test.ts", "export {};"],
    ["test/comment.test.ts", `// readFileSync("${path}");`],
  ]);
}

test(proof, () => {
  for (const path of contracts) {
    const input = { files: tree(path), pathReaders: [], symbolSuites: [] };
    const selection = selectAffectedSuites([path], input);
    assert.equal(selection.fullRun, false, path);
    assert.deepEqual(selection.suites, ["test/direct.test.ts", "test/indirect.test.ts"], path);
    assert.deepEqual(selection.narrow, selection.suites, "the author gate keeps helper readers");
    assert.ok(selection.reasons.includes(`test/indirect.test.ts: reaches ${path}`));

    const mixed = selectAffectedSuites([path, "src/route.ts"], {
      ...input, symbolSuites: ["test/route.test.ts"],
    });
    assert.equal(mixed.fullRun, false);
    assert.deepEqual(mixed.suites, ["test/direct.test.ts", "test/indirect.test.ts", "test/route.test.ts"]);
    assert.deepEqual(mixed.narrow, mixed.suites);
  }
});

test(`${proof}: unusable read maps keep contract readers and report the map problem`, () => {
  const map: NonNullable<ReadMapInput["map"]> = { format: READ_MAP_FORMAT, sha: "main", suites: [], reads: {}, listed: {} };
  const cases: Array<{ readMap?: ReadMapInput; problem?: string }> = [
    {},
    { readMap: { mapProblem: "file not found", drift: { changedSinceMap: [] } }, problem: "no read map (file not found)" },
    { readMap: { mapProblem: "malformed", drift: { changedSinceMap: [] } }, problem: "no read map (malformed)" },
    { readMap: { map, drift: { distance: 900, changedSinceMap: [] } }, problem: "read map main is stale: 900 commits behind the base, past its bound of 150" },
    { readMap: { map, drift: { problem: "no ancestry", changedSinceMap: [] } }, problem: "read map main is not an ancestor of the base (no ancestry)" },
  ];
  for (const path of contracts) {
    for (const { readMap, problem } of cases) {
      const selection = selectAffectedSuites([path], {
        files: tree(path), pathReaders: [], symbolSuites: [], readMap,
      });
      assert.equal(selection.fullRun, false, `${path}: ${problem}`);
      assert.deepEqual(selection.suites, ["test/direct.test.ts", "test/indirect.test.ts"]);
      assert.deepEqual(selection.narrow, selection.suites);
      assert.equal(selection.readMapFallback, problem);
    }
  }
});

test(`${proof}: other contract-tree paths still force a full run and name the path`, () => {
  const readMaps: Array<ReadMapInput | undefined> = [undefined, {
    map: { format: READ_MAP_FORMAT, sha: "main", suites: [], reads: {}, listed: {} },
    drift: { distance: 0, changedSinceMap: [] },
  }];
  for (const path of ["openapi/other.yaml", "packages/api-client/src/client.ts"]) {
    for (const readMap of readMaps) {
      const selection = selectAffectedSuites([contracts[0]!, path], {
        files: tree(contracts[0]!), pathReaders: [], readMap,
      });
      assert.equal(selection.fullRun, true, path);
      assert.deepEqual(selection.suites, []);
      assert.ok(selection.reasons[0]!.startsWith(`full run: ${path} is outside what the selector models`));
      assert.ok(!selection.reasons[0]!.includes("undefined"));
      if (readMap) assert.equal(selection.readMapFallback, undefined);
    }
  }
});

test(`${proof}: contract readers are derived from newly added code and joined segments`, () => {
  for (const path of contracts) {
    const files = tree(path);
    const segments = path.split("/").map((part) => `'${part}'`).join(",\n");
    files.set("scripts/new-reader.mjs", `readFileSync(resolve(ROOT, ${segments}), 'utf8');`);
    files.set("test/new-reader.test.ts", 'import "../scripts/new-reader.mjs";');
    const selection = selectAffectedSuites([path], { files, pathReaders: [], symbolSuites: [] });
    assert.equal(selection.fullRun, false);
    assert.deepEqual(selection.suites, ["test/direct.test.ts", "test/indirect.test.ts", "test/new-reader.test.ts"]);
    assert.deepEqual(selection.narrow, selection.suites);
  }
});

test(`${proof}: a source traversal cannot hide a shared contract reader from the author gate`, () => {
  const files = tree(contracts[0]!);
  files.set("test/indirect.test.ts", 'import "../src/route.js"; import "./helpers/bridge.js";');
  const selection = selectAffectedSuites(["src/route.ts", contracts[0]!], {
    files, pathReaders: [], symbolSuites: [],
  });
  assert.deepEqual(selection.narrow, ["test/direct.test.ts", "test/indirect.test.ts"]);
  assert.deepEqual(selection.suites, ["test/direct.test.ts", "test/indirect.test.ts", "test/route.test.ts"]);
});

test(`${proof}: source data tables naming a contract do not create reader edges, while runtime reads do`, () => {
  for (const path of contracts) {
    const files = tree(path);
    files.set("scripts/generate.mjs", `readFileSync('${path}', 'utf8');`);
    files.set("src/table.ts", `export const paths = { '${path}': 'generate', 'scripts/generate.mjs': 'tool' };`);
    files.set("test/table.test.ts", 'import "../src/table.js";');
    files.set("src/reader.ts", `readFileSync('${path}', 'utf8');`);
    files.set("test/runtime-reader.test.ts", 'import "../src/reader.js";');
    const selection = selectAffectedSuites([path], { files, pathReaders: [], symbolSuites: [] });
    assert.equal(selection.fullRun, false);
    assert.deepEqual(selection.suites, ["test/direct.test.ts", "test/indirect.test.ts", "test/runtime-reader.test.ts"]);
    assert.deepEqual(selection.narrow, selection.suites);
  }
});

test(`${proof}: the real contract readers do not pull unrelated cli suites into the author gate`, () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const path of contracts) {
    const input = readAffectedSuitesInput(root, [path], { symbolSuites: [] });
    assert.ok(input.files.has("test/api-client-drift-check.test.ts"), "the input sees the real suites");
    assert.ok(input.files.has("test/helpers/openapi-strict.ts"), "the input sees the shared reader");
    const selection = selectAffectedSuites([path], input);
    assert.equal(selection.fullRun, false);
    assert.ok(selection.suites.includes("test/api-client-drift-check.test.ts"));
    if (path.startsWith("openapi/")) {
      assert.ok(selection.suites.includes("test/every-view-body-matches-its-schema.test.ts"));
    }
    assert.ok(!selection.suites.includes("test/the-affected-suite-graph-reads-no-comment.test.ts"));
    assert.deepEqual(selection.narrow, selection.suites);
  }
});
