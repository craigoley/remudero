import assert from "node:assert/strict";
import { test } from "node:test";
import { censusWalksOf } from "#src/lib/ci-parity.js";
import { decideFixOutcomeAction, readRedAttribution, redAttribution } from "#src/lib/fix-outcome.js";

const CENSUS = "test/catch-erasure-ratchet.test.ts";
const CANDIDATE = "test/new-census.test.ts";
const ORDINARY = "test/plain.test.ts";
const CHANGED = "src/lib/new-site.ts";
const CANDIDATE_TEXT = `
import { readdirSync } from "node:fs";
const files = (dir: string) => readdirSync(dir, { withFileTypes: true });
for (const file of files(join(REPO, "src"))) inspect(file);
`;

function input(file: string, text: string) {
  return {
    failingTestFiles: [file], changedPaths: [CHANGED],
    closure: new Map([[file, new Set([file])]]),
    baseOutcomes: new Map([[file, "passes" as const]]),
    namedInClosure: new Set<string>(), isHarnessPath: () => false,
    censusWalks: new Map([[file, censusWalksOf(file, text)]]),
  };
}

function reads(file: string, text: string | undefined) {
  return {
    failingTestFiles: [file], headSha: "head", prNumber: 1,
    ledger: [{ step: "sweep.base_reproduction", head_sha: "head", files: [{ file, outcome: "passes" }] }],
    rerunReproduced: false, isHarnessPath: () => false,
    mainTip: () => "main", changedPaths: () => [CHANGED],
    closure: async () => new Map([[file, new Set([file])]]),
    namedInClosure: () => new Set<string>(),
    readTestText: (head: string, path: string) => {
      assert.equal(head, "head");
      assert.equal(path, file);
      return text;
    },
  };
}

test("W1-T9733: a census red the diff enters is diff-reaches", async () => {
  for (const [file, text] of [[CENSUS, ""], [CANDIDATE, CANDIDATE_TEXT]] as const) {
    for (const attribution of [redAttribution(input(file, text)), await readRedAttribution(reads(file, text))]) {
      assert.equal(attribution.kind, "diff-reaches");
      assert.deepEqual(attribution.reached, [CHANGED]);
      assert.ok(attribution.reason.includes(file), attribution.reason);
      assert.ok(attribution.reason.includes(CHANGED), attribution.reason);
      assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["src/lib/repair.ts"] },
        { admitTests: true, attribution }).kind, "scope-needed");
    }
  }
});

test("W1-T9733: an ordinary red the diff cannot reach is unchanged", async () => {
  for (const attribution of [redAttribution(input(ORDINARY, "export {};")),
    await readRedAttribution(reads(ORDINARY, "export {};"))]) {
    assert.equal(attribution.kind, "diff-cannot-reach");
    assert.deepEqual(attribution.reached, []);
    assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["src/lib/repair.ts"] },
      { admitTests: true, attribution }).kind, "rerun-once");
  }
  assert.equal((await readRedAttribution(reads(ORDINARY, undefined))).kind, "unknown",
    "only readable ordinary text can establish that the suite walks nothing");
});

test("W1-T9733: census prefixes preserve boundaries and mixed failures preserve unread facts", () => {
  const base = input(CENSUS, "");
  const outside = redAttribution({ ...base, changedPaths: ["src-other/new-site.ts"] });
  assert.equal(outside.kind, "diff-cannot-reach");
  const mixed = { ...base, failingTestFiles: [CENSUS, CANDIDATE],
    closure: new Map([[CENSUS, new Set([CENSUS])], [CANDIDATE, new Set([CANDIDATE])]]),
    baseOutcomes: new Map([[CENSUS, "passes" as const], [CANDIDATE, "passes" as const]]) };
  assert.equal(redAttribution(mixed).kind, "diff-reaches", "one known walk is enough to reach the red");
  const unread = redAttribution({ ...mixed, changedPaths: ["docs/other.md"] });
  assert.equal(unread.kind, "unknown", "a missing second file cannot prove the diff reaches neither suite");
  assert.ok(unread.reason.includes(CANDIDATE), unread.reason);
  assert.equal(redAttribution({ ...base, censusWalks: undefined }).kind, "unknown");
});

test("W1-T9733: the default reader reads the census at the requested git head", async () => {
  const attribution = await readRedAttribution({ ...reads(CENSUS, ""), headSha: "HEAD", readTestText: undefined });
  assert.equal(attribution.kind, "diff-reaches");
  assert.deepEqual(attribution.reached, [CHANGED]);
  const absent = await readRedAttribution({ ...reads("test/absent-w1-t9733.test.ts", ""),
    headSha: "HEAD", readTestText: undefined });
  assert.equal(absent.kind, "unknown");
});

test("W1-T9733: unread census text keeps the scope amendment", async () => {
  for (const file of [CENSUS, CANDIDATE]) {
    for (const readTestText of [() => undefined, () => { throw new Error("head blob unavailable"); }]) {
      const attribution = await readRedAttribution({ ...reads(file, ""), readTestText });
      assert.equal(attribution.kind, "unknown");
      assert.ok(attribution.reason.includes(file), attribution.reason);
      assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["src/lib/repair.ts"] },
        { admitTests: true, attribution }).kind, "scope-needed");
    }
  }
});
