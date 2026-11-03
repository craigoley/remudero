import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifiedSymbolShadow, qualifiedShadowFailures } from "#src/lib/qualified-symbol-shadow.js";
import type { AffectedSuitesInput } from "#src/lib/affected-suites.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";
// @ts-expect-error — the CLI is JavaScript and ships no declaration file.
import { main } from "#scripts/select-affected-suites.mjs";

const files = new Map([
  ["scripts/target.mjs", "export function main() {}"],
  ["scripts/unrelated.mjs", "export function main() {}"],
  ["src/barrel.ts", 'export {main as run} from "../scripts/target.mjs";'],
  ["test/target.test.ts", 'import {main as target} from "../scripts/target.mjs"; target();'],
  ["test/barrel.test.ts", 'import {run} from "../src/barrel.js"; run();'],
  ["test/namesake.test.ts", 'import {main} from "../scripts/unrelated.mjs"; main();'],
  ["test/census.test.ts", "export {};"],
  ["test/recent.test.ts", "export {};"],
  ["test/reads.test.ts", 'readFileSync("scripts/target.mjs");'],
  ["test/changed.test.ts", "export {};"],
]);
const input = (): AffectedSuitesInput => ({ files, pathReaders: ["test/census.test.ts"], recentFailures: ["test/recent.test.ts"] });
const raw = ["test/target.test.ts", "test/barrel.test.ts", "test/namesake.test.ts", "test/recent.test.ts"];

test("qualified symbol shadow excludes a same-name different-module hit without dropping the floor", () => {
  const record = qualifiedSymbolShadow(["scripts/target.mjs", "test/changed.test.ts"], input(), raw);
  assert.equal(record.mode, "shadow");
  assert.equal(record.skipsNothing, true);
  assert.equal(record.fallback, undefined);
  assert.deepEqual(record.qualified, ["test/barrel.test.ts", "test/target.test.ts"]);
  assert.deepEqual(record.excludedNamesakes, ["test/namesake.test.ts"]);
  for (const suite of ["test/census.test.ts", "test/recent.test.ts", "test/reads.test.ts", "test/changed.test.ts", ...record.floor]) {
    assert.ok(record.proposed.includes(suite), suite);
  }
  assert.deepEqual(raw, ["test/target.test.ts", "test/barrel.test.ts", "test/namesake.test.ts", "test/recent.test.ts"], "inputs are not mutated");
});

test("qualified shadow retains dynamic imports and actual spawn paths", () => {
  const tree = new Map(files);
  tree.set("test/dynamic.test.ts", 'await import("../scripts/target.mjs");');
  tree.set("test/spawn.test.ts", 'spawn("node", ["scripts/target.mjs"]);');
  const record = qualifiedSymbolShadow(["scripts/target.mjs"], { ...input(), files: tree }, ["test/dynamic.test.ts", "test/spawn.test.ts"]);
  assert.deepEqual(record.qualified, ["test/dynamic.test.ts", "test/spawn.test.ts"]);
});

test("qualified shadow never certifies absent-source unknown-path or missing-test input", () => {
  for (const [changed, symbols] of [
    [["scripts/deleted.mjs"], raw], [["package-lock.json"], raw], [["scripts/target.mjs"], ["test/ghost.test.ts"]],
    [["test/changed.test.ts"], raw],
  ] as const) {
    const record = qualifiedSymbolShadow(changed, input(), symbols);
    assert.ok(record.fallback);
    assert.deepEqual(record.excludedNamesakes, []);
    assert.equal(qualifiedShadowFailures(record, ["test/namesake.test.ts"])[0]!.proposed, "unknown");
  }
});

test("qualified shadow reports an oracle miss instead of claiming a smaller selection is safe", () => {
  const record = qualifiedSymbolShadow(["scripts/target.mjs"], input(), raw);
  assert.deepEqual(qualifiedShadowFailures(record, ["test/namesake.test.ts", "test/target.test.ts", "test/namesake.test.ts"]), [
    { file: "test/namesake.test.ts", floor: "missed", proposed: "missed" },
    { file: "test/target.test.ts", floor: "selected", proposed: "selected" },
  ]);
});

test("qualified shadow never mislabels a full-run fallback as a floor miss", () => {
  const record = qualifiedSymbolShadow(["package-lock.json"], input(), raw);
  assert.equal(record.fullRun, true);
  assert.ok(record.fallback);
  assert.deepEqual(qualifiedShadowFailures(record, ["test/namesake.test.ts"]), [
    { file: "test/namesake.test.ts", floor: "selected", proposed: "unknown" },
  ]);
});

test("qualified shadow CLI emits a real Git-backed proposal and names an unreadable corpus", (t) => {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  for (const [path, content] of files) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  }
  repo.git("add", "."); repo.git("commit", "-m", "seed qualified shadow corpus");
  const changed = join(repo.dir, "changed.txt"), diff = join(repo.dir, "change.diff");
  writeFileSync(changed, "scripts/target.mjs\n");
  writeFileSync(diff, "+++ b/scripts/target.mjs\n@@ -1 +1 @@\n-export function main() {}\n+export function main() { return 1; }\n");
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const args = ["--changed-files", changed, "--diff", diff, "--qualified-symbol-shadow"];
  assert.equal(main(args, { root: repo.dir, summaryPath: undefined }), 0);
  const read = () => JSON.parse(lines.find((line) => line.startsWith("QUALIFIED-SYMBOL-SHADOW: "))!.slice(25));
  const observed = read();
  assert.equal(observed.mode, "shadow");
  assert.equal(observed.skipsNothing, true);
  assert.ok(observed.qualified.includes("test/target.test.ts"), "the Git-backed corpus sees its positive control");
  assert.ok(observed.excludedNamesakes.includes("test/namesake.test.ts"));
  lines.length = 0;
  assert.equal(main(args, { root: join(repo.dir, "missing"), summaryPath: undefined }), 0);
  assert.match(read().fallback, /could not produce a qualified corpus/);
});
