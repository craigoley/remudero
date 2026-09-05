# 0001. Use TypeScript 7's native compiler as the project compiler

Status: Accepted
Date: 2026-07-14

## Context

The repository's initial scaffold commit (`WS-0 spike: prove the Remudero
primitive loop end-to-end`, PR #1, 2026-07-14) pinned `"typescript": "^7.0.2"`
in `package.json` from the very first commit — OBSERVED via
`git log -S'"typescript": "^7'` on `package.json`, which resolves to that
commit and no earlier one. TypeScript 7 ships a native (non-JS-hosted)
compiler; the project has run on that line for its entire history.

The initial commit's own message argues for the scaffold as a whole (the
worker/spike primitives), not for the TypeScript version specifically — the
recorded rationale for *why 7* over an older major is thin: no commit message,
DECISIONS.md entry, or MASTER-PLAN section that this checkout can reach
argues the choice on its own terms. This is a real gap, not filled in here.

The one-way door is downstream, not in the choice itself: any tool that
consumes the TypeScript **compiler API** (rather than shelling out to `tsc`)
caps at whatever major that tool's own dependency range supports. That
surfaced three days later — `.dependency-cruiser.cjs` (PR #176, W1-T26,
2026-07-17, the same PR that added this ADR process) documents it directly:

> Parse with swc, not the `typescript` compiler API: dependency-cruiser's
> tsc-based extractor only supports typescript >=2 <7, and this repo runs
> typescript@7 ... swc has no such ceiling, so it — not the project's own tsc
> version — drives extraction here.

So the project adapted its tooling around TS7 rather than capping TS7 to fit
the tooling. Every future compiler-API-consuming tool inherits the same
constraint.

## Decision

The project compiler is TypeScript `^7.0.2` (the native-compiler major),
used for `tsc --noEmit` typechecking and `tsc` builds across `src/`, `test/`,
and every workspace package/app. Tools that need the TypeScript compiler API
directly (not just CLI output) are pointed at an alternative (e.g. swc)
rather than pinning the project back to a compiler-API-compatible major.

## Consequences

- Any future dependency-graph, lint, or codegen tool that depends on the
  `typescript` npm package's compiler API for parsing will hit the same `<7`
  ceiling dependency-cruiser did, and needs the same kind of workaround
  (a non-tsc parser) rather than a version bump on the tool's side.
- HYPOTHESIS, unmeasured in this repo: TS7's native compiler is faster than
  the JS-hosted compiler it replaces. No before/after benchmark for this
  codebase is recorded anywhere this checkout can reach.
- The "why 7" rationale gap above is real; if it is ever resolved (a
  DECISIONS.md entry, a linked design note), this ADR should be superseded
  or amended to cite it rather than left implying a rationale that was never
  actually recorded.

**How to reverse:** downgrading to a TypeScript major in dependency-cruiser's
supported `<7` range would let that tool drop its swc parser and go back to
the native tsc extractor, but every other `<7`-incompatible surface written
against TS7 since 2026-07-14 would need re-validation — this is a
whole-tree typecheck-and-fix cost, not a data migration, but it scales with
however much TS7-only syntax the ~725-file tree (per DECISIONS.md's
2026-08-11 measurement) has accumulated since, which this checkout did not
enumerate.
