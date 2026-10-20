#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateStorageRetention, readStorageObservation } from '../src/lib/evidence-storage-policy.ts';
import { systemClock } from '../src/lib/clock.ts';

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== '--manifest') throw new Error('usage: evidence-storage-policy.mjs --manifest PATH (read-only; no --apply)');
    const result = evaluateStorageRetention(readStorageObservation(argv[1]), systemClock.now());
    console.log(JSON.stringify(result, null, 2));
    return result.state === 'unknown' ? 2 : 0;
  } catch { console.error('storage-policy: UNKNOWN; invalid, changed or unreadable private manifest or arguments'); return 2; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
