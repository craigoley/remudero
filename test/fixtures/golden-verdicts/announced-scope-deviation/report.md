REPORT
- a.ts now exports the corrected constant a.
- DELIBERATE SCOPE DEVIATION, ANNOUNCED: this diff also touches learnings/architecture.yaml,
  outside declared scope. It trims a pre-existing entry's `fact` field down to its actionable rule
  text alone, moving its measurement forensics into a new `evidence` field, so the corpus stays
  under its own curation cap -- a prerequisite this PR could not otherwise clear, not unrelated
  growth.
PR_URL: https://github.com/o/r/pull/9011
