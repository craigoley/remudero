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

test("W1-T4585: a path under the retired apps/dashboard root is refused, never handed to a runner", () => {
  // W1-T4566 deleted apps/dashboard and core no longer installs Vitest, so the root W1-T3178 added
  // for it could only ever resolve to a runner that is absent. It is gone: such a path now refuses
  // with the dialect's explainer, like any undeclared root. Vitest routing for the repositories that
  // do run it (remudero-site, remudero-console) is pinned in cross-repo-proof-suite-registry.test.ts.
  assert.equal(parseWhitelistedProof("unit test: apps/dashboard/src/App.test.tsx"), null, "the retired root must refuse");
  const why = explainUnitTestProofRefusal("unit test: apps/dashboard/src/App.test.tsx");
  assert.match(why ?? "", /does not declare/);
  assert.match(why ?? "", /The declared roots are `test\/` \(node\)\./, "the explainer lists only the live root");
  assert.ok(pinnedVitestCli("/x").startsWith("/x/"), "the Vitest pin stays rooted at the given checkout");
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
