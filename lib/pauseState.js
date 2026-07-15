/**
 * Shared pause/resume state for the three drips. Pausing freezes time:
 * we record when the pause began, and on resume the caller shifts its
 * own schedule anchor forward by however long the pause lasted --
 * next-send-at for the probabilistic drips (SCP, Ong's Hat), the
 * activation date for Dionaea (whose whole schedule hangs off that one
 * date; without the shift, every item that came due during the pause
 * would flood out at once on resume).
 */

const PAUSED_KEY = 'paused';
const PAUSED_AT_KEY = 'paused-at';

async function getPaused(store) {
  try {
    const raw = await store.get(PAUSED_KEY, { type: 'text' });
    return raw === 'true';
  } catch (err) {
    return false;
  }
}

/** Marks the drip paused. Returns false if it was already paused. */
async function pauseNow(store) {
  if (await getPaused(store)) return false;
  await store.set(PAUSED_KEY, 'true');
  await store.set(PAUSED_AT_KEY, new Date().toISOString());
  return true;
}

/**
 * Clears the paused state and returns how long the pause lasted in ms
 * (0 if it wasn't paused, or if paused-at is somehow missing). The
 * caller applies that duration to its own schedule anchor.
 */
async function resumeAndGetPausedMs(store) {
  if (!(await getPaused(store))) return null;
  let pausedMs = 0;
  try {
    const raw = await store.get(PAUSED_AT_KEY, { type: 'text' });
    if (raw) pausedMs = Math.max(Date.now() - new Date(raw).getTime(), 0);
  } catch (err) {
    // paused-at missing -- treat as zero-length pause
  }
  await store.set(PAUSED_KEY, 'false');
  await store.set(PAUSED_AT_KEY, '');
  return pausedMs;
}

module.exports = { getPaused, pauseNow, resumeAndGetPausedMs };
