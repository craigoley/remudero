// W1-T4584: test/helpers/declared-routes.ts found routes by scanning src/lib for a line that STARTS
// with `path: "..."`, taking its method from the lines above. MEASURED 2026-09-26 against the
// assembled route table: it saw 95 routes while serve assembles 104. /v1/operator-agent/ask declares
// method and path on one line; the consequences routes, /v1/confirm, /v1/hooks/github,
// /v1/incidents/events and GET / carry no `path:` literal at all. console-parity and route-wiring
// read this helper, so those routes were invisible to both.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assembledRoutes, declaredConsoleRoutes } from "./helpers/declared-routes.js";

test("W1-T4584: every route the server assembles is in the declared set, and a same-line declaration is scanned", () => {
  const declared = declaredConsoleRoutes();
  const keys = new Set(declared.map((r) => `${r.method} ${r.path}`));
  const assembled = assembledRoutes().map((r) => `${r.method} ${r.path}`);
  assert.ok(assembled.length >= 100, `the assembled table must be read, saw ${assembled.length}`);
  assert.deepEqual(assembled.filter((key) => !keys.has(key)), [], "no served route is invisible to the helper");

  const ask = declared.find((r) => r.method === "POST" && r.path === "/v1/operator-agent/ask");
  assert.match(ask?.where ?? "", /^src\/lib\/operator-agent-answer\.ts:\d+$/, "the source scan itself finds the one-line declaration");
});

test("W1-T4584: the source scan reads a path anywhere on its line and a method earlier on that line", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4584-lib-"));
  try {
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        "export function buildFixtureRoutes() {",
        '  return [{ method: "PUT", path: "/v1/one-line", scope: "write" },',
        "    {",
        '      method: "DELETE",',
        '      path: "/v1/multi-line",',
        "    }];",
        "}",
      ].join("\n"),
    );
    const keys = declaredConsoleRoutes(dir).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(keys.sort(), ["DELETE /v1/multi-line", "PUT /v1/one-line"], "both shapes, and nothing assembled for a fixture lib");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
