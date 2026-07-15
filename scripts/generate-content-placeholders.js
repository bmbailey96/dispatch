/**
 * Creates one placeholder .txt file per schedule item that needs content.
 * Each placeholder is a comment block (starting with PASTE_HERE, which the
 * send function checks for) telling you exactly what real material goes
 * in that file — which real page, which date, which sender — so you know
 * precisely what to go find and paste in, one at a time.
 *
 * Usage: node scripts/generate-content-placeholders.js
 * Safe to re-run — it will NOT overwrite a file that no longer starts
 * with PASTE_HERE (i.e. one you've already filled in).
 */

const fs = require('fs');
const path = require('path');
const schedule = require('../data/schedule.json');

const CONTENT_DIR = path.join(__dirname, '..', 'content');
if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

let created = 0;
let skipped = 0;

for (const item of schedule) {
  if (!item.contentFile) continue;
  const filePath = path.join(__dirname, '..', item.contentFile);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (!existing.trimStart().startsWith('PASTE_HERE')) {
      skipped++;
      continue; // already filled in — don't touch it
    }
  }

  const placeholder = `PASTE_HERE
---
This file is empty. Replace everything in this file (including this
notice) with the real text for:

  Subject:   ${item.subject}
  Sender:    ${item.sender || '(none — this is your own writing)'}
  Real date: ${item.realDate}
  Type:      ${item.type}
  Part:      ${item.partTitle}

Once this file no longer starts with "PASTE_HERE", the send system will
treat it as ready.
`;
  fs.writeFileSync(filePath, placeholder);
  created++;
}

console.log(`Created ${created} placeholder files, skipped ${skipped} already-filled files.`);
