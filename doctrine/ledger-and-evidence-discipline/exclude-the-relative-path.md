- **On a zero match, `node --test --test-name-pattern` still emits `ok 1 - <RELATIVE test path>` —
  exclude the wrapper by the RELATIVE path, never the absolute one.** A control filtering on the
  absolute path counts the wrapper, returns 1, and reports a false pass, which would make every
  proof verification vacuous. Always run the control
  (`--test-name-pattern "no test title matches this xyzzy"`) and require a post-filter count of 0
  before believing any match count. *(#981 — the control caught the blind discriminator, not the proofs)*
