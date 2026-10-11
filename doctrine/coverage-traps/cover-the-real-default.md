- **When every test injects a fake, the seam's DEFAULT implementation and each `catch` arm are
  unreachable — write one test that really shells out, and one per catch arm.** #978 shipped 182
  lines of tests that all supplied their own `PreflightSpawn`, so `defaultPreflightSpawn` never ran
  and 1 of 3 catch arms was exercised (9 uncovered lines). Fix shape: append the injectable
  parameter LAST so no positional caller shifts, cover the wiring with a recorder, and assert the
  real thing (status, stdout, stderr, piped stdin) — a leaf that threw on nonzero exit would turn
  every ordinary check failure into the catch arm's message and lose the tool's own output.
  *(#977, #978)*
