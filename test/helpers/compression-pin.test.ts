import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SOURCE = "src/lib/module.ts";
const PIN = "test/compress-module.test.ts";

function fixture(pinAtBase: boolean) {
  const repo = gitRepo({ kind: "compression-pin" });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, SOURCE), "// a long\n// explanation\nexport const x = 1;\n");
  if (pinAtBase) writeFileSync(join(repo.dir, PIN), "// pin\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, SOURCE), "// short\nexport const x = 1;\n");
  writeFileSync(join(repo.dir, PIN), "// pin, edited\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "head");
  return { repo, pinUrl: pathToFileURL(join(repo.dir, PIN)).href };
}

test("compressionPinBase returns the merge-base source when the diff adds the pin", () => {
  const { repo, pinUrl } = fixture(false);
  assert.equal(compressionPinBase(SOURCE, pinUrl, repo.dir),
    "// a long\n// explanation\nexport const x = 1;\n");
});

test("compressionPinBase is inert once the pin exists at the merge base", () => {
  const { repo, pinUrl } = fixture(true);
  assert.equal(compressionPinBase(SOURCE, pinUrl, repo.dir), undefined);
});

test("compressionPinBase throws when the merge base cannot be resolved", () => {
  const { repo, pinUrl } = fixture(false);
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.throws(() => compressionPinBase(SOURCE, pinUrl, repo.dir), /git merge-base failed/);
});

test("compressionPinBase refuses a pin outside the checkout", () => {
  const { repo } = fixture(false);
  assert.throws(() => compressionPinBase(SOURCE, import.meta.url, repo.dir), /must live inside/);
});
