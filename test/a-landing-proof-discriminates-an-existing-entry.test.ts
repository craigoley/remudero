import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LANDING_BRANCH, landFeedback } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { gitRepo } from "./helpers/git-repo.js";

const id = "fb-landing-proof";
const rel = `plan/feedback/${id}.yaml`;

function landedProof(t: TestContext, base: string | undefined, head: string) {
  const origin = gitRepo({ bare: true, kind: "landing-proof-origin" });
  const root = gitRepo({ kind: "landing-proof-root" });
  t.after(() => root.cleanup());
  t.after(() => origin.cleanup());
  const path = join(root.dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (base !== undefined) {
    writeFileSync(path, base);
    root.git("add", rel);
    root.git("commit", "-q", "-m", "chore: seed existing feedback");
  }
  root.addRemote("origin", origin.dir);
  root.git("push", "-q", "origin", "HEAD:main");
  writeFileSync(path, head);

  let body: string | undefined;
  const result = withLiveWritesAllowed(() => landFeedback(root.dir, {
    sourceRepository: { owner: "fixture", repo: "fixture" },
    planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }),
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "list") return "[]";
      assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
      const bodyIndex = args.indexOf("--body");
      assert.ok(bodyIndex >= 0);
      body = args[bodyIndex + 1];
      return "https://github.com/fixture/fixture/pull/1";
    },
  }));
  assert.equal(result.landed, true, result.error);
  assert.deepEqual(result.files, [rel]);
  assert.ok(body);
  const criteria = parseAcceptanceBlock(body);
  assert.equal(criteria.length, 1);
  const proof = criteria[0].proof;
  const match = /^grep: (.+) in (\S+)$/.exec(proof);
  assert.ok(match, "the emitted acceptance proof must be executable");
  assert.equal(match[2], rel);

  const grepAt = (ref: string) => {
    const exported = join(root.dir, "proof-blobs", ref, rel);
    mkdirSync(dirname(exported), { recursive: true });
    writeFileSync(exported, origin.git("show", `${ref}:${rel}`));
    const grep = spawnSync("grep", ["-arn", "--", match[1], exported], { encoding: "utf8" });
    assert.ifError(grep.error);
    assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
    return grep.status;
  };
  assert.equal(grepAt(LANDING_BRANCH), 0, "the proof matches the actual pushed blob");
  if (base !== undefined) {
    assert.equal(grepAt("main"), 1, "the proof must fail against the existing entry on main");
  } else {
    assert.equal(origin.git("ls-tree", "main", "--", rel), "", "a new entry is absent at base");
  }
  return proof;
}

test("W1-T5381: a landing that changes an existing entry proves the new status", (t) => {
  const base = `id: ${id}\nraw: needs a decision\nstatus: proposed\n`;
  const head = base.replace("status: proposed", "status: accepted");
  assert.equal(landedProof(t, base, head), `grep: ^status: accepted$ in ${rel}`);
});

test("W1-T5381: a landing that adds a new entry still proves it by id", (t) => {
  const head = `id: ${id}\nraw: a new entry\nstatus: new\n`;
  assert.equal(landedProof(t, undefined, head), `grep: ${id} in ${rel}`);
});
