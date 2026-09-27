/**
 * lib/ability-map.ts — an item-response fit that reports model ability apart from task difficulty
 * (W1-T4626).
 *
 * Raw pass rates mix a model's ability with the difficulty of the tasks the router handed it. This
 * module fits a Rasch/1PL model, P(success) = sigmoid(theta_model + theta_role - beta_task), over
 * attempt-level observations. It is a regularised maximum-a-posteriori fit: a weak Gaussian prior
 * on every parameter, Newton steps with step halving, and a fixed iteration bound. Task difficulty
 * is centred to mean 0 and role ability to mean 0, so model ability carries the intercept.
 *
 * Intervals are Laplace intervals from the posterior curvature, taken on the centred contrasts.
 * The Hessian is solved through its Schur complement: task parameters form a diagonal block, so a
 * fit over thousands of tasks costs O(K^2 T), with K models plus roles.
 *
 * Invariants: a cell below its minimum attempts is `insufficient` and carries no number; the map is
 * observational evidence for internal diagnosis and never a public ranking.
 * Falsifier: test/model-ability-is-separated-from-task-difficulty.test.ts.
 */

export const ABILITY_MAP_VERSION = "ability-map-v1" as const;

const DEFAULT_PRIOR_SD = 2.5;
const DEFAULT_MIN_CELL_ATTEMPTS = 5;
const DEFAULT_MIN_TASK_ATTEMPTS = 3;
const DEFAULT_INTERVAL_Z = 1.959964;
/** BACKSTOP: Newton on this log-concave objective converges in well under 30 steps. */
const NEWTON_ITERATION_LIMIT = 100;
const NEWTON_TOLERANCE = 1e-9;

/** Where a binary outcome came from; a verified outcome always wins over the recorded one. */
export type AbilityOutcomeSource = "verified" | "attempt-recorded";

export function abilityObservation(input: {
  model: string;
  role: string;
  task: string;
  recordedSuccess: boolean;
  verifiedSuccess?: boolean;
}): AbilityObservation {
  const verified = typeof input.verifiedSuccess === "boolean";
  return {
    model: input.model,
    role: input.role,
    task: input.task,
    success: verified ? input.verifiedSuccess! : input.recordedSuccess,
    source: verified ? "verified" : "attempt-recorded",
  };
}

/** One attempt: an assignment of `model` in `role` to `task`, and its binary outcome. */
export interface AbilityObservation {
  model: string;
  role: string;
  task: string;
  success: boolean;
  source: AbilityOutcomeSource;
}

export interface AbilityMapOptions {
  priorSd?: number;
  /** Minimum attempts before a model or role cell is reported as a number. */
  minCellAttempts?: number;
  /** Minimum attempts before a task difficulty is reported as a number. */
  minTaskAttempts?: number;
}

/** A reported cell. `insufficient` deliberately has no estimate: thin evidence is blank, not zero. */
export type AbilityCell =
  | {
    key: string;
    attempts: number;
    successes: number;
    minimumAttempts: number;
    state: "estimated";
    estimate: number;
    standardError: number;
    interval: { lower: number; upper: number };
  }
  | { key: string; attempts: number; successes: number; minimumAttempts: number; state: "insufficient" };

export interface AbilityMap {
  version: typeof ABILITY_MAP_VERSION;
  state: "fitted" | "unavailable";
  reason?: string;
  evidence: "observational";
  publicRanking: false;
  modelForm: "rasch-1pl: P(success) = sigmoid(theta_model + theta_role - beta_task)";
  identification: "beta_task centred to mean 0; theta_role centred to mean 0";
  intervalMethod: "laplace-map";
  intervalLevel: number;
  observations: number;
  outcomeSources: Record<AbilityOutcomeSource, number>;
  excluded?: Record<string, number>;
  fit: { iterations: number; converged: boolean; logPosterior: number | null };
  models: AbilityCell[];
  roles: AbilityCell[];
  tasks: AbilityCell[];
}

function abilityMapShell(observations: number): Omit<AbilityMap, "state" | "reason"> {
  return {
    version: ABILITY_MAP_VERSION,
    evidence: "observational",
    publicRanking: false,
    modelForm: "rasch-1pl: P(success) = sigmoid(theta_model + theta_role - beta_task)",
    identification: "beta_task centred to mean 0; theta_role centred to mean 0",
    intervalMethod: "laplace-map",
    intervalLevel: 0.95,
    observations,
    outcomeSources: { verified: 0, "attempt-recorded": 0 },
    fit: { iterations: 0, converged: false, logPosterior: null },
    models: [],
    roles: [],
    tasks: [],
  };
}

export function unavailableAbilityMap(reason: string, observations = 0): AbilityMap {
  return { ...abilityMapShell(observations), state: "unavailable", reason };
}

function sortedKeys(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function softplus(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Gauss-Jordan inverse with partial pivoting; the Schur complement it inverts is SPD. */
function invert(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const lead = a[col]![col]!;
    for (let j = 0; j < 2 * n; j += 1) a[col]![j]! /= lead;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j += 1) a[r]![j]! -= factor * a[col]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

/** Aggregated attempts sharing one (model, role, task) triple; the fit works on these counts. */
interface Triple {
  model: number;
  role: number;
  task: number;
  attempts: number;
  successes: number;
}

/** The posterior curvature, split into the dense model+role block and the diagonal task block. */
interface Curvature {
  sInverse: number[][];
  coupling: number[][];
  taskDiagonal: number[];
}

function curvatureAt(x: readonly number[], triples: readonly Triple[], k: number, t: number, precision: number): Curvature {
  const a = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? precision : 0)));
  const coupling = Array.from({ length: k }, () => new Array<number>(t).fill(0));
  const taskDiagonal = new Array<number>(t).fill(precision);
  for (const cell of triples) {
    const p = sigmoid(x[cell.model]! + x[cell.role]! - x[k + cell.task]!);
    const w = cell.attempts * p * (1 - p);
    a[cell.model]![cell.model]! += w;
    a[cell.role]![cell.role]! += w;
    a[cell.model]![cell.role]! += w;
    a[cell.role]![cell.model]! += w;
    coupling[cell.model]![cell.task]! -= w;
    coupling[cell.role]![cell.task]! -= w;
    taskDiagonal[cell.task]! += w;
  }
  const schur = a.map((row, i) => row.map((value, j) => {
    let sum = value;
    for (let task = 0; task < t; task += 1) sum -= (coupling[i]![task]! * coupling[j]![task]!) / taskDiagonal[task]!;
    return sum;
  }));
  return { sInverse: invert(schur), coupling, taskDiagonal };
}

/** Solve H x = v through the Schur complement of the task block. */
function solve(curvature: Curvature, vK: readonly number[], vT: readonly number[]): { xK: number[]; xT: number[] } {
  const { sInverse, coupling, taskDiagonal } = curvature;
  const k = sInverse.length;
  const r = vK.map((value, i) => {
    let sum = value;
    for (let task = 0; task < vT.length; task += 1) sum -= (coupling[i]![task]! * vT[task]!) / taskDiagonal[task]!;
    return sum;
  });
  const xK = sInverse.map((row) => row.reduce((sum, value, j) => sum + value * r[j]!, 0));
  const xT = vT.map((value, task) => {
    let sum = value;
    for (let i = 0; i < k; i += 1) sum -= coupling[i]![task]! * xK[i]!;
    return sum / taskDiagonal[task]!;
  });
  return { xK, xT };
}

function negativeLogPosterior(x: readonly number[], triples: readonly Triple[], k: number, precision: number): number {
  let total = 0;
  for (const cell of triples) {
    const eta = x[cell.model]! + x[cell.role]! - x[k + cell.task]!;
    total += cell.attempts * softplus(eta) - cell.successes * eta;
  }
  for (const value of x) total += 0.5 * precision * value * value;
  return total;
}

function gradient(x: readonly number[], triples: readonly Triple[], k: number, precision: number): number[] {
  const g = x.map((value) => precision * value);
  for (const cell of triples) {
    const residual = cell.attempts * sigmoid(x[cell.model]! + x[cell.role]! - x[k + cell.task]!) - cell.successes;
    g[cell.model]! += residual;
    g[cell.role]! += residual;
    g[k + cell.task]! -= residual;
  }
  return g;
}

function cell(key: string, attempts: number, successes: number, minimumAttempts: number,
  estimate: number, variance: number, z: number): AbilityCell {
  if (attempts < minimumAttempts) return { key, attempts, successes, minimumAttempts, state: "insufficient" };
  const standardError = Math.sqrt(Math.max(0, variance));
  return {
    key, attempts, successes, minimumAttempts, state: "estimated", estimate, standardError,
    interval: { lower: estimate - z * standardError, upper: estimate + z * standardError },
  };
}

/**
 * Fit the ability map. Deterministic: keys are sorted and counts aggregated before fitting, so
 * input order cannot change the result. Thin cells still inform the fit but are reported blank.
 */
export function fitAbilityMap(observations: readonly AbilityObservation[], options: AbilityMapOptions = {}): AbilityMap {
  const priorSd = options.priorSd ?? DEFAULT_PRIOR_SD;
  const minCell = options.minCellAttempts ?? DEFAULT_MIN_CELL_ATTEMPTS;
  const minTask = options.minTaskAttempts ?? DEFAULT_MIN_TASK_ATTEMPTS;
  const z = DEFAULT_INTERVAL_Z;
  if (observations.length === 0) return unavailableAbilityMap("no-observations");
  const outcomeSources: Record<AbilityOutcomeSource, number> = { verified: 0, "attempt-recorded": 0 };
  for (const o of observations) outcomeSources[o.source] += 1;

  const models = sortedKeys(observations.map((o) => o.model));
  const roles = sortedKeys(observations.map((o) => o.role));
  const tasks = sortedKeys(observations.map((o) => o.task));
  const m = models.length;
  const k = m + roles.length;
  const t = tasks.length;
  const modelIndex = new Map(models.map((key, i) => [key, i]));
  const roleIndex = new Map(roles.map((key, i) => [key, m + i]));
  const taskIndex = new Map(tasks.map((key, i) => [key, i]));
  const byTriple = new Map<string, Triple>();
  const tallies = new Map<string, { attempts: number; successes: number }>();
  const tally = (key: string, success: boolean) => {
    const current = tallies.get(key) ?? { attempts: 0, successes: 0 };
    current.attempts += 1;
    if (success) current.successes += 1;
    tallies.set(key, current);
  };
  for (const o of observations) {
    const key = `${o.model}\0${o.role}\0${o.task}`;
    const triple = byTriple.get(key) ?? {
      model: modelIndex.get(o.model)!, role: roleIndex.get(o.role)!, task: taskIndex.get(o.task)!, attempts: 0, successes: 0,
    };
    triple.attempts += 1;
    if (o.success) triple.successes += 1;
    byTriple.set(key, triple);
    tally(`m\0${o.model}`, o.success);
    tally(`r\0${o.role}`, o.success);
    tally(`t\0${o.task}`, o.success);
  }
  const triples = [...byTriple.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const precision = 1 / (priorSd * priorSd);

  let x = new Array<number>(k + t).fill(0);
  let objective = negativeLogPosterior(x, triples, k, precision);
  let iterations = 0;
  let converged = false;
  while (iterations < NEWTON_ITERATION_LIMIT && !converged) {
    iterations += 1;
    const g = gradient(x, triples, k, precision);
    const step = solve(curvatureAt(x, triples, k, t, precision), g.slice(0, k), g.slice(k));
    const direction = [...step.xK, ...step.xT];
    let scale = 1;
    let candidate = x.map((value, i) => value - direction[i]!);
    let candidateObjective = negativeLogPosterior(candidate, triples, k, precision);
    for (let halving = 0; halving < 40 && !(candidateObjective <= objective + 1e-12); halving += 1) {
      scale /= 2;
      candidate = x.map((value, i) => value - scale * direction[i]!);
      candidateObjective = negativeLogPosterior(candidate, triples, k, precision);
    }
    const moved = Math.max(...direction.map((d) => Math.abs(scale * d)));
    x = candidate;
    objective = candidateObjective;
    converged = moved < NEWTON_TOLERANCE;
  }
  if (!converged || !x.every(Number.isFinite)) return unavailableAbilityMap("fit-did-not-converge", observations.length);

  const curvature = curvatureAt(x, triples, k, t, precision);
  const S = curvature.sInverse;
  const rolesCount = roles.length;
  const roleMean = x.slice(m, k).reduce((a, b) => a + b, 0) / rolesCount;
  const taskMean = x.slice(k).reduce((a, b) => a + b, 0) / t;
  // Covariance of the centred contrasts, via one solve against the all-ones task vector.
  const ones = solve(curvature, new Array<number>(k).fill(0), new Array<number>(t).fill(1));
  const onesTotal = ones.xT.reduce((a, b) => a + b, 0);
  const quadratic = (c: readonly number[]) => c.reduce((sum, ci, i) => sum + ci * S[i]!.reduce((row, sij, j) => row + sij * c[j]!, 0), 0);
  const roleContrast = (own: number | undefined): number[] =>
    Array.from({ length: k }, (_, i) => (i === own ? 1 : 0) - (i >= m ? 1 / rolesCount : 0));
  const modelCells = models.map((key, i) => {
    const c = Array.from({ length: k }, (_, j) => (j === i ? 1 : 0) + (j >= m ? 1 / rolesCount : 0));
    const cross = c.reduce((sum, ci, j) => sum + ci * ones.xK[j]!, 0);
    const counts = tallies.get(`m\0${key}`)!;
    return cell(key, counts.attempts, counts.successes, minCell, x[i]! + roleMean - taskMean,
      quadratic(c) - (2 * cross) / t + onesTotal / (t * t), z);
  });
  const roleCells = roles.map((key, i) => {
    const counts = tallies.get(`r\0${key}`)!;
    return cell(key, counts.attempts, counts.successes, minCell, x[m + i]! - roleMean, quadratic(roleContrast(m + i)), z);
  });
  const taskCells = tasks.map((key, task) => {
    const column = Array.from({ length: k }, (_, i) => curvature.coupling[i]![task]!);
    const inverseDiagonal = 1 / curvature.taskDiagonal[task]!;
    const own = inverseDiagonal + inverseDiagonal * inverseDiagonal * quadratic(column);
    const counts = tallies.get(`t\0${key}`)!;
    return cell(key, counts.attempts, counts.successes, minTask, x[k + task]! - taskMean,
      own - (2 * ones.xT[task]!) / t + onesTotal / (t * t), z);
  });
  return {
    ...abilityMapShell(observations.length),
    state: "fitted",
    outcomeSources,
    fit: { iterations, converged, logPosterior: -objective },
    models: modelCells,
    roles: roleCells,
    tasks: taskCells,
  };
}
