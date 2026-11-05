import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { legacyViewSampler, type ShadowRequest } from "#src/lib/view-shadow.js";
import { computeViewBody, renderView, viewEtag, type ViewDefinition } from "#src/lib/views.js";

// W1-T11328: serve's main thread spent 11.6% self time in viewEtag (2026-11-04 profile), because the shadow
// sampler rendered every sampled legacy body through renderView and never read its etag.

const T0 = Date.parse("2026-11-04T12:00:00.000Z");
const fresh = [{ name: "ledger", state: "fresh" as const, asOf: "2026-11-04T11:59:00.000Z" }];

test("W1-T11328: computeViewBody is renderView's body, and renderView adds only the etag of that body", () => {
  const view: ViewDefinition<{ count: number }> = { name: "nav-badge", version: 3, compute: () => ({ data: { count: 4 }, sources: fresh }) };
  const computed = computeViewBody(view, fixedClock(T0));
  const rendered = renderView(view, fixedClock(T0));
  assert.ok(!("error" in computed) && !("error" in rendered));
  assert.deepEqual(rendered.body, computed.body, "a served response keeps exactly the body the computation returns");
  assert.equal(rendered.etag, viewEtag("nav-badge", 3, false, { count: 4 }), "a served response keeps its entity tag");
  assert.equal("etag" in computed, false, "the body-only computation carries no entity tag");
  const failing: ViewDefinition = { name: "bad", version: 1, compute: () => ({ error: "nope" }) };
  assert.deepEqual(computeViewBody(failing, fixedClock(T0)), { error: "nope" });
});

test("W1-T11328: the shadow sampler posts a legacy body whose etag could never be computed", () => {
  // JSON.stringify throws on a BigInt, so a path that reaches viewEtag fails on this body and one that does not succeeds.
  const view: ViewDefinition = { name: "inbox", version: 1, compute: () => ({ data: { total: 7681n }, sources: fresh }) };
  assert.throws(() => renderView(view, fixedClock(T0)), TypeError, "positive control: the etag path throws on this body");
  const posted: ShadowRequest[] = [];
  const sample = legacyViewSampler({ legacy: [view], clock: fixedClock(T0), defer: (run) => run(), post: (request) => posted.push(request) });
  sample("inbox", "", new URLSearchParams());
  assert.equal(posted.length, 1, "the sampled legacy body is posted to the comparator");
  assert.deepEqual(posted[0]!.legacy?.data, { total: 7681n }, "the posted legacy data is the computed body's data");
  assert.equal(posted[0]!.legacy?.asOfMs, Date.parse("2026-11-04T11:59:00.000Z"));
});
