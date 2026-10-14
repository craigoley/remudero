- **Control a multi-form glob on COVERAGE (was every form opened?), not on a match — a glob naming
  one form answers from the other silently.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below stated the trap, not the control that catches it. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **(c) A GLOB THAT NAMES ONE FILE FORM ANSWERS FROM THE OTHER WITHOUT SAYING SO.** Under `bash` a
  non-matching glob passes through literally and `grep` fails it into `2>/dev/null`; under `zsh` it
  errors. THE GENERAL FORM: control on COVERAGE (did every form get opened?), not on READABILITY (did
  something match?). *(2026-08-12)*
