- **A `grep:` proof must match text on ONE PHYSICAL LINE — a YAML block scalar wraps, and the
  pattern then reads 0 at head with no error.** Distinct from the acceptance-parser wrap hazard
  above: that one truncates a BLOCK, this one silently fails to match at all, so the criterion
  degrades on a body that looks right. Verify every proof at head AND base before pushing; the
  head-side zero is what catches it. *(#2645 — "GRANT A STRIKE BACK WHEN THE SIGNATURE CHANGES" read
  0, repointed to a phrase that did not wrap)*
