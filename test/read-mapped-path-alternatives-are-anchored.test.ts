// @source-text-subject: #344 concerns regex precedence in source; runtime fallback checks accompany the syntactic regression control.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fullRunTrigger } from "#src/lib/affected-suites.js";

test("read-mapped path alternatives have whole-path anchors without narrowing the safety fallback", () => {
  const source = readFileSync(new URL("../src/lib/affected-suites.ts", import.meta.url), "utf8");
  const literal = /^const READ_MAPPED = (\/.*\/);$/m.exec(source)?.[1];
  assert.ok(literal, "the real selector predicate is observed");
  const predicate = new RegExp(literal.slice(1, -1));
  assert.ok(predicate.source.startsWith("^(?:"), "both alternatives share the start anchor");
  assert.ok(predicate.source.endsWith(")$"), "both alternatives share the end anchor");
  const old = /^(?:openapi|deploy)\/|\.json$/;
  const corpus = [".mcp.json", "root.json", "root.JSON", "root.json.backup", "rootjson", "nested/value.json",
    "openapi/file.yaml", "deploy/entrypoint.sh", "notdeploy/file.sh", "nested/deploy/file.sh", "deployX/file.sh",
    "openapiX/file.yaml", "", "deploy/", "a\nb.json", "deploy/a\nb", "a.json\n", "a.json\r\n"];
  for (const path of corpus) assert.equal(predicate.test(path), old.test(path), path);
  assert.equal(fullRunTrigger([".mcp.json"], true), undefined);
  assert.equal(fullRunTrigger([".mcp.json"], false), ".mcp.json", "no qualified read map retains the broad safety fallback");
  assert.equal(fullRunTrigger(["nested/deploy/file.sh"], true), "nested/deploy/file.sh");
  assert.equal(fullRunTrigger(["openapi/new-contract.yaml"], true), "openapi/new-contract.yaml", "unmodelled contracts remain broad");
});
