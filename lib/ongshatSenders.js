/**
 * Ong's Hat is one continuous sequence, but it's actually assembled
 * from several real, distinct documents -- the Incunabula Press
 * catalog, Peter Lamborn Wilson's own brochure article, Joseph
 * Matheny's personal journal and interviews, and his later "Living
 * Book" essay -- plus original investigator-note fragments that aren't
 * part of any of those documents at all. This maps each item's id to
 * which of those it actually belongs to, so the email arrives signed
 * (or deliberately unsigned) accordingly.
 *
 * Boundaries were found the same way the note-placement grounding
 * checks were done earlier: searching the actual sequence text for
 * where each real document's content starts.
 */
const SECTIONS = [
  { end: 57, sender: 'Incunabula Press' },        // the rare-book catalog itself
  { end: 78, sender: 'Peter Lamborn Wilson' },     // the Ong's Hat brochure article
  { end: 158, sender: 'Joseph Matheny' },          // his own journal, the Herbert/Cranston material, and Part II
  { end: Infinity, sender: 'Joseph Matheny' },     // The Living Book
];

function senderForSourceId(id) {
  for (const s of SECTIONS) {
    if (id <= s.end) return s.sender;
  }
  return 'Joseph Matheny';
}

/**
 * Returns a display name to sign the email with, or null to leave it
 * unsigned (Resend still needs a From address either way -- null just
 * means "use the plain fallback address with no display name," which
 * is the point for these: the investigator notes are anonymous by
 * design, and the scanned pages are just scans, not someone's writing.
 */
function getSenderFor(item) {
  if (item.type === 'source') return senderForSourceId(item.id);
  if (item.type === 'transcript') return 'Dr. Landett'; // the "Dark Planet" radio host
  return null; // notes and images stay unsigned
}

module.exports = { getSenderFor };
