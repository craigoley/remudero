import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The exercised gate is a plain .mjs script without a declaration file.
import { formatBlockingViolation, computeBoundaryRanges, DIFF_COV_DIRECTIVES } from "../scripts/diff-coverage.mjs";

const added = new Map([["src/example.ts", new Map([[2, "return 1;"]])]]);

test("a c8 ignore beside a reported line is named as not honoured", () => {
  const result = formatBlockingViolation(
    "src/example.ts:2",
    added,
    "function example() {\n  /* c8 ignore next -- this looks like a coverage waiver */\n  return 1;\n}",
  );

  assert.match(result, /c8 ignore waiver is not honoured/);
});

test("the inert-waiver message names the diff-cov directive", () => {
  const result = formatBlockingViolation(
    "src/example.ts:2",
    added,
    "function example() {\n  // c8 ignore next\n  return 1;\n}",
  );

  assert.match(result, new RegExp(`diff-cov: ${DIFF_COV_DIRECTIVES.join(" or ")}`));
});

test("a honoured diff-cov directive still waives its region", () => {
  const { ranges, errors } = computeBoundaryRanges(
    [
      "// diff-cov: process-boundary — re-exec glue",
      "function dispatch() {",
      "  process.exit(0);",
      "}",
    ].join("\n"),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(
    ranges.map((range: { start: number; end: number; kind: string }) => ({
      start: range.start,
      end: range.end,
      kind: range.kind,
    })),
    [
    { start: 2, end: 4, kind: "process-boundary" },
    ],
  );
});
