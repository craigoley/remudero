- **(a) A POSIX REGEX ENGINE HERE SILENTLY DROPS `\s`/`\b` INSTEAD OF ERRORING, AND TWO DIFFERENT
  TOOLS DO IT.** Both are GNU extensions; a POSIX engine matches something else and reports a clean
  zero. `awk` is mawk: over a file containing `  let b = 2;`, `/^[[:space:]]+(let|const)/` matches 1
  and `/^\s+(let|const)/` matches 0 — one session's declaration scan used the `\s` form, reported an
  EMPTY declaration list and a row of zeros, and called a refactor scope-safe on no evidence
  *(2026-08-09, twice)*. **NEVER PUT `\b` IN A `git grep` PATTERN — WHETHER IT WORKS IS A GIT-VERSION FACT, NOT A
  STANDING ONE.** Same tree, same commands, 2026-09-07: `git grep -lE '\bdate' -- src/` returns
  **29** on git 2.39.5 (system grep agrees) and **0** on git 2.54.0; `criterionFieldTampered\b`
  returns **49** and **0**. The older reading recorded here (**21** at 6e7d131) was real and is
  SUPERSEDED, not deleted — CI runs the old engine and a workstation the new one, which is how a
  citation gate read zero for every symbol locally while CI stayed green *(W1-T2849)*. A `\b`
  adjacent to a NON-WORD character is a separate and CORRECT zero on every engine (`\b/usr/bin/`
  needs a word char left of `/`). Anchor on the non-word character
  (`[[:space:]]/usr/bin/`), use `-w`, or drop the `\b`. Never `\s` under `awk`. *(2026-08-12)*
