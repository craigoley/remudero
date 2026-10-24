import assert from "node:assert/strict";
import { test } from "node:test";
import { fixCommand, type FixCommandHost } from "#src/cli/commands/fix.js";

for (const { rest, unexpected } of [
  { rest: ["13851", "--unknown"], unexpected: "--unknown" },
  { rest: ["13851", "extra"], unexpected: "extra" },
  { rest: ["13851", "--requested", "--repo", "consumer", "--unknown"], unexpected: "--unknown" },
  { rest: ["13851", "--admission-adopt-comment", "42", "extra"], unexpected: "extra" },
]) {
  test(`W1-T9337: fixCommand rejects ${rest.slice(1).join(" ")} before lookup or dispatch`, async (t) => {
    const usage = "usage: rmd fix <pr-number> [--requested]";
    const host = new Proxy({} as FixCommandHost, {
      get(_target, member) {
        if (member === "USAGE") return usage;
        if (member === "workerBoundaryStack") return { loadedModule: undefined };
        assert.fail(`invalid arguments reached host collaborator ${String(member)}`);
      },
    });
    const error = t.mock.method(console, "error", () => {});
    const fetch = t.mock.fn(() => assert.fail("invalid arguments reached PR lookup"));
    const route = t.mock.fn(() => assert.fail("invalid arguments reached fix dispatch"));

    const code = await fixCommand(rest, {
      get config() { return assert.fail("invalid arguments reached configuration loading"); },
      fetch,
      route,
    }, host);

    assert.equal(code, 2);
    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [
      [`rmd fix: unexpected argument '${unexpected}' — see \`rmd --help\`\n${usage}`],
    ]);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(route.mock.callCount(), 0);
  });
}
