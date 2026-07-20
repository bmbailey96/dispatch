const { getStore, connectLambda } = require('@netlify/blobs');
const masterList = require('../../data/arg-master-list.json');
const sendOrder = require('../../data/arg-send-order.json'); // ids sorted by real-world anniversary date (see data/arg-anniversaries.json) -- this IS the calendar, not an arbitrary sequence, so reorder arg-anniversaries.json (and rerun the sort script) rather than hand-editing this file
const anniversaries = require('../../data/arg-anniversaries.json'); // slug -> { date: "MM-DD", basis, note }
const { sendEmail } = require('../../lib/sendEmail');
const { buildArgEmailHtml, buildSubject } = require('../../lib/buildArgEmailHtml');
const { denverWallTimeToUTC } = require('../../lib/denverTime');
const { appendHistory } = require('../../lib/historyLog');
const { getPaused, pauseNow, resumeAndGetPausedMs } = require('../../lib/pauseState');
const { formatFrom } = require('../../lib/senderIdentity');
const { arg: JITTER, getEffectiveGap } = require('../../lib/pacing');

// Single consistent sender identity for this drip -- unlike Dionaea or
// Ong's Hat, there's no in-fiction character roster here, it's a
// newsletter voice, so one name throughout is correct rather than a gap.
const SENDER_DISPLAY_NAME = 'ARG of the Week';

const byId = Object.fromEntries(masterList.map((e) => [e.id, e]));
const TOTAL = sendOrder.length;

const CURSOR_KEY = 'next-index'; // index into sendOrder, not an entry id directly
const NEXT_SEND_KEY = 'next-send-at';
const STARTED_KEY = 'started';

/**
 * Anniversary-driven scheduling: each entry has a real MM-DD in
 * arg-anniversaries.json (the event date, or the most meaningful
 * substitute where no single date exists -- declassification,
 * discovery, publication). sendOrder is already sorted by that date,
 * so "the next entry" and "the next anniversary" are the same thing --
 * this function just finds when that date next occurs after `from`,
 * this year or next, and applies the same evening-weighted
 * Montana-local time-of-day randomization SCP/Ong's Hat use, plus a
 * small day-of jitter (JITTER, from pacing.js) so it doesn't always
 * land on the exact same hour on the exact same calendar day.
 */
function nextAnniversaryTime(entry, from, jitterDays) {
  const [mm, dd] = anniversaries[entry.slug].date.split('-').map(Number);
  const jitter = jitterDays.minGapDays + Math.random() * (jitterDays.maxGapDays - jitterDays.minGapDays);

  let year = from.getUTCFullYear();
  let target = new Date(Date.UTC(year, mm - 1, dd));
  if (target.getTime() + jitter * 86400000 <= from.getTime()) {
    year += 1;
    target = new Date(Date.UTC(year, mm - 1, dd));
  }
  target = new Date(target.getTime() + jitter * 24 * 60 * 60 * 1000);

  let hour;
  if (Math.random() < 0.7) {
    hour = 18 + Math.floor(Math.random() * 5); // 6pm-10:59pm
  } else {
    hour = 8 + Math.floor(Math.random() * 10); // 8am-5:59pm
  }
  const minute = Math.floor(Math.random() * 60);

  const targetUTC = denverWallTimeToUTC(
    target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute
  );
  if (targetUTC <= from) {
    const nextDay = new Date(targetUTC);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return denverWallTimeToUTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, minute);
  }
  return targetUTC;
}

function entryAtCursor(cursor) {
  const id = sendOrder[cursor];
  return id !== undefined ? byId[id] : null;
}

exports.handler = async function (event) {
  connectLambda(event);

  const params = event.queryStringParameters || {};
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';

  // ?test_id=N sends that specific entry id right now, ignoring the
  // cursor entirely -- doesn't touch any stored state.
  if (params.test_id !== undefined) {
    const id = parseInt(params.test_id, 10);
    const entry = byId[id];
    if (!entry) return { statusCode: 404, body: `No entry with id ${id}. Valid ids: 1-${masterList.length}.` };
    const html = buildArgEmailHtml({ entry, total: TOTAL, siteUrl });
    await sendEmail({
      to: process.env.ARG_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      from: formatFrom(SENDER_DISPLAY_NAME) || undefined,
      subject: `${buildSubject(entry, TOTAL)} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: id ${id} (${entry.title})` };
  }

  const store = getStore('arg-weekly-history');

  // ?test_next=1 -- whatever's up next at the current cursor, without
  // touching the cursor or schedule. What the dashboard's test button calls.
  if (params.test_next !== undefined) {
    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }
    const entry = entryAtCursor(cursor);
    if (!entry) return { statusCode: 200, body: 'Sequence finished. Nothing left to test.' };
    const html = buildArgEmailHtml({ entry, total: TOTAL, siteUrl });
    await sendEmail({
      to: process.env.ARG_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      from: formatFrom(SENDER_DISPLAY_NAME) || undefined,
      subject: `${buildSubject(entry, TOTAL)} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: index ${cursor} (id ${entry.id}, ${entry.title})` };
  }

  // ?jump_to=N -- move the cursor to position N in sendOrder without
  // sending anything. Safe whether or not the chain has started.
  if (params.jump_to !== undefined) {
    const idx = parseInt(params.jump_to, 10);
    if (isNaN(idx) || idx < 0 || idx > sendOrder.length) {
      return { statusCode: 400, body: `Invalid index. Must be 0-${sendOrder.length}.` };
    }
    await store.set(CURSOR_KEY, String(idx));
    const upcoming = entryAtCursor(idx);
    return { statusCode: 200, body: `Cursor set to ${idx}. Next up: ${upcoming ? upcoming.title : '(end of sequence)'}` };
  }

  // ?resync=1 -- recompute next-send-at for whatever entry is currently
  // at the cursor, without sending or advancing anything. Needed after
  // arg-send-order.json is edited/reordered: the cursor is just a numeric
  // position, so the underlying entry at that position can change, but
  // next-send-at is only ever set at ?start=1 or right after a real send
  // -- it does NOT auto-update when the file changes. Without this, a
  // reordered file leaves next-send-at pointing at whatever the OLD
  // entry's anniversary was, silently mismatched against the new label.
  if (params.resync !== undefined) {
    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }
    const entry = entryAtCursor(cursor);
    if (!entry) return { statusCode: 200, body: 'Cursor is at/past the end of the sequence -- nothing to resync.' };
    const jitter = await getEffectiveGap(store, JITTER);
    const next = nextAnniversaryTime(entry, new Date(), jitter);
    await store.set(NEXT_SEND_KEY, next.toISOString());
    return { statusCode: 200, body: `Resynced. Cursor ${cursor} (${entry.title}, anniversary ${anniversaries[entry.slug].date}) now scheduled for ${next.toISOString()}.` };
  }

  // ?set_gap=min,max (days) / ?set_gap=default -- controls the small
  // jitter applied AFTER the real anniversary date (so it doesn't
  // always land on the exact same calendar day/hour). This is not a
  // gap between sends anymore -- the calendar does that job now -- so
  // keep it small; a few days at most or it starts to defeat the
  // point of an anniversary send.
  if (params.set_gap !== undefined) {
    if (params.set_gap === 'default') {
      await store.set('gap-override', '');
      return { statusCode: 200, body: `Jitter reset to default (${JITTER.minGapDays}-${JITTER.maxGapDays} days after the anniversary).` };
    }
    const [min, max] = String(params.set_gap).split(',').map(Number);
    if (!isFinite(min) || !isFinite(max) || min < 0 || max > 5 || max < min) {
      return { statusCode: 400, body: 'set_gap wants min,max in days: 0 <= min <= max <= 5 (this is jitter around the real anniversary now, not a gap between sends). Or set_gap=default.' };
    }
    await store.set('gap-override', JSON.stringify({ min, max }));
    return { statusCode: 200, body: `Jitter set: ${min}-${max} days after the anniversary, from the next scheduling onward.` };
  }

  if (params.pause !== undefined) {
    const did = await pauseNow(store);
    return { statusCode: 200, body: did ? 'Paused.' : 'Already paused.' };
  }

  if (params.resume !== undefined) {
    const pausedMs = await resumeAndGetPausedMs(store);
    if (pausedMs === null) return { statusCode: 200, body: 'Not paused.' };
    try {
      const raw = await store.get(NEXT_SEND_KEY, { type: 'text' });
      if (raw) {
        const shifted = new Date(new Date(raw).getTime() + pausedMs);
        await store.set(NEXT_SEND_KEY, shifted.toISOString());
      }
    } catch (err) {
      // no next-send-at yet -- nothing to shift
    }
    return { statusCode: 200, body: `Resumed. Schedule shifted forward by ${Math.round(pausedMs / 3600000)}h.` };
  }

  // ?send_now=1 -- a REAL send of whatever's at the cursor: advances the
  // cursor, logs history, reschedules from this moment.
  if (params.send_now !== undefined) {
    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }
    const entry = entryAtCursor(cursor);
    if (!entry) return { statusCode: 200, body: 'Sequence finished. Nothing left to send.' };
    const now = new Date();
    const html = buildArgEmailHtml({ entry, total: TOTAL, siteUrl });
    const subject = buildSubject(entry, TOTAL);
    await sendEmail({ to: process.env.ARG_TO_EMAIL || process.env.DIGEST_TO_EMAIL, from: formatFrom(SENDER_DISPLAY_NAME) || undefined, subject, html });
    const jitter = await getEffectiveGap(store, JITTER);
    const upcoming = entryAtCursor(cursor + 1);
    const next = upcoming ? nextAnniversaryTime(upcoming, now, jitter) : null;
    await store.set(CURSOR_KEY, String(cursor + 1));
    if (next) await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, type: entry.category });
    return { statusCode: 200, body: `Sent for real: index ${cursor} (id ${entry.id}, ${entry.title}). ${next ? `Next send (${upcoming.title}, anniversary ${anniversaries[upcoming.slug].date}) scheduled for ${next.toISOString()}.` : 'That was the last entry in the sequence.'}` };
  }

  // ?start=1 arms the chain. The first entry waits for its own real
  // anniversary just like every other entry -- starting the drip
  // doesn't mean "send immediately," it means "begin observing the
  // calendar."
  if (params.start !== undefined) {
    let already = null;
    try {
      already = await store.get(STARTED_KEY, { type: 'text' });
    } catch (err) {
      // not started yet
    }
    if (already === 'true') return { statusCode: 200, body: 'Already started.' };
    await store.set(STARTED_KEY, 'true');
    const first = entryAtCursor(0);
    const jitter = await getEffectiveGap(store, JITTER);
    const next = nextAnniversaryTime(first, new Date(), jitter);
    await store.set(NEXT_SEND_KEY, next.toISOString());
    return { statusCode: 200, body: `Started. First entry (${first.title}, anniversary ${anniversaries[first.slug].date}) scheduled for ${next.toISOString()}.` };
  }

  try {
    let started = null;
    try {
      started = await store.get(STARTED_KEY, { type: 'text' });
    } catch (err) {
      // not started yet
    }
    if (started !== 'true') return { statusCode: 200, body: 'Not started yet.' };

    if (await getPaused(store)) return { statusCode: 200, body: 'Paused.' };

    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }

    if (cursor >= sendOrder.length) {
      return { statusCode: 200, body: 'Sequence finished. Nothing left to send.' };
    }

    const now = new Date();
    let nextSendAt = null;
    try {
      const raw = await store.get(NEXT_SEND_KEY, { type: 'text' });
      if (raw) nextSendAt = new Date(raw);
    } catch (err) {
      // no schedule set yet -- treat as due immediately
    }

    if (nextSendAt && now < nextSendAt) {
      return { statusCode: 200, body: `Not due yet. Next send: ${nextSendAt.toISOString()}` };
    }

    const entry = entryAtCursor(cursor);
    const html = buildArgEmailHtml({ entry, total: TOTAL, siteUrl });
    const subject = buildSubject(entry, TOTAL);

    await sendEmail({ to: process.env.ARG_TO_EMAIL || process.env.DIGEST_TO_EMAIL, from: formatFrom(SENDER_DISPLAY_NAME) || undefined, subject, html });

    const jitter = await getEffectiveGap(store, JITTER);
    const upcoming = entryAtCursor(cursor + 1);
    const next = upcoming ? nextAnniversaryTime(upcoming, now, jitter) : null;
    await store.set(CURSOR_KEY, String(cursor + 1));
    if (next) await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, type: entry.category });

    return {
      statusCode: 200,
      body: `Sent: index ${cursor} (id ${entry.id}, ${entry.title}). ${next ? `Next send (${upcoming.title}, anniversary ${anniversaries[upcoming.slug].date}) scheduled for ${next.toISOString()}.` : 'That was the last entry in the sequence.'}`,
    };
  } catch (err) {
    console.error('ARG of the Week drip failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
