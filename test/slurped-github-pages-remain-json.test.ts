import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ghJson, splitGhHeaderBlock, type GhRateLimitReading } from "../src/lib/github-transport.js";

const args = ["api", "repos/acme/app/pulls?state=open&per_page=100", "--paginate", "--slurp"];
function header(remaining: number, newline = "\n") {
  return ["HTTP/2.0 200 OK", "Content-Type: application/json", "X-Ratelimit-Resource: core",
    `X-Ratelimit-Remaining: ${remaining}`, "", ""].join(newline);
}

test("slurped GitHub pages retain every page and the last rate-limit headers", () => {
  for (const newline of ["\n", "\r\n"]) {
    const pages = [[{ number: 1, body: "HTTP/2.0 200 OK\nX-Header: data\n\ncontent" }], [{ number: 2 }], []];
    const output = `[${pages.map((page, i) => header(99 - i, newline) + JSON.stringify(page)).join(",")}]`;
    let limit: GhRateLimitReading | undefined;
    assert.deepEqual(ghJson(args, (reading) => { limit = reading; }, () => output), pages);
    assert.equal(limit?.remaining, 97); assert.equal(limit?.resource, "core");
  }
});

test("slurped GitHub object pages and empty corpora remain measured JSON", () => {
  for (const pages of [[], [[]], [{ data: { nodes: [1] } }, { data: { nodes: [2] } }]]) {
    const out = `[${pages.map((page) => header(10) + JSON.stringify(page)).join(",")}]`;
    assert.deepEqual(ghJson(args, undefined, () => out), pages);
  }
  assert.deepEqual(splitGhHeaderBlock("[[1],[]]", true), { headers: "", body: "[[1],[]]" });
  assert.deepEqual(splitGhHeaderBlock(header(12) + "{}"), { headers: header(12).trimEnd(), body: "{}" });
});

test("slurped GitHub malformed pages still refuse instead of becoming an empty success", () => {
  for (const out of [`[${header(10)}not-json]`, `[HTTP/broken\n\n[]]`, `[${header(10)}[] trailing]`]) {
    assert.throws(() => ghJson(args, undefined, () => out), /response body was unreadable/);
  }
});

test("the default GitHub JSON spawn parses included slurp headers without dropping dedupe evidence", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "rmd-slurp-default-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const pages = [[{ body: "Opportunity-Key: acme/app/debt:1" }], []];
  const output = `[${header(10)}${JSON.stringify(pages[0])},${header(9)}[]]`;
  const script = `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\n`;
  writeFileSync(join(bin, "gh"), script, { mode: 0o755 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${previous ?? ""}`;
    let limit: GhRateLimitReading | undefined;
    const read = ghJson(args, (value) => { limit = value; });
    assert.deepEqual(read, pages); assert.equal(limit?.remaining, 9);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
