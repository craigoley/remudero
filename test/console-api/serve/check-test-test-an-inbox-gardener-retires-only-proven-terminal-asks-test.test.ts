import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { world } from "#test/helpers/why-me-world.js";

test("W1-T10941: check:test:test/an-inbox-gardener-retires-only-proven-terminal-asks.test.ts is prevented, not retried", async () => {
  let retire!: () => void | Promise<void>;
  let releaseWriter!: () => void;
  let releasePublication!: () => void;
  let publishing!: () => void;
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
  const atPublication = new Promise<void>(resolve => { publishing = resolve; });
  const events: string[] = [];
  const w = await world({ after: finish => { retire = finish; } }, {
    httpTransport: "duplex",
    retirementBarrier: async () => {
      events.push("publication");
      publishing();
      await publicationGate;
      mkdirSync(w.state, { recursive: true });
      writeFileSync(join(w.state, "last-publication"), "settled");
    },
  });
  w.after(async () => {
    await writerGate;
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, "last-write"), "closed");
    events.push("closed");
  });
  const finishing = Promise.resolve(retire());
  try {
    await turn();
    assert.equal(existsSync(w.root), true, "the writer still owns the fixture");
    assert.deepEqual(events, [], "publication cannot overtake writer closure");
    releaseWriter();
    await Promise.race([
      atPublication,
      finishing.then(() => assert.fail("retirement skipped the publication barrier")),
    ]);
    assert.deepEqual(events, ["closed", "publication"]);
    assert.equal(existsSync(join(w.state, "last-write")), true);
    releasePublication();
    await finishing;
    assert.equal(existsSync(w.root), false);
    await turn();
    assert.equal(existsSync(w.root), false, "no pending writer recreates the retired root");
  } finally {
    releaseWriter();
    releasePublication();
    try { await finishing; } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
});
