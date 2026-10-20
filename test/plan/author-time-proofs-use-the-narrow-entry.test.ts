// Real author-time consumer proofs; only the unused CLI socket launcher is refused by the fixture.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlanPrBody } from "#src/lib/plan-pr-emitter.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

function consumer() {
  const fixture = gitRepo({ kind: "author-proof-consumer" });
  mkdirSync(join(fixture.dir, "src"));
  // A launch rooted at the consumer would execute this poison instead of the trusted harness.
  writeFileSync(join(fixture.dir, "src/check-proof-main.ts"), 'throw new Error("consumer entry must never run");\n');
  writeFileSync(join(fixture.dir, "marker.txt"), "shared\n");
  fixture.git("add", ".");
  fixture.git("commit", "-qm", "test: base consumer marker");
  const base = fixture.git("rev-parse", "HEAD");
  fixture.git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(fixture.dir, "marker.txt"), "shared\nadded\n");
  fixture.git("add", ".");
  fixture.git("commit", "-qm", "test: head consumer marker");
  assert.equal(existsSync(join(fixture.dir, "node_modules")), false);
  const bin = join(fixture.dir, "private-bin"), attemptedCli = join(fixture.dir, "cli-attempted");
  mkdirSync(bin);
  // Cross-platform control for a capability the sealed Mac sandbox actually refuses: tsx CLI IPC.
  // The fixed caller uses the real absolute node binary and real narrow entry, not a fake verdict.
  writeFileSync(join(bin, "node"), [
    "#!/bin/sh",
    'case "$1" in',
    "  */node_modules/.bin/tsx|*/tsx/dist/cli.mjs)",
    `    printf '%s\\n' 'CLI socket loader refused' >> ${shellQuote(attemptedCli)}`,
    "    exit 73;;",
    "esac",
    `exec ${shellQuote(process.execPath)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    fixture, attemptedCli,
    run<T>(fn: () => T): T {
      const prior = process.env.PATH;
      process.env.PATH = `${bin}:${prior ?? ""}`;
      try { return fn(); } finally { process.env.PATH = prior; }
    },
    body(proof: string, baseRef?: string) {
      return buildPlanPrBody({
        intro: "Consumer proof fixture", proofCwd: fixture.dir,
        ...(baseRef === undefined ? {} : { baseRef }),
        criteria: [{ claim: "the marker is proved against this consumer", proof }],
      });
    },
  };
}

test("author-time proofs run the harness narrow entry without the CLI socket loader", () => {
  const c = consumer();
  try {
    c.run(() => {
      assert.match(c.body("grep: added in marker.txt", "HEAD~1"), /## Acceptance/);
      assert.throws(() => c.body("grep: shared in marker.txt", "HEAD~1"), /passes at both head and base/);
      assert.throws(() => c.body("grep: absent in marker.txt", "HEAD~1"), /could not prove this head \(check-proof exit 1\)/);
      assert.equal(existsSync(c.attemptedCli), false, "the real caller never starts the socket-creating CLI");
    });
  } finally { c.fixture.cleanup(); }
});

test("author-time narrow proofs derive the base from the consumer checkout", () => {
  const c = consumer();
  try {
    c.run(() => {
      assert.match(c.body("grep: added in marker.txt"), /## Acceptance/);
      assert.equal(existsSync(c.attemptedCli), false);
    });
  } finally { c.fixture.cleanup(); }
});

test("an author-time proof refusal still prevents body emission", () => {
  assert.throws(() => buildPlanPrBody({
    intro: "Closed boundary control", baseRef: "fixture-base",
    criteria: [{ claim: "never waive a proof", proof: "grep: absent in marker.txt" }],
    proofCheck: () => 1,
  }), /body emission refused/);
});
