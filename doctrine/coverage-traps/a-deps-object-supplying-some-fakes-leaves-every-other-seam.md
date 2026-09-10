- **A deps object supplying SOME fakes leaves every other seam on its REAL default — so relaxing a
  guard can make a previously-dead default FIRE, in a file the diff never touched.** The MIRROR of
  the all-fakes bullet above. A test stubbing only `log` let the real `defaultReexec` fire, which
  replays `process.argv.slice(1)` — under `node --test` that IS the runner — killing six runners at
  `exit 143` with no failed step and no summary, which reads as preemption. Run every CALLER of a
  changed symbol (`git grep -l`), never the files the task declares; the scoped run was green.
  *(#2237, #2248)*
