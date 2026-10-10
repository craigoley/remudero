#!/usr/bin/env node
// `npm run typecheck`: the plain `tsc -p tsconfig.json --noEmit` off the fleet; on it, incremental and admitted through
// the host-wide test slot when cold (src/lib/typecheck-command.ts). Extra argv after `--` reaches tsc unchanged.
import { runTypecheckCommand } from '../src/lib/typecheck-command.ts';

process.exitCode = await runTypecheckCommand(process.cwd(), { extraArgs: process.argv.slice(2) });
