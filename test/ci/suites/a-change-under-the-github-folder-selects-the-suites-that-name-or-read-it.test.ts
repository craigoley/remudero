import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReadMap,
  fullRunTrigger,
  readAffectedSuitesInput,
  selectAffectedSuites,
  type AffectedSuitesInput,
  type ReadMapInput,
} from "#src/lib/affected-suites.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A small tree: one suite names a semgrep file, one names the workflows folder, one only comments on a file. */
const TREE: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "test/names-file.test.ts": 'readFileSync(join(ROOT, ".github/semgrep/build-requirements.txt"), "utf8");\n',
  "test/names-folder.test.ts": 'readdirSync(join(ROOT, ".github", "workflows"));\n',
  "test/comment.test.ts": "// .github/unknown/commented.yml is named only in this comment.\nexport {};\n",
  "test/reads-codeql.test.ts": "export {};\n",
  "test/unrelated.test.ts": "export {};\n",
};

const input = (over: Partial<AffectedSuitesInput> = {}): AffectedSuitesInput =>
  ({ files: new Map(Object.entries(TREE)), pathReaders: [], symbolSuites: [], ...over });

/** A usable read map recording every suite; only test/reads-codeql.test.ts read a codeql config. */
const readMap = (): ReadMapInput => ({
  map: buildReadMap(Object.keys(TREE).filter((f) => f.startsWith("test/")).map((suite) => ({
    suite, reads: suite === "test/reads-codeql.test.ts" ? [".github/codeql/codeql-config.yml"] : [], listed: [], unknownDescriptors: false,
  })), { sha: "a".repeat(40) }),
  drift: { distance: 1, changedSinceMap: [] },
});

test("W1-T13036 criterion 1: a .github change selects the suites that name or read it, not every suite", () => {
  for (const path of [".github/semgrep/build-requirements.txt", ".github/workflows/ci.yml"]) {
    assert.equal(fullRunTrigger([path]), undefined, path);
    assert.equal(fullRunTrigger([path], true), undefined, path);
  }
  const file = selectAffectedSuites([".github/semgrep/build-requirements.txt"], input());
  assert.equal(file.fullRun, false, file.reasons.join("\n"));
  assert.deepEqual(file.suites, ["test/names-file.test.ts"]);
  assert.ok(file.reasons.includes("test/names-file.test.ts: names .github/semgrep/build-requirements.txt"), file.reasons.join("\n"));
  assert.deepEqual(file.narrow, file.suites);
  const folder = selectAffectedSuites([".github/workflows/ci.yml"], input());
  assert.equal(folder.fullRun, false, folder.reasons.join("\n"));
  assert.deepEqual(folder.suites, ["test/names-folder.test.ts"]);
  const mapped = selectAffectedSuites([".github/codeql/codeql-config.yml"], input({ readMap: readMap() }));
  assert.equal(mapped.fullRun, false, mapped.reasons.join("\n"));
  assert.deepEqual(mapped.suites, ["test/reads-codeql.test.ts"]);
  assert.ok(mapped.reasons.includes("test/reads-codeql.test.ts: read .github/codeql/codeql-config.yml (read map)"), mapped.reasons.join("\n"));
});

test("W1-T13036 criterion 1: the real tree selects the suites naming a real .github file", () => {
  const changed = [".github/semgrep/build-requirements.txt"];
  const real = readAffectedSuitesInput(REPO_ROOT, changed, { symbolSuites: [] });
  const sel = selectAffectedSuites(changed, real);
  assert.equal(sel.fullRun, false, sel.reasons.join("\n"));
  const suites = [...real.files.keys()].filter((f) => /^test\/.*\.test\.ts$/.test(f));
  assert.ok(sel.suites.length > 0 && sel.suites.length < suites.length, `${sel.suites.length} of ${suites.length} suites`);
});

test("W1-T13036 criterion 2: a .github file no suite names and the map does not record still forces a full run", () => {
  const path = ".github/unknown/orphan.yml";
  for (const over of [{}, { readMap: readMap() }]) {
    const sel = selectAffectedSuites([path, "src/a.ts"], input(over));
    assert.equal(sel.fullRun, true, path);
    assert.equal(sel.suites.length, 0, "an empty reader set is never an empty selection");
    assert.deepEqual(sel.reasons, [`full run: ${path} is modelled, but no reader was found: no suite imports, names or reads it`]);
  }
  // A comment names nothing: the one suite mentioning commented.yml only in a comment is no reader.
  const comment = selectAffectedSuites([".github/unknown/commented.yml"], input());
  assert.equal(comment.fullRun, true);
  assert.match(comment.reasons[0]!, /no reader was found/);
});

test("W1-T13036 criterion 3: other unmodelled paths still force a full run and a diff without .github is unchanged", () => {
  for (const path of ["Dockerfile.x", "openapi/other.yaml", "packages/api-client/src/index.ts", "test/fixtures/x.ts", ".githubx/y.yml"]) {
    assert.equal(fullRunTrigger([path]), path);
    assert.equal(fullRunTrigger([path], true), path);
    const sel = selectAffectedSuites([path, ".github/semgrep/build-requirements.txt"], input({ readMap: readMap() }));
    assert.equal(sel.fullRun, true, path);
    assert.match(sel.reasons[0]!, new RegExp(`^full run: ${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is outside what the selector models`));
  }
  const plain = selectAffectedSuites(["src/a.ts", "test/unrelated.test.ts"], input());
  assert.equal(plain.fullRun, false, plain.reasons.join("\n"));
  assert.deepEqual(plain.suites, ["test/unrelated.test.ts"]);
});
