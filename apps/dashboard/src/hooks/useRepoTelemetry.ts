import { useEffect, useState } from "react";

import {
  placeholderRepoTelemetryClient,
  type RepoTelemetryClient,
  type RepoTelemetryResponse,
} from "../api/repoTelemetry";

export interface RepoTelemetryState {
  readonly loading: boolean;
  readonly response: RepoTelemetryResponse | null;
  readonly error: string | null;
}

export function useRepoTelemetry(repoId: string | null, client: RepoTelemetryClient = placeholderRepoTelemetryClient): RepoTelemetryState {
  const [state, setState] = useState<RepoTelemetryState>({ loading: false, response: null, error: null });

  useEffect(() => {
    if (repoId === null) {
      setState({ loading: false, response: null, error: null });
      return;
    }
    let live = true;
    setState({ loading: true, response: null, error: null });
    client
      .getRepoTelemetry(repoId)
      .then((response) => {
        if (live) setState({ loading: false, response, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState({ loading: false, response: null, error: String((error as Error)?.message ?? error) });
      });
    return () => {
      live = false;
    };
  }, [client, repoId]);

  return state;
}
