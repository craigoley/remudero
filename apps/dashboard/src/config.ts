// apps/dashboard/src/config.ts — where the client comes from.
//
// Same `?daemon=`/`?token=` placeholder dashboard v0 used, kept deliberately: a real auth UX is
// separate work, and inventing one here would be scope this task did not take. `createDaemonClient`
// validates the base URL at construction and throws before any token is transmitted, so a crafted
// `?daemon=` cannot aim an authenticated request at an arbitrary host.
import { createDaemonClient, type DaemonClient } from "@remudero/api-client/client";

export interface ConsoleConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export function readConfig(search: string): ConsoleConfig | null {
  const q = new URLSearchParams(search);
  const baseUrl = q.get("daemon");
  const token = q.get("token");
  if (baseUrl === null || baseUrl === "" || token === null || token === "") return null;
  return { baseUrl, token };
}

export function clientFor(config: ConsoleConfig): DaemonClient {
  return createDaemonClient({ baseUrl: config.baseUrl, token: config.token });
}
