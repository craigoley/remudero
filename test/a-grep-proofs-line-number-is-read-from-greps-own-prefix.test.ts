import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { diffAnchor } from "#src/lib/main-repair-acceptance.js";
import {
  commentOnlyGrepProofRefusal,
  grepProofCanOnlyCertifyComments,
  matchedLinesAreAllComments,
  parseGrepOutputLine,
} from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const RECORD = "plan/tasks.d/W1-T1.yaml";
const STAMPED = "  # refusal-amendment (W1-T1, run r1, 2026-11-24T03:23:01.092Z): held";
const GNU_LINE = `6:${STAMPED}`;
const BSD_LINE = `${RECORD}:6:${STAMPED}`;
const PATTERN = "run r1, 2026-11-24T03";

function withFiles(files: Record<string, string>, run: (read: (path: string) => string | undefined) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}grep-prefix-`));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    run((path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 30 lines; `line6` and `line23` replace lines 6 and 23. */
function recordText(line6: string, line23: string): string {
  const lines = Array.from({ length: 30 }, (_, i) => `  key${i + 1}: value ${i + 1}`);
  lines[0] = "- id: W1-T1";
  lines[5] = line6;
  lines[22] = line23;
  return `${lines.join("\n")}\n`;
}

test("W1-T14618 criterion 1: the line number and text come from grep's own prefix, never a time stamp", () => {
  assert.deepEqual(parseGrepOutputLine(GNU_LINE), { lineNumber: 6, text: STAMPED.trim() });
  assert.ok(parseGrepOutputLine(GNU_LINE).text.startsWith("# refusal-amendment"));
  assert.deepEqual(parseGrepOutputLine(GNU_LINE, RECORD), { lineNumber: 6, text: STAMPED.trim() });
  assert.deepEqual(parseGrepOutputLine(BSD_LINE, RECORD), { lineNumber: 6, text: STAMPED.trim() });
  assert.deepEqual(parseGrepOutputLine('41:  const t = "10:15:00";'), { lineNumber: 41, text: 'const t = "10:15:00";' });
  assert.deepEqual(parseGrepOutputLine('41:  const t = "10:15:00";', "src/a.ts"), { lineNumber: 41, text: 'const t = "10:15:00";' });
  assert.deepEqual(parseGrepOutputLine("// at 2026-11-24T03:23:01Z"), { text: "// at 2026-11-24T03:23:01Z" });
});

test("W1-T14618 criterion 2: the comment-only verdict follows the matched line, not the minutes of a time stamp", () => {
  const commentAt6 = recordText(STAMPED, "  key23: data");
  const dataAt6 = recordText(`  note: "refusal-amendment (W1-T1, run r1, 2026-11-24T03:23:01.092Z): held"`, "  # a comment line");
  const jsFile = Array.from({ length: 30 }, (_, i) => (i === 4 ? "// ran at 03:23:01" : `export const v${i + 1} = ${i + 1};`)).join("\n");
  withFiles({ [RECORD]: commentAt6, "plan/tasks.d/W1-T2.yaml": dataAt6.replace("W1-T1", "W1-T2"), "src/a.ts": jsFile }, (read) => {
    assert.equal(grepProofCanOnlyCertifyComments(PATTERN, RECORD, read(RECORD)), true);
    assert.match(commentOnlyGrepProofRefusal(`grep: ${PATTERN} in ${RECORD}`, read) ?? "", /can only match comment text/);
    const other = "plan/tasks.d/W1-T2.yaml";
    assert.equal(grepProofCanOnlyCertifyComments(PATTERN, other, read(other)), false);
    assert.equal(commentOnlyGrepProofRefusal(`grep: ${PATTERN} in ${other}`, read), undefined);

    for (const line of [GNU_LINE, BSD_LINE]) {
      assert.equal(matchedLinesAreAllComments([line], { pattern: PATTERN, fileText: commentAt6, path: RECORD }), true, line);
      const dataLine = line.replace(STAMPED, dataAt6.split("\n")[5]!);
      assert.equal(matchedLinesAreAllComments([dataLine], { pattern: PATTERN, fileText: dataAt6, path: RECORD }), false, dataLine);
    }
    assert.equal(grepProofCanOnlyCertifyComments("ran at", "src/a.ts", read("src/a.ts")), true);
    assert.equal(matchedLinesAreAllComments(["5:// ran at 03:23:01"], { pattern: "ran at", fileText: jsFile, path: "src/a.ts" }), true);
    assert.equal(matchedLinesAreAllComments(["src/gone.ts:1:// gone", "5:// ran at 03:23:01"]), true);
    assert.equal(matchedLinesAreAllComments(["src/gone.ts:1:// gone", 'src/gone.ts:2:x = "03:23:01"']), false);
  });
});

test("W1-T14618 criterion 3: main-repair acceptance reads an added line with no grep prefix as text", () => {
  const diff = (added: string[]): string =>
    ["diff --git a/src/lib/a.ts b/src/lib/a.ts", "--- a/src/lib/a.ts", "+++ b/src/lib/a.ts", `@@ -1,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`), ""].join("\n");
  assert.deepEqual(diffAnchor(diff(["// at 2026-11-24T03:23:01Z"])), { kind: "unavailable", reason: "no-safe-candidate" });
  const anchor = diffAnchor(diff(["// at 2026-11-24T03:23:01Z", 'x = "03:23:01"']));
  assert.equal(anchor.kind, "anchored");
  assert.equal(anchor.kind === "anchored" ? anchor.line : undefined, 'x = "03:23:01"');
});

// A copy of the two readers this parser replaced, to check the lines they read right are unchanged.
function previousReading(line: string): { lineNumber?: number; text: string } {
  const textMatch = line.match(/^(?:.*?:)?\d+:(.*)$/);
  const text = (textMatch ? textMatch[1]! : line).trim();
  const numberMatch = line.match(/^(?:.*?:)?(\d+):/);
  const n = numberMatch ? Number(numberMatch[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? { lineNumber: n, text } : { text };
}

test("W1-T14618 criterion 4: invariant:grep-line-numbers-without-a-colon-number-are-unchanged", () => {
  const rows: Array<[string, string | undefined]> = [
    ["6:  # plain comment, no stamp", undefined],
    ["6:  # plain comment, no stamp", RECORD],
    ["12:export const x = 1; // trailing", "src/a.ts"],
    ["1:", undefined],
    ["0:zero is no number", undefined],
    ["99999999999999999999:too large", undefined],
    ["src/a.ts:12:// no stamp", undefined],
    ["src/a.ts:12:// no stamp", "src/a.ts"],
    [`${RECORD}:6:  # refusal-amendment held`, RECORD],
    [`${RECORD}:6:  # refusal-amendment held`, undefined],
    ["plan/x.yaml:30:  key: value", undefined],
    ["// a comment with no prefix", undefined],
    ["// a comment with no prefix", "src/a.ts"],
    ["const a = b ? c : d;", "src/a.ts"],
    ["key: value", RECORD],
    ["  12 items: none", undefined],
  ];
  for (const [line, path] of rows) {
    assert.deepEqual(parseGrepOutputLine(line, path), previousReading(line), `${line} (path ${path ?? "unknown"})`);
  }
});
