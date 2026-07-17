const { getStore, connectLambda } = require('@netlify/blobs');
const masterList = require('../../data/arg-master-list.json');
const sendOrder = require('../../data/arg-send-order.json'); // array of ids, in send order (currently 1..50, i.e. the order the research was built in -- reorder this file, not the master list, if you want a different weekly sequence)
const { sendEmail } = require('../../lib/sendEmail');
const { buildArgEmailHtml, buildSubject } = require('../../lib/buildArgEmailHtml');
const { denverWallTimeToUTC } = require('../../lib/denverTime');
const { appendHistory } = require('../../lib/historyLog');
const { getPaused, pauseNow, resumeAndGetPausedMs } = require('../../lib/pauseState');
const { formatFrom } = require('../../lib/senderIdentity');
const { arg: PACING, getEffectiveGap } = require('../../lib/pacing');

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
 * Same shape as SCP/Ong's Hat: Montana-local time, never overnight,
 * weighted toward evening. Kept identical on purpose -- an automated
 * send landing at a suspiciously consistent time of day is the kind of
 * thing that gives an automated thing away.
 */
function randomNextSendTime(from, gap) {
  const gapDays = gap.minGapDays + Math.random() * (gap.maxGapDays - gap.minGapDays);
  const target = new Date(from.getTime() + gapDays * 24 * 60 * 60 * 1000);

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

  // ?set_gap=min,max (days) / ?set_gap=default -- same runtime pacing
  // override pattern as SCP and Ong's Hat.
  if (params.set_gap !== undefined) {
    if (params.set_gap === 'default') {
      await store.set('gap-override', '');
      return { statusCode: 200, body: `Pacing reset to default (${PACING.minGapDays}-${PACING.maxGapDays} day gaps).` };
    }
    const [min, max] = String(params.set_gap).split(',').map(Number);
    if (!isFinite(min) || !isFinite(max) || min < 0.1 || max > 45 || max < min) {
      return { statusCode: 400, body: 'set_gap wants min,max in days: 0.1 <= min <= max <= 45. Or set_gap=default.' };
    }
    await store.set('gap-override', JSON.stringify({ min, max }));
    return { statusCode: 200, body: `Pacing set: ${min}-${max} day gaps from the next scheduling onward.` };
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
    const gap = await getEffectiveGap(store, PACING);
    const next = randomNextSendTime(now, gap);
    await store.set(CURSOR_KEY, String(cursor + 1));
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, type: entry.category });
    return { statusCode: 200, body: `Sent for real: index ${cursor} (id ${entry.id}, ${entry.title}). Next send scheduled for ${next.toISOString()}.` };
  }

  // ?start=1 arms the chain. First real send happens on the next cron tick.
  if (params.start !== undefined) {
    let already = null;
    try {
      already = await store.get(STARTED_KEY, { type: 'text' });
    } catch (err) {
      // not started yet
    }
    if (already === 'true') return { statusCode: 200, body: 'Already started.' };
    await store.set(STARTED_KEY, 'true');
    return { statusCode: 200, body: 'Started. First entry will go out on the next scheduled check (within 30 minutes).' };
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

    const gap = await getEffectiveGap(store, PACING);
    const next = randomNextSendTime(now, gap);
    await store.set(CURSOR_KEY, String(cursor + 1));
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, type: entry.category });

    return {
      statusCode: 200,
      body: `Sent: index ${cursor} (id ${entry.id}, ${entry.title}). Next send scheduled for ${next.toISOString()}.`,
    };
  } catch (err) {
    console.error('ARG of the Week drip failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
