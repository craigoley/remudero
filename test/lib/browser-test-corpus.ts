import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BrowserTestSource { path: string; source: string }
export type TestCorpusListing = (root: string) => string;
export type TestSourceRead = (path: string) => string;
const SELF = "test/serve-browser-teardown.test.ts";

function defaultTestCorpus(root: string): string {
  const paths = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", "chromium.launch(", "test"], {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  return paths.trim().split("\n").join("\0") + "\0";
}

/** Read current bytes, not HEAD blobs; an unavailable selected source cannot disappear as a match. */
export function trackedBrowserTestSources(
  root: string,
  list: TestCorpusListing = defaultTestCorpus,
  read: TestSourceRead = (path) => readFileSync(join(root, path), "utf8"),
): BrowserTestSource[] {
  const listing = list(root);
  if (!listing) throw new Error("tracked test corpus is empty");
  if (!listing.endsWith("\0")) throw new Error("tracked test corpus is not NUL terminated");
  const paths = listing.slice(0, -1).split("\0");
  if (paths.some(path => !path.startsWith("test/") || path.split("/").includes("..") || path === "test/")) {
    throw new Error("tracked test corpus contains an invalid path");
  }
  if (new Set(paths).size !== paths.length) throw new Error("tracked test corpus contains duplicate paths");
  const tests = paths.filter(path => path.endsWith(".test.ts"));
  if (!tests.length) throw new Error("tracked test corpus is empty");
  const sources: BrowserTestSource[] = [];
  for (const path of tests) {
    const source = read(path);
    if (source.includes("\0")) throw new Error(`${path}: tracked test source contains NUL bytes`);
    if (path !== SELF && source.includes("chromium.launch(")) sources.push({ path, source });
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

/** The existing guard's floor and three assertions, shared with deterministic corpus controls. */
export function assertBrowserTeardownSources(sources: readonly BrowserTestSource[]): void {
  assert.ok(sources.length >= 3, `expected at least the three known browser suites (W1-T4566 deleted dashboard-loads), found ${sources.length}`);
  for (const { path: f, source: src } of sources) {
    assert.match(src, /browserPromise = chromium\.launch\(/,
      `${f}: chromium.launch() must be assigned to browserPromise SYNCHRONOUSLY, so teardown can see it`);
    assert.match(src, /const launched = await browserPromise;\s*\n\s*await launched\?\.close\(\);/,
      `${f}: teardown must await the launch promise and close what it resolves to`);
    assert.doesNotMatch(src, /after\(async \(\) => \{\s*\n\s*(?:if \(browser\) )?await browser\.close\(\);/,
      `${f}: closing the resolved handle is the leak -- it is still undefined when teardown fires on a zero-match filter`);
  }
}
