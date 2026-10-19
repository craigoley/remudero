import assert from "node:assert/strict";
import { test } from "node:test";
import * as push from "#src/lib/git-push.js";

test("private disk tmp keeps only the prepush throwaway home writable", () => {
  const home = "/owned/run-home";
  assert.equal(push.prePushEphemeralBind(home, home, home), true);
  assert.equal(push.prePushEphemeralBind(home + "/.rmd-private-tmp", "/tmp", home), true);
  for (const [from, to] of [["/checkout", "/checkout"], ["/install", "/install"], ["/other/.rmd-private-tmp", "/tmp"], [home + "/elsewhere", "/tmp"], [home, "/tmp"], [home + "/.rmd-private-tmp", "/shared"], [undefined, undefined]]) {
    assert.equal(push.prePushEphemeralBind(from, to, home), false, `${from} -> ${to} is not this run's ephemeral bind`);
  }
});
