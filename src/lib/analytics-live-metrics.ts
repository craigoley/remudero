export type LiveMetrics = {
  queuePending: number;
  providerRemaining: number;
  asOf?: string;
  [key: string]: any;
};

export function computeLiveMetrics(state: { queue?: { pending?: number }, provider?: { remaining?: number }, asOf?: string } = {}): LiveMetrics {
  const queuePending = typeof state.queue?.pending === 'number' ? state.queue!.pending! : 0;
  const providerRemaining = typeof state.provider?.remaining === 'number' ? state.provider!.remaining! : 0;
  const asOf = state.asOf ?? new Date().toISOString();
  return { queuePending, providerRemaining, asOf };
}

export default computeLiveMetrics;
