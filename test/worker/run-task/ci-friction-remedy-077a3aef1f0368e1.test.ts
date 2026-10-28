import assert from "node:assert/strict";
import { test } from "node:test";
import { censusMembershipCommand } from "#src/run-task.js";

function membership(changedPaths: string[], flags: string[] = ["--files"]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.join(" ")); };
  try {
    const code = censusMembershipCommand(flags, {
      changedPaths,
      spawn: () => ({ status: 1, stdout: "", stderr: "" }),
      readers: () => [],
    });
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const paritySuite = "test/console-parity-ratchet.test.ts";

test("W1-T10408: check:test:test/console-parity-ratchet.test.ts:flaky is prevented, not retried", () => {
  const report = membership(["src/run-task.ts"]);
  assert.equal(report.code, 0);
  assert.ok(report.out.includes(paritySuite), "the author sweep must select the real parity check");
  assert.ok(report.out.includes("test/help-renders-a-summary-not-a-paragraph.test.ts"));
  assert.deepEqual(report.err, []);
});

test("console parity is selected for routes, classifications, baseline and its own suite", () => {
  const paths = [
    "src/lib/inbox-routes.ts", "scripts/console-parity-ratchet.mjs",
    "scripts/console-parity-baseline.json", "test/helpers/declared-routes.ts", paritySuite,
  ];
  for (const path of paths) {
    assert.ok(membership([path]).out.includes(paritySuite), path);
  }
  assert.equal(membership(["src/run-task.ts", ...paths]).out.filter((p) => p === paritySuite).length, 1);
  const human = membership(["src/run-task.ts"], []);
  assert.ok(human.out.some((line) => line.includes(`-> ${paritySuite}`)));
});

test("console parity is not selected for an unrelated documentation change", () => {
  assert.equal(membership(["README.md"]).out.includes(paritySuite), false);
  assert.ok(membership(["README.md"], []).out.some((line) => line.includes("joins no known census")));
});
