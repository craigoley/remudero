import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = (await import(pathToFileURL(join(ROOT, "scripts", "proof-discrimination-gate.mjs")).href)) as {
  evaluateProofDiscrimination: (
    c: Array<{ proof: string }>,
    base: string,
    run: (p: string, b: string) => { status: number; stdout: string },
  ) => { stale: unknown[]; countDiscriminated: Array<{ head: string; base: string }> };
};

test("W1-T5418: check:ci-log:proof-discrimination is prevented, not retried", () => {
  const run = (hits: number, base: number) => () => ({ status: 5, stdout: `hits:       ${hits}\nbase hits:  ${base}\n` });
  const grown = gate.evaluateProofDiscrimination([{ proof: "grep: marker in src/x.ts" }], "abc", run(3, 1));
  assert.equal(grown.stale.length, 0);
  assert.deepEqual(grown.countDiscriminated.map((r) => [r.head, r.base]), [["3", "1"]]);
  const same = gate.evaluateProofDiscrimination([{ proof: "grep: marker in src/x.ts" }], "abc", run(2, 2));
  assert.equal(same.stale.length, 1);
  const unit = gate.evaluateProofDiscrimination([{ proof: "unit test: some title" }], "abc", run(3, 1));
  assert.equal(unit.stale.length, 1);
});
