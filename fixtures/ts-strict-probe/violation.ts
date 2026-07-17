// FIXTURE — never imported by src/ or test/, never compiled by the real
// `tsc -p tsconfig.json` build on its own. .github/scripts/ts-strict-probe.sh
// copies this file INTO src/lib/ temporarily and runs the project's real
// typecheck command against it. It must FAIL to compile, with a
// strict-mode-specific error (TS18047 on this repo's pinned TypeScript 7,
// "'x' is possibly 'null'" — strictNullChecks; TS <=5 reports the same
// violation as TS2531, a different code — see ts-strict-probe.sh), never a
// bare syntax/type error a non-strict `tsc` would also catch. If the probe
// run ever SUCCEEDS, that proves strict mode is not actually active on this
// project's tsconfig — the planted-probe pattern from LEARNINGS ("'0
// violations' from a fresh strict gate is suspicious until falsified", the
// neon-drift `_probe(x)` lesson) applied to TypeScript's `strict` flag
// specifically.
export function _tsStrictProbe(x: string | null): string {
  return x.toUpperCase();
}
