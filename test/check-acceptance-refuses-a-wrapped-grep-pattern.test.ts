//
// #11704 (2026-10-14): a hand PR's body carried `grep: "census:worktree-creation" in package.json`. `rmd
// check-acceptance` printed OK and `rmd check-proof` passed it, but CI's acceptance-author-gate refused it as
// proof-shape ("wraps its grep pattern in \""), and the fleet had to repair the stored body. The pre-open verb
// now reports the same refusal, through the same wrappedGrepPattern the gate calls.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAcceptanceCommand } from "#src/run-task.js";

function run(proof: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-check-acceptance-wrapped-"));
  const path = join(dir, "body.md");
  writeFileSync(path, `## Why\n\nx\n\n## Acceptance\n\n- claim: the script exists\n  proof: ${proof}\n`);
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { code: checkAcceptanceCommand([path], { planPath: join(dir, "no-plan.yaml") }), out: lines.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test("check-acceptance refuses a body grep proof whose pattern is wrapped in quotes or backticks, as the gate does", () => {
  for (const [proof, delimiter] of [
    ['grep: "census:worktree-creation" in package.json', '"'],
    ["grep: `census:worktree-creation` in package.json", "`"],
    ["grep: 'census:worktree-creation' in package.json", "'"],
  ]) {
    const r = run(proof);
    assert.equal(r.code, 1, proof);
    assert.match(r.out, /REFUSED by acceptance-author-gate \(proof-shape\)/, proof);
    assert.ok(r.out.includes(`criterion 1 wraps its grep pattern in ${delimiter}; use: grep: census:worktree-creation in <path>`), r.out);
    assert.doesNotMatch(r.out, /^OK/m, proof);
  }
});

test("check-acceptance still passes the bare grep pattern the gate accepts", () => {
  const r = run("grep: census:worktree-creation in package.json");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK — the parser resolves exactly what was written/m);
  assert.doesNotMatch(r.out, /REFUSED/);
});
