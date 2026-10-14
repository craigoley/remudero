- **`diff-coverage` flags ADDED lines, so restructuring an untested region inherits its debt at the
  gate — measure MAIN's coverage of that region before assuming the PR caused it.** Rewriting a
  block converts a silent pre-existing gap into a blocking failure. *(#1399 — every line of the
  comment-assembly block scored 0 hits on origin/main; the PR only moved it)*
