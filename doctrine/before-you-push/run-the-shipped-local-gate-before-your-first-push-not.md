- **Run the shipped local gate before your FIRST push, not every commit.**
  `rmd preflight --ci-parity` (W1-T294, `src/lib/ci-parity.ts`) shells CI's OWN commands, one
  entry per `.github/workflows/ci.yml` job -- its `ci` entry runs `npm run test:ci`, the SAME
  full-suite command the coverage-ratchet job runs, so a green run is the real signal, not a
  scoped approximation. Run the gate itself, never a proxy for what it does -- the next local
  check this repo adds inherits this rule too. *(W1-T294, W1-T338)*
