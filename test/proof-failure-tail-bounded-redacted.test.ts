/**
 * W1-T9301 — the failure tail is bounded, says how many earlier lines it omitted, and is redacted;
 * review.ts builds its tail through {@link formatTail}.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTail, redactProofOutput } from "#src/lib/proofExecutor.js";
import { proofFailureTail } from "#src/lib/review.js";

const numbered = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

test("formatTail keeps the whole output and no note when under the bounds", () => {
  assert.equal(formatTail("a\n\nb", "c"), "a\nb\nc");
  assert.equal(formatTail("", ""), "");
});

test("formatTail keeps the last lines and reports the exact omitted count", () => {
  const out = formatTail(numbered(50), "", 10).split("\n");
  assert.equal(out[0], "(40 earlier lines omitted)");
  assert.equal(out.length, 11);
  assert.equal(out.at(-1), "line 49");
  assert.equal(formatTail(numbered(3), "", 2).split("\n")[0], "(1 earlier line omitted)");
});

test("formatTail trims by characters too and counts those lines as omitted", () => {
  const out = formatTail(["x".repeat(40), "y".repeat(40), "z".repeat(40)].join("\n"), "", 40, 85).split("\n");
  assert.deepEqual(out, ["(1 earlier line omitted)", "y".repeat(40), "z".repeat(40)]);
});

test("formatTail cuts a single over-long last line to its tail", () => {
  const out = formatTail("q".repeat(100), "", 40, 10);
  assert.equal(out, `…${"q".repeat(9)}`);
  assert.equal(out.length, 10, "the truncation marker is inside the character bound");
  assert.equal(formatTail("xy", "", 40, 1), "…");
  assert.equal(formatTail("q".repeat(10), "", 40, 10), "q".repeat(10), "the exact boundary needs no marker");
});

test("formatTail redacts the entire secret before cutting through a long final line", () => {
  const token = `ghp_${"A".repeat(36)}`;
  assert.equal(formatTail(`prefix ${token} end`, "", 40, 10), "…cted> end");
  const out = formatTail(`discard\n${"q".repeat(3001)}`);
  const [note, body] = out.split("\n");
  assert.equal(note, "(1 earlier line omitted)");
  assert.equal(body.length, 3000);
});

test("formatTail redacts secrets, including one that straddles the cut", () => {
  const token = `ghp_${"A".repeat(36)}`;
  // Built at runtime so no literal credential-shaped string sits in the source for leak-grep.
  const awsKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const skKey = ["sk", "-", "abcdefghijklmnop1234"].join("");
  const privateKeyLabel = ["RSA", "PRIVATE", "KEY"].join(" ");
  const raw = [
    `fetch https://user:hunter2@example.com/x`,
    `Authorization: Bearer abcdef1234567890`,
    `GITHUB_TOKEN=${token}`,
    `password = "p@ss word"`,
    `key ${awsKey} and ${skKey}`,
    `-----BEGIN ${privateKeyLabel}-----\nMIIBOgIBAAJB\n-----END ${privateKeyLabel}-----`,
    `author: bob`,
  ].join("\n");
  const out = formatTail(raw);
  for (const leaked of ["hunter2", "abcdef1234567890", token, "p@ss", awsKey, skKey, "MIIBOgIBAAJB"]) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  }
  assert.match(out, /author: bob/);
  assert.match(redactProofOutput("x-access-token: abc"), /<redacted>/);
  assert.ok(!formatTail(`${token}\nlast`, "", 1).includes("ghp_"));
});

test("proofFailureTail in review.ts goes through formatTail: bounded, noted, redacted", () => {
  const out = proofFailureTail(`${numbered(100)}\napi_key=SECRETVALUE123`, "boom");
  assert.match(out, /^\(62 earlier lines omitted\)\n/);
  assert.match(out, /api_key=<redacted>/);
  assert.ok(!out.includes("SECRETVALUE123"));
  assert.equal(out.split("\n").at(-1), "boom");
});
