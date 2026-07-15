const { getStore, connectLambda } = require('@netlify/blobs');
const sequence = require('../../data/ongshat-sequence.json');
const { sendEmail } = require('../../lib/sendEmail');
const { buildOngshatEmailHtml, buildSubject } = require('../../lib/buildOngshatEmailHtml');
const { denverWallTimeToUTC } = require('../../lib/denverTime');
const { appendHistory } = require('../../lib/historyLog');
const { getPaused, pauseNow, resumeAndGetPausedMs } = require('../../lib/pauseState');
const { ongshat: PACING } = require('../../lib/pacing');

// Recomputed from the actual sequence rather than hardcoded, since this
// number has already grown once and may grow again -- it's all one
// continuous sequence, no book divisions encoded in the data itself.
const TOTAL_TEXT_ITEMS = sequence.filter((i) => i.type === 'source' || i.type === 'note').length;

const CURSOR_KEY = 'next-index';
const NEXT_SEND_KEY = 'next-send-at';
const STARTED_KEY = 'started';

// Originally tuned so 122 items averaged out to about six months end to
// end. The sequence has since grown (bridge material, Book Two, coda all
// spliced into one continuous run), so at this same gap the full run is
// longer than six months now -- tighten these two numbers (in
// lib/pacing.js, not here) if a shorter total runtime matters more than
// the pacing feel. status.js's duration estimate reads the same values.
const MIN_GAP_DAYS = PACING.minGapDays;
const MAX_GAP_DAYS = PACING.maxGapDays;

/**
 * Picks a random Montana-local send time, weighted toward evening,
 * never overnight (11pm-8am) -- same shape as the SCP digest's timing,
 * so an unexplained fragment never arrives at 3am and gives itself away
 * as an automated thing.
 */
function randomNextSendTime(from) {
  const gapDays = MIN_GAP_DAYS + Math.random() * (MAX_GAP_DAYS - MIN_GAP_DAYS);
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

exports.handler = async function (event) {
  connectLambda(event);

  const params = event.queryStringParameters || {};
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';

  // ?test_index=N sends that item right now regardless of schedule, and
  // never touches the stored cursor -- safe to use repeatedly while
  // checking how things render.
  if (params.test_index !== undefined) {
    const idx = parseInt(params.test_index, 10);
    const item = sequence[idx];
    if (!item) return { statusCode: 404, body: `No item at index ${idx}. Sequence has ${sequence.length} items (0-${sequence.length - 1}).` };
    const html = buildOngshatEmailHtml({ item, siteUrl, total: TOTAL_TEXT_ITEMS });
    await sendEmail({
      to: process.env.ONGSHAT_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      subject: `${buildSubject(item, TOTAL_TEXT_ITEMS)} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: index ${idx}, type ${item.type}` };
  }

  const store = getStore('ongshat-drip-history');

  // ?test_next=1 sends whatever item is currently up next (the item at
  // the stored cursor), without touching the cursor or the schedule --
  // this is what the dashboard's "test" button calls, since it doesn't
  // need to know an index ahead of time.
  if (params.test_next !== undefined) {
    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }
    const item = sequence[cursor];
    if (!item) return { statusCode: 200, body: 'Sequence finished. Nothing left to test.' };
    const html = buildOngshatEmailHtml({ item, siteUrl, total: TOTAL_TEXT_ITEMS });
    await sendEmail({
      to: process.env.ONGSHAT_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      subject: `${buildSubject(item, TOTAL_TEXT_ITEMS)} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: index ${cursor} (next up), type ${item.type}` };
  }

  // ?jump_to=N sets the cursor directly to index N -- lets you start (or
  // restart) the chain from any point instead of always item 0. Doesn't
  // send anything itself and doesn't touch next-send-at, so the normal
  // pacing picks up from wherever this lands. Safe to call whether or
  // not the chain has started yet.
  if (params.jump_to !== undefined) {
    const idx = parseInt(params.jump_to, 10);
    if (isNaN(idx) || idx < 0 || idx > sequence.length) {
      return { statusCode: 400, body: `Invalid index. Must be 0-${sequence.length}.` };
    }
    await store.set(CURSOR_KEY, String(idx));
    const upcoming = sequence[idx];
    return {
      statusCode: 200,
      body: `Cursor set to ${idx}. Next up: ${upcoming ? `${upcoming.type}${upcoming.type === 'source' ? ' ' + buildSubject(upcoming, TOTAL_TEXT_ITEMS) : ''}` : '(end of sequence)'}`,
    };
  }

  // ?pause=1 / ?resume=1 -- pausing freezes the chain: the scheduled
  // check skips while paused, and resuming shifts the pending gap
  // forward by the pause duration, so the next item lands as far out as
  // it would have when you paused, not instantly.
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

  // ?send_now=1 -- a REAL send of the next item, right now: advances
  // the cursor, logs history, and reschedules the following item from
  // this moment using normal pacing. Unlike test_next this counts.
  if (params.send_now !== undefined) {
    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }
    const item = sequence[cursor];
    if (!item) return { statusCode: 200, body: 'Sequence finished. Nothing left to send.' };
    const now = new Date();
    const html = buildOngshatEmailHtml({ item, siteUrl, total: TOTAL_TEXT_ITEMS });
    const subject = buildSubject(item, TOTAL_TEXT_ITEMS);
    await sendEmail({ to: process.env.ONGSHAT_TO_EMAIL || process.env.DIGEST_TO_EMAIL, subject, html });
    const next = randomNextSendTime(now);
    await store.set(CURSOR_KEY, String(cursor + 1));
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: subject, type: item.type });
    return { statusCode: 200, body: `Sent for real: index ${cursor} (${item.type}). Next send scheduled for ${next.toISOString()}.` };
  }

  // ?start=1 arms the chain -- until this has been called once, the
  // scheduled cron check below does nothing, even though it still runs
  // every 30 minutes. This is what the dashboard's "start" button calls.
  // The very first real send happens on the next cron tick after this.
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
    await store.set(STARTED_KEY, 'true');
    return { statusCode: 200, body: 'Started. First item will go out on the next scheduled check (within 30 minutes).' };
  }

  try {
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

    let cursor = 0;
    try {
      const raw = await store.get(CURSOR_KEY, { type: 'text' });
      if (raw !== null) cursor = parseInt(raw, 10);
    } catch (err) {
      // first run
    }

    if (cursor >= sequence.length) {
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

    const item = sequence[cursor];
    const html = buildOngshatEmailHtml({ item, siteUrl, total: TOTAL_TEXT_ITEMS });
    const subject = buildSubject(item, TOTAL_TEXT_ITEMS);

    await sendEmail({ to: process.env.ONGSHAT_TO_EMAIL || process.env.DIGEST_TO_EMAIL, subject, html });

    const next = randomNextSendTime(now);
    await store.set(CURSOR_KEY, String(cursor + 1));
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: subject, type: item.type });

    return {
      statusCode: 200,
      body: `Sent: index ${cursor} (${item.type}). Next send scheduled for ${next.toISOString()}.`,
    };
  } catch (err) {
    console.error('Ong\'s Hat drip failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
