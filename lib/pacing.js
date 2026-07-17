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
const DEFAULTS = {
  ongshat: { minGapDays: 0.75, maxGapDays: 2.25 },
  scp: { minGapDays: 1, maxGapDays: 8 },
  // NOT a gap between sends -- arg-weekly-check.js schedules each entry
  // on its own real-world anniversary (see data/arg-anniversaries.json),
  // so the calendar itself provides the ~weekly spacing. This is a small
  // jitter applied AFTER that date, purely so a send doesn't land at the
  // exact same hour on the exact same day every single year.
  arg: { minGapDays: 0, maxGapDays: 2 },
};

/**
 * The dashboard can override a drip's gap at runtime (stored in that
 * drip's own Blobs store under 'gap-override') -- so pacing changes
 * don't need a code deploy. Falls back to the defaults above.
 */
async function getEffectiveGap(store, defaults) {
  try {
    const raw = await store.get('gap-override', { type: 'json' });
    if (raw && typeof raw.min === 'number' && typeof raw.max === 'number'
        && raw.min >= 0.1 && raw.max <= 45 && raw.max >= raw.min) {
      return { minGapDays: raw.min, maxGapDays: raw.max, overridden: true };
    }
  } catch (err) {
    // no override set
  }
  return { minGapDays: defaults.minGapDays, maxGapDays: defaults.maxGapDays, overridden: false };
}

module.exports = { ...DEFAULTS, DEFAULTS, getEffectiveGap };
