import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENWEIGHT_RESPONSE_FORMATS,
  OpenWeightUnsupportedResponseFormatError,
  openWeightResponseFormatField,
} from "../src/lib/worker-provider.js";

// W1-T3695. `spawnOpenWeightWorker` carried a blanket "Do not add `response_format` here",
// measured against gpt-oss-120b, which returns MALFORMED JSON under json_object. That measurement
// is a property of ONE DEPLOYMENT, not of the field. Probed 2026-09-16 with the adapter's own URL
// and api-version: gpt-5-mini answers json_object with HTTP 200 and clean `{"ok":true,"n":7}`.

test("W1-T3695: a deployment that declares json_object gets the field on its request", () => {
  assert.deepEqual(openWeightResponseFormatField("gpt-5-mini", "json_object"), {
    response_format: { type: "json_object" },
  });
});

test("W1-T3695: gpt-oss-120b still REFUSES json_object — the original measurement is preserved, not reversed", () => {
  assert.equal(OPENWEIGHT_RESPONSE_FORMATS["gpt-oss-120b"], undefined);
  assert.throws(
    () => openWeightResponseFormatField("gpt-oss-120b", "json_object"),
    OpenWeightUnsupportedResponseFormatError,
  );
});

test("W1-T3695: an UNMEASURED deployment declares nothing and may not be asked", () => {
  // gpt-5-nano is priced, shaped and bounded, but its json_object behaviour was never probed.
  // Silence must read as "no", never as "probably fine".
  assert.equal(OPENWEIGHT_RESPONSE_FORMATS["gpt-5-nano"], undefined);
  assert.throws(() => openWeightResponseFormatField("gpt-5-nano", "json_object"), OpenWeightUnsupportedResponseFormatError);
  assert.throws(() => openWeightResponseFormatField("a-deployment-nobody-measured", "json_object"), OpenWeightUnsupportedResponseFormatError);
});

test("W1-T3695: asking for nothing sends nothing — prose stays every lane's default", () => {
  assert.deepEqual(openWeightResponseFormatField("gpt-5-mini", undefined), {});
  assert.deepEqual(openWeightResponseFormatField("gpt-oss-120b", undefined), {});
});

test("W1-T3695: the refusal names the deployment and what it does support, so a caller can reroute", () => {
  try {
    openWeightResponseFormatField("gpt-oss-120b", "json_object");
    assert.fail("expected a refusal");
  } catch (e) {
    const msg = String((e as Error).message);
    assert.match(msg, /gpt-oss-120b/);
    assert.match(msg, /declares no structured-output support/);
    assert.match(msg, /Route this lane to a deployment that declares it/);
  }
});

test("W1-T3695: an unsupported FORMAT on a declaring deployment still refuses", () => {
  assert.throws(() => openWeightResponseFormatField("gpt-5-mini", "json_schema"), OpenWeightUnsupportedResponseFormatError);
});
