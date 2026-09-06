# generate-docs-index.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/generate-docs-index.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol it explained. The file itself keeps a one-line `// Why:` pointer
wherever the history mattered.

Line numbers below are positions in `scripts/generate-docs-index.mjs` at the merge base of the
compaction PR (`origin/main` at 31e6d173152f3e6e8c8e4d4e80b83f41439c0a90).

## The file header

Removed from lines 2-48.

```
// scripts/generate-docs-index.mjs
//
// Docs INDEX generator (W1-T2282, MASTER-PLAN §8A).
//
// docs/ was the one knowledge corpus that never got this repo's own RETRIEVED-not-INJECTED
// treatment: MASTER-PLAN.md has plan/plan-index.json + `plan-index:check` (W1-T37),
// learnings/ has learnings/index.json + `learnings-index:check` + a budget ratchet + per-task
// matching (W1-T33), and CLAUDE.md is injected up front by a recorded decision
// (src/lib/plan-index.ts). docs/ had none of the three: a doc was reachable only if some OTHER
// file happened to cite its path, so several files carried no incoming citation from outside
// docs/ and were unreachable by construction, not by neglect.
//
// This script builds the missing index: for every markdown file under docs/, its path, title
// (the first `# ` heading, or the filename if none), a one-line summary (the first non-blank
// body line after that heading) and a grep hint (the title itself -- the string a worker would
// grep docs/ for to land on this file). An entry gives every doc a retrieval key, so "reachable"
// stops depending on whether some other file happened to name it. The index EXCLUDES its own
// output path, so generating it never creates an entry that would regenerate on every run.
//
// It also exposes findUnresolvedMermaidCitations(), which refuses (names the offending doc and
// path) a doc that cites a repo-relative path inside a fenced ```mermaid code block that does not
// resolve against the real checkout -- the shape of the one live defect this task found
// (docs/system-diagrams.md's mermaid label names `lib/status.ts`, which does not exist; the real
// file is `src/lib/status.ts`). This scope -- mermaid node-label citations, not every path-shaped
// substring in prose -- is deliberate: this corpus's prose routinely shortens an already-
// established `src/lib/foo.ts` mention to bare `lib/foo.ts` as accepted shorthand
// (docs/cli-reference.md, docs/operator-guide.md, docs/dep-review.md, docs/alert-lane.md and
// docs/review-gate.md all do this repeatedly), and a check that flagged every one of those would
// be a false-positive firehose, not a gate on a real defect. A mermaid diagram node label is
// different: MASTER-PLAN §"System diagrams" (docs/system-diagrams.md's own header) states every
// edge is "derived from a named symbol", i.e. it is a literal citation of a source location, not
// shorthand for one already established in surrounding prose, so precision there is enforceable.
// Existing docs are NEVER rewritten by this generator or its checks -- an unresolved path is
// reported and named, never silently corrected; the repair is its own, later change.
//
// The generated index is content-only (no timestamp) so it is byte-stable across runs when
// docs/**/*.md hasn't changed -- that is what makes `--check` a meaningful staleness gate, the
// same convention scripts/generate-plan-index.mjs (W1-T37) and scripts/generate-learnings-index.mjs
// (W1-T33) already use. Mermaid-path resolution is a SEPARATE gate (`--check-paths`), kept out of
// `--check` on purpose: staleness must track this corpus's own committed shape 1:1 with its
// siblings, and today's real corpus carries one known, tracked, unrepaired defect (see above) that
// would otherwise make `--check` permanently red for a reason unrelated to staleness.
//
// Usage:
//   node scripts/generate-docs-index.mjs [--dir docs] [--out docs/docs-index.json]
//   node scripts/generate-docs-index.mjs --check         # exit 1 if the committed index is stale
//   node scripts/generate-docs-index.mjs --check-paths   # exit 1 if any mermaid citation is unresolved
```

WHY THIS MATTERS, AND WHY IT IS NOW STALE. The "one known, tracked, unrepaired defect" this header
described was measured on `docs/system-diagrams.md`, whose mermaid label cited `lib/status.ts`
where the real file lives at `src/lib/status.ts`. That citation was corrected in place by PR #4075
(referenced but not yet merged as of `.github/workflows/docs-index-check.yml`'s own header
comment). At the time this compaction PR was written, `npm run docs-index:check-paths` reads OK
with zero unresolved citations — OBSERVED, this session — so the defect this paragraph named no
longer exists; the paragraph is kept here as the historical record of why the design keeps
`--check-paths` a separate gate from `--check` rather than folding mermaid-path resolution into
the staleness check.

## parseDocEntry

Removed from lines 91-118 (the full symbol doc):

```
/**
 * Parse one doc's markdown text into a {title, summary} pair: title is the first `# ` (H1)
 * heading with emphasis stripped, or null if the doc has none; summary is the first non-blank,
 * non-heading, NON-CALLOUT body line found after the title (truncated), or "" if the doc has no
 * such prose before its next heading / EOF.
 *
 * WHY CALLOUTS ARE SKIPPED, AND WHY THAT IS NOT A SPECIAL CASE FOR ONE DOC. A summary exists so a
 * reader scanning the index can tell what a doc is ABOUT. A banner saying who maintains the file
 * and that hand edits are overwritten answers a different question, so it was never a summary --
 * it was the heuristic picking up machinery because machinery happened to come first.
 *
 * IT IS ALSO WHY THE INDEX WENT STALE ON EVERY RETRO. `rmd retro` writes
 * `_MAINTAINED BY \`rmd retro\` -- regenerated <ISO>._` into docs/ORIENTATION.md on every run
 * (src/lib/retro.ts), and a first-prose-line heuristic copied that timestamp into the index --
 * so a generator the retro knows nothing about summarised a line the retro rewrites. Skipping the
 * callout takes the line BELOW it, which for that doc is a constant string literal in retro.ts
 * ("A fresh Architect session should be able to orient from THIS doc alone...") and therefore
 * survives a retro unchanged. Fixing the INPUT is what makes a freshness guard safe to add later;
 * adding the guard first would have reddened the retro's own PR for a defect it did not cause.
 *
 * MEASURED over docs/ at f5ac7cb5: 26 docs, 25 whose first prose line is ordinary prose and
 * exactly 1 that is a wholly-emphasised callout -- the same 1 whose line carries a timestamp. The
 * rule selects it without naming it, and would select any future doc that opens the same way.
 *
 * KNOWN LIMIT, stated rather than hidden: a genuine one-line summary written entirely in emphasis
 * would be skipped too. None exists today, and the fallback is the next prose line or "" -- never
 * machinery.
 */
```

## Other compacted doc comments

Doc comments for `WHOLLY_EMPHASISED_RE` (line 86), `buildDocsIndex` (line 144),
`extractMermaidPathCitations` (line 170), `findUnresolvedPathsInText` (line 192),
`findUnresolvedMermaidCitations` (line 208) and `main` (line 224) were shortened for length alone —
each kept its purpose sentence and any invariant it stated; none carried a measured fact, a named
incident or a design argument distinct from what the file header or `parseDocEntry`'s doc already
covers above.
