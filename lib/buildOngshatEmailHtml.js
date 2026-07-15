/**
 * Renders one Ong's Hat sequence item as an email body. The goal is
 * "photocopied document landing in your inbox," not "newsletter" --
 * so the three types look deliberately unlike each other, the way a
 * real found-document cache would: an official catalog excerpt doesn't
 * look like a stranger's private marginalia, and neither looks like a
 * scanned photograph.
 *
 * Three types:
 *   source -- real 2002 Matheny excerpt. Aged-paper card, small stamped
 *             number, CC footer.
 *   note   -- original investigator-note fragment. Typewriter face on
 *             a plain off-white field, no card, no border -- reads like
 *             something typed straight into a blank message, not designed.
 *   image  -- a scanned catalog/brochure page. Black field, no chrome,
 *             no subject-adjacent text at all -- the scan is the whole
 *             email.
 */

// Faint grain, applied only to the 'source' card, so those specifically
// read as a physical, xeroxed thing rather than clean digital text. Kept
// very subtle -- some mail clients (Outlook desktop) strip SVG data-URI
// backgrounds entirely, which is fine: it degrades to a plain paper
// color there, never to something broken.
const NOISE_BG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.035 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>";

const SOURCE_NOTE = `
  <p style="margin:26px 0 0;padding-top:12px;border-top:1px solid #c9c2ab;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8265;">
    Fragment from Incunabula: Ong's Hat by Joseph Matheny (2002), licensed CC BY-NC-ND 4.0.
    Full text: <a href="https://archive.org/details/OngsHatTheBeginningJosephMatheny" style="color:#8a8265;">archive.org</a>
  </p>`;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToParagraphs(text, style) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 15px;${style}">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function renderSource(item, total) {
  const bodyHtml = textToParagraphs(item.text, '');
  const stampNum = String(item.id + 1).padStart(3, '0');
  return `
  <div style="background:#e9e3d0;padding:34px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
      <tr>
        <td style="background-color:#f2ede0;background-image:url('${NOISE_BG}');padding:34px 32px;border:1px solid #cfc7ac;box-shadow:0 1px 0 #cfc7ac;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
            <tr>
              <td style="border:1px solid #96603f;color:#96603f;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.14em;padding:3px 7px;transform:rotate(-1deg);display:inline-block;">
                INCUNABULA &middot; ${stampNum}/${total}
              </td>
            </tr>
          </table>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.75;color:#26221a;">
            ${bodyHtml}
          </div>
          ${SOURCE_NOTE}
        </td>
      </tr>
    </table>
  </div>`;
}

function renderNote(item) {
  const bodyHtml = textToParagraphs(item.text, `font-family:'Courier New',monospace;`);
  return `
  <div style="background:#f6f5f2;padding:50px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr>
        <td style="border-left:2px solid #999;padding-left:18px;">
          <div style="font-family:'Courier New',monospace;font-size:14px;line-height:1.7;color:#3a3a3a;">
            ${bodyHtml}
          </div>
        </td>
      </tr>
    </table>
  </div>`;
}

function renderImage(item, siteUrl) {
  const imgUrl = `${siteUrl}/ongshat/${item.file}`;
  return `
  <div style="background:#0a0a0a;padding:26px 10px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;">
      <tr>
        <td style="text-align:center;">
          <img src="${imgUrl}" alt="" style="max-width:100%;height:auto;display:block;margin:0 auto;" />
        </td>
      </tr>
    </table>
  </div>`;
}

function buildOngshatEmailHtml({ item, siteUrl, total }) {
  if (item.type === 'image') return renderImage(item, siteUrl);
  if (item.type === 'note') return renderNote(item);
  return renderSource(item, total);
}

// Numbering is against the full text sequence (source + note items), not
// the combined schedule that also includes images -- so numbering stays
// meaningful even though images sit at their own separate positions.
// total is passed in by the caller (the count of source+note items in the
// current sequence) rather than hardcoded, since the sequence has grown
// past its original 103 items and may grow again.
function buildSubject(item, total) {
  if (item.type === 'source') return `INCUNABULA ${String(item.id + 1).padStart(3, '0')}/${total}`;
  return '.'; // notes and images both arrive bare, unexplained
}

module.exports = { buildOngshatEmailHtml, buildSubject };
