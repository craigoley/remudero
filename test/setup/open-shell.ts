// test/setup/open-shell.ts — shared Chromium boot barrier for the serve.*.test.ts suites
// (W1-T255), plus (W1-T335) the shared way those same suites reach a section once it's booted.
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
import type { Page } from "playwright";

export function shellBootReady(): boolean {
  const el = document.getElementById("top-status");
  if (el === null || el.textContent === null || el.textContent.includes("loading")) return false;
  return document.body.dataset.writeScopeResolved === "1";
}

// reachSection -- W1-T335 (second of three shards split out of W1-T314: W1-T334 scaffolded the
// four-tab console bar without moving anything under it; W1-T336 will move sections under tabs
// next). Until W1-T336 lands, every real section is a direct, always-visible sibling in the flat
// shell and this resolves on its very first check without touching anything. Once W1-T336 nests
// a section inside its owning tab's panel (hidden unless that tab is active), THIS is what
// activates that tab before a caller's own assertions read the section's content -- so a suite
// that routes a section id through here keeps passing on both sides of that restructure without
// knowing, or needing to know, which shape it is currently driving.
//
// DELIBERATELY GENERIC, not a hardcoded section-id -> tab-id table: which section lands under
// which tab is W1-T336's decision, not this one's (see that task's own design notes -- moving
// sections under tabs is explicitly out of scope here). Instead this asks the DOM directly "is
// the section visible right now," and if not, clicks the shell's own tab buttons one at a time
// until it is. That makes it correct under whatever mapping W1-T336 lands on, with nothing in
// this file to keep in sync when it does.
//
// UNLIKE shellBootReady, this is NOT handed to `page.waitForFunction` -- clicking a tab is a real
// page interaction, not a pure read of `document`, so it takes the Playwright `page` directly
// (per the constraint above: shellBootReady itself must stay a zero-argument, self-contained
// function; this is a separate export, never logic folded into it).
export async function reachSection(page: Page, sectionId: string): Promise<void> {
  const isVisible = () =>
    page.evaluate((id) => {
      const el = document.getElementById(id);
      return el !== null && el.offsetParent !== null;
    }, sectionId);

  if (await isVisible()) return; // flat shape, or already on the section's owning tab: no-op

  const tabDataIds = await page.evaluate(
    () => Array.from(document.querySelectorAll("#console-tabs .tab-btn")).map((b) => (b as HTMLElement).dataset.tab ?? ""),
  );
  for (const tabDataId of tabDataIds) {
    if (!tabDataId) continue;
    await page.click(`#console-tabs .tab-btn[data-tab="${tabDataId}"]`);
    if (await isVisible()) return;
  }

  if (tabDataIds.length > 0) {
    // A tab bar exists but NONE of its tabs reveal the section: loud failure on purpose (learnings
    // standing rule: risk:high here is exactly a helper that silently no-ops under the tabbed
    // shape too, which would look like a pass and strand the next restructure the same way).
    throw new Error(
      `reachSection: "#${sectionId}" stayed hidden through every tab in #console-tabs -- either the ` +
        `id does not exist, or it is genuinely app-hidden rather than owned by any tab.`,
    );
  }
  // No tab bar at all: nothing to activate. The caller's own subsequent wait/assert is what will
  // report a section that is missing outright, rather than merely tab-hidden.
}
