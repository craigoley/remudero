import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

/** A single process-local monotonic envelope. Zero would disable Node's timeout. */
export function remainingSubprocessTimeout(startedMono, budgetMs, nowMono = performance.now(), reserveMs = 0) {
  if (!Number.isFinite(startedMono) || startedMono < 0 || !Number.isFinite(nowMono) || nowMono < startedMono ||
      !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 2_147_483_647 ||
      !Number.isSafeInteger(reserveMs) || reserveMs < 0) throw new Error('subprocess budget: invalid monotonic envelope');
  const remaining = Math.floor(budgetMs - (nowMono - startedMono) - reserveMs);
  if (remaining < 1) throw new Error('subprocess budget: fixed deadline exhausted');
  return remaining;
}

/** The timeout is always an integer from the SAME envelope, never a fresh per-step budget. */
export function spawnWithinBudget(file, args, options, spawn = spawnSync) {
  const {startedMono, budgetMs, reserveMs = 0, ...childOptions} = options;
  if (Object.hasOwn(childOptions, 'timeout') || childOptions.shell) throw new Error('subprocess budget: timeout override or shell refused');
  return spawn(file, args, {...childOptions, shell: false,
    timeout: remainingSubprocessTimeout(startedMono, budgetMs, performance.now(), reserveMs)});
}
