// test/console-shell-age-formatter.test.ts -- W1-T3615.
//
// console-freshness.ts's `formatAge` is the ONE tested four-tier age formatter ("just now" /
// "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago"), and its own header claims the shell "mirrors" it so
// every "… ago" on the header reads identically. Until this task, `bootConsoleShellClient`'s own
// freshness ticker (`tickFreshness`) never called it: it hand-rolled a SECOND, one-tier formatter
// (`${secs}s ago`, uncapped), so an hour-idle console rendered "updated 3600s ago" where the
// tested function says "1h ago" -- the two agree below a minute and silently diverge above it,
// exactly the range an idle console sits in.
//
// These tests boot the REAL `bootConsoleShellClient` under a minimal DOM/fetch stub (the same
// real-boot technique test/serve.change-management.test.ts's "round 2" suite uses) and drive its
// freshness ticker directly on a clock this test controls, so a reintroduced one-tier copy fails
// behaviourally -- never again only by an operator screenshot.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bootConsoleShellClient, consoleShellClientSource } from "../src/lib/console-shell-client.js";
import { resolveFreshness, formatAge } from "../src/lib/console-freshness.js";

class StubClassList {
  private readonly names = new Set<string>();
  add(...names: string[]): void { for (const name of names) this.names.add(name); }
  remove(...names: string[]): void { for (const name of names) this.names.delete(name); }
  contains(name: string): boolean { return this.names.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.names.has(name);
    if (next) this.names.add(name);
    else this.names.delete(name);
    return next;
  }
}

class StubElement {
  readonly classList = new StubClassList();
  readonly dataset: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  readonly children: StubElement[] = [];
  firstChild: StubElement | null = null;
  firstElementChild: StubElement | null = null;
  nextSibling: StubElement | null = null;
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  title = "";
  className = "";
  private inner = "";

  constructor(readonly id = "") {}

  get innerHTML(): string { return this.inner; }
  set innerHTML(value: string) { this.inner = value; }

  addEventListener(): void {}
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  insertBefore(child: StubElement, anchor: StubElement | null): void {
    const existing = this.children.indexOf(child);
    if (existing !== -1) this.children.splice(existing, 1);
    const at = anchor ? this.children.indexOf(anchor) : -1;
    this.children.splice(at === -1 ? this.children.length : at, 0, child);
    this.firstChild = this.children[0] ?? null;
    this.firstElementChild = this.children[0] ?? null;
  }
  remove(): void {}
  after(): void {}
  contains(): boolean { return false; }
  querySelector(): StubElement | null { return null; }
  querySelectorAll(): StubElement[] { return []; }
  closest(): StubElement | null { return null; }
  click(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

/** A document stub minimal enough to boot the real client: any `getElementById` id is
 *  auto-created on first request (the same trick test/serve.change-management.test.ts's
 *  `makeChangeManagementDocument` uses), so this file needn't enumerate every id the boot path
 *  touches -- only the one ("freshness") this task's own claim is about. */
function makeAutoDocument(): { document: unknown; elements: Map<string, StubElement> } {
  const elements = new Map<string, StubElement>();
  const get = (id: string): StubElement => {
    let el = elements.get(id);
    if (!el) {
      el = new StubElement(id);
      elements.set(id, el);
    }
    return el;
  };
  get("rest-detail").hidden = true;
  return {
    document: {
      title: "Remudero",
      body: get("body"),
      getElementById: get,
      createElement: (tag: string) => new StubElement(tag),
      querySelector: (selector: string) => (selector === "main" ? get("main") : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    elements,
  };
}

/** Boots the REAL `bootConsoleShellClient` under a minimal DOM/fetch stub, capturing every
 *  `setInterval` registration instead of running it, so the freshness ticker
 *  (`setInterval(tickFreshness, 1000)`) can be driven MANUALLY on a clock `setElapsedMs` (below)
 *  controls -- never a real 1s wall-clock wait, and never dependent on real elapsed time drift. */
async function withFreshnessBoot(
  formatAgeArg: ((ms: number) => string) | undefined,
  fn: (freshnessEl: StubElement, setElapsedMs: (ms: number) => void) => Promise<void> | void,
): Promise<void> {
  const { document, elements } = makeAutoDocument();
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const original = {
    window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
    fetch: globalThis.fetch, history: globalThis.history, CSS: globalThis.CSS, setInterval: globalThis.setInterval,
  };
  const storage = new Map<string, string>();
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const windowStub = {
    location: { search: "?token=stub-read", hash: "", pathname: "/" },
    sessionStorage: storageApi, localStorage: storageApi,
    matchMedia: () => ({ matches: true }), addEventListener: () => {}, open: () => null, confirm: () => false,
  };
  const bodies: Record<string, unknown> = {
    "/v1/status": { generated_at: "2026-09-21T00:00:00.000Z", tasks: [], counts: {}, spend: null },
  };
  const originalDateNow = Date.now;
  // A FIXED clock throughout boot: `touchFreshness` captures `Date.now()` as `lastLiveAt` during
  // the boot-time `refreshAll()`, so pinning the clock before boot and only moving it afterwards
  // makes `lastLiveAt` an EXACT, known value -- no real-wall-clock drift to account for below.
  let clockMs = originalDateNow();
  Date.now = () => clockMs;
  try {
    Object.assign(globalThis, {
      window: windowStub,
      document,
      localStorage: storageApi,
      history: { replaceState: () => {} },
      CSS: { escape: (value: unknown) => String(value) },
      setInterval: ((cb: () => void, ms: number) => { intervals.push({ fn: cb, ms }); return intervals.length; }) as unknown as typeof setInterval,
      fetch: ((input: unknown) => {
        const path = typeof input === "string" ? input : String(input);
        if (path === "/v1/status/stream") return new Promise<Response>(() => {});
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => bodies[path] ?? {},
          text: async () => JSON.stringify(bodies[path] ?? {}),
        } as Response);
      }) as typeof fetch,
    });
    if (formatAgeArg) bootConsoleShellClient({ default: 1 }, resolveFreshness, formatAgeArg);
    else bootConsoleShellClient({ default: 1 }, resolveFreshness);
    for (let i = 0; i < 100; i += 1) {
      if (elements.get("top-status")?.dataset.pollState === "ok") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(elements.get("top-status")?.dataset.pollState, "ok", "bootConsoleShellClient's first refresh must land before this test drives the ticker");
    // `bootConsoleShellClient` registers TWO 1000ms intervals -- `tickElapsed` first, then
    // `tickFreshness` -- so the LAST 1000ms registration (never the first) is the freshness one.
    const ticker = intervals.filter((i) => i.ms === 1000).at(-1);
    assert.ok(ticker, "bootConsoleShellClient must register the freshness ticker on a 1000ms interval");
    const base = clockMs; // == `lastLiveAt`, exactly, since the clock was pinned throughout boot.
    const setElapsedMs = (ms: number) => {
      clockMs = base + ms;
      ticker!.fn();
    };
    // `getElementById` auto-creates on first request (see makeAutoDocument) -- fetch "freshness"
    // through it, rather than off `elements` directly, so it exists even if nothing has rendered
    // into it yet (tickFreshness itself is the first thing that will).
    const freshnessEl = (document as { getElementById: (id: string) => StubElement }).getElementById("freshness");
    await fn(freshnessEl, setElapsedMs);
  } finally {
    Date.now = originalDateNow;
    Object.assign(globalThis, original);
  }
}

test("the console header renders the tested four-tier age, never a second one-tier copy", async () => {
  await withFreshnessBoot(undefined, (freshnessEl, setElapsedMs) => {
    // MEASURED 2026-09-15 (this task's own rationale): the tested formatAge against what the
    // browser used to render, at these exact elapsed times.
    for (const elapsedMs of [1_000, 45_000, 3_600_000, 90_000_000]) {
      setElapsedMs(elapsedMs);
      assert.equal(freshnessEl.textContent, `updated ${formatAge(elapsedMs)}`);
    }
    // The specific divergence this task fixes: an hour-idle console must say "1h ago", never the
    // one-tier copy's uncapped "3600s ago".
    setElapsedMs(3_600_000);
    assert.equal(freshnessEl.textContent, "updated 1h ago");
  });
});

test("a seconds-only age formatter in the shell client is refused", async () => {
  const sentinel = (ms: number) => `SENTINEL(${ms})`;
  await withFreshnessBoot(sentinel, (freshnessEl, setElapsedMs) => {
    setElapsedMs(7_000);
    assert.equal(
      freshnessEl.textContent,
      "updated SENTINEL(7000)",
      "a second, hard-coded formatter would ignore the injected one and this assertion would fail",
    );
  });
});

test("W1-T3615: consoleShellClientSource embeds the REAL formatAge (lib/console-freshness.ts), not a hand copy", () => {
  const src = consoleShellClientSource({ default: 1 });
  // `.toString()` off the real, imported function -- same technique W1-T281 already uses for
  // `resolveFreshness`. Asserting on its OWN source rather than a description of it: a drifted,
  // hand-written copy would fail this.
  assert.equal(src.includes(formatAge.toString()), true);
});
