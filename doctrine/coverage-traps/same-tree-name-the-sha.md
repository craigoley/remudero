- **Build the lcov and the diff from the SAME tree — commit before measuring — AND NAME THE SHA in
  what you report.** An lcov from a dirty working tree measured against `git diff origin/main...HEAD`
  (which excludes uncommitted work) misaligns line numbers and reports untouched pre-existing code
  as newly uncovered. The quieter variant: reusable artefact paths (`/tmp/x.lcov`) survive while
  `origin/main` MOVES under you mid-session, so a re-run silently compares a stale lcov against a
  fresh diff — stamp the sha into the filename or the report line, and re-derive both sides after
  any pull. *(#1399 — two phantom "uncovered" lines that were the pre-existing `floorDegraded`
  branch; filename-reuse variant 2026-08-14)*
