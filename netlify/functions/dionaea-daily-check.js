const { getStore, connectLambda } = require('@netlify/blobs');
const fs = require('fs');
const path = require('path');
const schedule = require('../../data/schedule.json');
const { sendEmail } = require('../../lib/sendEmail');
const { buildEmailHtml } = require('../../lib/buildEmailHtml');
const { denverWallTimeToUTC } = require('../../lib/denverTime');
const { appendHistory } = require('../../lib/historyLog');
const { getPaused, pauseNow, resumeAndGetPausedMs } = require('../../lib/pauseState');

const SENT_KEY = 'sent-item-ids';
const STARTED_KEY = 'started';
const ACTIVATION_KEY = 'activation-date';

/**
 * ACTIVATION_DATE is day zero -- the calendar date Mark's first email
 * "arrives." Every item's real send moment is ACTIVATION_DATE + item's
 * compressed dayIndex, at item.hour:item.minute Mountain Time (the
 * ORIGINAL, uncompressed clock time from the real historical record).
 *
 * Resolved in this order: a date stored in Blobs (set automatically by
 * the dashboard's "start" button, if no other date exists yet) beats
 * the DIONAEA_ACTIVATION_DATE environment variable, which is there as a
 * manual override if you want a specific date instead of "whenever I
 * clicked start."
 */
async function getActivationDateParts(store) {
  let raw = null;
  try {
    raw = await store.get(ACTIVATION_KEY, { type: 'text' });
  } catch (err) {
    // nothing stored yet
  }
  if (!raw) raw = process.env.DIONAEA_ACTIVATION_DATE;
  if (!raw) return null;
  const [year, month, day] = raw.split('-').map((n) => parseInt(n, 10));
  return { year, month, day };
}

function targetInstantFor(item, activationParts) {
  const base = new Date(Date.UTC(activationParts.year, activationParts.month - 1, activationParts.day));
  base.setUTCDate(base.getUTCDate() + item.dayIndex);
  return denverWallTimeToUTC(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    item.hour,
    item.minute
  );
}

function readContent(item) {
  if (!item.contentFile) return null;
  const filePath = path.join(__dirname, '..', '..', item.contentFile);
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trimStart().startsWith('PASTE_HERE')) return null;
  return text;
}

/** Builds and sends the email for a single item. Returns a short status string. Does NOT touch the sent-tracking store -- callers decide whether this counts as "really sent." */
async function sendOne(item, { testMode }) {
  if (item.absence) {
    const html = buildEmailHtml({ item, content: null, absenceNote: item.note });
    await sendEmail({
      to: process.env.DIONAEA_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      subject: `Dionaea House -- ${item.subject}${testMode ? ' [TEST]' : ''}`,
      html,
    });
    return { ok: true, message: `SENT (absence)${testMode ? ' [TEST]' : ''}: ${item.id}` };
  }

  const content = readContent(item);
  if (!content) {
    return { ok: false, message: `WAITING ON CONTENT: ${item.id} (${item.contentFile})` };
  }

  const html = buildEmailHtml({ item, content, absenceNote: null });
  await sendEmail({
    to: process.env.DIONAEA_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
    subject: `Dionaea House -- ${item.subject}${testMode ? ' [TEST]' : ''}`,
    html,
  });
  return { ok: true, message: `SENT${testMode ? ' [TEST]' : ''}: ${item.id}` };
}

exports.handler = async function (event) {
  connectLambda(event);

  const params = event.queryStringParameters || {};

  // --- TEST MODE: ?test_id=<schedule id> sends that one item right now,
  // regardless of whether it's actually due yet, and never touches the
  // real sent-tracking store -- so testing never disturbs the real
  // schedule playing out. ?list=1 instead just lists every valid id.
  if (params.list) {
    const ids = schedule.map((i) => `${i.id}  (${i.type}, day ${i.dayIndex})`);
    return { statusCode: 200, body: ids.join('\n') };
  }

  if (params.test_id) {
    const item = schedule.find((i) => i.id === params.test_id);
    if (!item) {
      return { statusCode: 404, body: `No item with id "${params.test_id}". Add ?list=1 to see all valid ids.` };
    }
    const result = await sendOne(item, { testMode: true });
    return { statusCode: result.ok ? 200 : 200, body: result.message };
  }

  const store = getStore('dionaea-house-history');

  // ?test_next=1 sends the earliest not-yet-sent item in schedule order
  // (by dayIndex/hour/minute, ignoring whether it's actually "due" yet)
  // -- what the dashboard's "test" button calls.
  if (params.test_next !== undefined) {
    let sentIds = [];
    try {
      const raw = await store.get(SENT_KEY, { type: 'json' });
      if (Array.isArray(raw)) sentIds = raw;
    } catch (err) {
      // no history yet
    }
    const sentSet = new Set(sentIds);
    const upcoming = schedule
      .filter((i) => !sentSet.has(i.id))
      .sort((a, b) => a.dayIndex - b.dayIndex || a.hour - b.hour || a.minute - b.minute);
    if (upcoming.length === 0) {
      return { statusCode: 200, body: 'Nothing left to test -- everything has been sent.' };
    }
    const result = await sendOne(upcoming[0], { testMode: true });
    return { statusCode: 200, body: `${result.message} (next up)` };
  }

  // ?jump_to=<schedule id> marks every item before it (in dayIndex/hour/
  // minute order) as already sent, so the next real send is exactly
  // that item -- lets you start (or restart) from any point instead of
  // always the beginning. Add ?list=1 first to find the exact id.
  if (params.jump_to !== undefined) {
    const sorted = [...schedule].sort((a, b) => a.dayIndex - b.dayIndex || a.hour - b.hour || a.minute - b.minute);
    const targetIdx = sorted.findIndex((i) => i.id === params.jump_to);
    if (targetIdx === -1) {
      return { statusCode: 404, body: `No item with id "${params.jump_to}". Add ?list=1 to see all valid ids.` };
    }
    const alreadySent = sorted.slice(0, targetIdx).map((i) => i.id);
    await store.set(SENT_KEY, JSON.stringify(alreadySent));
    return { statusCode: 200, body: `Jumped to: ${params.jump_to}. ${alreadySent.length} earlier items marked as already sent.` };
  }

  // ?pause=1 / ?resume=1 -- Dionaea's whole schedule hangs off the
  // activation date, so resuming slides that date forward by the pause
  // duration. Without the slide, every item that came due during the
  // pause would flood out at once on the first check after resume.
  if (params.pause !== undefined) {
    const did = await pauseNow(store);
    return { statusCode: 200, body: did ? 'Paused.' : 'Already paused.' };
  }

  if (params.resume !== undefined) {
    const pausedMs = await resumeAndGetPausedMs(store);
    if (pausedMs === null) return { statusCode: 200, body: 'Not paused.' };
    const parts = await getActivationDateParts(store);
    if (parts) {
      const shiftDays = Math.round(pausedMs / (24 * 60 * 60 * 1000));
      const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
      d.setUTCDate(d.getUTCDate() + shiftDays);
      const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      // Written to Blobs, which wins over the env var in the resolution
      // order -- so this works even if the original date came from
      // DIONAEA_ACTIVATION_DATE.
      await store.set(ACTIVATION_KEY, iso);
      return { statusCode: 200, body: `Resumed. Activation date slid forward ${shiftDays} day(s) to ${iso}.` };
    }
    return { statusCode: 200, body: 'Resumed. (No activation date existed yet, nothing to shift.)' };
  }

  // ?send_now=1 -- a REAL send of the earliest unsent item, right now,
  // regardless of whether it's due yet: marks it sent and logs history.
  // The rest of the schedule is untouched (it's date-anchored).
  if (params.send_now !== undefined) {
    let sentIdsNow = [];
    try {
      const raw = await store.get(SENT_KEY, { type: 'json' });
      if (Array.isArray(raw)) sentIdsNow = raw;
    } catch (err) {
      // no history yet
    }
    const sentSetNow = new Set(sentIdsNow);
    const upcomingNow = schedule
      .filter((i) => !sentSetNow.has(i.id))
      .sort((a, b) => a.dayIndex - b.dayIndex || a.hour - b.hour || a.minute - b.minute);
    if (upcomingNow.length === 0) {
      return { statusCode: 200, body: 'Nothing left to send.' };
    }
    const item = upcomingNow[0];
    const result = await sendOne(item, { testMode: false });
    if (result.ok) {
      sentSetNow.add(item.id);
      await store.set(SENT_KEY, JSON.stringify([...sentSetNow]));
      await appendHistory(store, { at: new Date().toISOString(), label: item.subject, type: item.type, id: item.id });
    }
    return { statusCode: 200, body: `${result.message} (sent for real)` };
  }

  // ?start=1 arms the chain. If no activation date exists yet (neither
  // in Blobs nor as an env var), this also sets one to right now, so the
  // schedule actually has a day zero to count from. This is what the
  // dashboard's "start" button calls.
  if (params.start !== undefined) {
    let already = null;
    try {
      already = await store.get(STARTED_KEY, { type: 'text' });
    } catch (err) {
      // not started yet
    }
    if (already === 'true') {
      return { statusCode: 200, body: 'Already started.' };
    }
    const existingDate = await getActivationDateParts(store);
    if (!existingDate) {
      const now = new Date();
      const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
      await store.set(ACTIVATION_KEY, iso);
    }
    await store.set(STARTED_KEY, 'true');
    return { statusCode: 200, body: 'Started. Items will go out as they come due (checked every 15 minutes).' };
  }

  // --- NORMAL MODE: real scheduled check ---
  let started = null;
  try {
    started = await store.get(STARTED_KEY, { type: 'text' });
  } catch (err) {
    // not started yet
  }
  if (started !== 'true') {
    return { statusCode: 200, body: 'Not started yet.' };
  }

  if (await getPaused(store)) {
    return { statusCode: 200, body: 'Paused.' };
  }

  let sentIds = [];
  try {
    const raw = await store.get(SENT_KEY, { type: 'json' });
    if (Array.isArray(raw)) sentIds = raw;
  } catch (err) {
    // no history yet -- first run
  }
  const sentSet = new Set(sentIds);

  const activationParts = await getActivationDateParts(store);
  if (!activationParts) {
    return { statusCode: 200, body: 'Started, but no activation date resolved yet -- this should not happen; try ?start=1 again.' };
  }
  const now = new Date();

  const due = schedule
    .filter((item) => !sentSet.has(item.id) && targetInstantFor(item, activationParts) <= now)
    .sort((a, b) => targetInstantFor(a, activationParts) - targetInstantFor(b, activationParts));

  if (due.length === 0) {
    return { statusCode: 200, body: 'Nothing due right now.' };
  }

  const results = [];
  for (const item of due) {
    const result = await sendOne(item, { testMode: false });
    if (result.ok) {
      sentSet.add(item.id);
      await appendHistory(store, { at: now.toISOString(), label: item.subject, type: item.type, id: item.id });
    }
    results.push(result.message);
  }

  await store.set(SENT_KEY, JSON.stringify([...sentSet]));
  return { statusCode: 200, body: results.join('\n') };
};
