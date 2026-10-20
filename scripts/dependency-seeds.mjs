#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
// Standalone installs use Node's native type stripping, including the repository Clock port.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === './clock.js' && context.parentURL?.endsWith('/dependency-seeds.ts') ? './clock.ts' : specifier, context);
} });
const { configuredDependencySeedRoot, defaultDependencySeedRoot, dependencySeedConfigPath, materializeDependencySeed, observeDependencySeedReuse, sweepDependencySeeds } = await import('../src/lib/dependency-seeds.ts');

export function seedIsOpen(seed, uid = process.getuid?.(), exec = execFileSync) {
  // User lsof cannot rule out other accounts; seed pruning requires an administrator view.
  if (uid !== 0) throw new Error('administrator open-file scan required');
  try { return exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '+D', seed], { encoding: 'utf8', timeout: 30_000 }).trim().length > 0; }
  catch (error) { if (error.status === 1 && !error.stdout?.length && !error.stderr?.length) return false; throw error; }
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const checkout = command === 'prime' ? args.shift() : undefined;
  const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  try {
  const root = flag('--root') ?? configuredDependencySeedRoot() ?? defaultDependencySeedRoot();
  if (command === 'enable') {
    if (!isAbsolute(root)) throw new Error('seed root must be absolute');
    const file = dependencySeedConfigPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { writeFileSync(file, JSON.stringify({ enabled: true, root }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('existing seed configuration must be reviewed before replacing it'); throw error; }
    console.log(JSON.stringify({ config: file, root }));
  } else if (command === 'prime' && checkout) {
    console.log(JSON.stringify(materializeDependencySeed(checkout, { root, sourceDir: flag('--source'), proof: args.includes('--proof') })));
  } else if (command === 'report') {
    if (args.includes('--apply')) throw new Error('report is read-only; --apply is not accepted');
    console.log(JSON.stringify(observeDependencySeedReuse(root), null, 2));
  } else if (command === 'sweep') {
    console.log(JSON.stringify(sweepDependencySeeds(root, { apply: args.includes('--apply'), isOpen: seedIsOpen }), null, 2));
  } else throw new Error('usage: dependency-seeds.mjs enable [--root PATH] | prime CHECKOUT [--source DONOR] [--proof] [--root PATH] | report [--root PATH] | sweep [--root PATH] [--apply]');
    return 0;
  } catch (error) { console.error(`dependency-seeds: ${error.message}`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
