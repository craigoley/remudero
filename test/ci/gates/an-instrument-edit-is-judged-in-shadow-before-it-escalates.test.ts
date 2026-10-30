import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  INSTRUMENT_GRANT_SHADOW_DIR, INSTRUMENT_GRANT_SHADOW_STEP, classifyInstrumentDiff, recordInstrumentGrantShadow,
} from "#src/lib/instrument-grant.js";
import { withTempDir } from "#src/lib/tmp.js";

const CENSUS = "scripts/expiring-fixture-census.mjs";
const BASELINE = "scripts/census-precheck-parity-baseline.json";

const additiveCensus = [
  `diff --git a/${CENSUS} b/${CENSUS}`,
  "index 1111111..2222222 100644",
  `--- a/${CENSUS}`,
  `+++ b/${CENSUS}`,
  "@@ -10,3 +10,4 @@ const CLOCKS = [",
  "   \"startedAt\",",
  "+  \"registeredAt\",",
  "   \"endedAt\",",
  "   \"closedAt\",",
].join("\n");

const changedBaseline = [
  `diff --git a/${BASELINE} b/${BASELINE}`,
  `--- a/${BASELINE}`,
  `+++ b/${BASELINE}`,
  "@@ -1,3 +1,3 @@",
  " {",
  "-  \"ceiling\": 12",
  "+  \"ceiling\": 14",
  " }",
].join("\n");

test("W1-T11029 criterion 1: a diff that only adds lines to every requested instrument path would be granted", () => {
  const j = classifyInstrumentDiff(additiveCensus, [CENSUS]);
  assert.equal(j.verdict, "would_grant");
  assert.deepEqual(j.paths, [{ path: CENSUS, verdict: "additive", added: 1, removed: 0, reason: "adds 1 line(s) and removes none" }]);
  assert.equal(j.reason, "every requested instrument path only adds lines");
});

test("W1-T11029 criterion 1: a changed line, a moved number, or a path the diff never touches escalates", () => {
  const j = classifyInstrumentDiff(`${additiveCensus}\n${changedBaseline}`, [CENSUS, BASELINE, "scripts/diff-class.mjs"]);
  assert.equal(j.verdict, "would_escalate");
  assert.deepEqual(j.paths.map((p) => [p.path, p.verdict]), [
    [BASELINE, "modifies"], ["scripts/diff-class.mjs", "absent"], [CENSUS, "additive"],
  ]);
  assert.match(j.reason, /census-precheck-parity-baseline\.json: removes or changes 1 line\(s\)/);
  assert.match(j.reason, /diff-class\.mjs: the worker's diff does not touch this path/);
});

test("W1-T11029 criterion 1: hunk lines resembling file headers count as edits", () => {
  const changed = [
    `diff --git a/${CENSUS} b/${CENSUS}`,
    `--- a/${CENSUS}`,
    `+++ b/${CENSUS}`,
    "@@ -1 +1 @@",
    "--- count;", // Removed source line: -- count;
    "+console.log(count);",
  ].join("\n");
  const judgement = classifyInstrumentDiff(changed, [CENSUS]);
  assert.equal(judgement.verdict, "would_escalate");
  assert.deepEqual(judgement.paths.map((path) => [path.verdict, path.added, path.removed]), [["modifies", 1, 1]]);

  const added = [
    `diff --git a/${CENSUS} b/${CENSUS}`,
    `--- a/${CENSUS}`,
    `+++ b/${CENSUS}`,
    "@@ -0,0 +1 @@",
    "+++ count;", // Added source line: ++ count;
  ].join("\n");
  assert.deepEqual(classifyInstrumentDiff(added, [CENSUS]).paths.map((path) => [path.verdict, path.added, path.removed]),
    [["additive", 1, 0]]);
});

test("W1-T11029 criterion 1: a deletion, a mode change, a rename or a binary diff is never additive", () => {
  const cases: Array<[string, string]> = [
    ["deleted file mode 100644", "the file is deleted"],
    ["old mode 100644", "the file mode changes"],
    ["Binary files a/x and b/x differ", "the diff is binary"],
    ["rename from scripts/a.mjs", "the file is renamed"],
  ];
  for (const [line, reason] of cases) {
    const diff = [`diff --git a/${CENSUS} b/${CENSUS}`, line, "+added"].join("\n");
    const j = classifyInstrumentDiff(diff, [CENSUS]);
    assert.deepEqual([j.verdict, j.paths[0]!.verdict, j.paths[0]!.reason], ["would_escalate", "modifies", reason]);
  }
  const headerOnly = classifyInstrumentDiff(`diff --git a/${CENSUS} b/${CENSUS}\nindex 1..2 100644`, [CENSUS]);
  assert.deepEqual([headerOnly.paths[0]!.verdict, headerOnly.paths[0]!.reason], ["absent", "the diff adds no line"]);
  assert.deepEqual(classifyInstrumentDiff("", []), { verdict: "would_escalate", paths: [], reason: "no instrument path was requested" });
  assert.equal(classifyInstrumentDiff("stray line before any header\n" + additiveCensus, [CENSUS]).verdict, "would_grant");
});

test("W1-T11029 criterion 1: both endpoints of a rename modify the requested paths", () => {
  for (const edits of [[], ["@@ -1 +1,2 @@", " unchanged", "+added"]]) {
    const diff = [
      `diff --git a/${CENSUS} b/${BASELINE}`,
      `similarity index ${edits.length ? 90 : 100}%`,
      `rename from ${CENSUS}`,
      `rename to ${BASELINE}`,
      ...(edits.length ? [`--- a/${CENSUS}`, `+++ b/${BASELINE}`, ...edits] : []),
    ].join("\n");
    const judgement = classifyInstrumentDiff(diff, [CENSUS, BASELINE]);
    assert.equal(judgement.verdict, "would_escalate");
    assert.deepEqual(judgement.paths, [BASELINE, CENSUS].map((path) => ({
      path, verdict: "modifies", added: edits.length ? 1 : 0, removed: 0, reason: "the file is renamed",
    })));
    for (const path of [CENSUS, BASELINE]) {
      assert.equal(classifyInstrumentDiff(diff, [path]).paths[0]!.verdict, "modifies");
    }
  }
});

test("W1-T11029 criterion 1: the stand-down ledgers its shadow verdict and saves the worker's patch for the spot-check", async () => {
  await withTempDir("instrument-grant", async (dir) => {
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const calls: string[][] = [];
    const judgement = await recordInstrumentGrantShadow({
      worktreePath: "/worktree", instrumentPaths: [CENSUS], stateDir: dir, roundId: "DAEMON-1:1:2", prNumber: 15520, headSha: "9dca5f8",
      git: async (cwd, args) => { calls.push([cwd, ...args]); return additiveCensus; },
      log: (step, fields) => rows.push({ step, fields }),
    });
    assert.equal(judgement?.verdict, "would_grant");
    assert.deepEqual(calls, [["/worktree", "diff", "--no-color", "--no-ext-diff", "HEAD", "--", CENSUS]]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.step, INSTRUMENT_GRANT_SHADOW_STEP);
    const patchPath = join(dir, INSTRUMENT_GRANT_SHADOW_DIR, "DAEMON-1_1_2.patch");
    assert.equal(rows[0]!.fields.patch_path, patchPath);
    assert.equal(readFileSync(patchPath, "utf8"), additiveCensus);
    assert.equal(rows[0]!.fields.pr_number, 15520);
    assert.equal(rows[0]!.fields.verdict, "would_grant");
    assert.match(String(rows[0]!.fields.patch_sha256), /^[a-f0-9]{64}$/);
    assert.deepEqual(rows[0]!.fields.judged, [{ path: CENSUS, verdict: "additive", added: 1, removed: 0 }]);
  });
});

test("W1-T11029 criterion 1: an unreadable diff or an unwritable patch is ledgered and never throws", async () => {
  await withTempDir("instrument-grant", async (dir) => {
    const rows: Array<Record<string, unknown>> = [];
    const unread = await recordInstrumentGrantShadow({
      worktreePath: "/gone", instrumentPaths: [CENSUS], stateDir: dir, roundId: "r", prNumber: undefined, headSha: "h",
      git: async () => { throw new Error("not a git repository"); }, log: (_step, fields) => rows.push(fields),
    });
    assert.equal(unread, undefined);
    assert.equal(rows[0]!.verdict, "unreadable");
    assert.match(String(rows[0]!.reason), /not a git repository/);

    writeFileSync(join(dir, INSTRUMENT_GRANT_SHADOW_DIR), "a file where the patch directory belongs");
    const judged = await recordInstrumentGrantShadow({
      worktreePath: "/worktree", instrumentPaths: [BASELINE], stateDir: dir, roundId: "r2", prNumber: 1, headSha: "h",
      git: async () => changedBaseline, log: (_step, fields) => rows.push(fields),
    });
    assert.equal(judged?.verdict, "would_escalate");
    assert.equal(typeof rows[1]!.patch_error, "string");
    assert.equal(rows[1]!.patch_path, undefined);
  });
});

for (const readable of [true, false]) {
  test(`W1-T11029 criterion 1: a ledger failure after an ${readable ? "additive" : "unreadable"} diff never rejects`, async () => {
    await withTempDir("instrument-grant", async (dir) => {
      const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
      await assert.doesNotReject(async () => {
        const judgement = await recordInstrumentGrantShadow({
          worktreePath: "/worktree", instrumentPaths: [CENSUS], stateDir: dir,
          roundId: readable ? "readable" : "unreadable", prNumber: 15520, headSha: "h",
          git: async () => {
            if (!readable) throw new Error("not a git repository");
            return additiveCensus;
          },
          log: (step, fields) => {
            rows.push({ step, fields });
            throw new Error("ledger filesystem unavailable");
          },
        });
        assert.equal(judgement, undefined);
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.step, INSTRUMENT_GRANT_SHADOW_STEP);
      assert.equal(rows[0]!.fields.verdict, readable ? "would_grant" : "unreadable");
      if (readable) assert.equal(readFileSync(join(dir, INSTRUMENT_GRANT_SHADOW_DIR, "readable.patch"), "utf8"), additiveCensus);
    });
  });
}
