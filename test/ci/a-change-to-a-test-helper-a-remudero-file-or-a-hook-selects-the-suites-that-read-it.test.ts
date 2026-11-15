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

/** One import line, built from segments so this file holds no relative specifier. */
const imports = (...segments: string[]) => `import { x } from "${segments.join("/")}";\n`;

/** A small tree: two suites reach a helper (one through a bridge), two suites name a hook (one through a
 *  helper that joins its segments), one names a config file, one only mentions the hook in a comment. */
const TREE: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "test/a.test.ts": imports("..", "src", "a.js"),
  "test/changed.test.ts": "export {};\n",
  "test/helpers/shared.ts": "export const shared = 1;\n",
  "test/helpers/bridge.ts": imports(".", "shared.js").replace("import", "export"),
  "test/helpers/orphan.ts": "export const orphan = 1;\n",
  "test/direct.test.ts": 'import { shared } from "#test/helpers/shared.js";\n',
  "test/indirect.test.ts": imports(".", "helpers", "bridge.js"),
  "test/names-hook.test.ts": 'readFileSync(join(ROOT, "hooks/pre-push"), "utf8");\n',
  "test/helpers/hook-runner.ts": 'export const hook = join(ROOT, "hooks", "pre-push");\n',
  "test/via-hook-runner.test.ts": imports(".", "helpers", "hook-runner.js"),
  "test/names-config.test.ts": 'readFileSync(join(ROOT, ".remudero/mounts.yaml"), "utf8");\n',
  "test/comment.test.ts": "// .remudero/skills/review.yaml and hooks/pre-push are named only here.\nexport {};\n",
  "test/reads-skill.test.ts": "export {};\n",
  "test/unrelated.test.ts": "export {};\n",
};

const input = (over: Partial<AffectedSuitesInput> = {}): AffectedSuitesInput =>
  ({ files: new Map(Object.entries(TREE)), pathReaders: [], symbolSuites: [], ...over });

/** A usable read map whose only record says test/reads-skill.test.ts read a skill file. */
const readMap = (): ReadMapInput => ({
  map: buildReadMap([{ suite: "test/reads-skill.test.ts", reads: [".remudero/skills/review.yaml"], listed: [], unknownDescriptors: false }],
    { sha: "a".repeat(40) }),
  drift: { distance: 1, changedSinceMap: [] },
});

test("W1-T12506 criterion 1: a test helper change selects the suites that reach it, not every suite", () => {
  assert.equal(fullRunTrigger(["test/helpers/shared.ts"]), undefined);
  assert.equal(fullRunTrigger(["test/helpers/shared.ts"], true), undefined);
  const sel = selectAffectedSuites(["test/helpers/shared.ts", "src/a.ts", "test/changed.test.ts"], input());
  assert.equal(sel.fullRun, false, sel.reasons.join("\n"));
  assert.deepEqual(sel.suites, ["test/a.test.ts", "test/changed.test.ts", "test/direct.test.ts", "test/indirect.test.ts"]);
  assert.ok(sel.reasons.includes("test/indirect.test.ts: reaches test/helpers/shared.ts"), sel.reasons.join("\n"));
  for (const suite of ["test/changed.test.ts", "test/direct.test.ts", "test/indirect.test.ts"]) {
    assert.ok(sel.narrow?.includes(suite), `the narrow arm keeps ${suite}`);
  }
});

test("W1-T12506 criterion 1: the real tree selects the importers of a real helper", () => {
  const changed = ["test/helpers/repo-root.ts"];
  const real = readAffectedSuitesInput(REPO_ROOT, changed, { symbolSuites: [] });
  const sel = selectAffectedSuites(changed, real);
  assert.equal(sel.fullRun, false, sel.reasons.join("\n"));
  const suites = [...real.files.keys()].filter((f) => /^test\/.*\.test\.ts$/.test(f));
  const self = "test/ci/a-change-to-a-test-helper-a-remudero-file-or-a-hook-selects-the-suites-that-read-it.test.ts";
  assert.ok(sel.suites.includes(self), "this suite imports the helper");
  assert.ok(sel.narrow?.includes(self), "the narrow arm keeps it");
  assert.ok(!sel.suites.includes("test/read-mapped-path-alternatives-are-anchored.test.ts"), "a suite that does not import it is left out");
  assert.ok(sel.suites.length < suites.length, `${sel.suites.length} of ${suites.length} suites`);
});

test("W1-T12506 criterion 2: a hook or .remudero change selects the suites that name or read it", () => {
  for (const path of ["hooks/pre-push", ".remudero/mounts.yaml", ".remudero/managed-repos.json"]) {
    assert.equal(fullRunTrigger([path]), undefined, path);
    assert.equal(fullRunTrigger([path], true), undefined, path);
  }
  const hook = selectAffectedSuites(["hooks/pre-push"], input());
  assert.equal(hook.fullRun, false, hook.reasons.join("\n"));
  assert.deepEqual(hook.suites, ["test/names-hook.test.ts", "test/via-hook-runner.test.ts"], "a comment names nothing");
  assert.deepEqual(hook.narrow, hook.suites);
  const config = selectAffectedSuites([".remudero/mounts.yaml"], input());
  assert.equal(config.fullRun, false, config.reasons.join("\n"));
  assert.deepEqual(config.suites, ["test/names-config.test.ts"]);
  // With a usable read map, the suites it records as readers are selected too.
  const skill = selectAffectedSuites([".remudero/skills/review.yaml"], input({ readMap: readMap() }));
  assert.equal(skill.fullRun, false, skill.reasons.join("\n"));
  assert.deepEqual(skill.suites, ["test/reads-skill.test.ts"]);
  assert.ok(skill.reasons.includes("test/reads-skill.test.ts: read .remudero/skills/review.yaml (read map)"), skill.reasons.join("\n"));
});

test("W1-T12506 criterion 3: a modelled helper or hook with no reader still forces the full run", () => {
  for (const [path, over] of [
    ["test/helpers/orphan.ts", {}],
    ["hooks/unknown-hook", { files: new Map([["test/unrelated.test.ts", "export {};\n"]]) }],
    [".remudero/skills/review.yaml", {}],
  ] as const) {
    assert.equal(fullRunTrigger([path]), undefined, `${path} is modelled`);
    const sel = selectAffectedSuites([path, "src/a.ts"], input(over));
    assert.equal(sel.fullRun, true, path);
    assert.equal(sel.suites.length, 0, "an empty reader set is never an empty selection");
    assert.deepEqual(sel.reasons, [`full run: ${path} is modelled, but no reader was found: no suite imports, names or reads it`]);
  }
});

test("W1-T12506 criterion 4: .github, openapi and packages changes still force the full run", () => {
  for (const path of [".github/workflows/ci.yml", "openapi/other.yaml", "packages/api-client/src/index.ts", "test/fixtures/x.ts"]) {
    assert.equal(fullRunTrigger([path]), path);
    assert.equal(fullRunTrigger([path], true), path);
    const sel = selectAffectedSuites([path, "test/helpers/shared.ts"], input({ readMap: readMap() }));
    assert.equal(sel.fullRun, true, path);
    assert.match(sel.reasons[0]!, new RegExp(`^full run: ${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is outside what the selector models`));
  }
  for (const contract of ["openapi/daemon.yaml", "packages/api-client/src/schema.d.ts"]) assert.equal(fullRunTrigger([contract]), undefined);
});
