import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_SECTIONS, inboxQualificationPolicy, inboxShadowPopulation } from "#src/lib/inbox-view.js";
import { snapshotCursor } from "#src/lib/read-page.js";
import { VIEW_SHADOW_SAMPLE_MS, VIEW_SHADOW_SUMMARY_STEP, createViewShadow, type ShadowEvidence, type ViewShadowState } from "#src/lib/view-shadow.js";
import type { ShadowPopulation } from "#src/lib/view-shadow-store.js";
import { viewKey } from "#src/lib/views.js";

// W1-T11329: the needs-you section grows and shrinks a page whenever its item count crosses a page boundary, so
// the same logical page left and returned many times a day. Each return minted a fresh incarnation and restarted
// that page's full day, which no flapping page could ever finish.

const T0 = Date.parse("2026-11-04T00:00:00.000Z");
const MINUTE = VIEW_SHADOW_SAMPLE_MS, DAY = 1440 * MINUTE;
const SCOPE = { instance: "core", repository: "craigoley/remudero" };
const POLICY = inboxQualificationPolicy(SCOPE);
const SNAPSHOT = "c".repeat(64);
const NONE: ShadowEvidence = {
  legacyAsOfMs: T0, viewAsOfMs: T0, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0,
};

function steppedClock(): Clock & { advance(ms: number): void } {
  let ms = T0;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), advance: (by) => void (ms += by) };
}

/** The production Inbox producer's population for `needsYou` pages, carried forward from the previous one as serve does. */
function produce(clock: Clock, needsYou: number, previous?: ShadowPopulation): ShadowPopulation {
  const asOf = clock.iso();
  const bodies = INBOX_VIEW_SECTIONS.flatMap(section => {
    const of = section === "needsYou" ? needsYou : 1;
    return Array.from({ length: of }, (_, index) => {
      const cursor = (offset: number) => snapshotCursor({ snapshotKey: SNAPSHOT, section, offset });
      return { key: viewKey(new URLSearchParams({ section, ...(index > 0 ? { cursor: cursor(index) } : {}) })),
        sources: [{ name: "inbox-store:core", asOf, state: "fresh" as const }],
        data: { snapshotKey: SNAPSHOT, section, items: [{ id: `${section}-${index}` }], counts: {}, page: { index, of, total: of, ...(index + 1 < of ? { next: cursor(index + 1) } : {}) } } };
    });
  });
  return inboxShadowPopulation(bodies, SCOPE, clock.now(), previous);
}

/** The real comparator over a saved store, fed by the real producer; `needsYou(n)` is a population change. */
function flappingInbox(clock: Clock & { advance(ms: number): void }) {
  let population = produce(clock, 2);
  const saved: Record<string, ViewShadowState> = {};
  const rows: Array<Record<string, unknown>> = [];
  const shadow = createViewShadow({ clock, evidence: () => NONE, qualifications: { [INBOX_VIEW_NAME]: POLICY },
    log: (step, extra) => { if (step === VIEW_SHADOW_SUMMARY_STEP) rows.push(extra); },
    populations: () => ({ [INBOX_VIEW_NAME]: population }),
    store: { load: () => structuredClone(saved), save: (key, state) => { saved[key] = structuredClone(state); } },
  });
  const compare = (key: string, real = false) => {
    const page = population.pages.find(page => page.key === key)!;
    const data = { snapshotKey: SNAPSHOT, section: page.section, page: { index: page.index }, note: "same" };
    return shadow.compare({ view: INBOX_VIEW_NAME, key, requests: 0, qualificationGeneration: population.generation,
      legacy: { data, asOfMs: clock.now(), qualificationGeneration: population.generation },
      body: { data: real ? { ...data, note: "changed" } : data, asOf: clock.iso() } });
  };
  /** One sampler sweep over every current page, then a minute passes. */
  const minute = () => { for (const page of population.pages) compare(page.key); clock.advance(MINUTE); };
  const needsYouPage = (index: number) => population.pages.find(page => page.section === "needsYou" && page.index === index);
  const current = () => Object.values(saved).find(state => state.view === INBOX_VIEW_NAME && state.qualificationGeneration === POLICY)!;
  const evidence = (index: number) => {
    const page = needsYouPage(index)!;
    return current().population!.pages.find(own => own.logicalKey === page.logicalKey)!;
  };
  return { shadow, rows, compare, minute, needsYouPage, evidence, current,
    /** `incarnations` overrides a needs-you page's producer incarnation, as a page minted before W1-T11329 carries. */
    needsYou: (n: number, incarnations: Record<number, string> = {}) => {
      const next = produce(clock, n, population);
      population = { ...next, pages: next.pages.map(page => page.section === "needsYou" && incarnations[page.index] ? { ...page, incarnation: incarnations[page.index]! } : page) };
    },
    readiness: () => shadow.readiness().find(row => row.view === INBOX_VIEW_NAME)! };
}

test("W1-T11329: a needs-you page that returns gets the same incarnation from the producer", () => {
  const clock = steppedClock();
  const two = produce(clock, 2), one = produce(clock, 1, two), back = produce(clock, 2, one);
  const second = (population: ShadowPopulation) => population.pages.find(page => page.section === "needsYou" && page.index === 1);
  assert.equal(second(one), undefined, "positive control: the second page left the population");
  assert.equal(second(back)!.logicalKey, second(two)!.logicalKey);
  assert.equal(second(back)!.incarnation, second(two)!.incarnation, "the returning position is the same page, not a new one");
  assert.match(second(back)!.incarnation, /^[a-f0-9-]{36}$/, "it is still the UUID shape the population parser accepts");
});

test("W1-T11329: a page that leaves and returns within the hour keeps its samples and sinceMs, and so still qualifies", () => {
  const clock = steppedClock(), f = flappingInbox(clock);
  for (let m = 0; m < 20 * 60; m++) f.minute();
  const before = f.evidence(1);
  assert.equal(before.samples, 20 * 60, "positive control: the second page measured twenty hours");
  f.needsYou(1);
  for (let m = 0; m < 10; m++) f.minute();
  assert.equal(f.needsYouPage(1), undefined, "the second page is out of the population");
  f.needsYou(2);
  f.minute();
  const back = f.evidence(1);
  assert.equal(back.incarnation, before.incarnation);
  assert.equal(back.sinceMs, before.sinceMs, "it keeps the day it had already started");
  assert.equal(back.samples, before.samples + 1, "it keeps every sample it measured before it left");
  for (let m = 0; m < 5 * 60; m++) f.minute();
  const ready = f.readiness();
  assert.equal(ready.ready, true, `a page away ten minutes still finishes its day: ${ready.reason}`);
  assert.ok(f.evidence(1).samples >= 1440 && clock.now() - f.evidence(1).sinceMs! >= DAY, "it earned its full day and cadence under the unchanged rule");
});

test("W1-T11329: a real diff while the page is away resets it when it returns", () => {
  const clock = steppedClock(), f = flappingInbox(clock);
  for (let m = 0; m < 60; m++) f.minute();
  assert.ok(f.evidence(1).samples > 0, "positive control: the page measured before it left");
  f.needsYou(1);
  f.minute();
  const first = f.needsYouPage(0)!.key;
  assert.ok(f.compare(first, true).diffs.some(diff => diff.classification === "real"), "positive control: this comparison is a real diff");
  clock.advance(MINUTE);
  f.needsYou(2);
  f.minute();
  const back = f.evidence(1);
  assert.equal(back.samples, 1, "evidence measured before a real diff is never restored");
  assert.equal(back.sinceMs, clock.now() - MINUTE, "its day starts over on return");
});

test("W1-T11329: a page that returns as another incarnation starts at zero", () => {
  const clock = steppedClock(), f = flappingInbox(clock);
  for (let m = 0; m < 60; m++) f.minute();
  const before = f.evidence(1);
  f.needsYou(1);
  f.minute();
  f.needsYou(2, { 1: "00000000-0000-0000-0000-000000000001" });
  f.compare(f.needsYouPage(1)!.key);
  clock.advance(MINUTE);
  assert.notEqual(f.evidence(1).incarnation, before.incarnation, "positive control: the returning page is another incarnation");
  assert.equal(f.evidence(1).samples, 1, "another incarnation's evidence is never borrowed");
  assert.equal(f.evidence(1).sinceMs, clock.now() - MINUTE);
});

test("W1-T11329: a page gone for a day returns at zero, and a never-seen position still needs its own day", () => {
  const clock = steppedClock(), f = flappingInbox(clock);
  for (let m = 0; m < 60; m++) f.minute();
  f.needsYou(1);
  f.minute();
  clock.advance(DAY);
  f.minute();
  f.needsYou(3);
  f.minute();
  assert.equal(f.evidence(1).samples, 1, "a page gone a day does not get its old evidence back");
  assert.equal(f.evidence(1).sinceMs, clock.now() - MINUTE);
  assert.equal(f.evidence(2).samples, 1, "a never-seen position starts at zero");
  for (let m = 0; m < 2 * 1440; m++) f.minute();
  assert.equal(f.readiness().ready, true, "positive control: two more days qualify every page");
  f.needsYou(4);
  f.minute();
  assert.equal(f.evidence(3).samples, 1, "the new fourth position starts at zero");
  const refused = f.readiness();
  assert.equal(refused.ready, false, "a brand-new position cannot borrow the view's qualification");
  assert.match(refused.reason, /still needs its own full day and cadence/);
});

test("W1-T11329 criterion 2: each summary row counts current pages younger than a day and those that re-appeared", () => {
  const clock = steppedClock(), f = flappingInbox(clock);
  for (let m = 0; m < 10; m++) f.minute();
  f.needsYou(1);
  for (let m = 0; m < 10; m++) f.minute();
  f.needsYou(2);
  for (let m = 0; m < 10; m++) f.minute();
  f.needsYou(3);
  for (let m = 0; m < 40; m++) f.minute();
  const row = f.rows.at(-1)!;
  assert.ok(row, "positive control: an hour of samples wrote a summary row");
  assert.equal(row.pages_young, INBOX_VIEW_SECTIONS.length + 2, "every current page is under a day old");
  assert.equal(row.pages_young_reappeared, 1, "only the second needs-you page left and came back; the third is new");
  for (let m = 0; m < 1440; m++) f.minute();
  const later = f.rows.at(-1)!;
  assert.equal(later.pages_young, 0, "a day later no current page is young");
  assert.equal(later.pages_young_reappeared, 0);
});
