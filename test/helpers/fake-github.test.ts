/**
 * test/helpers/fake-github.test.ts — W1-T2903 acceptance: "a shared fake GitHub gateway records
 * every call it receives."
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGitHub } from "./fake-github.js";

// ── the four REQUIRED GitHub members answer with harmless defaults, and are recorded ────────────

test("fakeGitHub: the four required members default to 'nothing resolved', and are recorded", () => {
  const github = fakeGitHub();
  assert.equal(github.prByRef("42"), null);
  assert.equal(github.findMergedByTrailer("W1-T1"), null);
  assert.equal(github.headRefName("https://github.com/o/r/pull/1"), undefined);
  assert.equal(github.prBody("https://github.com/o/r/pull/1"), undefined);
  assert.deepEqual(
    github.calls.map((c) => c.method),
    ["prByRef", "findMergedByTrailer", "headRefName", "prBody"],
  );
});

// ── the three next-most-faked optional members (measured 2026-09-08) ship as defaults too ───────

test("fakeGitHub: reviewState/autoMergeArmed/readFailed default to 'nothing armed, nothing failed', and are recorded", () => {
  const github = fakeGitHub();
  assert.equal(github.reviewState!("https://github.com/o/r/pull/1"), "none");
  assert.equal(github.autoMergeArmed!("https://github.com/o/r/pull/1"), false);
  assert.equal(github.readFailed!(), false);
  assert.deepEqual(
    github.calls.map((c) => c.method),
    ["reviewState", "autoMergeArmed", "readFailed"],
  );
});

// ── every call is recorded with its exact arguments, in call order ──────────────────────────────

test("fakeGitHub: .calls records EVERY call, with its exact arguments, in the order they happened", () => {
  const github = fakeGitHub();
  github.prByRef(42);
  github.prByRef("https://github.com/o/r/pull/7");
  github.headRefName("https://github.com/o/r/pull/7");
  assert.deepEqual(github.calls, [
    { method: "prByRef", args: [42] },
    { method: "prByRef", args: ["https://github.com/o/r/pull/7"] },
    { method: "headRefName", args: ["https://github.com/o/r/pull/7"] },
  ]);
});

test("fakeGitHub: an UNCALLED method leaves no trace in .calls — recording is per-invocation, never per-construction", () => {
  const github = fakeGitHub();
  github.prByRef(1);
  assert.deepEqual(
    github.calls.map((c) => c.method),
    ["prByRef"],
    "constructing the gateway and calling three OTHER default methods must not itself appear",
  );
});

// ── overrides replace the ANSWER but never opt out of recording ─────────────────────────────────

test("fakeGitHub: an override replaces the default answer, and is STILL recorded", () => {
  const byRef: Record<string, { number: number; url: string; state: string }> = {
    "7": { number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED" },
  };
  const github = fakeGitHub({ prByRef: (ref) => byRef[String(ref)] ?? null });
  assert.deepEqual(github.prByRef(7), byRef["7"]);
  assert.equal(github.prByRef(99), null, "the override's OWN miss behaviour, not the default's, answers an unlisted ref");
  assert.deepEqual(
    github.calls.map((c) => c.method),
    ["prByRef", "prByRef"],
  );
});

test("fakeGitHub: an override for an OPTIONAL member outside the seven defaults is ALSO recorded", () => {
  const github = fakeGitHub({ changedFiles: () => ["a.ts", "b.ts"] });
  assert.deepEqual(github.changedFiles!("https://github.com/o/r/pull/1"), ["a.ts", "b.ts"]);
  assert.deepEqual(github.calls, [{ method: "changedFiles", args: ["https://github.com/o/r/pull/1"] }]);
  // an optional member the caller never overrode and this gateway does not default-implement
  // (e.g. `warm`) stays genuinely absent — never silently filled in as a no-op
  assert.equal(github.warm, undefined);
});

test("fakeGitHub: two independently-built gateways never share a .calls array", () => {
  const a = fakeGitHub();
  const b = fakeGitHub();
  a.prByRef(1);
  assert.deepEqual(
    b.calls.map((c) => c.method),
    [],
    "calling a's gateway must never appear on b's recording",
  );
});
