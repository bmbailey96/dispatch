/**
 * Converts the real 1999-2026 timeline into a compressed schedule where:
 *   - WHICH DAY something arrives is compressed proportionally (so the
 *     ~289-day silence between Part 4 and Part 5 stays the longest silence
 *     by far, relative to everything else, even compressed)
 *   - WHAT TIME OF DAY something arrives is NOT compressed -- Mark's
 *     8:17 AM email stays an 8:17 AM email, the SMS burst still starts at
 *     4:14 PM, etc. Only the calendar date is scaled; the clock time is
 *     carried straight through from the real historical record.
 *
 * Output: data/schedule.json -- every item, plus `dayIndex` (integer,
 * compressed days from activation) and `hour`/`minute` (the real,
 * uncompressed clock time), plus `contentFile`.
 *
 * Usage: node scripts/build-schedule.js > data/schedule.json
 */

const { TIMELINE } = require('../data/timeline');

const MAIN_ARC_TARGET_DAYS = 150; // ~5 months. Chosen so the dense Oct 2004 cluster (Danielle/Eric/updates/AIM log, ~26 pieces in 20 real days) spreads across a couple of weeks instead of piling onto 2-3 days, while the ~289-day real silence stays proportionally dominant either way.
const EPILOGUE_GAP_DAYS = 14; // deliberate pause after the main arc ends, before the 2014 material
const EPILOGUE_HOUR = 9; // arbitrary -- the 2014 posts don't carry meaningful real-world times

function parseDate(s) {
  return new Date(s + (s.includes('T') ? '' : 'T00:00:00'));
}

/** Calendar-day-only distance between two dates, ignoring time of day entirely. */
function calendarDaysBetween(a, b) {
  const aDayStart = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bDayStart = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bDayStart - aDayStart) / (1000 * 60 * 60 * 24));
}

function buildSchedule() {
  const EPILOGUE_IDS = ['p6-2014-original', 'p6-2014-update1a', 'p6-2014-update1b', 'p6-2014-update2a', 'p6-2014-update2b'];
  const mainArc = TIMELINE
    .filter((item) => !EPILOGUE_IDS.includes(item.id))
    .sort((a, b) => parseDate(a.realDate) - parseDate(b.realDate));
  const epilogueItems = TIMELINE
    .filter((item) => EPILOGUE_IDS.includes(item.id))
    .sort((a, b) => parseDate(a.realDate) - parseDate(b.realDate));

  const firstDate = parseDate(mainArc[0].realDate);
  const lastDate = parseDate(mainArc[mainArc.length - 1].realDate);
  const totalRealCalendarDays = calendarDaysBetween(firstDate, lastDate);
  const scale = MAIN_ARC_TARGET_DAYS / totalRealCalendarDays;

  const schedule = mainArc.map((item) => {
    const schedulingDate = parseDate(item.realDate);
    const realDayGap = calendarDaysBetween(firstDate, schedulingDate);
    const dayIndex = Math.round(realDayGap * scale);
    return {
      ...item,
      dayIndex,
      hour: schedulingDate.getHours(),
      minute: schedulingDate.getMinutes(),
      contentFile: item.absence ? null : `content/${item.id}.txt`,
      sent: false,
    };
  });

  const lastMainDayIndex = schedule[schedule.length - 1].dayIndex;

  const epilogueSpacingDays = {
    'p6-2014-original': 0,
    'p6-2014-update1a': 4,
    'p6-2014-update1b': 6,
    'p6-2014-update2a': 10,
    'p6-2014-update2b': 12,
  };

  for (const item of epilogueItems) {
    const extra = EPILOGUE_GAP_DAYS + (epilogueSpacingDays[item.id] ?? 0);
    schedule.push({
      ...item,
      dayIndex: lastMainDayIndex + extra,
      hour: EPILOGUE_HOUR,
      minute: 0,
      contentFile: `content/${item.id}.txt`,
      sent: false,
    });
  }

  return schedule;
}

const schedule = buildSchedule();
const last = schedule[schedule.length - 1];
console.error(`Built schedule: ${schedule.length} items, spanning ${last.dayIndex} days total.`);
process.stdout.write(JSON.stringify(schedule, null, 2));
