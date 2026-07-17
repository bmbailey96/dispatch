
const { getStore, connectLambda } = require('@netlify/blobs');
const { readHistory } = require('../../lib/historyLog');
const { getPaused } = require('../../lib/pauseState');
const { denverWallTimeToUTC } = require('../../lib/denverTime');
const { ongshat: ONGSHAT_PACING, scp: SCP_PACING, arg: ARG_PACING, getEffectiveGap } = require('../../lib/pacing');

const schedule = require('../../data/schedule.json');
const scpSendOrder = require('../../data/scp-send-order.json');
const scpMasterList = require('../../data/scp-master-list.json');
const ongshatSequence = require('../../data/ongshat-sequence.json');
const argMasterList = require('../../data/arg-master-list.json');
const argSendOrder = require('../../data/arg-send-order.json');

const argById = Object.fromEntries(argMasterList.map((e) => [e.id, e]));

const scpByUrl = Object.fromEntries(scpMasterList.map((e) => [e.url, e]));

const STARTED_KEY = 'started';
const DAY_MS = 24 * 60 * 60 * 1000;

function targetInstantFor(item, activationParts) {
  const base = new Date(Date.UTC(activationParts.year, activationParts.month - 1, activationParts.day));
  base.setUTCDate(base.getUTCDate() + item.dayIndex);
  return denverWallTimeToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), item.hour, item.minute);
}

async function getStarted(store) {
  try {
    const raw = await store.get(STARTED_KEY, { type: 'text' });
    return raw === 'true';
  } catch (err) {
    return false;
  }
}

function daysBetween(a, b) {
  return Math.round(((b - a) / DAY_MS) * 10) / 10;
}

async function dionaeaStatus() {
  const store = getStore('dionaea-house-history');
  const started = await getStarted(store);
  const paused = await getPaused(store);

  let sentIds = [];
  try {
    const raw = await store.get('sent-item-ids', { type: 'json' });
    if (Array.isArray(raw)) sentIds = raw;
  } catch (err) {
    // no history yet
  }
  const sentSet = new Set(sentIds);
  const history = await readHistory(store);

  let activationRaw = null;
  try {
    activationRaw = await store.get('activation-date', { type: 'text' });
  } catch (err) {
    // not set
  }
  if (!activationRaw) activationRaw = process.env.DIONAEA_ACTIVATION_DATE || null;

  const sortedSchedule = [...schedule].sort((a, b) => a.dayIndex - b.dayIndex || a.hour - b.hour || a.minute - b.minute);

  let activationParts = null;
  if (activationRaw) {
    const [year, month, day] = activationRaw.split('-').map((n) => parseInt(n, 10));
    activationParts = { year, month, day };
  }

  const now = new Date();
  const items = sortedSchedule.map((item) => ({
    key: item.id,
    label: item.subject,
    type: item.type,
    sent: sentSet.has(item.id),
    at: activationParts ? targetInstantFor(item, activationParts).toISOString() : null,
  }));

  const nextItem = items.find((i) => !i.sent) || null;

  let duration = { mode: 'exact', note: activationParts ? null : 'no activation date set yet -- dates unknown until started' };
  if (activationParts) {
    const activationDate = new Date(Date.UTC(activationParts.year, activationParts.month - 1, activationParts.day));
    const finishAt = targetInstantFor(sortedSchedule[sortedSchedule.length - 1], activationParts);
    duration.finishAt = finishAt.toISOString();
    duration.totalDays = daysBetween(activationDate, finishAt);
    duration.remainingDays = Math.max(daysBetween(now, finishAt), 0);
  }

  return {
    name: 'Dionaea House',
    endpoint: 'dionaea-daily-check',
    started,
    paused,
    total: schedule.length,
    sent: sentIds.length,
    remaining: schedule.length - sentIds.length,
    next: nextItem ? { label: nextItem.label, at: nextItem.at } : null,
    duration,
    items,
    history: history.slice().reverse(),
  };
}

async function scpStatus() {
  const store = getStore('scp-weekly-history');
  const started = await getStarted(store);
  const paused = await getPaused(store);

  let sentUrls = [];
  try {
    const raw = await store.get('sent-urls', { type: 'json' });
    if (Array.isArray(raw)) sentUrls = raw;
  } catch (err) {
    // no history yet
  }
  let nextSendAt = null;
  try {
    const raw = await store.get('next-send-at', { type: 'text' });
    if (raw) nextSendAt = raw;
  } catch (err) {
    // not scheduled yet
  }
  const history = await readHistory(store);
  const sentSet = new Set(sentUrls);
  const gap = await getEffectiveGap(store, SCP_PACING);
  const avgGap = (gap.minGapDays + gap.maxGapDays) / 2;

  const now = new Date();
  let cursorDate = nextSendAt ? new Date(nextSendAt) : now;
  const items = sendOrderWithEstimates(scpSendOrder, sentSet, scpByUrl, cursorDate, avgGap, (url) => scpByUrl[url].title);

  const nextItem = items.find((i) => !i.sent) || null;
  const remainingCount = Math.max(scpSendOrder.length - sentUrls.length, 0);

  const duration = {
    mode: 'estimate',
    note: `average pacing (${gap.minGapDays}-${gap.maxGapDays} day gaps, ~${avgGap} avg) -- not exact`,
    totalDays: Math.round(scpSendOrder.length * avgGap),
    remainingDays: Math.round(remainingCount * avgGap),
    finishAt: remainingCount > 0 ? new Date(now.getTime() + remainingCount * avgGap * DAY_MS).toISOString() : null,
  };

  return {
    name: 'SCP Weekly',
    endpoint: 'scp-weekly',
    started,
    paused,
    total: scpSendOrder.length,
    sent: sentUrls.length,
    remaining: remainingCount,
    next: nextItem ? { label: nextItem.label, at: nextItem.at } : null,
    duration,
    gap: { min: gap.minGapDays, max: gap.maxGapDays, overridden: gap.overridden },
    items,
    history: history.slice().reverse(),
  };
}

function sendOrderWithEstimates(order, sentSet, byKey, startDate, avgGap, labelFn) {
  let runningDate = new Date(startDate);
  return order.map((key) => {
    const sent = sentSet.has(key);
    let at = null;
    if (!sent) {
      at = runningDate.toISOString();
      runningDate = new Date(runningDate.getTime() + avgGap * DAY_MS);
    }
    return { key, label: labelFn(key), type: undefined, sent, at };
  });
}

async function ongshatStatus() {
  const store = getStore('ongshat-drip-history');
  const started = await getStarted(store);
  const paused = await getPaused(store);

  let cursor = 0;
  try {
    const raw = await store.get('next-index', { type: 'text' });
    if (raw !== null) cursor = parseInt(raw, 10);
  } catch (err) {
    // no history yet
  }
  let nextSendAt = null;
  try {
    const raw = await store.get('next-send-at', { type: 'text' });
    if (raw) nextSendAt = raw;
  } catch (err) {
    // not scheduled yet
  }
  const history = await readHistory(store);
  const gap = await getEffectiveGap(store, ONGSHAT_PACING);
  const avgGap = (gap.minGapDays + gap.maxGapDays) / 2;
  const now = new Date();

  let runningDate = nextSendAt ? new Date(nextSendAt) : now;
  const items = ongshatSequence.map((item, idx) => {
    const sent = idx < cursor;
    let at = null;
    if (!sent) {
      at = runningDate.toISOString();
      runningDate = new Date(runningDate.getTime() + avgGap * DAY_MS);
    }
    const label = item.type === 'image' ? `image: ${item.file}` : item.type === 'source' ? `source #${item.id + 1}` : item.type;
    return { key: idx, label, type: item.type, sent, at };
  });

  const nextItem = items.find((i) => !i.sent) || null;
  const remainingCount = Math.max(ongshatSequence.length - cursor, 0);

  const duration = {
    mode: 'estimate',
    note: `average pacing (${gap.minGapDays}-${gap.maxGapDays} day gaps, ~${avgGap} avg) -- not exact`,
    totalDays: Math.round(ongshatSequence.length * avgGap),
    remainingDays: Math.round(remainingCount * avgGap),
    finishAt: remainingCount > 0 ? new Date(now.getTime() + remainingCount * avgGap * DAY_MS).toISOString() : null,
  };

  return {
    name: "Ong's Hat",
    endpoint: 'ongshat-check',
    started,
    paused,
    total: ongshatSequence.length,
    sent: cursor,
    remaining: remainingCount,
    next: nextItem ? { label: nextItem.label, at: nextItem.at } : null,
    duration,
    gap: { min: gap.minGapDays, max: gap.maxGapDays, overridden: gap.overridden },
    items,
    history: history.slice().reverse(),
  };
}

async function argStatus() {
  const store = getStore('arg-weekly-history');
  const started = await getStarted(store);
  const paused = await getPaused(store);

  let cursor = 0;
  try {
    const raw = await store.get('next-index', { type: 'text' });
    if (raw !== null) cursor = parseInt(raw, 10);
  } catch (err) {
    // no history yet
  }
  let nextSendAt = null;
  try {
    const raw = await store.get('next-send-at', { type: 'text' });
    if (raw) nextSendAt = raw;
  } catch (err) {
    // not scheduled yet
  }
  const history = await readHistory(store);
  const gap = await getEffectiveGap(store, ARG_PACING);
  const avgGap = (gap.minGapDays + gap.maxGapDays) / 2;
  const now = new Date();

  let runningDate = nextSendAt ? new Date(nextSendAt) : now;
  const items = argSendOrder.map((id, idx) => {
    const sent = idx < cursor;
    let at = null;
    if (!sent) {
      at = runningDate.toISOString();
      runningDate = new Date(runningDate.getTime() + avgGap * DAY_MS);
    }
    const entry = argById[id];
    return { key: idx, label: entry ? entry.title : `id ${id}`, type: entry ? entry.category : undefined, sent, at };
  });

  const nextItem = items.find((i) => !i.sent) || null;
  const remainingCount = Math.max(argSendOrder.length - cursor, 0);

  const duration = {
    mode: 'estimate',
    note: `average pacing (${gap.minGapDays}-${gap.maxGapDays} day gaps, ~${avgGap} avg) -- not exact`,
    totalDays: Math.round(argSendOrder.length * avgGap),
    remainingDays: Math.round(remainingCount * avgGap),
    finishAt: remainingCount > 0 ? new Date(now.getTime() + remainingCount * avgGap * DAY_MS).toISOString() : null,
  };

  return {
    name: 'ARG of the Week',
    endpoint: 'arg-weekly-check',
    started,
    paused,
    total: argSendOrder.length,
    sent: cursor,
    remaining: remainingCount,
    next: nextItem ? { label: nextItem.label, at: nextItem.at } : null,
    duration,
    gap: { min: gap.minGapDays, max: gap.maxGapDays, overridden: gap.overridden },
    items,
    history: history.slice().reverse(),
  };
}

exports.handler = async function (event) {
  connectLambda(event);
  try {
    const [dionaea, scp, ongshat, arg] = await Promise.all([dionaeaStatus(), scpStatus(), ongshatStatus(), argStatus()]);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), drips: [dionaea, scp, ongshat, arg] }),
    };
  } catch (err) {
    console.error('status failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
