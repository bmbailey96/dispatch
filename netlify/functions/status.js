const { getStore, connectLambda } = require('@netlify/blobs');
const { readHistory } = require('../../lib/historyLog');
const { denverWallTimeToUTC } = require('../../lib/denverTime');

const schedule = require('../../data/schedule.json');
const scpSendOrder = require('../../data/scp-send-order.json');
const scpMasterList = require('../../data/scp-master-list.json');
const ongshatSequence = require('../../data/ongshat-sequence.json');

const scpByUrl = Object.fromEntries(scpMasterList.map((e) => [e.url, e]));

const STARTED_KEY = 'started';

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

async function dionaeaStatus() {
  const store = getStore('dionaea-house-history');
  const started = await getStarted(store);

  let sentIds = [];
  try {
    const raw = await store.get('sent-item-ids', { type: 'json' });
    if (Array.isArray(raw)) sentIds = raw;
  } catch (err) {
    // no history yet
  }
  const sentSet = new Set(sentIds);
  const history = await readHistory(store);

  // Activation date: Blobs (set by "start") first, env var override second --
  // matches the resolution order in dionaea-daily-check.js itself.
  let activationRaw = null;
  try {
    activationRaw = await store.get('activation-date', { type: 'text' });
  } catch (err) {
    // not set
  }
  if (!activationRaw) activationRaw = process.env.DIONAEA_ACTIVATION_DATE || null;

  let nextItem = null;
  if (activationRaw) {
    const [year, month, day] = activationRaw.split('-').map((n) => parseInt(n, 10));
    const activationParts = { year, month, day };
    const upcoming = schedule
      .filter((item) => !sentSet.has(item.id))
      .map((item) => ({ item, at: targetInstantFor(item, activationParts) }))
      .sort((a, b) => a.at - b.at);
    if (upcoming.length > 0) {
      nextItem = { label: upcoming[0].item.subject, at: upcoming[0].at.toISOString() };
    }
  }

  return {
    name: 'Dionaea House',
    endpoint: 'dionaea-daily-check',
    started,
    total: schedule.length,
    sent: sentIds.length,
    remaining: schedule.length - sentIds.length,
    next: nextItem,
    history: history.slice(-10).reverse(),
  };
}

async function scpStatus() {
  const store = getStore('scp-weekly-history');
  const started = await getStarted(store);

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
  const nextUrl = scpSendOrder.find((url) => !sentSet.has(url));

  return {
    name: 'SCP Weekly',
    endpoint: 'scp-weekly',
    started,
    total: scpSendOrder.length,
    sent: sentUrls.length,
    remaining: Math.max(scpSendOrder.length - sentUrls.length, 0),
    next: nextSendAt
      ? { label: nextUrl && scpByUrl[nextUrl] ? scpByUrl[nextUrl].title : '(cycle restarting)', at: nextSendAt }
      : null,
    history: history.slice(-10).reverse(),
  };
}

async function ongshatStatus() {
  const store = getStore('ongshat-drip-history');
  const started = await getStarted(store);

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
  const nextItem = ongshatSequence[cursor];

  return {
    name: "Ong's Hat",
    endpoint: 'ongshat-check',
    started,
    total: ongshatSequence.length,
    sent: cursor,
    remaining: Math.max(ongshatSequence.length - cursor, 0),
    next: nextSendAt
      ? { label: nextItem ? (nextItem.type === 'image' ? `(image: ${nextItem.file})` : nextItem.type) : '(sequence finished)', at: nextSendAt }
      : null,
    history: history.slice(-10).reverse(),
  };
}

exports.handler = async function (event) {
  connectLambda(event);
  try {
    const [dionaea, scp, ongshat] = await Promise.all([dionaeaStatus(), scpStatus(), ongshatStatus()]);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), drips: [dionaea, scp, ongshat] }),
    };
  } catch (err) {
    console.error('status failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
