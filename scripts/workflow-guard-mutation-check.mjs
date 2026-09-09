#!/usr/bin/env node
// W1-T3220 compatibility entrypoint. The implementation lives in the *-ratchet.mjs path so the
// existing INSTRUMENT_SURFACE pattern protects the CI-grading logic from product-code coupling.
export * from "./workflow-guard-mutation-check-ratchet.mjs";
import { main } from "./workflow-guard-mutation-check-ratchet.mjs";

if (process.argv[1] && process.argv[1].endsWith("workflow-guard-mutation-check.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
