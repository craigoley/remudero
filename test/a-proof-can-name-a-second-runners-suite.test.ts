import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { explainUnitTestProofRefusal, parseWhitelistedProof, pinnedVitestCli } from "../src/lib/review.js";

// W1-T3178 — THE PROOF DIALECT COULD NOT NAME A DASHBOARD TEST.
//
// `TEST_PATH_EXACT_RE` was anchored `^test/`, so every `apps/dashboard/**` path fell through to the
// bare-TITLE arm, was escaped into one `--test-name-pattern` that no test is named, resolved ZERO
// tests and graded `not_executable`. That made the console redesign (W1-T3173's ruling, W1-T3177's
// first screen) uncertifiable by construction: a whole workstream whose own tests could not
// certify it.
//
// These cases drive the REAL exported parser, never a re-implementation of its regex.

const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

test("W1-T3178: a proof naming a dashboard suite path resolves to that suite and spawns ITS runner, not node --test", () => {
  const p = parseWhitelistedProof("unit test: apps/dashboard/src/App.test.tsx");
  assert.ok(p, "a declared root must resolve, not refuse");
  assert.equal(p!.kind, "test");

  // ACCEPTING THE PATH WITHOUT TEACHING THE RUNNER IS THE TRAP THIS PINS: it would resolve and then
  // execute under `node --test`, which cannot run a .tsx component suite, and the red would be
  // reported as the author's defect rather than the dialect's.
  assert.ok(!p!.args.includes("--test"), "a dashboard suite must NOT be handed to node --test");
  assert.ok(p!.args.some((a) => a.endsWith(join("node_modules", "vitest", "vitest.mjs"))), "it runs the checkout's own Vitest");
  assert.equal(p!.args[1], "run", "and in run mode, never watch — a proof that never exits is a hung review");
  assert.ok(p!.args.includes("apps/dashboard/vite.config.ts"), "pointed at the dashboard's own config");

  // THE FULL REPO-RELATIVE PATH STAYS IN ARGV. `purePathTestFiles` reads the args back to decide the
  // not_yet_built carve-out and base discrimination; a path rewritten relative to the package would
  // make a dashboard proof invisible to both, and a forward-referencing filing would grade
  // executed_fail instead of not_yet_built.
  assert.ok(p!.args.includes("apps/dashboard/src/App.test.tsx"), "the repo-relative path must survive into argv");

  // The CLI is PINNED, for the reason pinnedPlaywrightCli already records: `npx` resolves a NAME and
  // on a cache miss fetches a different Vitest than the one this checkout installed.
  assert.equal(p!.command, "node", "run through the live node binary, never npx");
  assert.ok(pinnedVitestCli("/x").startsWith("/x/"), "the pin is rooted at the given checkout");
});

test("W1-T3178: a proof naming a test/ path still resolves exactly as it does today — byte-identical argv", () => {
  // THE REGRESSION THAT WOULD RE-GRADE THE WHOLE CORPUS. Every pure-path proof in the plan runs
  // through this arm; a changed flag, a changed order or a dropped import re-grades all of them.
  const p = parseWhitelistedProof("unit test: test/deny-floor.test.ts");
  assert.ok(p);
  assert.equal(p!.command, "node");
  assert.deepEqual(
    p!.args,
    ["--test", "--import", "tsx", "--import", TMP_HYGIENE_IMPORT, "test/deny-floor.test.ts"],
    "the node --test argv must be byte-identical to what it was before the second root existed",
  );
  assert.equal(p!.nameFiltered, undefined, "and it stays a pure-path proof, not a name-filtered one");
});

test("W1-T3178: a path under NEITHER declared root is REFUSED with the dialect's own explainer, never silently fallen through", () => {
  // W1-T3073 removed exactly this silent fall-through for `::`. A path-shaped body under an
  // undeclared root had the same defect: it reached the TITLE arm, matched zero tests, and the
  // criterion degraded to the keyword floor without a word.
  assert.equal(parseWhitelistedProof("unit test: src/lib/review.test.ts"), null, "an undeclared root must refuse");

  const why = explainUnitTestProofRefusal("unit test: src/lib/review.test.ts");
  assert.ok(why, "and the refusal must carry a sentence, not a bare null");
  assert.match(why!, /does not declare/, "it names the reason");
  assert.match(why!, /test\//, "and lists the declared roots so the author can act");
  assert.match(why!, /apps\/dashboard\/src\//);

  // A BARE TITLE IS NOT A PATH and must still reach the name-filtered arm untouched.
  const title = parseWhitelistedProof("unit test: a second read-shaped gh call inside the floor is refused");
  assert.ok(title, "a bare title must not be caught by the path refusal");
  assert.equal(title!.nameFiltered, true);
});

test("W1-T3178: a `..` segment is refused on the NEW root as well as the old", () => {
  // Traversal is refused BEFORE the runner is chosen, so the second arm inherits the guard rather
  // than re-deriving it — re-deriving is how one of two roots ends up unguarded.
  assert.equal(parseWhitelistedProof("unit test: apps/dashboard/src/../../../etc/passwd.test.ts"), null, "new root");
  assert.equal(parseWhitelistedProof("unit test: test/../../../etc/passwd.test.ts"), null, "old root, unchanged");
});

test("W1-T3178: the bare-TITLE arm's argv and escaping are unchanged, so no existing proof re-grades", () => {
  // The title arm is the fallback for the overwhelming majority of proofs in this plan. W1-T112
  // round 3: --test-name-pattern compiles its argument as a REGEX, so a title echoing real syntax
  // becomes an unescaped CHARACTER CLASS and manufactures a FAIL. That escaping must not move.
  const p = parseWhitelistedProof("unit test: a title with (parens) and [brackets] and a . dot");
  assert.ok(p);
  assert.equal(p!.nameFiltered, true);
  const idx = p!.args.indexOf("--test-name-pattern");
  assert.ok(idx > -1, "still name-filtered through the same flag");
  const pattern = p!.args[idx + 1];
  assert.match(pattern, /\\\(parens\\\)/, "parens escaped");
  assert.match(pattern, /\\\[brackets\\\]/, "brackets escaped");
  assert.match(pattern, /\\\./, "the dot escaped — it is not a wildcard");
  assert.equal(p!.args[0], "--test", "and it still runs under node --test");
});
