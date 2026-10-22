/** Pure authority preflight shared by session and SDK tool construction. */
import type { CanaryRequest } from "./model-canary-runner.js";

export function nativeCanaryToolPolicy(request: Pick<CanaryRequest, "toolPolicy" | "invokeTool">) {
  const policy = request.toolPolicy ?? "none";
  if (!["none", "inventory", "retry", "approval"].includes(policy)) throw new Error("canary-native-tool-policy-invalid");
  if (policy !== "none" && typeof request.invokeTool !== "function") throw new Error("canary-native-tool-capability-missing");
  return policy;
}
