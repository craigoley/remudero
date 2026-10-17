import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("project MCP configuration is valid JSON with an explicit empty server registry", () => {
  const configuration = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(configuration), ["mcpServers"]);
  assert.deepEqual(configuration.mcpServers, {}, "the repository does not bundle commands, URLs or credentials");
});
