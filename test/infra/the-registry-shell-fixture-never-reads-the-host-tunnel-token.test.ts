import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { registryShellFixture } from "#test/helpers/registry-shell-fixture.js";

// W1-T11370: deploy/edge-heal.sh defaults RMD_CLOUDFLARED_TOKEN_FILE to /etc/remudero/cloudflared-token. On a host that
// has one, a generated launcher's boot inside this fixture recorded a cloudflared launch, and three selected-shell tests
// failed there while hosted CI (no such file) stayed green.
test("W1-T11370: the registry shell fixture points the tunnel token inside its own root, at a path that does not exist", (t) => {
  const f = registryShellFixture(t);
  const token = f.env.RMD_CLOUDFLARED_TOKEN_FILE;
  assert.equal(typeof token, "string", "the fixture overrides edge-heal's default token path");
  const inside = relative(f.root, token!);
  assert.ok(inside !== "" && !inside.startsWith("..") && !inside.startsWith("/"), `${token} lies under ${f.root}`);
  assert.equal(existsSync(token!), false, "nothing in the fixture creates the token, so edge-heal sees no tunnel");
});
