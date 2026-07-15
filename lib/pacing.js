/**
 * Single source of truth for the random-gap pacing used by SCP and
 * Ong's Hat, so status.js's duration estimates always match what the
 * actual send functions are doing -- tune the numbers here, not in two
 * places that can drift out of sync.
 *
 * Dionaea isn't here because its pacing isn't probabilistic -- every
 * item has an exact dayIndex/hour/minute offset from activation, so its
 * finish date is computed directly from the schedule, not estimated.
 */
module.exports = {
  ongshat: { minGapDays: 0.75, maxGapDays: 2.25 },
  scp: { minGapDays: 1, maxGapDays: 8 },
};
