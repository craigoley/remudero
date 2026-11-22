export const MERGE_MIXING_VARIANCE = 0.25;

/** Bounds on selected minus control for one pair of binary outcomes. Exact observations have equal bounds. */
export interface MergeDifferenceObservation {
  lower: number;
  upper: number;
}

export interface MergeDifferenceSequence extends MergeDifferenceObservation {
  pairs: number;
  /** Always-valid two-sided p-value for a difference of zero. */
  pValue: number;
}

/**
 * Normal-mixture sequential test for paired proportions. Each difference is in [-1, 1].
 * Under a candidate conditional mean, Hoeffding's bound makes
 * exp(lambda * centeredSum - n * lambda² / 2) a supermartingale. Mixing over
 * lambda ~ N(0, MERGE_MIXING_VARIANCE) gives a closed-form e-value. Its running
 * maximum gives the p-value and inverting the test at every look gives the interval.
 *
 * The guarantee assumes a common conditional mean across the enrollment-ordered pairs.
 * For incomplete pairs, widen the interval and minimize the e-value over possible
 * completions at each look.
 */
export function mergeDifferenceSequence(
  observations: Iterable<MergeDifferenceObservation>,
  alpha = 0.05,
): MergeDifferenceSequence {
  let pairs = 0;
  let lowerSum = 0;
  let upperSum = 0;
  let lower = -1;
  let upper = 1;
  let logMaxEvidence = 0;
  const logThreshold = -2 * Math.log(alpha);

  for (const observation of observations) {
    pairs++;
    lowerSum += observation.lower;
    upperSum += observation.upper;
    const logVolume = Math.log1p(pairs * MERGE_MIXING_VARIANCE);
    const precision = pairs ** 2 / (pairs + 1 / MERGE_MIXING_VARIANCE);
    const radius = Math.sqrt((logThreshold + logVolume) / precision);
    const lowMean = lowerSum / pairs;
    const highMean = upperSum / pairs;
    lower = Math.max(lower, lowMean - radius);
    upper = Math.min(upper, highMean + radius);

    const distanceFromZero = Math.max(0, lowMean, -highMean);
    const logEvidence = (precision * distanceFromZero ** 2 - logVolume) / 2;
    logMaxEvidence = Math.max(logMaxEvidence, logEvidence);
  }

  return { pairs, lower, upper, pValue: Math.exp(-logMaxEvidence) };
}
