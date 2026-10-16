# Test restructure: operator decisions

2026-10-16, asked by Craig: "our test folder doesn't seem to be very well structured… add sub folders and structure… research best practices, innovate… don't break in-flight PRs… grill me… lean into automated flow and self improvement".

Answers so far:
1. Scope: test/ now, src/ later. The test taxonomy mapping should be reusable to drive a later src/lib split.
2. Rollout: fleet-driven waves. Tooling first (placement map, path-alias layer for plan proofs and manifests, placement census), then the fleet moves one folder per PR, skipping files any open PR touches.
3. Naming: keep the sentence-style names; folders give the grouping, with no renames.

Research in flight: coupling-inventory.md, taxonomy.md and proposed-map.tsv, best-practices.md (this seed directory).

## Round 2 answers (2026-10-16, after research)
4. Taxonomy: 21 subsystem folders + rules/: console-api, worker, ci, inbox, rules, review, daemon, plan, github, deploy, learning, ledger, sweep, gardeners, fix-lane, routing, dispatch, memory, triage, infra, sre. Second levels for console-api, worker, ci. fixtures/helpers/setup are unchanged. No folder named census, ratchet or baseline (RULE_SUITE_NAME_RE).
5. Identity: the unique basename is the key. A uniqueness census, plus every path-keyed reader falling back to basename lookup. Merged proofs are not rewritten, and open proofs need no re-pointing.
6. Rules cost: test/rules/ becomes the rule-suite declaration. Shard the rules lane by measured duration, plus a shared repo snapshot per CI job keyed by tree SHA.
7. Self-improvement: a misplacement gardener opens small pure-rename move PRs through the normal flow and measures the map's accuracy. Its map later drives the src/lib split.

## Plan (filed as tasks; ids are in plan/tasks.d, filed with this directory)
- Phase 0 (enablers, no moves):
  - A. basename identity and resolver;
  - B. repoRoot() helper and census minimum counts;
  - C. #src/#test import alias, with imports rewritten in batches of ≤900 files;
  - D. flat-only readers made recursive;
  - E. auto-placement of new tests, with the classifier and map committed as repo data.
- Phase 1: F. placement census (no new flat files, flat count only falls, every folder in the map); G. test/rules/ declares rule suites, plus sharding and a snapshot.
- Phase 2: H. the `rmd test-move <folder>` tool (regenerated against main, skips files open PRs touch, pure renames, re-keys manifests, blame-ignore-revs), then one fleet task per folder.
- Phase 3: I. the misplacement gardener.
