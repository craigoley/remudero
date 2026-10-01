/**
 * `rmd read-model switch` rewrites `switches.json` whole. It sets only `projector` and the views, so
 * every other key in the file (`push`, `github`) must survive the rewrite, or flipping one view
 * silently turns push off.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { readModelCommand, readModelSwitchesPath } from "../src/lib/read-model-cli.js";
import { makeTempDir } from "../src/lib/tmp.js";

test("a view switch keeps the push and github keys it does not set", (t) => {
  const stateDir = makeTempDir("switch-keys");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const path = readModelSwitchesPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ projector: "on", views: { "nav-badge": "shadow" }, push: "on", github: "worker" }));
  const lines: string[] = [];
  assert.equal(readModelCommand(["switch", "nav-badge", "auto"], { stateDir, out: (l) => void lines.push(l), error: (l) => void lines.push(l) }), 0, lines.join("\n"));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { projector: "on", views: { "nav-badge": "auto" }, push: "on", github: "worker" });
});
