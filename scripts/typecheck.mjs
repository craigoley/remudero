#!/usr/bin/env node
// scripts/typecheck.mjs — `npm run typecheck`: the full `tsc -p tsconfig.json --noEmit`, incremental against this
// checkout's per-worktree buildinfo and admitted through a host test slot when cold. Same diagnostics and exit code as
// plain tsc; extra argv passes through. Runs under `--import tsx` because src/lib/test-slot.ts imports `.js` specifiers.
import { runTypecheck } from "../src/lib/typecheck-run.ts";

process.exit(runTypecheck(process.cwd(), process.argv.slice(2).filter((arg) => arg !== "--")));
