- **Require a verbatim `grep -rlF -- '<substring>' test/` hit — a passing scoped test run is NOT
  evidence the proof resolves.** `resolveNameFilteredCandidates` greps the SOURCE with a fixed
  string, so a title assembled from `" + "`-joined literals exists verbatim in no file: a proof
  spanning that concatenation seam resolves to ZERO candidates and is judged unexecutable even
  though the test exists and passes. *(impl-AG, caught pre-commit)*
