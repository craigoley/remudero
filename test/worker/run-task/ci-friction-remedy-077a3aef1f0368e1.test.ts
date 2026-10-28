import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

interface Report { code: number; out: string[]; err: string[] }
type Query = { changedPaths: string[]; flags?: string[] };

// Exercise the published command in a separate process. This is an integration boundary:
// the regression suite does not become another in-process importer of the full CLI graph.
function membership(queries: Query[]): Report[] {
  const script = `
    import { readFileSync } from "node:fs";
    const { censusMembershipCommand } = await import(process.argv[1]);
    const queries = JSON.parse(readFileSync(0, "utf8"));
    const reports = queries.map(({ changedPaths, flags = ["--files"] }) => {
      const out = [], err = [];
      const log = console.log, error = console.error;
      console.log = (...args) => out.push(args.join(" "));
      console.error = (...args) => err.push(args.join(" "));
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
    });
    process.stdout.write(JSON.stringify(reports));
  `;
  return JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, "#src/run-task.js"],
    { cwd: REPO_ROOT, input: JSON.stringify(queries), encoding: "utf8" })) as Report[];
}

const paritySuite = "test/console-parity-ratchet.test.ts";

test("W1-T10408: check:test:test/console-parity-ratchet.test.ts:flaky is prevented, not retried", () => {
  const report = membership([{ changedPaths: ["src/run-task.ts"] }])[0]!;
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
  const reports = membership([
    ...paths.map((path) => ({ changedPaths: [path] })),
    { changedPaths: ["src/run-task.ts", ...paths] },
    { changedPaths: ["src/run-task.ts"], flags: [] },
  ]);
  for (const [index, path] of paths.entries()) {
    assert.ok(reports[index]!.out.includes(paritySuite), path);
  }
  assert.equal(reports[paths.length]!.out.filter((p) => p === paritySuite).length, 1);
  const human = reports[paths.length + 1]!;
  assert.ok(human.out.some((line) => line.includes(`-> ${paritySuite}`)));
});

test("console parity is not selected for an unrelated documentation change", () => {
  const [files, human] = membership([
    { changedPaths: ["README.md"] },
    { changedPaths: ["README.md"], flags: [] },
  ]);
  assert.equal(files!.out.includes(paritySuite), false);
  assert.ok(human!.out.some((line) => line.includes("joins no known census")));
});
