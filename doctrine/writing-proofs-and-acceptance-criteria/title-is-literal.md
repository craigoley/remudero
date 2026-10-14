- **A `unit test:` title is matched as a LITERAL substring after escaping — the OPPOSITE of a
  `grep:` pattern, which is a BASIC REGEX.** `parseTestTarget` (`src/lib/review.ts`) compiles a
  bare title to `--test-name-pattern escapeRegExp(trimmed)`, so `.` `(` `)` `[` `]` and every other
  regex metacharacter match only THEMSELVES and never act as a wildcard, group, or class. A title
  where `.` stands in for punctuation you didn't want to type verbatim resolves to ZERO real tests
  and reads `not_executable` — silently, with no error, and the criterion quietly falls back to the
  keyword floor (W1-T245/#651: 4 of 5 proofs executed; the 5th used `.` for the parentheses in the
  test's own title and matched nothing). Copy the title's plain prose out verbatim and use no
  metacharacters; this dialect offers no way to opt into pattern semantics. *(W1-T112, W1-T488)*
