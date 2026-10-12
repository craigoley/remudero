import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { ghJsonAsync, ghTextAsync } from "../src/lib/github-transport.js";
import { ghShim } from "./helpers/gh-shim.js";

test("test/an-async-gh-write-is-never-coalesced.test.ts: writes spawn separately and GET reads share", async (t) => {
  const shim = ghShim([{ when: "", stdout: '{"ok":true}', delaySeconds: 0.02 }]);
  const env = {
    PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    RMD_GH_CACHE_HOME: shim.dir,
    RMD_GH_TRANSPORT_FLOOR: "advisory",
    RMD_GH_SHARED_READ_GAP_MS: "0",
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const cases: { args: string[]; processes: number }[] = [
    { args: ["pr", "merge", "https://github.com/o/r/pull/42", "--auto", "--squash"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "-X", "GET"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "--method=GET"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "-XGET"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "-X=GET"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "--header", "Accept: application/json"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "--jq=.ok", "--include"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "-q.ok"], processes: 1 },
    { args: ["pr", "view", "42", "--json", "number"], processes: 1 },
    { args: ["pr", "list", "--json", "number"], processes: 1 },
    { args: ["pr", "checks", "42", "--json", "name"], processes: 1 },
    ...["POST", "PUT", "PATCH", "DELETE"].map((method) => ({
      args: ["api", "repos/o/r/pulls/42", "-X", method], processes: 2,
    })),
    { args: ["api", "repos/o/r/pulls/42", "--method=PATCH"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "-XPOST"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "-f", "title=new"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "--field=title=new"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "-Ftitle=new"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "--raw-field", "title=new"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "-f", "page=1", "--method", "GET"], processes: 1 },
    { args: ["api", "repos/o/r/pulls/42", "--input=body.json"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "--unknown"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "--method"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "-f", "--method=GET"], processes: 2 },
    { args: ["api", "repos/o/r/pulls/42", "--header", "--method=GET", "-f", "title=new"], processes: 2 },
    { args: ["pr", "edit", "42", "--title", "new"], processes: 2 },
    { args: ["pr", "comment", "42", "--body", "hello"], processes: 2 },
    { args: ["unknown", "command"], processes: 2 },
  ];
  try {
    for (const transport of [ghTextAsync, ghJsonAsync]) {
      for (const { args, processes } of cases) {
        await t.test(`${transport.name}: ${args.join(" ")}`, async () => {
          const before = shim.calls().length;
          const results = await Promise.all([transport(args), transport([...args])]);
          assert.deepEqual(results, transport === ghTextAsync
            ? ['{"ok":true}\n', '{"ok":true}\n']
            : [{ ok: true }, { ok: true }]);
          assert.equal(shim.calls().length - before, processes);
        });
      }
      await t.test(`${transport.name}: arm, disarm, arm sends all three intents`, async () => {
        const before = shim.calls().length;
        const arm = ["pr", "merge", "42", "--auto", "--squash"];
        const disarm = ["pr", "merge", "42", "--disable-auto"];
        await Promise.all([transport(arm), transport(disarm), transport([...arm])]);
        assert.equal(shim.calls().length - before, 3);
        assert.equal(shim.calls().slice(before).filter((call) => call === arm.join(" ")).length, 2);
      });
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
