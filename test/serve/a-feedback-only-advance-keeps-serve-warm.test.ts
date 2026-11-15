import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import { readFeedbackEntry } from "#src/lib/feedback.js";
import { assessGatewayCheckout, gateStaleCodeExit, SERVE_HANDOFF_COALESCE_MS } from "#src/lib/serve.js";
import { changedPathsSince } from "#src/lib/serve-restart-relevance.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, originWithClone, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T12706: an advance that changes only plan/feedback/ (and paths serve never loads) moves serve's
// checkout forward in place and keeps the warm generation; any code change still hands off.

const BOOTED_AT = 1_000_000_000_000;
const entry = (raw: string): string => `id: fb-1\nstatus: new\nraw: ${raw}\n`;

interface Row {
  step: string;
  extra: Record<string, unknown>;
}

function gateway(): { clone: GitRepo; author: GitRepo; bootSha: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-warm-`));
  const { origin, clone } = originWithClone(join(root, "gateway"), {
    seed: { "plan/feedback/fb-1.yaml": entry("at boot"), "src/a.ts": "export const a = 1;\n", "plan/policy.yaml": "a: 1\n" },
  });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "serve-warm-author" });
  return { clone, author, bootSha: clone.git("rev-parse", "HEAD") };
}

function land(author: GitRepo, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(author.dir, rel)), { recursive: true });
    writeFileSync(join(author.dir, rel), content);
  }
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "advance");
  author.git("push", "--quiet", "origin", "HEAD:main");
  return author.git("rev-parse", "HEAD");
}

/** The production gate over the production assessment, on a real clone; only time and the exit are held. */
function servingGate(clone: GitRepo, bootSha: string) {
  let now = BOOTED_AT;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const rows: Row[] = [];
  const handoffs: Record<string, unknown>[] = [];
  const ends: string[] = [];
  const gate = gateStaleCodeExit({
    bootSha,
    resolveCurrentSha: () => clone.git("rev-parse", "HEAD"),
    exit: () => ends.push("exit"),
    beforeExit: () => ends.push("beforeExit"),
    drain: async () => void ends.push("drain"),
    log: (step, extra = {}) => rows.push({ step, extra }),
    clock,
    scheduleRecheck: () => () => {},
    resolveCommitsBehind: () => 1,
    bootedAt: BOOTED_AT,
    changedPathsSince: (boot, target) => changedPathsSince(boot, target, clone.dir),
    assessCheckout: () => assessGatewayCheckout({ repoDir: clone.dir, env: {}, supervised: true, clock }),
    requestHandoff: (detail) => void handoffs.push(detail),
  });
  const steps = (step: string): Row[] => rows.filter((row) => row.step === step);
  return { gate, rows, handoffs, ends, steps, pass: (ms: number) => void (now += ms) };
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("W1-T12706 criterion 1: a plan/feedback/-only advance moves the checkout in place and asks for no handoff", async () => {
  const { clone, author, bootSha } = gateway();
  const toSha = land(author, { "plan/feedback/fb-1.yaml": entry("changed"), "plan/feedback/fb-2.yaml": "id: fb-2\n", "test/a.test.ts": "x\n", "scripts/a.mjs": "x\n" });
  const g = servingGate(clone, bootSha);
  g.pass(SERVE_HANDOFF_COALESCE_MS * 2);
  await g.gate.recheck();
  await until(() => g.steps("serve.checkout_advanced").length > 0);
  await g.gate.recheck();
  assert.equal(clone.git("rev-parse", "HEAD"), toSha, "the checkout moved forward in place");
  assert.deepEqual(g.steps("serve.handoff_requested"), [], "no handoff: the warm read model stays");
  assert.equal(g.handoffs.length, 0);
  assert.deepEqual(g.ends, [], "no drain and no exit, so the read model is never stopped");
  const advanced = g.steps("serve.checkout_advanced");
  assert.equal(advanced.length, 1, "one row per advance, not one per check");
  assert.equal(advanced[0].extra.fromSha, bootSha);
  assert.equal(advanced[0].extra.toSha, toSha);
  assert.deepEqual([...(advanced[0].extra.changedPaths as string[])].sort(), ["plan/feedback/fb-1.yaml", "plan/feedback/fb-2.yaml", "scripts/a.mjs", "test/a.test.ts"]);
});

test("W1-T12706 criterion 2: after the advance a console read of a feedback entry answers the new content", async () => {
  const { clone, author, bootSha } = gateway();
  assert.equal(readFeedbackEntry(clone.dir, "fb-1").raw, "at boot");
  land(author, { "plan/feedback/fb-1.yaml": entry("changed after boot"), "plan/feedback/fb-2.yaml": "id: fb-2\nraw: added\n" });
  const g = servingGate(clone, bootSha);
  await g.gate.recheck();
  await until(() => g.steps("serve.checkout_advanced").length > 0);
  assert.equal(readFeedbackEntry(clone.dir, "fb-1").raw, "changed after boot", "a changed entry reads new, not the boot sha");
  assert.equal(readFeedbackEntry(clone.dir, "fb-2").raw, "added", "an added entry reads at all");
  assert.equal(g.handoffs.length, 0);
});

test("W1-T12706 criterion 3: an advance that also changes code or a boot-read plan path still hands off, coalesced", async () => {
  for (const extra of [{ "src/a.ts": "export const a = 2;\n" }, { "plan/policy.yaml": "a: 2\n" }] as Record<string, string>[]) {
    const { clone, author, bootSha } = gateway();
    land(author, { "plan/feedback/fb-1.yaml": entry("changed"), ...extra });
    const g = servingGate(clone, bootSha);
    await g.gate.recheck();
    assert.equal(g.handoffs.length, 0, `${Object.keys(extra)[0]}: inside the coalescing window nothing is asked yet`);
    g.pass(SERVE_HANDOFF_COALESCE_MS);
    await g.gate.recheck();
    await until(() => g.handoffs.length > 0);
    assert.equal(g.handoffs.length, 1, Object.keys(extra)[0]);
    assert.equal(g.handoffs[0].reason, "checkout_behind");
    assert.equal(g.steps("serve.handoff_requested").length, 1);
    assert.deepEqual(g.steps("serve.checkout_advanced"), [], "code never moves under a running generation");
    assert.equal(clone.git("rev-parse", "HEAD"), bootSha);
  }
});

test("W1-T12706 criterion 4: an unreadable, empty or blank diff still restarts and a dirty checkout never does", async () => {
  const BOOT = "a".repeat(40);
  const NEW = "b".repeat(40);
  const assess = (diff: () => string) =>
    assessGatewayCheckout({
      repoDir: "/nonexistent",
      env: {},
      fetch: async () => {},
      git: (args) => {
        if (args[0] === "rev-parse") return args[1] === "HEAD" ? `${BOOT}\n` : `${NEW}\n`;
        if (args[0] === "status") return "";
        if (args[0] === "diff") return diff();
        if (args[0] === "rev-list") return "1\n";
        return "";
      },
    });
  const unreadable = await assess(() => {
    throw new Error("fatal: bad object");
  });
  for (const [name, read] of [["unreadable", unreadable], ["empty", await assess(() => "")], ["blank", await assess(() => " \n\n")]] as const) {
    assert.equal(read.restartDue, true, name);
    assert.equal(read.advanceInPlace, undefined, `${name}: an uncertain diff never moves the checkout`);
  }

  const { clone, author, bootSha } = gateway();
  land(author, { "plan/feedback/fb-1.yaml": entry("changed") });
  writeFileSync(join(clone.dir, "src", "a.ts"), "export const a = 9;\n");
  const g = servingGate(clone, bootSha);
  g.pass(SERVE_HANDOFF_COALESCE_MS * 2);
  await g.gate.recheck();
  await g.gate.recheck();
  assert.equal(clone.git("rev-parse", "HEAD"), bootSha, "a dirty checkout is never moved");
  assert.equal(g.handoffs.length, 0, "and never restarts");
  assert.deepEqual(g.steps("serve.checkout_advanced"), []);
  assert.equal(g.steps("serve.gateway_checkout_dirty").length, 1);
});

test("a move that git refuses falls back to the handoff a code change takes", async () => {
  const { clone, author, bootSha } = gateway();
  land(author, { "plan/feedback/fb-2.yaml": "id: fb-2\n" });
  writeFileSync(join(clone.dir, "plan", "feedback", "fb-2.yaml"), "an untracked file in the way\n");
  const g = servingGate(clone, bootSha);
  g.pass(SERVE_HANDOFF_COALESCE_MS * 2);
  await g.gate.recheck();
  await until(() => g.steps("serve.checkout_advance_refused").length > 0);
  assert.equal(clone.git("rev-parse", "HEAD"), bootSha);
  assert.equal(g.handoffs.length, 0);
  await g.gate.recheck();
  await until(() => g.handoffs.length > 0);
  assert.equal(g.handoffs.length, 1, "when in doubt, restart");
  assert.equal(g.handoffs[0].reason, "checkout_behind");
  assert.equal(g.steps("serve.checkout_advance_refused").length, 1, "the move is tried once, not once a minute");
});
