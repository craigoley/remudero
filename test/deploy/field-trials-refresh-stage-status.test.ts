import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("deploy/field-trials-refresh.sh", __workspaceRootUrl), "utf8");
const definition = source.match(/^run_stage\(\) \{[\s\S]*?^\}\n/m)?.[0];
assert.ok(definition, "the actual launcher stage implementation must exist");
const invoke = (body: string) => spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${definition}\n${body}`], {
  encoding: "utf8", timeout: 5_000, env: { PATH: "/usr/bin:/bin" },
});

test("the collector stage records real success without logging command arguments or certifying freshness", () => {
  const result = invoke('run_stage routing-daily-review /bin/bash -c \'printf payload\' synthetic-private-argument; printf continued');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "payloadcontinued");
  assert.match(result.stderr, /stage=routing-daily-review event=started at=\d{4}-/);
  assert.match(result.stderr, /stage=routing-daily-review event=completed exit=0 at=/);
  assert.doesNotMatch(result.stderr, /synthetic-private-argument|payload|state=(?:fresh|healthy)/);
  const events = result.stderr.trim().split("\n");
  assert.equal(events.length, 2);
  for (const event of events) assert.match(event,
    /^field-trials-refresh: stage=routing-daily-review event=(?:started|completed)(?: exit=0)? at=[0-9TZ:-]+$/);
});

test("an actual failed collector child preserves its exit and stops the chain after naming its stage", () => {
  for (const status of [2, 125, 134]) {
    const result = invoke(`run_stage case-files /bin/bash -c 'exit ${status}'; printf unsafe-next-stage`);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`stage=case-files event=failed exit=${status} at=`));
    assert.doesNotMatch(result.stderr, /event=completed|unsafe-next-stage/);
  }
});

test("a collector stage refuses an unknown label or missing command before producing progress", () => {
  for (const body of ["run_stage unsafe-label /usr/bin/true", "run_stage field-trials"]) {
    const result = invoke(body);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});
