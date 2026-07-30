// test/setup/open-shell.ts — shared Chromium boot barrier for the serve.*.test.ts suites
// (W1-T255).
//
// Every Chromium-driving serve suite (shell-ux, live-state, find, detail-journey, density-ia)
// carried its OWN copy of the same "has the shell finished its first real paint" wait:
//   page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"))
//
// That predicate is VACUOUSLY TRUE before #top-status even exists in the DOM: on a slow first
// paint, `getElementById` returns null, `?.textContent` short-circuits to `undefined`, and
// `!undefined` is `true` -- so the barrier resolves on the FIRST poll, before the shell has
// rendered anything, instead of waiting for real content. That is exactly the observed shape of
// the flake this task (W1-T255) makes the CI gate tolerant of; fixing the predicate itself
// removes one source of it at the root, and folding the fix into ONE shared helper (instead of
// patching five duplicated copies) means the next suite that needs this wait inherits the fix
// instead of re-introducing the bug.
//
// shellBootReady is passed DIRECTLY to Playwright's `page.waitForFunction(shellBootReady)`,
// which serializes the function's OWN source text and evaluates it inside the page -- it cannot
// resolve imports or outer closures, so this function must stay a genuinely zero-argument,
// self-contained read of the page's global `document`. test/test-with-retry.test.ts unit-tests
// this same function (no Playwright/browser dependency) by stubbing `globalThis.document` with a
// minimal `getElementById` stub before calling it directly in this Node process.
//
// W1-T202: ALSO waits for the boot write-scope probe to resolve (document.body.dataset.
// writeScopeResolved === "1"), not just the first real paint. Before this, every suite that
// interacted with a write control raced the SAME probe individually (see the flake-fix comment on
// test/serve.shell-ux.test.ts's markHandledPresence) -- folding it into the one shared boot
// barrier means every caller inherits a fully-settled write-gating state (fleet-control buttons'
// `disabled`, NEEDS ME/UP NEXT row affordances) instead of re-deriving its own wait.
export function shellBootReady(): boolean {
  const el = document.getElementById("top-status");
  if (el === null || el.textContent === null || el.textContent.includes("loading")) return false;
  return document.body.dataset.writeScopeResolved === "1";
}
