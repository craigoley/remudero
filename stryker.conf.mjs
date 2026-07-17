// Stryker mutation-testing config (W1-T25, MASTER-PLAN §5 TIER 2 "Mutation-
// testing baseline"). "Green tests that kill no mutants are theater; the
// mutation score is the falsifier that coverage % cannot provide" (LEARNINGS).
//
// SCOPE: src/lib/**/*.ts only. src/run-task.ts / src/spike.ts are CLI glue
// (the dependency-cruiser fitness rule elsewhere in this tier already says
// "src/lib imports nothing from spike/CLI" — src/lib is the testable core;
// the CLI layer is thin wiring, not where a mutation score earns its keep).
//
// testRunner: 'command' (not jest/mocha/karma) because this repo runs tests
// via Node's own `--test` runner, which Stryker has no native plugin for.
// The command runner re-execs `npm run test:unit` per mutant — no
// per-mutant test selection, so it is the slowest option Stryker offers.
//
// test:unit (test/*.test.ts, NON-recursive) deliberately excludes
// test/integration/**, not test/**/*.test.ts (which "npm test" — the real
// per-PR suite — still runs). Verified empirically: this repo's pinned
// TypeScript 7 is a native-port preview whose tsc shim delegates to a
// native binary (process.execve, falling back to execFileSync) rather than
// running a pure-JS compiler; invoked from a test that is itself DOUBLY
// nested inside another process's child-process tree (this is exactly what
// Stryker's command runner does — exec("npm run test:unit") wrapping a full
// `node --test` run), that delegation intermittently returned a silent
// false-pass (exit 0, empty stdout) — see
// test/integration/ts-strict-probe.test.ts's header for the full account.
// A flaky dry run would sink the ENTIRE mutation gate before a single
// mutant runs, so the handful of tests that shell out to external tool
// binaries live in test/integration/ and are excluded here, not "fixed" by
// retrying past an ambiguity a falsifier test cannot afford to paper over.
//
// inPlace: true is NOT a style choice — it is a forced workaround. Without
// it, Stryker's sandbox step tries to rewrite a COPY of tsconfig.json via
// `ts.parseConfigFileTextToJson`, an API TypeScript 7 (this repo's pinned
// `typescript` version) has removed; the run crashes with
// `TypeError: ts.parseConfigFileTextToJson is not a function` before a single
// mutant runs (verified empirically against this repo's installed TS 7.0.2 —
// distrust-the-prompt rule: this is exactly the kind of "assumed compatible"
// claim that turned out false). `inPlace` skips that rewrite entirely (see
// node_modules/@stryker-mutator/core/dist/src/sandbox/ts-config-preprocessor.js).
// The cost: inPlace mutates the real working tree file-by-file (with a
// backup/restore), so mutants CANNOT run concurrently — concurrency is
// pinned to 1 below. That, plus the command runner's full-suite-per-mutant
// cost (~2s/run measured), is why this is a SCHEDULED job
// (.github/workflows/mutation.yml: push-to-main + weekly + workflow_dispatch)
// and not a per-PR blocking gate — a full src/lib run is on the order of an
// hour, the same tradeoff the fleet already makes for CodeQL/OSV's full scans
// vs their PR-time fast paths (codeql.yml, osv-scanner.yml vs
// osv-scanner-pr.yml).
//
// RATCHET: thresholds.break below is sourced live from
// .remudero/quality-baseline.json's mutation.score — Stryker's own built-in
// enforcement (exits non-zero when the run's score is below `break`).
// .github/scripts/mutation-ratchet.mjs (package.json "mutation") is a
// SECOND, independent enforcement of the same ratchet, built on pure,
// unit-tested logic (src/lib/mutation-ratchet.ts /
// test/mutation-ratchet.test.ts) — belt-and-suspenders, not redundant dead
// code: either one failing fails the CI job. `null` (the bootstrap state —
// no real full-scope run has completed yet) disables Stryker's own
// enforcement; once a real baseline score is hand-recorded here, this gate
// ratchets it like coverage.
import { readFileSync } from 'node:fs';

const baseline = JSON.parse(
  readFileSync(new URL('./.remudero/quality-baseline.json', import.meta.url), 'utf8'),
);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'command',
  commandRunner: { command: 'npm run test:unit' },
  mutate: ['src/lib/**/*.ts'],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  coverageAnalysis: 'off',
  concurrency: 1,
  inPlace: true,
  timeoutMS: 60000,
  thresholds: { high: 80, low: 60, break: baseline.mutation.score },
};
