import { RawBodyTooLargeError, readBoundedRawBody, verifiedActor, type Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { ProductIntentStore } from "./product-intent-store.js";
import {
  PRODUCT_REPOSITORY_LIMITS, PRODUCT_REPOSITORY_VERSION, ProductRepositoryService,
  type ProductRepositoryCode, type ProductRepositoryProvider,
} from "./product-repository.js";
import {
  PRODUCT_DEPLOYMENT_LIMITS, PRODUCT_DEPLOYMENT_VERSION, ProductDeploymentService,
  type ProductDeploymentCode, type ProductDeploymentProvider,
} from "./product-deployment.js";
import { PRODUCT_INTENT_LIMITS, PRODUCT_INTENT_VERSION, type ProductStoreCode } from "./product-intent.js";
import { PRODUCT_RESEARCH_LIMITS, PRODUCT_RESEARCH_VERSION, ProductResearchService, type ProductResearchCode, type ProductResearchProvider } from "./product-research.js";

const status: Record<ProductStoreCode, number> = {
  invalid_identity: 403, invalid_input: 400, not_found: 404, stale_revision: 409,
  idempotency_conflict: 409, capacity: 409, busy: 503, corrupt: 503, unavailable: 503,
  outcome_unknown: 503, recovery_required: 503,
};

/** Private drafts use the existing verified principal; a shared token grants no product ownership. */
export function buildProductRoutes(options: { root?: string }): Route[] {
  const store = new ProductIntentStore(options);
  return [
    { method: "GET", path: "/v1/products", scope: "read", sensitivity: "sensitive", handler(req, res) {
      res.setHeader("Cache-Control", "private, no-store");
      const actor = verifiedActor(req);
      const reply = (code: ProductStoreCode) => sendJson(res, status[code], { version: PRODUCT_INTENT_VERSION, error: code });
      if (!actor) { reply("invalid_identity"); return; }
      const query = new URL(req.url ?? "/", "http://rmd.local").searchParams;
      const keys = [...query.keys()];
      if (keys.length > 1 || keys.some((key) => key !== "id" && key !== "requestId")) { reply("invalid_input"); return; }
      if (query.has("id")) {
        const result = store.read(actor, query.get("id")!);
        if (!result.ok) { reply(result.code); return; }
        sendJson(res, 200, { version: PRODUCT_INTENT_VERSION, product: result.value });
      } else if (query.has("requestId")) {
        const result = store.receipt(actor, query.get("requestId")!);
        if (!result.ok) { reply(result.code); return; }
        sendJson(res, 200, { version: PRODUCT_INTENT_VERSION, receipt: result.value });
      } else {
        const result = store.list(actor);
        if (!result.ok) { reply(result.code); return; }
        sendJson(res, 200, { version: PRODUCT_INTENT_VERSION, products: result.value });
      }
    } },
    { method: "POST", path: "/v1/products", scope: "write", tier: "middle", async handler(req, res) {
      res.setHeader("Cache-Control", "private, no-store");
      const actor = verifiedActor(req);
      if (!actor) { sendJson(res, 403, { version: PRODUCT_INTENT_VERSION, error: "invalid_identity" }); return; }
      let command: unknown;
      try { command = JSON.parse(await readBoundedRawBody(req, PRODUCT_INTENT_LIMITS.requestBytes)); }
      catch (error) {
        const tooLarge = error instanceof RawBodyTooLargeError;
        sendJson(res, tooLarge ? 413 : 400, { version: PRODUCT_INTENT_VERSION, error: tooLarge ? "request_too_large" : "invalid_input" });
        return;
      }
      const result = store.write(actor, command);
      if (!result.ok) { sendJson(res, status[result.code], { version: PRODUCT_INTENT_VERSION, error: result.code }); return; }
      sendJson(res, 200, { version: PRODUCT_INTENT_VERSION, ...result.value });
    } },
  ];
}

const researchStatus: Record<ProductResearchCode, number> = { ...status, already_answered: 409 };

/** Bounded research and clarification for the verified operator's own product; grants no provider or spending authority. */
export function buildProductResearchRoutes(options: { root?: string; provider?: ProductResearchProvider; budgetUsd?: number }): Route[] {
  const service = new ProductResearchService(options);
  return [
    { method: "POST", path: "/v1/products/research", scope: "write", tier: "middle", async handler(req, res) {
      res.setHeader("Cache-Control", "private, no-store");
      const fail = (code: number, error: string) => sendJson(res, code, { version: PRODUCT_RESEARCH_VERSION, error });
      const actor = verifiedActor(req);
      if (!actor) { fail(403, "invalid_identity"); return; }
      let command: unknown;
      try { command = JSON.parse(await readBoundedRawBody(req, PRODUCT_RESEARCH_LIMITS.requestBytes)); }
      catch (error) {
        // An oversize body and malformed JSON are distinct refusals: 413 request_too_large vs 400 invalid_input.
        const tooLarge = error instanceof RawBodyTooLargeError;
        fail(tooLarge ? 413 : 400, tooLarge ? "request_too_large" : "invalid_input");
        return;
      }
      const result = await service.run(actor, command);
      if (!result.ok) { fail(researchStatus[result.code], result.code); return; }
      sendJson(res, 200, result.value);
    } },
  ];
}

const repositoryStatus: Record<ProductRepositoryCode, number> = {
  invalid_identity: 403, invalid_input: 400, not_found: 404, repository_not_found: 404, repository_conflict: 409,
  idempotency_conflict: 409, creation_denied: 403, capacity: 409, busy: 503, corrupt: 503, unavailable: 503,
  provider_unreadable: 503, outcome_unknown: 503,
  stale_revision: 409, recovery_required: 503,
};

/** Exact create-or-adopt of the product repository. HIGH tier: it may create a real GitHub repository. */
export function buildProductRepositoryRoutes(options: { root?: string; provider?: ProductRepositoryProvider }): Route[] {
  const service = new ProductRepositoryService(options);
  return [
    { method: "POST", path: "/v1/products/repository", scope: "write", tier: "high", async handler(req, res) {
      res.setHeader("Cache-Control", "private, no-store");
      const reply = (code: number, body: Record<string, unknown>) => sendJson(res, code, { version: PRODUCT_REPOSITORY_VERSION, ...body });
      const actor = verifiedActor(req);
      if (!actor) { reply(403, { error: "invalid_identity" }); return; }
      let command: unknown;
      try { command = JSON.parse(await readBoundedRawBody(req, PRODUCT_REPOSITORY_LIMITS.requestBytes)); }
      catch (error) {
        const tooLarge = error instanceof RawBodyTooLargeError;
        reply(tooLarge ? 413 : 400, { error: tooLarge ? "request_too_large" : "invalid_input" });
        return;
      }
      const result = await service.execute(actor, command);
      if (!result.ok) { reply(repositoryStatus[result.code], { error: result.code }); return; }
      reply(200, result.value);
    } },
  ];
}

const deploymentStatus: Record<ProductDeploymentCode, number> = {
  invalid_identity: 403, invalid_input: 400, not_found: 404, project_not_found: 404, repository_required: 409,
  repository_mismatch: 409, team_mismatch: 409, project_conflict: 409, idempotency_conflict: 409, stale_revision: 409,
  capacity: 409, creation_denied: 403, not_configured: 503, busy: 503, corrupt: 503, unavailable: 503,
  provider_unreadable: 503, outcome_unknown: 503, recovery_required: 503,
};

/** Bind the product to its existing Vercel scope. It records a project binding only: never a deployment. */
export function buildProductDeploymentRoutes(options: { root?: string; provider?: ProductDeploymentProvider; env?: NodeJS.ProcessEnv }): Route[] {
  const service = new ProductDeploymentService(options);
  return [
    { method: "POST", path: "/v1/products/deployment", scope: "write", tier: "middle", async handler(req, res) {
      res.setHeader("Cache-Control", "private, no-store");
      const reply = (code: number, body: Record<string, unknown>) => sendJson(res, code, { version: PRODUCT_DEPLOYMENT_VERSION, ...body });
      const actor = verifiedActor(req);
      if (!actor) { reply(403, { error: "invalid_identity" }); return; }
      let command: unknown;
      try { command = JSON.parse(await readBoundedRawBody(req, PRODUCT_DEPLOYMENT_LIMITS.requestBytes)); }
      catch (error) {
        const tooLarge = error instanceof RawBodyTooLargeError;
        reply(tooLarge ? 413 : 400, { error: tooLarge ? "request_too_large" : "invalid_input" });
        return;
      }
      const result = await service.execute(actor, command);
      if (!result.ok) { reply(deploymentStatus[result.code], { error: result.code }); return; }
      reply(200, result.value);
    } },
  ];
}
