- **Never add an advisory ignore, scanner exclusion or gate loosening without the operator's explicit
  yes; read ALL comments on another session's PR before pushing to it.**
  A red security or policy gate is the operator's call, not the author's. An advisory ignore, a
  scanner exclusion, a lint exemption, a skipped rule or a raised limit each turns a red into a green
  without fixing what the gate measures, so each needs the operator's explicit yes on the PR or in the
  session first. A reachability argument ("we never serve that transport") is a question to put to the
  operator, not a waiver to merge. Without the yes, leave the gate red, say why in the PR, and file or
  escalate the real fix.

  **READ THE WHOLE PR FIRST.** Before pushing to another session's PR, read ALL its comments, not only
  the body: an owner's refusal lives in the thread.

  **MEASURED 2026-10-16.**
  - #12305 (65f87ae06) restored mcp 1.29.0 for Semgrep's exact pin and made OSV green with a
    GHSA-84m7-p3x7-pcfv ignore in `.github/semgrep/osv-scanner.toml`, argued unreachable because Scan
    serves no Streamable HTTP endpoint. The PR owner had asked on the PR to keep every security gate
    intact with no exception. #12342 (4fd721d3a) reverted it.
  - #12322 (813d4a39a) exempted Dependabot-authored titles from commitlint's `header-max-length`.
    #12343 (85ffb6621) reverted it on the operator's ruling of 2026-10-16: no gate loosening; an
    over-long Dependabot title is retitled by the fleet instead.

  Workers get the same rule from `learnings/ci.yaml#an-advisory-ignore-needs-the-operator-yes`,
  scoped to the scanner, commitlint and merge-policy files. *(#12305/#12342, #12322/#12343)*
