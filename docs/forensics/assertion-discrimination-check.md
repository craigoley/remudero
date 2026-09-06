# assertion-discrimination-check.mjs forensics

The measured forensics, incident narrative and design arguments removed from
`scripts/assertion-discrimination-check.mjs` when its comments were compacted to the plain-language
standard. Every block below is the removed text verbatim, marker characters stripped and nothing
else changed. Headings name the section the text explained; the code keeps a one-line `// Why:`
pointer where the history mattered. Base revision: origin/main at
ec4c8abaecef98791fc32f94864da32f0057ee07; the line numbers below are that revision's.

## Module header

### Base lines 2-30 — the flock CI incident, the mutation-testing blind spot, and the predicate

```
// scripts/assertion-discrimination-check.mjs
//
// ASSERTION-DISCRIMINATION gate (W1-T1051).
//
// A test can assert that a literal string appears in the RAW text of a repo file while the
// literal is satisfied only by a COMMENT next to the mechanism the test claims to be pinning.
// The mechanism can go dead -- the assertion still passes, because the string is still there.
// That is exactly how a CI wait that should have blocked for ~5 minutes on an apt lock instead
// returned in ~1 second and shipped green: the test asserted the literal `flock` appeared, the
// literal was present, and nobody noticed `flock(2)` and dpkg's `fcntl(2)` record lock are
// independent lock spaces because the assertion could not tell "the wait is real" from "the word
// is written down somewhere in the file, including in a comment about it."
//
// Mutation testing cannot see this class at all: it mutates SOURCE, this defect lives in a TEST
// asserting against a non-source file (a workflow, a script, ...), and `test/**` is never a
// mutation target in this repo (see stryker.conf.json / mutation-nightly-scope.json).
//
// THE PREDICATE (stated so a falsifier can exist): for each assertion whose subject is a
// variable read via readFileSync/readFile from a path that resolves STATICALLY to a real path
// inside the repo checkout (never a per-test tmpdir -- those are not "a repo path" and are
// reported UNRESOLVED, not silently skipped and not silently passed), locate the target file,
// strip its comments, and re-evaluate the SAME literal against the stripped copy:
//   - literal present in raw text, ABSENT after stripping -> FAIL (comment-satisfiable only)
//   - literal present in both                             -> PASS
//   - literal absent from raw text too (assertion already fails for its own reasons, out of
//     this check's scope), or the target path / its comment syntax cannot be resolved
//     statically                                           -> UNRESOLVED (counted separately,
//                                                              never silently treated as a pass)
//
```

### Base lines 41-66 — the flock-shaped comment-syntax rationale, the mutation-baseline mirror, and the claims-check.mjs shape convention

```
// COMMENT SYNTAX IS PER-TARGET: `#` to end-of-line for .yml/.yaml/.sh/.bash (this also covers a
// shell comment INSIDE a workflow `run:` block, the exact shape of the flock defect -- the block
// scalar's lines are still plain text carrying a `#` shell comment token); `//` and `/* */` for
// .ts/.tsx/.js/.mjs/.cjs/.json/.jsonc. A `#`/`//` byte inside a quoted string is never treated
// as a comment start (test/fixtures/assertion-discrimination-check/targets/quoted-hash.yml pins
// this). Any other target extension is UNRESOLVED (no known comment syntax to strip).
//
// FAIL LOUD. Resolving zero assertion sites at all is a FAILURE, not a vacuous pass -- an empty
// comparison is exactly the shape of dead-guard this check exists to catch in itself.
//
// A finding may be EXEMPTED via scripts/assertion-discrimination-baseline.json, but every
// exemption entry MUST carry a non-empty `reason` -- an exemption with no reason is rejected at
// load time so the list cannot grow silently (mirrors scripts/mutation-baseline.json's captured
// bootstrap-with-reason shape).
//
// READ-ONLY: this script allocates nothing, edits no test, rewrites no baseline.
//
// Usage:
//   node scripts/assertion-discrimination-check.mjs [--root <repo-root>] [--test-dir <dir>]
//                                                    [--baseline <path>]
//
// Defaults: --root <repo root>, --test-dir test, --baseline scripts/assertion-discrimination-baseline.json
//
// Mirrors scripts/claims-check.mjs's shape: a plain node module, exported pure pieces for unit
// testing, one CLI entry point, exposed as an npm script, wired into exactly one unconditional
// ci.yml job.
```

## Scope

### Base lines 31-39 — why the variable-bound, plain-string-only form is deliberately narrower than the problem

```
// SCOPE, DELIBERATELY NARROWER THAN THE PROBLEM. Only the variable-bound form is recognised
// (`const x = readFileSync(...)` / `const x = await readFile(...)`, later checked via
// `x.includes("literal")`, `x.match(/literal/)`, `assert.match(x, /literal/)`, or
// `assert.ok(x.includes("literal"))`), and only when the literal is a PLAIN string -- a regex
// with real metacharacters (e.g. `/^\s*claims:\s*$/m`) is not "a literal a comment could
// satisfy" in the sense this check decides, so it is not treated as a site at all. An inline
// `readFileSync(...).includes(...)` chain with no intermediate variable is out of scope too.
// This is the same "narrower than the problem, and that's the point" shape as every other
// mechanical gate in this repo -- see the task's own rationale/design for the full case.
```
