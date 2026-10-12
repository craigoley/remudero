#!/usr/bin/env node
// scripts/test-run.mjs — `npm test`: the caller's `node --test` argv, run in a host test slot at a concurrency sized by
// memory headroom as well as CPU, niced. Same files, reporter and exit code as plain node; extra argv passes through.
// Runs under `--import tsx` because src/lib/test-slot.ts imports `.js` specifiers.
import { runBoundedTest } from "../src/lib/test-run.ts";

process.exit(await runBoundedTest(process.argv.slice(2).filter((arg) => arg !== "--")));
