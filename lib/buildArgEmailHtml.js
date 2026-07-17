/**
 * Renders one ARG-of-the-Week entry as an email body.
 *
 * Unlike Ong's Hat (one continuous 2002 text, chunked) or Dionaea
 * (hard-wrapped found documents), each entry here is a complete,
 * independent researched piece -- markdown-lite source (## headers,
 * > blockquotes, [IMAGE -- caption: view at URL] markers, a trailing
 * link list) written for a chat surface, not for email. This module
 * is the translation layer between that source format and something
 * that actually renders as HTML mail.
 *
 * Each entry has one real, downloaded lead image (public/arg/<file>,
 * sourced from Wikipedia/Wikimedia Commons, public domain or
 * CC-BY-SA -- see renderLeadImage below, which adds the attribution
 * line those licenses call for) that renders as an actual <img> tag
 * right under the title, siteUrl-relative the same way Ong's Hat's
 * renderImage() does it.
 *
 * The [IMAGE] markers scattered through the BODY of each entry are a
 * separate thing: those point at article PAGES that contain a second
 * or third relevant photo, not direct hotlinkable image files -- there
 * was no reliable way to resolve every one of those to a real <img
 * src> target. Rather than fake a broken-image icon or silently drop
 * them, each renders as a small captioned reference card with a link
 * out to where that specific photo actually lives (see renderImage,
 * the block-level one, further down -- not to be confused with
 * renderLeadImage above it).
 *
 * Five visual "skins," picked by category, so the drip doesn't read
 * as one template with swapped text -- the same differentiation
 * principle as Ong's Hat's source/note/image/transcript split:
 *
 *   case-file    -- true-crime, mystery, maritime-mystery, unsolved-mystery
 *   terminal     -- arg, internet-mystery, unfiction, creepypasta, analog-horror
 *   parchment    -- occult, ufo, folklore
 *   declassified -- declassified, wwii
 *   clean-report -- hoax, science-mystery
 */

const SKIN_BY_CATEGORY = {
  'true-crime': 'case-file',
  'mystery': 'case-file',
  'maritime-mystery': 'case-file',
  'unsolved-mystery': 'case-file',
  'arg': 'terminal',
  'internet-mystery': 'terminal',
  'unfiction': 'terminal',
  'creepypasta': 'terminal',
  'analog-horror': 'terminal',
  'occult': 'parchment',
  'ufo': 'parchment',
  'folklore': 'parchment',
  'declassified': 'declassified',
  'wwii': 'declassified',
  'hoax': 'clean-report',
  'science-mystery': 'clean-report',
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Very small inline-markdown pass: **bold**, *italic*, bare URLs left alone. */
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

const IMAGE_RE = /^\[IMAGE\s*[—-]\s*(.+?):\s*view at\s+(\S+)(.*)\]$/i;
// Real, hotlinkable direct image -- actually renders as <img>, not a
// reference card. Source these from stable direct-file patterns:
// Wikimedia Commons' Special:FilePath/<filename> (redirects straight to
// the real upload.wikimedia.org bytes, no MD5 hash lookup needed) or
// archive.org's /download/<identifier>/<filename> pattern.
//   [IMG: <direct-url> | <caption>]
const IMG_RE = /^\[IMG:\s*(\S+)\s*\|\s*(.+)\]$/i;
// A real PDF/scanned-document artifact -- rendered as a document card
// (icon + caption) linking straight to the file, since PDFs can't be
// inlined in email the way images can.
//   [PDF: <url> | <caption>]
const PDF_RE = /^\[PDF:\s*(\S+)\s*\|\s*(.+)\]$/i;
// A real video -- rendered as a thumbnail-style card (since video can't
// autoplay or even embed in email at all) linking out to the actual
// clip.
//   [VIDEO: <url> | <caption>]
const VIDEO_RE = /^\[VIDEO:\s*(\S+)\s*\|\s*(.+)\]$/i;
// A real website screenshot -- same rendering as a real image, just
// its own marker so source data can be honest about what kind of
// artifact it is.
//   [SCREENSHOT: <direct-image-url> | <caption>]
const SCREENSHOT_RE = /^\[SCREENSHOT:\s*(\S+)\s*\|\s*(.+)\]$/i;
// A real image saved locally under public/arg/<file> (e.g. a photo the
// user uploaded directly, with no public hotlinkable URL) -- resolved
// against siteUrl at render time the same way Ong's Hat's local files
// are, since email needs an absolute URL, not a relative one.
//   [LOCALIMG: filename.jpg | caption]
const LOCALIMG_RE = /^\[LOCALIMG:\s*(\S+)\s*\|\s*(.+)\]$/i;
// Same idea for a PDF saved locally under public/arg/<file> -- e.g. a
// declassified document the user uploaded directly with no public URL.
//   [LOCALPDF: filename.pdf | caption]
const LOCALPDF_RE = /^\[LOCALPDF:\s*(\S+)\s*\|\s*(.+)\]$/i;

/**
 * Splits an entry's body into typed blocks: heading, quote, image,
 * links (the trailing "receipts" section, rendered specially), code
 * (fenced ``` blocks, used by exactly one entry for the Somerton Man
 * cipher), hr, and paragraph. Handles both the common "## Heading"
 * convention and the handful of entries written in the bold-label
 * "**HEADING**" dossier style (Iron Mountain, Phoenix Lights,
 * Amityville) -- a bare bolded-only line is treated as a heading too.
 */
function parseBlocks(body) {
  const lines = body.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }
    if (line.trim() === '---') { blocks.push({ type: 'hr' }); i++; continue; }

    if (/^#{1,3}\s+/.test(line)) {
      blocks.push({ type: 'heading', text: line.replace(/^#{1,3}\s+/, '').trim() });
      i++;
      continue;
    }

    // Bare "**Something**" as its own line (no other text) = heading,
    // dossier-style. Must not also start a bullet or blockquote.
    const boldOnly = line.trim().match(/^\*\*([^*]+)\*\*:?$/);
    if (boldOnly) {
      blocks.push({ type: 'heading', text: boldOnly[1].trim() });
      i++;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    const localPdfMatch = line.trim().match(LOCALPDF_RE);
    if (localPdfMatch) {
      blocks.push({ type: 'local-pdf', file: localPdfMatch[1].trim(), caption: localPdfMatch[2].trim() });
      i++;
      continue;
    }

    const localImgMatch = line.trim().match(LOCALIMG_RE);
    if (localImgMatch) {
      blocks.push({ type: 'local-img', file: localImgMatch[1].trim(), caption: localImgMatch[2].trim() });
      i++;
      continue;
    }

    const imgRealMatch = line.trim().match(IMG_RE);
    if (imgRealMatch) {
      blocks.push({ type: 'img-real', url: imgRealMatch[1].trim(), caption: imgRealMatch[2].trim() });
      i++;
      continue;
    }

    const pdfMatch = line.trim().match(PDF_RE);
    if (pdfMatch) {
      blocks.push({ type: 'pdf', url: pdfMatch[1].trim(), caption: pdfMatch[2].trim() });
      i++;
      continue;
    }

    const videoMatch = line.trim().match(VIDEO_RE);
    if (videoMatch) {
      blocks.push({ type: 'video', url: videoMatch[1].trim(), caption: videoMatch[2].trim() });
      i++;
      continue;
    }

    const screenshotMatch = line.trim().match(SCREENSHOT_RE);
    if (screenshotMatch) {
      blocks.push({ type: 'screenshot', url: screenshotMatch[1].trim(), caption: screenshotMatch[2].trim() });
      i++;
      continue;
    }

    const imgMatch = line.trim().match(IMAGE_RE);
    if (imgMatch) {
      blocks.push({ type: 'image', caption: imgMatch[1].trim(), url: imgMatch[2].trim() });
      i++;
      continue;
    }

    if (/^>\s?/.test(line.trim())) {
      const quoteLines = [];
      while (i < lines.length && (/^>\s?/.test(lines[i].trim()) || lines[i].trim() === '')) {
        if (lines[i].trim() === '') { i++; continue; }
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    // "## The receipts, actual URLs" bullet list, or bold-label
    // "**RECEIPTS, ACTUAL URLS:**" variant -- gather the following
    // "- url — note" lines as a links block instead of plain paragraphs.
    if (/^-\s+https?:\/\//.test(line.trim())) {
      const linkLines = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        linkLines.push(lines[i].trim().replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ type: 'links', lines: linkLines });
      continue;
    }

    // Ordinary paragraph -- collect contiguous non-blank, non-special lines.
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      lines[i].trim() !== '---' &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !lines[i].trim().match(/^\*\*([^*]+)\*\*:?$/) &&
      !lines[i].trim().startsWith('```') &&
      !IMAGE_RE.test(lines[i].trim()) &&
      !LOCALIMG_RE.test(lines[i].trim()) &&
      !LOCALPDF_RE.test(lines[i].trim()) &&
      !IMG_RE.test(lines[i].trim()) &&
      !PDF_RE.test(lines[i].trim()) &&
      !VIDEO_RE.test(lines[i].trim()) &&
      !SCREENSHOT_RE.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^-\s+https?:\/\//.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

// ---------------------------------------------------------------------
// Shared block renderers, parameterized by a small per-skin palette so
// the five skins don't have to duplicate all this logic.
// ---------------------------------------------------------------------

function renderQuote(block, palette) {
  const body = block.lines.map((l) => inline(l)).join('<br/>');
  return `<blockquote style="margin:18px 0;padding:12px 18px;border-left:3px solid ${palette.accent};background:${palette.quoteBg};font-family:${palette.serif};font-style:italic;font-size:15px;line-height:1.6;color:${palette.text};">${body}</blockquote>`;
}

function renderImage(block, palette) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="border:1px dashed ${palette.hairline};background:${palette.imgBg};padding:14px 16px;">
      <p style="margin:0;font-family:${palette.mono};font-size:11px;letter-spacing:0.08em;color:${palette.muted};text-transform:uppercase;">&#128247; image reference</p>
      <p style="margin:6px 0 0;font-family:${palette.serif};font-size:14px;color:${palette.text};">${inline(block.caption)}</p>
      <p style="margin:6px 0 0;"><a href="${escapeHtml(block.url)}" style="font-family:${palette.mono};font-size:12px;color:${palette.accent};">${escapeHtml(block.url)} &rarr;</a></p>
    </td></tr>
  </table>`;
}

/** A real, hotlinked image -- actually renders inline, full width. */
function renderImgReal(block, palette) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr><td style="text-align:center;">
      <img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption)}" style="max-width:100%;height:auto;display:block;margin:0 auto;border:1px solid ${palette.hairline};" />
      <p style="margin:8px 0 0;font-family:${palette.serif};font-size:12px;font-style:italic;color:${palette.muted};">${inline(block.caption)}</p>
    </td></tr>
  </table>`;
}

/** A real image with no public hotlinkable URL -- saved locally under
 * public/arg/<file> and resolved against siteUrl, same pattern as Ong's
 * Hat's local files. Renders identically to a real hotlinked image. */
function renderLocalImg(block, palette, siteUrl) {
  const src = `${siteUrl}/arg/${block.file}`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr><td style="text-align:center;">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(block.caption)}" style="max-width:100%;height:auto;display:block;margin:0 auto;border:1px solid ${palette.hairline};" />
      <p style="margin:8px 0 0;font-family:${palette.serif};font-size:12px;font-style:italic;color:${palette.muted};">${inline(block.caption)}</p>
    </td></tr>
  </table>`;
}

/** Same treatment as a real image -- a screenshot IS a photo of a screen. */
function renderScreenshot(block, palette) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr><td style="text-align:center;">
      <p style="margin:0 0 6px;font-family:${palette.mono};font-size:10px;letter-spacing:0.1em;color:${palette.muted};text-transform:uppercase;">&#128421; screenshot</p>
      <img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption)}" style="max-width:100%;height:auto;display:block;margin:0 auto;border:1px solid ${palette.hairline};" />
      <p style="margin:8px 0 0;font-family:${palette.serif};font-size:12px;font-style:italic;color:${palette.muted};">${inline(block.caption)}</p>
    </td></tr>
  </table>`;
}

/** A real PDF with no public URL -- saved locally under public/arg/<file>,
 * resolved against siteUrl. Same document-card styling as renderPdf. */
function renderLocalPdf(block, palette, siteUrl) {
  const src = `${siteUrl}/arg/${block.file}`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="border:1px solid ${palette.hairline};background:${palette.imgBg};padding:16px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:26px;padding-right:12px;vertical-align:middle;">&#128196;</td>
        <td style="vertical-align:middle;">
          <p style="margin:0;font-family:${palette.mono};font-size:10px;letter-spacing:0.1em;color:${palette.muted};text-transform:uppercase;">scanned document</p>
          <p style="margin:4px 0 0;font-family:${palette.serif};font-size:14px;color:${palette.text};">${inline(block.caption)}</p>
          <p style="margin:6px 0 0;"><a href="${escapeHtml(src)}" style="font-family:${palette.mono};font-size:12px;color:${palette.accent};">open the actual PDF &rarr;</a></p>
        </td>
      </tr></table>
    </td></tr>
  </table>`;
}

/** A real PDF/scanned document -- can't inline a PDF in email, so this
 * is a document card: icon, caption, direct link to the actual file. */
function renderPdf(block, palette) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="border:1px solid ${palette.hairline};background:${palette.imgBg};padding:16px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:26px;padding-right:12px;vertical-align:middle;">&#128196;</td>
        <td style="vertical-align:middle;">
          <p style="margin:0;font-family:${palette.mono};font-size:10px;letter-spacing:0.1em;color:${palette.muted};text-transform:uppercase;">scanned document</p>
          <p style="margin:4px 0 0;font-family:${palette.serif};font-size:14px;color:${palette.text};">${inline(block.caption)}</p>
          <p style="margin:6px 0 0;"><a href="${escapeHtml(block.url)}" style="font-family:${palette.mono};font-size:12px;color:${palette.accent};">open the actual PDF &rarr;</a></p>
        </td>
      </tr></table>
    </td></tr>
  </table>`;
}

/** A real video -- thumbnail-card styling, links out (email can't play
 * video). */
function renderVideo(block, palette) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="border:1px solid ${palette.hairline};background:#000;padding:0;position:relative;">
      <a href="${escapeHtml(block.url)}" style="display:block;text-decoration:none;padding:38px 18px;text-align:center;">
        <span style="display:inline-block;width:0;height:0;border-top:14px solid transparent;border-bottom:14px solid transparent;border-left:22px solid #ffffff;margin-bottom:10px;"></span>
        <p style="margin:0;font-family:${palette.serif};font-size:14px;color:#ffffff;">${inline(block.caption)}</p>
        <p style="margin:6px 0 0;font-family:${palette.mono};font-size:11px;color:#999;">&#9654; watch &rarr;</p>
      </a>
    </td></tr>
  </table>`;
}

function renderCode(block, palette) {
  return `<pre style="margin:16px 0;padding:14px 16px;background:${palette.codeBg};color:${palette.codeText};font-family:${palette.mono};font-size:13px;line-height:1.6;overflow-x:auto;white-space:pre-wrap;">${escapeHtml(block.text)}</pre>`;
}

function renderLinks(block, palette) {
  const items = block.lines.map((l) => {
    const m = l.match(/^(\S+)\s*(?:—|-)\s*(.*)$/);
    const url = m ? m[1] : l;
    const note = m ? m[2] : '';
    return `<li style="margin:0 0 8px;"><a href="${escapeHtml(url)}" style="color:${palette.accent};font-family:${palette.mono};font-size:12px;">${escapeHtml(url)}</a>${note ? `<br/><span style="font-family:${palette.serif};font-size:13px;color:${palette.muted};">${inline(note)}</span>` : ''}</li>`;
  }).join('');
  return `<p style="margin:26px 0 6px;font-family:${palette.mono};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${palette.muted};">Receipts</p><ul style="margin:0;padding-left:18px;">${items}</ul>`;
}

function renderBlocks(blocks, palette, siteUrl) {
  return blocks.map((b) => {
    if (b.type === 'heading') {
      if (/^receipts/i.test(b.text.trim())) return ''; // links block prints its own label
      return `<h2 style="margin:26px 0 10px;font-family:${palette.sans};font-size:14px;letter-spacing:0.06em;text-transform:uppercase;color:${palette.accent};">${inline(b.text)}</h2>`;
    }
    if (b.type === 'quote') return renderQuote(b, palette);
    if (b.type === 'image') return renderImage(b, palette);
    if (b.type === 'img-real') return renderImgReal(b, palette);
    if (b.type === 'local-img') return renderLocalImg(b, palette, siteUrl);
    if (b.type === 'local-pdf') return renderLocalPdf(b, palette, siteUrl);
    if (b.type === 'screenshot') return renderScreenshot(b, palette);
    if (b.type === 'pdf') return renderPdf(b, palette);
    if (b.type === 'video') return renderVideo(b, palette);
    if (b.type === 'code') return renderCode(b, palette);
    if (b.type === 'links') return renderLinks(b, palette);
    if (b.type === 'hr') return `<hr style="border:none;border-top:1px solid ${palette.hairline};margin:22px 0;"/>`;
    return `<p style="margin:0 0 15px;font-family:${palette.serif};font-size:15px;line-height:1.7;color:${palette.text};">${inline(b.text)}</p>`;
  }).join('');
}

/**
 * The real, downloaded lead image for this entry (public/arg/<file>,
 * sourced from Wikipedia/Wikimedia Commons -- public domain or
 * CC-BY-SA, hence the attribution line, same courtesy pattern as
 * buildOngshatEmailHtml.js's CC footer on 'source' items). siteUrl is
 * threaded through from the caller the same way Ong's Hat's renderImage
 * does it. If an entry has no image (shouldn't happen post-backfill,
 * but keep this defensive), renders nothing rather than a broken tag.
 */
function renderLeadImage(entry, siteUrl, palette) {
  if (!entry.image) return '';
  const src = `${siteUrl}/arg/${entry.image}`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
    <tr><td>
      <img src="${src}" alt="" style="max-width:100%;height:auto;display:block;border:1px solid ${palette.hairline};" />
      <p style="margin:6px 0 0;font-family:${palette.mono};font-size:10px;letter-spacing:0.06em;color:${palette.muted};">image via Wikimedia Commons / Wikipedia, public domain or CC BY-SA</p>
    </td></tr>
  </table>`;
}

// ---------------------------------------------------------------------
// Five skins. Each returns a full HTML string wrapping the shared
// block renderer in its own chrome (background, header stamp/label).
// ---------------------------------------------------------------------

const FONT_SERIF = "Georgia, 'Times New Roman', serif";
const FONT_SANS = "-apple-system, Helvetica, Arial, sans-serif";
const FONT_MONO = "'Courier New', ui-monospace, monospace";

function caseFile({ entry, id, total, siteUrl }) {
  const palette = {
    serif: FONT_SERIF, sans: FONT_SANS, mono: FONT_MONO,
    text: '#2a2620', muted: '#8a8265', accent: '#7a1f1f',
    hairline: '#c9c2ab', quoteBg: '#efe9d8', imgBg: '#f2ede0',
  };
  const blocks = parseBlocks(entry.body);
  return `
  <div style="background:#dfd9c4;padding:34px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
      <tr><td style="background:#f2ede0;padding:36px 34px;border:1px solid ${palette.hairline};">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
          <tr><td style="border:1px solid ${palette.accent};color:${palette.accent};font-family:${FONT_MONO};font-size:10px;letter-spacing:0.14em;padding:3px 8px;transform:rotate(-1deg);display:inline-block;">CASE FILE &middot; ${String(id).padStart(2, '0')}/${total}</td></tr>
        </table>
        <h1 style="margin:0 0 22px;font-family:${FONT_SERIF};font-size:24px;color:${palette.text};letter-spacing:0.01em;">${inline(entry.title)}</h1>
        ${renderLeadImage(entry, siteUrl, palette)}
        ${renderBlocks(blocks, palette, siteUrl)}
      </td></tr>
    </table>
  </div>`;
}

function terminal({ entry, id, total, siteUrl }) {
  const palette = {
    serif: FONT_MONO, sans: FONT_MONO, mono: FONT_MONO,
    text: '#c7f5c7', muted: '#5a8f5a', accent: '#5ad65a',
    hairline: '#2a3a2a', quoteBg: '#0d1a0d', imgBg: '#0d1410',
  };
  const blocks = parseBlocks(entry.body);
  return `
  <div style="background:#050805;padding:30px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
      <tr><td style="background:#0a100a;border:1px solid ${palette.hairline};padding:26px 26px 22px;">
        <p style="margin:0 0 16px;font-family:${FONT_MONO};font-size:11px;letter-spacing:0.1em;color:${palette.muted};">&#9679; ENTRY ${String(id).padStart(3, '0')}/${total} &nbsp; [unverified source]</p>
        <h1 style="margin:0 0 20px;font-family:${FONT_MONO};font-size:20px;color:${palette.accent};letter-spacing:0.02em;">${inline(entry.title)}</h1>
        ${renderLeadImage(entry, siteUrl, palette)}
        ${renderBlocks(blocks, palette, siteUrl)}
      </td></tr>
    </table>
  </div>`;
}

function parchment({ entry, id, total, siteUrl }) {
  const palette = {
    serif: FONT_SERIF, sans: FONT_SERIF, mono: FONT_MONO,
    text: '#3a2f22', muted: '#8a7355', accent: '#8a5a2a',
    hairline: '#d4c39a', quoteBg: '#f0e3c8', imgBg: '#f5ecd6',
  };
  const blocks = parseBlocks(entry.body);
  return `
  <div style="background:#e8dcbf;padding:36px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
      <tr><td style="background:#f7eeda;border:1px solid ${palette.hairline};padding:6px;">
        <div style="border:1px solid ${palette.hairline};padding:32px 30px;">
          <p style="margin:0 0 16px;text-align:center;font-family:${FONT_SERIF};font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${palette.muted};">Field Note ${id} of ${total}</p>
          <h1 style="margin:0 0 22px;text-align:center;font-family:${FONT_SERIF};font-size:22px;color:${palette.text};font-variant:small-caps;">${inline(entry.title)}</h1>
          ${renderLeadImage(entry, siteUrl, palette)}
          ${renderBlocks(blocks, palette, siteUrl)}
        </div>
      </td></tr>
    </table>
  </div>`;
}

function declassified({ entry, id, total, siteUrl }) {
  const palette = {
    serif: FONT_SERIF, sans: FONT_SANS, mono: FONT_MONO,
    text: '#1c1c1c', muted: '#666666', accent: '#7a1f1f',
    hairline: '#b8b8b0', quoteBg: '#e8e8e0', imgBg: '#ececE4',
  };
  const blocks = parseBlocks(entry.body);
  return `
  <div style="background:#c9c9be;padding:34px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
      <tr><td style="background:#e4e4dc;padding:32px 30px;border:1px solid ${palette.hairline};">
        <p style="margin:0 0 4px;font-family:${FONT_MONO};font-size:11px;letter-spacing:0.16em;color:${palette.accent};">&#9608;&#9608;&#9608; DECLASSIFIED &nbsp; ${String(id).padStart(2, '0')}/${total}</p>
        <h1 style="margin:14px 0 20px;font-family:${FONT_SANS};font-size:21px;color:${palette.text};text-transform:uppercase;letter-spacing:0.02em;">${inline(entry.title)}</h1>
        ${renderLeadImage(entry, siteUrl, palette)}
        ${renderBlocks(blocks, palette, siteUrl)}
      </td></tr>
    </table>
  </div>`;
}

function cleanReport({ entry, id, total, siteUrl }) {
  const palette = {
    serif: FONT_SERIF, sans: FONT_SANS, mono: FONT_MONO,
    text: '#1a1a1a', muted: '#6b6b6b', accent: '#2a5a8a',
    hairline: '#dedede', quoteBg: '#f4f4f4', imgBg: '#fafafa',
  };
  const blocks = parseBlocks(entry.body);
  return `
  <div style="background:#ffffff;padding:36px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
      <tr><td style="padding:0 6px;">
        <p style="margin:0 0 6px;font-family:${FONT_SANS};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${palette.muted};">Report ${id} / ${total}</p>
        <h1 style="margin:0 0 20px;font-family:${FONT_SERIF};font-size:23px;color:${palette.text};border-bottom:2px solid ${palette.text};padding-bottom:12px;">${inline(entry.title)}</h1>
        ${renderLeadImage(entry, siteUrl, palette)}
        ${renderBlocks(blocks, palette, siteUrl)}
      </td></tr>
    </table>
  </div>`;
}

const SKIN_RENDERERS = {
  'case-file': caseFile,
  'terminal': terminal,
  'parchment': parchment,
  'declassified': declassified,
  'clean-report': cleanReport,
};

function buildArgEmailHtml({ entry, total, siteUrl }) {
  const skinName = SKIN_BY_CATEGORY[entry.category] || 'case-file';
  const render = SKIN_RENDERERS[skinName];
  return render({ entry, id: entry.id, total, siteUrl });
}

function buildSubject(entry, total) {
  return `ARG of the Week #${entry.id}/${total}: ${entry.title}`;
}

module.exports = { buildArgEmailHtml, buildSubject, SKIN_BY_CATEGORY };
