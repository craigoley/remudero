/**
 * The pins that keep deploy/resource-policy.sh from reading the host a suite runs on (W1-T11553, W1-T12027).
 *
 * The policy reads a running fleet container's memory.max and memory.peak through docker and the cgroup
 * tree, and each peer's recorded peak through the instance registry's state roots. On a host that runs
 * the fleet a fixture without these pins is answered by the live containers instead of its own inputs.
 * Both paths point inside the fixture root and are never created.
 */
import { join } from "node:path";

export function hostIndependentPolicyEnv(root: string): { RMD_CGROUP_ROOT: string; RMD_RESOURCE_POLICY_REGISTRY: string } {
  return { RMD_CGROUP_ROOT: join(root, "no-cgroup"), RMD_RESOURCE_POLICY_REGISTRY: join(root, "no-registry.yaml") };
}
