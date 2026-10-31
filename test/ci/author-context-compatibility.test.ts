import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const contextModule = '#scripts/lib/author-context-compatibility.mjs';
const {AUTHOR_CONTEXT_FORMAT, observeAuthorContext, requireAuthorContext} = await import(contextModule);

test("W1-T10961: only matching exact source dependency allocation and owner context can start or reuse a native phase", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-author-context-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const scratch = join(root, 'scratch'), output = join(root, 'output');
  mkdirSync(scratch); mkdirSync(output);
  const head = 'a'.repeat(40), tree = 'b'.repeat(40);
  const slot = {outcome: 'acquired', childEnvironment: {RMD_TEST_SLOT_PARENT: JSON.stringify({
    nonce: 'fixture-owner-nonce', pid: process.pid, start: 'fixture-process-start', path: join(root, 'lease'),
  })}};
  const dependency = () => ({state: 'present', lockSha256: 'fixture-lock', toolsSha256: 'fixture-tools'});
  const observe = () => observeAuthorContext({root, slot, allocations: {scratch, output}, dependency,
    git: (args: string[]) => args[0] === 'status' ? '' : args[1] === 'HEAD' ? head : tree});
  const expected = observe();
  assert.equal(expected.format, AUTHOR_CONTEXT_FORMAT);
  assert.deepEqual(expected.source, {head, tree, clean: true});
  assert.equal(expected.owner.ownerNonce, 'fixture-owner-nonce');
  assert.deepEqual(Object.keys(expected.allocations), ['output', 'scratch']);
  assert.ok(expected.allocations.scratch.ino > 0);
  assert.ok(expected.allocations.output.blockSize > 0);

  for (const intent of ['start', 'reuse']) {
    assert.deepEqual(requireAuthorContext(expected, observe(), intent), {compatible: true, mismatches: []});
    const variants = [
      {part: 'format', change: (c: any) => { c.format = 'unknown'; }},
      {part: 'source', change: (c: any) => { c.source.head = 'c'.repeat(40); }},
      {part: 'source', change: (c: any) => { c.source.tree = 'd'.repeat(40); }},
      {part: 'source', change: (c: any) => { c.source.clean = false; }},
      {part: 'dependency', change: (c: any) => { c.dependency.toolsSha256 = 'changed-tool'; }},
      {part: 'dependency', change: (c: any) => { c.dependency = {state: 'unavailable'}; }},
      {part: 'owner', change: (c: any) => { c.owner.ownerNonce = 'another-owner'; }},
      {part: 'owner', change: (c: any) => { c.owner.processStart = 'another-process'; }},
      {part: 'allocations', change: (c: any) => { delete c.allocations.output; }},
      {part: 'allocation:scratch', change: (c: any) => { c.allocations.scratch.ino++; }},
      {part: 'allocation:output', change: (c: any) => { c.allocations.output.fsType++; }},
    ];
    for (const {part, change} of variants) {
      const observed = structuredClone(expected);
      change(observed);
      assert.throws(() => requireAuthorContext(expected, observed, intent),
        (error: any) => error.code === 'ERR_AUTHOR_CONTEXT_MISMATCH' && error.mismatches.includes(part),
        `${intent} must refuse changed ${part}`);
    }
    for (const part of ['source', 'dependency', 'owner', 'allocations']) {
      const incomplete = structuredClone(expected);
      delete incomplete[part];
      assert.throws(() => requireAuthorContext(incomplete, incomplete, intent),
        (error: any) => error.code === 'ERR_AUTHOR_CONTEXT_MISMATCH',
        `equal missing ${part} must never authorize ${intent}`);
    }
  }
  rmSync(output, {recursive: true});
  const unavailable = observe();
  assert.equal(unavailable.allocations.output.state, 'unavailable');
  assert.throws(() => requireAuthorContext(expected, unavailable, 'reuse'), /allocation:output/);
  assert.throws(() => requireAuthorContext(expected, expected, 'resume'), /intent must be start or reuse/);
});
