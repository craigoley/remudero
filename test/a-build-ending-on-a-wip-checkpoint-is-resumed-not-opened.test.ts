// #10482 (W1-T6434): a build whose tip was a "chore(wip): …" checkpoint opened its PR unfinished,
// titled after the checkpoint, with four reds its own "remaining" steps would have caught.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

const url = new URL("../src/lib/unfinished-checkpoint.ts", import.meta.url);
const mod: Record<string, (...args: never[]) => unknown> | undefined = existsSync(url) ? await import(url.href) : undefined;
const fn = <T>(name: string) => {
  assert.equal(typeof mod?.[name], "function", `src/lib/unfinished-checkpoint.ts must export ${name}`);
  return mod![name] as unknown as T;
};

test("a chore(wip) checkpoint subject is recognised as unfinished and never becomes a PR title", () => {
  const isWip = fn<(s: string) => boolean>("isWipSubject");
  const title = fn<(s: readonly string[]) => string | undefined>("prTitleFromBranchCommits");
  assert.equal(isWip("chore(wip): bind the unreadable reason in a recorded object"), true);
  assert.equal(isWip("wip: wire the sweep hook"), true);
  assert.equal(isWip("fix(sweep): preserve owner residue"), false);
  assert.equal(
    title(["chore(wip): bind the unreadable reason", "fix(sweep): preserve owner residue for the next round", "wip: start"]),
    "fix(sweep): preserve owner residue for the next round",
  );
  assert.equal(title(["chore(wip): bind the unreadable reason in a recorded object"]), "chore: bind the unreadable reason in a recorded object");
  assert.equal(title(["wip(sweep): add the hook"]), "chore(sweep): add the hook");
});

test("a checkpoint's remaining work is read from its [remudero-context] block and named in the resume prompt", () => {
  const remaining = fn<(b: string) => string | undefined>("checkpointRemaining");
  const prompt = fn<(s: string, r: string | undefined, h: boolean) => string>("renderContinuationPrompt");
  const body = "[remudero-context]\ndecided: keep the hook in sweep.ts\nremaining: final ratchets and neighbouring suites\nfailed: none";
  assert.equal(remaining(body), "final ratchets and neighbouring suites");
  assert.equal(remaining("[remudero-context]\nremaining: none"), undefined);
  assert.equal(remaining("no block here\nremaining: something"), undefined);
  const text = prompt("chore(wip): bind the unreadable reason", "final ratchets and neighbouring suites", false);
  assert.match(text, /final ratchets and neighbouring suites/);
  assert.match(text, /rmd preflight --fast/);
  assert.match(text, /never `wip:`/);
});

