# Forensics: scripts/coverage-merge-ratchet.mjs hand fixes

Scope: PRs #12820, #12796, #11834, #11602 and #9855, read as they touch
`scripts/coverage-merge-ratchet.mjs`. This serves W1-T10186, the CI-friction remedy for
`hand_fix:scripts/coverage-merge-ratchet.mjs`. Evidence is the commit message and the hunks of each
PR's squash commit in this file's history. I did not read the GitHub review threads or CI logs.

## Per-PR findings

| PR | Commit | What the hunk in this file does | Input it had not modelled |
| --- | --- | --- | --- |
| #9855 | fbf087a30 | Adds `scriptsTheSourceMapDescribes`; keeps one instance per repeated URL on the raw and compact read paths. | One file loaded by both tsx loaders gives two V8 scripts under one URL, but the source-map cache holds one map. The other instance's zero ranges land on unrelated lines and erase real hits. |
| #11602 | df76a457d | Small hunk (`counts` reporting). The real change is in `src/lib/test-impact-map.ts`: place each source map once. | About 3,400 reports at ~0.7 s each is ~40 minutes. The nightly merge job hit its 20-minute bound, so the floor ratchet and red-shard check never ran. |
| #11834 | ad57fc965 | Adds `missingSourceMessage` and `SYNTHETIC_DEFINE_SOURCE`, so the refusal names the shard, the functions and the W1-T421 CommonJS cause. | A `<define:import.meta>` record came from tsx compiling a tmp-dir wrapper as CommonJS. The ratchet refused it correctly but opaquely. |
| #12796 | ca860d817 | Corpus format v2 to v3 (gzip chunks): a legacy read path, a codec module and chunk-encoding validation. | The evidence corpus outgrew its bounded, replayable form. |
| #12820 | b8a71a87b | Replaces open with `O_NOFOLLOW` plus `fstat` by `lstatSync` then `readCoverageChunkBytes`. The commit says "bind manifest reads to stable file identity". | Evidence files could change identity between check and read, and scratch could be replaced or disposed of. |

## Common failure pattern

Common failure pattern: the ratchet's evidence intake (what it reads from shards, V8 reports and
scratch files, and how it merges them) assumed a well-formed input shape. Each PR is the first
time a real run produced a shape the intake had not modelled. In every case the fix came after a
red run and was a hand fix to this one file.

The inputs were:

- a duplicate script instance under one URL (#9855);
- a report count beyond the time bound (#11602);
- a synthetic source record (#11834);
- a corpus past its size and format bound (#12796);
- a file that changed identity between check and read (#12820).

Three of the five (#9855, #11834, #11602) were found only because a downstream gate failed. That
gate was `diff-coverage`, the ratchet refusal, or the nightly timeout.

## What the five do not share

They do not share one root cause. A remedy aimed at a single code defect would miss most of them.

- #9855 is a correctness bug: it silently dropped real hits, so the data was wrong.
- #11602 is a performance bound, and the algorithm change is outside this file.
- #11834 is a diagnostic gap. The refusal was right; only its message was poor.
- #12796 and #12820 are format and integrity hardening of the evidence store. They landed within
  an hour of each other (2026-10-18 19:02Z and 19:39Z) and are really one follow-on pair.

So the shared pattern is a class of change rather than a single bug. The file is the intake
boundary for every coverage-evidence shape, and it is changed reactively, one new shape at a time.

## Implication for the W1-T10186 remedy

A remedy has to prevent the reactive loop. It cannot prevent "a hand-fixed file":

1. Check the intake against a corpus of the known hostile shapes: duplicate URLs, synthetic
   `<define:...>` sources, mixed ESM and CJS loads, and identity swaps. This should be a
   table-driven test that replays them through the real code path, so a new shape is a new row.
2. Keep refusals self-describing, as #11834 did, so a refusal names its cause and does not need a
   hand fix to be understood.
3. Keep the runtime bounded and checked against the real report count, so a bound that fires on a
   healthy load (#11602) is caught before the nightly.

## Not examined

Three other commits touch this file: #12025 (3b3a706bc, W1-T9481), #11524 and #9897. #12025's
message describes the same kind of failure: a file loaded in two shapes, and a zero range erasing
hits in the merge. That is consistent with the #9855 pattern, and it suggests that failure
recurs even after #9855's fix. I did not read #11524 or #9897, and I did not check whether any of
the three belongs in the pattern. The other-file hunks of #11602 and #12796 were also not read in
full.
