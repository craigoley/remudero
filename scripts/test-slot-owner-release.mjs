#!/usr/bin/env node
// Owner-lane release of ONE test-slot reservation, by the exact identity the owner observed (W1-T11808).
// It adds no release basis: every refusal of releaseTestSlotForOwner (live owner, foreign host/boot/pid
// namespace/uid, unproven terminal evidence, private records) applies. Run it from the owner's own PID
// namespace and uid. It never signals a process and never edits any other record.
import { join } from 'node:path';
import { releaseTestSlotForOwner } from '../src/lib/test-slot.ts';
import { isMainModule, parseArgv } from './lib/argv.mjs';

const HELP = `usage: node --import tsx scripts/test-slot-owner-release.mjs --slot-dir <dir> --slot <n> --nonce <ownerNonce> --pid <pid> --start <processStart>
All five flags are required; there is no pattern, glob or "latest" form.
Prints one JSON line {step, outcome, reason, evidence?}; exits 0 only on "released".`;

const OPTIONS = {
  'slot-dir': { type: 'string' }, slot: { type: 'string' }, nonce: { type: 'string' },
  pid: { type: 'string' }, start: { type: 'string' },
};

/** The five request fields, or the first reason they are not an exact identity. */
export function parseOwnerReleaseArgs(argv) {
  let values;
  try { ({ values } = parseArgv(argv, OPTIONS, { allowPositionals: false })); }
  catch (error) { return { reason: `bad arguments: ${error instanceof Error ? error.message : String(error)}` }; }
  for (const flag of Object.keys(OPTIONS)) {
    if (typeof values[flag] !== 'string' || values[flag] === '') return { reason: `missing required --${flag}` };
  }
  if (!/^[1-9][0-9]*$/.test(values.slot)) return { reason: '--slot must be a positive integer' };
  if (!/^[1-9][0-9]*$/.test(values.pid) || !Number.isSafeInteger(Number(values.pid))) return { reason: '--pid must be a positive integer' };
  return { path: join(values['slot-dir'], `slot-${values.slot}.json`),
    request: { ownerNonce: values.nonce, pid: Number(values.pid), processStart: values.start } };
}

/** Run the release; returns the JSON-line row and the exit status (0 only on "released"). */
export function runOwnerRelease(argv) {
  const parsed = parseOwnerReleaseArgs(argv);
  if (parsed.reason !== undefined) return { row: { step: 'test_slot.owner_release_cli', outcome: 'refused', reason: parsed.reason }, status: 2 };
  const result = releaseTestSlotForOwner(parsed.path, parsed.request);
  const row = { step: 'test_slot.owner_release_cli', ...result };
  if (result.outcome === 'released') row.reason = 'identity matched and covered work proven ended';
  return { row, status: result.outcome === 'released' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); }
  else {
    const { row, status } = runOwnerRelease(process.argv.slice(2));
    console.log(JSON.stringify(row));
    process.exitCode = status;
  }
}
