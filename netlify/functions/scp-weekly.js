const { getStore, connectLambda } = require('@netlify/blobs');
const masterList = require('../../data/scp-master-list.json');
const sendOrder = require('../../data/scp-send-order.json');
const { fetchScpContent } = require('../../lib/fetchScpContent');
const { sendEmail } = require('../../lib/sendEmail');
const { appendHistory } = require('../../lib/historyLog');
const { getPaused, pauseNow, resumeAndGetPausedMs } = require('../../lib/pauseState');
const { scp: PACING } = require('../../lib/pacing');

const SENT_KEY = 'sent-urls';
const NEXT_SEND_KEY = 'next-send-at';
const STARTED_KEY = 'started';

const { denverWallTimeToUTC } = require('../../lib/denverTime');

// Sporadic gap between sends: 1-8 days (average ~4.5), not tied to a
// fixed weekly schedule. Values live in lib/pacing.js so status.js's
// duration estimate always matches what's actually happening here.
const MIN_GAP_DAYS = PACING.minGapDays;
const MAX_GAP_DAYS = PACING.maxGapDays;

/**
 * Picks a random Montana-local send time: never between 11:00 PM and
 * 8:00 AM (no sends overnight), weighted toward evening (6 PM-11 PM)
 * the rest of the time, occasionally landing earlier in the day.
 * Converted to the correct UTC instant via the DST-aware helper, since
 * this schedule can run for years and will cross many DST transitions.
 */
function randomNextSendTime(from) {
  const gapDays = MIN_GAP_DAYS + Math.random() * (MAX_GAP_DAYS - MIN_GAP_DAYS);
  let target = new Date(from.getTime() + gapDays * 24 * 60 * 60 * 1000);

  // Allowed window: 8:00 AM - 11:00 PM Montana time (15 hours). Within
  // that, 70% chance of landing in the evening slice (6 PM-11 PM), 30%
  // chance anywhere in the daytime slice (8 AM-6 PM).
  let hour, minute;
  if (Math.random() < 0.7) {
    hour = 18 + Math.floor(Math.random() * 5); // 18-22 (6pm-10:59pm)
  } else {
    hour = 8 + Math.floor(Math.random() * 10); // 8-17 (8am-5:59pm)
  }
  minute = Math.floor(Math.random() * 60);

  const targetUTC = denverWallTimeToUTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hour,
    minute
  );

  // If picking the hour pushed it before "from" (can happen when gapDays
  // rounds down near a day boundary), push forward one more day.
  if (targetUTC <= from) {
    const nextDay = new Date(targetUTC);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return denverWallTimeToUTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, minute);
  }
  return targetUTC;
}

const byUrl = Object.fromEntries(masterList.map((e) => [e.url, e]));

async function getSentSet(store) {
  let sent = [];
  try {
    const raw = await store.get(SENT_KEY, { type: 'json' });
    if (Array.isArray(raw)) sent = raw;
  } catch (err) {
    // no history yet -- first run
  }
  return sent;
}

/** Read-only peek at what would be sent next, without touching state. */
function peekNextUrl(sent) {
  const sentSet = new Set(sent);
  const pool = sendOrder.filter((url) => !sentSet.has(url));
  return pool.length > 0 ? pool[0] : sendOrder[0]; // wraps around, matching pickNextEntry's loop-around behavior
}

async function pickNextEntry(store) {
  let sent = await getSentSet(store);
  const sentSet = new Set(sent);
  let pool = sendOrder.filter((url) => !sentSet.has(url));

  // Once the whole order has been sent, start over rather than going
  // silent -- at roughly one every 7 days, this won't happen for over
  // 11 years.
  if (pool.length === 0) {
    sent = [];
    pool = sendOrder;
  }

  const chosenUrl = pool[0]; // first unsent entry in the fixed, pre-mixed order
  await store.set(SENT_KEY, JSON.stringify([...sent, chosenUrl]));
  return byUrl[chosenUrl];
}

function buildEmailHtml({ entry, content }) {
  return `
  <div style="background:#ffffff;padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td style="padding-bottom:8px;">
          <p style="margin:0;font-size:28px;font-weight:bold;color:#961e1e;font-family:Georgia,'Times New Roman',serif;">${entry.title}</p>
        </td>
      </tr>
      <tr>
        <td style="border-bottom:1px solid #999;padding-bottom:14px;"></td>
      </tr>
      <tr>
        <td style="padding-top:16px;font-size:14px;line-height:1.65;color:#000000;">
          ${content}
        </td>
      </tr>
      <tr>
        <td style="padding-top:20px;border-top:1px solid #ddd;margin-top:20px;">
          <p style="margin:16px 0 0;font-size:13px;">
            <a href="${entry.url}" style="color:#1155cc;">Read on the SCP Wiki &rarr;</a>
          </p>
        </td>
      </tr>
    </table>
  </div>`;
}

exports.handler = async function (event) {
  connectLambda(event);

  const params = event.queryStringParameters || {};

  // Safe test routes -- never touch next-send-at or the sent-urls store.
  if (params.list) {
    const ids = sendOrder.map((url) => `${url}  (${byUrl[url] ? byUrl[url].title : 'unknown title'})`);
    return { statusCode: 200, body: ids.join('\n') };
  }

  if (params.test_url) {
    const entry = byUrl[params.test_url];
    if (!entry) {
      return { statusCode: 404, body: `No entry with url "${params.test_url}". Add ?list=1 to see all valid urls.` };
    }
    const content = await fetchScpContent(entry.url);
    const html = buildEmailHtml({ entry, content });
    await sendEmail({
      to: process.env.SCP_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      subject: `Declassified: ${entry.title} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: ${entry.title} (${entry.url})` };
  }

  const store = getStore('scp-weekly-history');

  // ?test_next=1 sends whatever entry would be picked next, without
  // marking it as sent or touching the schedule -- what the dashboard's
  // "test" button calls, since it doesn't need to know a url up front.
  if (params.test_next !== undefined) {
    const sent = await getSentSet(store);
    const url = peekNextUrl(sent);
    const entry = byUrl[url];
    const content = await fetchScpContent(entry.url);
    const html = buildEmailHtml({ entry, content });
    await sendEmail({
      to: process.env.SCP_TO_EMAIL || process.env.DIGEST_TO_EMAIL,
      subject: `Declassified: ${entry.title} [TEST]`,
      html,
    });
    return { statusCode: 200, body: `SENT [TEST]: ${entry.title} (${entry.url}) -- next up` };
  }

  // ?jump_to=<url> marks every entry before that url (in sendOrder) as
  // already sent, so the next real send is exactly that entry -- lets
  // you start (or restart) from any point instead of always the
  // beginning. Add ?list=1 first to find the exact url to use.
  if (params.jump_to !== undefined) {
    const targetIdx = sendOrder.indexOf(params.jump_to);
    if (targetIdx === -1) {
      return { statusCode: 404, body: `No entry with url "${params.jump_to}". Add ?list=1 to see all valid urls.` };
    }
    const alreadySent = sendOrder.slice(0, targetIdx);
    await store.set(SENT_KEY, JSON.stringify(alreadySent));
    const entry = byUrl[params.jump_to];
    return { statusCode: 200, body: `Jumped to: ${entry.title}. ${alreadySent.length} earlier entries marked as already sent.` };
  }

  // ?pause=1 / ?resume=1 -- pausing freezes the chain; resuming shifts
  // the pending gap forward by the pause duration so nothing fires
  // instantly on resume.
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

  // ?send_now=1 -- a REAL send of the next entry, right now: marks it
  // sent, logs history, reschedules the following one from this moment.
  if (params.send_now !== undefined) {
    const now = new Date();
    const entry = await pickNextEntry(store);
    const content = await fetchScpContent(entry.url);
    const html = buildEmailHtml({ entry, content });
    const subject = `Declassified: ${entry.title}`;
    await sendEmail({ to: process.env.SCP_TO_EMAIL || process.env.DIGEST_TO_EMAIL, subject, html });
    const next = randomNextSendTime(now);
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, url: entry.url });
    return { statusCode: 200, body: `Sent for real: ${entry.title}. Next send scheduled for ${next.toISOString()}.` };
  }

  // ?start=1 arms the chain -- the scheduled check below does nothing
  // until this has been called once, even though it still runs on its
  // usual cadence. This is what the dashboard's "start" button calls.
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
    return { statusCode: 200, body: 'Started. First entry will go out on the next scheduled check.' };
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

    const now = new Date();
    let nextSendAt = null;
    try {
      const raw = await store.get(NEXT_SEND_KEY, { type: 'text' });
      if (raw) nextSendAt = new Date(raw);
    } catch (err) {
      // no schedule set yet -- first run, treat as due immediately
    }

    if (nextSendAt && now < nextSendAt) {
      return { statusCode: 200, body: `Not due yet. Next send: ${nextSendAt.toISOString()}` };
    }

    const entry = await pickNextEntry(store);
    const content = await fetchScpContent(entry.url);

    const html = buildEmailHtml({ entry, content });
    const subject = `Declassified: ${entry.title}`;

    await sendEmail({ to: process.env.SCP_TO_EMAIL || process.env.DIGEST_TO_EMAIL, subject, html });

    // Schedule the next one: 1-8 days out, at a genuinely random hour.
    const next = randomNextSendTime(now);
    await store.set(NEXT_SEND_KEY, next.toISOString());
    await appendHistory(store, { at: now.toISOString(), label: entry.title, url: entry.url });

    return { statusCode: 200, body: `Sent: ${entry.title} (${entry.url}). Next send scheduled for ${next.toISOString()}.` };
  } catch (err) {
    console.error('SCP digest failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
