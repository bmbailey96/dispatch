/**
 * Shared history-logging helper for the three drip functions. Each real
 * (non-test) send appends one entry here, capped at the most recent 50,
 * so the status dashboard has actual send dates to show rather than
 * just a cursor position and a next-send projection.
 */

const HISTORY_KEY = 'send-history';
const MAX_HISTORY = 50;

/**
 * @param {import('@netlify/blobs').Store} store
 * @param {{ at: string, label: string, type?: string }} entry
 */
async function appendHistory(store, entry) {
  let history = [];
  try {
    const raw = await store.get(HISTORY_KEY, { type: 'json' });
    if (Array.isArray(raw)) history = raw;
  } catch (err) {
    // no history yet -- first send
  }
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
  await store.set(HISTORY_KEY, JSON.stringify(history));
}

async function readHistory(store) {
  try {
    const raw = await store.get(HISTORY_KEY, { type: 'json' });
    if (Array.isArray(raw)) return raw;
  } catch (err) {
    // no history yet
  }
  return [];
}

module.exports = { appendHistory, readHistory, HISTORY_KEY };
