#!/usr/bin/env node
// scripts/check.mjs — run a SCOPED test target and `tsc --noEmit` in ONE invocation, and report
// BOTH outcomes.
//
// THE FOOTGUN THIS REMOVES (impl-GC). Scoped local runs go through `tsx`, which STRIPS types
// without checking them: a test that passes a `Date` where the signature says `number` runs green
// under `tsx --test` and is rejected by `tsc`. So a session runs its suites, sees green, and pushes
// something that cannot typecheck. Every brief asks for "tsc clean" and sessions run it faithfully
// — the failure mode is not skipping it, it is running it BEFORE the last file is written, after
// which nothing re-checks. Bundling both into one command makes that ordering impossible: whatever
// `tsc` reports here is as-of the tree at this instant, the same instant the tests ran.
//
// BOTH SIGNALS, ALWAYS. `tsc` failing does not skip the tests and a failing test does not skip
// `tsc`. That is deliberate: CI's `ci` job runs Typecheck then Test as sequential steps, so a red
// typecheck there means the Test step never reports (the suite is still covered by the
// `coverage-ratchet` job, which runs the same `test/**/*.test.ts` glob independently — see the
// impl-GC report). Locally there is no reason to withhold either result.
//
// A TARGET IS REQUIRED. With no argument `node --test` walks the whole tree, and the full suite is
// not something this scoped verb should ever start by accident: it is CI's and
// `rmd preflight --ci-parity`'s job (both run `npm run test:ci`, the same full glob), and inside an
// agent container it cannot even pass honestly — uid 0 turns permission-branch fixtures into vacuous
// greens, Playwright suites die at browser launch, and `git commit` fixtures wedge on an unreachable
// MCP endpoint (docs/troubleshooting.md, "The full test suite cannot pass inside the agent
// container"). Refusing is safer than defaulting.
import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error(
    [
      "check: no test target given.",
      "",
      "  usage:  npm run check -- test/<file>.test.ts [more.test.ts ...]",
      "",
      "A target is REQUIRED on purpose: `node --test` with no argument walks the whole tree, and",
      "the full suite belongs to CI and `rmd preflight --ci-parity`, not to this scoped verb",
      "(inside an agent container it cannot pass honestly — see docs/troubleshooting.md).",
    ].join("\n"),
  );
  process.exit(2);
}

/** Run one command inheriting stdio; return its exit code (127 when the binary is missing). */
function run(label, file, args) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(file, args, { stdio: "inherit" });
  if (r.error) {
    console.error(`check: could not run ${label}: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

// Tests first, typecheck LAST — so the final word on the tree is the one the CI gate will also
// give, and so a session reading the tail of the output sees the check it is most likely to have
// run too early.
const testCode = run(
  `scoped tests (${targets.length} file${targets.length === 1 ? "" : "s"})`,
  "node",
  ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", ...targets],
);

const tscCode = run("tsc --noEmit (whole project, as of NOW)", "npx", ["--no-install", "tsc", "-p", "tsconfig.json", "--noEmit"]);

console.log(
  [
    "",
    "=== check summary ===",
    `  scoped tests : ${testCode === 0 ? "PASS" : `FAIL (exit ${testCode})`}`,
    `  typecheck    : ${tscCode === 0 ? "PASS" : `FAIL (exit ${tscCode})`}`,
  ].join("\n"),
);

// Non-zero if EITHER failed — never only the last one, which is how a piped check silently reports
// success on a failing step.
process.exit(testCode === 0 && tscCode === 0 ? 0 : 1);
