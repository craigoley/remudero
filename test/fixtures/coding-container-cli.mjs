// Synthetic Docker wire only. Never starts a container or executes submitted source.
import { readFileSync, writeFileSync } from 'node:fs';
const [scenario, verb, ...args] = process.argv.slice(2);
const id = 'a'.repeat(64), file = 'wire-state.json';
if (verb === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
else if (verb === 'overflow') process.stdout.write('x'.repeat(65537));
else if (verb === 'combined') { process.stdout.write('x'.repeat(40000)); process.stderr.write('y'.repeat(40000)); }
else if (verb === 'bad-exit') { process.stdout.write('unavailable'); process.exitCode = 7; }
else if (verb === 'create') {
  writeFileSync(file, JSON.stringify({ args, started: false }), { flag: 'wx', mode: 0o600 });
  if (scenario === 'uncertain-create') process.exitCode = 7;
  else process.stdout.write(scenario === 'malformed-id' ? 'done' : id);
} else {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const name = state.args[state.args.indexOf('--name') + 1];
  const mounts = state.args.filter(v => v.startsWith('type=bind,')).map(v => {
    const fields = Object.fromEntries(v.split(',').filter(v => v.includes('=')).map(v => v.split('=')));
    return { Type: 'bind', RW: false, Source: fields.src, Destination: fields.dst };
  });
  if (verb === 'inspect') {
    if (scenario === 'malformed-inspect') process.stdout.write('not-json');
    else process.stdout.write(JSON.stringify([{ Id: scenario === 'wrong-id' ? 'b'.repeat(64) : id,
      Image: state.args.find(v => /^sha256:[a-f0-9]{64}$/.test(v)), Name: '/' + name,
      Config: { User: '65534:65534', Entrypoint: ['node'], Cmd: ['--max-old-space-size=64', '/input/harness.mjs'], Env: ['PATH=/usr/bin'] },
      HostConfig: { Runtime: scenario === 'runc' ? 'runc' : 'runsc', NetworkMode: 'none', ReadonlyRootfs: true,
        Privileged: false, NanoCpus: 1000000000, Memory: 268435456, MemorySwap: 268435456, PidsLimit: 32,
        IpcMode: 'none', PidMode: '', CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges=true'],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=8m,mode=1777' }, Ulimits: [{ Name: 'nofile', Hard: 64, Soft: 64 }] },
      Mounts: mounts, State: { Status: state.started ? (scenario === 'still-running' ? 'running' : 'exited') : 'created',
        Running: state.started && scenario === 'still-running', Dead: false, OOMKilled: scenario === 'oom',
        Error: '', ExitCode: scenario === 'execution-failed' ? 1 : 0 } }]));
  } else if (verb === 'start') {
    state.started = true; writeFileSync(file, JSON.stringify(state));
    if (scenario === 'start-failed') process.exitCode = 1;
    else if (scenario === 'printed-pass') process.stdout.write('# tests 11\n# pass 11\n# fail 0');
    else {
      const nonce = name.slice('rmd-author-canary-coding-'.length);
      const inputs = [0, 42, 9999];
      process.stdout.write(JSON.stringify({ protocol: 'coding-values-v1', nonce: scenario === 'wrong-nonce' ? 'c'.repeat(32) : nonce,
        results: Array.from({ length: 11 }, (_, i) => ({ id: String(i), value: i < 3 ? { value: scenario === 'wrong-values' ? -1 : inputs[i] } : { error: 'TypeError' } })) }));
    }
  } else if (verb === 'rm') {
    if (scenario === 'cleanup-failed') process.exitCode = 1;
    else process.stdout.write(id);
  } else throw new Error('unknown synthetic verb');
}
