/**
 * Converts a wall-clock time in America/Denver into the correct UTC instant.
 * Needed because this project's schedule can genuinely span a DST
 * transition (a run starting mid-July and lasting 112 days lands right
 * around when Mountain Daylight Time ends in early November) — a fixed
 * -06:00 or -07:00 offset would be wrong for part of the run.
 */
function getTimezoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000; // minutes, timeZone-relative-to-UTC
}

/** month is 1-indexed (1 = January), matching normal convention — NOT JavaScript's native 0-indexed Date months. */
function denverWallTimeToUTC(year, month, day, hour, minute) {
  const naiveUTC = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMin = getTimezoneOffsetMinutes(new Date(naiveUTC), 'America/Denver');
  return new Date(naiveUTC - offsetMin * 60000);
}

module.exports = { denverWallTimeToUTC };
