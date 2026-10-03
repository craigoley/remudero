import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { createInboxThreadView, inboxThreadViewKey } from "../src/lib/inbox-thread-view.js";
import { viewKey, type ViewSource } from "../src/lib/views.js";

const clock = fixedClock(Date.parse("2026-10-02T12:00:00.000Z"));
const plain = { headline: "Decision", whatHappened: "Conflict", whatWeNeed: "Choose", ifNothingHappens: "Wait", options: [], source: "template" as const };
const item = (proposalId: string) => ({ proposalId, summary: "Known", plain, lane: "ready" });
const fresh: ViewSource = { name: "inbox-store:core", asOf: clock.iso(), state: "fresh" };
type Page = { index: number; of: number; total: number; next?: string };

function fixture(t: { after(fn: () => void): void }) {
  const root = makeTempDir("inbox-thread-evidence");
  const inboxRoot = join(root, "inbox");
  mkdirSync(join(inboxRoot, "state"), { recursive: true });
  const db = openProjectorReadModel(join(root, "read-model"), "core");
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE view_body(view TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,generation INTEGER NOT NULL,etag TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(view,key)) WITHOUT ROWID");
  const demand = createDemandBook({ clock });
  const view = createInboxThreadView({ inboxRoot, demand, clock });
  function seed(key = "section=needsYou", items = [item("present")], page: Page = { index: 0, of: 1, total: items.length }, sources = [fresh]) {
    const body = { data: { section: "needsYou", items, page }, sources };
    db.prepare("INSERT OR REPLACE INTO view_body VALUES('inbox',?,1,1,?,?)").run(key, `etag-${key}`, JSON.stringify(body));
  }
  function read(id = "missing") {
    const key = inboxThreadViewKey(inboxThreadId(id));
    demand.want("inbox-thread", key);
    return view.materialize({ now: clock.now(), instances: [{ db }] }).find((entry) => entry.key === key)!;
  }
  return { seed, read };
}

test("an unavailable inbox classification is never a fresh missing thread", (t) => {
  const f = fixture(t);
  f.seed(undefined, [], undefined, [{ ...fresh, state: "unavailable", asOf: null, reason: "classifier failed" }]);
  const result = f.read();
  assert.equal(result.sources[0]!.state, "unavailable");
  assert.equal(result.sources[0]!.asOf, null);
  assert.match(result.data.reason!, /classifier failed/);
});

test("an incomplete inbox snapshot cannot prove thread absence", (t) => {
  const f = fixture(t);
  f.seed(undefined, [item("present")], { index: 0, of: 2, total: 2, next: "1" });
  assert.equal(f.read().sources[0]!.state, "unavailable");
});

test("the thread view reads canonical cursor pages and preserves their source age", (t) => {
  const f = fixture(t);
  f.seed(undefined, [item("first")], { index: 0, of: 2, total: 2, next: "1" });
  const secondKey = viewKey(new URLSearchParams({ section: "needsYou", cursor: "1" }));
  assert.equal(secondKey, "cursor=1&section=needsYou");
  f.seed(secondKey, [item("second")], { index: 1, of: 2, total: 2 });
  assert.equal(f.read("second").data.found, true);
  assert.equal(f.read().sources[0]!.state, "fresh", "complete snapshots may prove absence");
  assert.equal(f.read("second").sources[0]!.asOf, fresh.asOf);
});

test("a stale classification stays stale and can recover without changing its item etag", (t) => {
  const f = fixture(t);
  f.seed(undefined, undefined, undefined, [{ ...fresh, state: "stale", reason: "behind" }]);
  assert.equal(f.read("present").sources[0]!.state, "stale");
  f.seed();
  assert.equal(f.read("present").sources[0]!.state, "fresh");
});

test("the thread view preserves the production classifier's GitHub dependency", (t) => {
  const f = fixture(t);
  const github: ViewSource = { name: "github:craigoley/remudero", asOf: "2026-10-02T11:59:00.000Z", state: "stale", reason: "board behind" };
  f.seed(undefined, undefined, undefined, [fresh, github]);
  const result = f.read("present");
  assert.equal(result.data.found, true);
  assert.equal(result.sources[0]!.asOf, fresh.asOf);
  assert.equal(result.sources[1]!.state, "stale");
  assert.equal(result.sources[1]!.asOf, github.asOf);
  f.seed(undefined, undefined, undefined, [fresh, { ...github, state: "fresh" }]);
  assert.equal(f.read("present").sources[1]!.state, "fresh");
});

test("an unclassified inbox, invalid page and unknown lane are unavailable", (t) => {
  const f = fixture(t);
  assert.equal(f.read().sources[0]!.state, "unavailable");
  f.seed(undefined, undefined, { index: -1, of: 1, total: 1 });
  assert.equal(f.read().sources[0]!.state, "unavailable");
  f.seed(undefined, [{ ...item("present"), lane: "unknown" }]);
  assert.equal(f.read("present").sources[0]!.state, "unavailable");
});

for (const [name, sources] of [
  ["missing source", []],
  ["unknown source age", [{ ...fresh, asOf: null }]],
  ["invalid source age", [{ ...fresh, asOf: "not-a-date" }]],
  ["wrong instance", [{ ...fresh, name: "inbox-store:site" }]],
] as const) {
  test(`inbox thread evidence rejects ${name}`, (t) => {
    const f = fixture(t);
    f.seed(undefined, undefined, undefined, [...sources]);
    assert.equal(f.read().sources[0]!.state, "unavailable");
  });
}

for (const [name, key, page, source] of [
  ["mixed source snapshots", "cursor=1&section=needsYou", { index: 1, of: 2, total: 2 }, { ...fresh, asOf: "2026-10-02T11:00:00.000Z" }],
  ["duplicate page index", "cursor=1&section=needsYou", { index: 0, of: 2, total: 2 }, fresh],
  ["wrong cursor", "cursor=9&section=needsYou", { index: 1, of: 2, total: 2 }, fresh],
  ["inconsistent total", "cursor=1&section=needsYou", { index: 1, of: 2, total: 3 }, fresh],
] as const) {
  test(`inbox thread evidence rejects ${name}`, (t) => {
    const f = fixture(t);
    f.seed(undefined, [item("first")], { index: 0, of: 2, total: 2, next: "1" });
    f.seed(key, [item("second")], { ...page }, [source]);
    assert.equal(f.read().sources[0]!.state, "unavailable");
  });
}
