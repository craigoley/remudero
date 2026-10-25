import type { ViewBodySource, ViewRequestFailure } from "./views.js";
export const CODE_HEALTH_VIEW_NAME = "code-health";
export const CODE_HEALTH_SCOPE_KEY = "__code_health_scope";
export function readCodeHealthReport(_opts: { stateDir: string; params: URLSearchParams; now: number }): any { return undefined; }
export function validateCodeHealthRequest(_params: URLSearchParams, _source?: ViewBodySource): ViewRequestFailure | undefined { return undefined; }
