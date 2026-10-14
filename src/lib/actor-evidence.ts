import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

const AGENT_ENV_EXACT = ["CLAUDECODE", "REMUDERO_RUN_ID", "REMUDERO_WORKER_SCOPE", "AI_AGENT"];
const AGENT_ENV_PREFIX = "CLAUDE_CODE_";

export interface ActorEvidenceProbe {
  env: Record<string, string | undefined>;
  osUser: () => string;
  host: () => string;
  containerId: () => string | undefined;
  stdinIsTTY: () => boolean;
  stdoutIsTTY: () => boolean;
  parents: () => string[];
}

export interface ActorEvidence {
  kind: "human" | "agent";
  os_user: string;
  host: string;
  container_id?: string;
  session?: string;
  agent_markers: string[];
  tty: { stdin: boolean; stdout: boolean };
  parents: string[];
  caller_class: "human at a terminal" | "agent session" | "remote non-interactive" | "host automation";
  ssh?: { client_address: string; pty: boolean };
  claimed_session_id?: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // An unreadable /proc entry is expected off Linux or under a hardened mount: the probe reports "unknown".
    void err;
    return undefined;
  }
}

function parentNames(): string[] {
  const names: string[] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const stat = readText(`/proc/${pid}/stat`);
    if (!stat) break;
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) break;
    names.push(stat.slice(open + 1, close));
    const next = Number(stat.slice(close + 2).split(" ")[1]);
    if (!Number.isSafeInteger(next)) break;
    pid = next;
  }
  return names;
}

function realContainerId(): string | undefined {
  const cgroup = readText("/proc/self/cgroup") ?? "";
  const hex = /([0-9a-f]{64})/.exec(cgroup)?.[1];
  if (hex) return hex.slice(0, 12);
  if (existsSync("/.dockerenv") || /docker|kubepods|containerd/.test(cgroup)) return hostname();
  return undefined;
}

export function realActorEvidenceProbe(): ActorEvidenceProbe {
  return {
    env: process.env,
    osUser: () => userInfo().username,
    host: () => hostname(),
    containerId: realContainerId,
    stdinIsTTY: () => process.stdin.isTTY === true,
    stdoutIsTTY: () => process.stdout.isTTY === true,
    parents: parentNames,
  };
}

/** Process facts gathered by the writer; a supplied session id remains a caller's claim. */
export function gatherActorEvidence(probe: ActorEvidenceProbe = realActorEvidenceProbe()): ActorEvidence {
  const markers = Object.keys(probe.env)
    .filter((k) => probe.env[k] !== undefined && probe.env[k] !== "" && (AGENT_ENV_EXACT.includes(k) || k.startsWith(AGENT_ENV_PREFIX)))
    .sort();
  const containerId = probe.containerId();
  const session = probe.env.CLAUDE_CODE_SESSION_ID || probe.env.REMUDERO_RUN_ID || undefined;
  const tty = { stdin: probe.stdinIsTTY(), stdout: probe.stdoutIsTTY() };
  const client = (probe.env.SSH_CONNECTION || probe.env.SSH_CLIENT)?.trim().split(/\s+/)[0];
  const pty = tty.stdin || Boolean(probe.env.SSH_TTY);
  const claimedSession = probe.env.REMUDERO_SESSION_ID?.trim();
  const callerClass = markers.length > 0 ? "agent session"
    : client && !pty ? "remote non-interactive"
    : containerId !== undefined ? "agent session"
    : pty ? "human at a terminal" : "host automation";
  return {
    kind: markers.length > 0 || containerId !== undefined ? "agent" : "human",
    os_user: probe.osUser(),
    host: probe.host(),
    ...(containerId !== undefined ? { container_id: containerId } : {}),
    ...(session ? { session } : {}),
    agent_markers: markers,
    tty,
    parents: probe.parents(),
    caller_class: callerClass,
    ...(client ? { ssh: { client_address: client, pty } } : {}),
    ...(claimedSession ? { claimed_session_id: claimedSession } : {}),
  };
}

/** Validate persisted evidence without inferring identity from legacy pid/host/session fields. */
export function readActorEvidence(raw: unknown): ActorEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const actor = raw as ActorEvidence;
  if (typeof actor.os_user !== "string" || typeof actor.host !== "string" ||
      !["human at a terminal", "agent session", "remote non-interactive", "host automation"].includes(actor.caller_class)) return undefined;
  return actor;
}

export function describeActorEvidence(raw: unknown): string {
  const actor = readActorEvidence(raw);
  if (!actor) return "actor unrecorded";
  return `${actor.os_user} on ${actor.host}${actor.container_id ? ` (container ${actor.container_id})` : ""}; ${actor.caller_class}` +
    `${actor.claimed_session_id ? `; session ${actor.claimed_session_id} (claimed)` : ""}`;
}
