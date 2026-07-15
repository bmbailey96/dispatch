/**
 * Fetches one SCP Wiki page and extracts clean article content from it.
 * Deliberately conservative: strips the rating widget, any embedded
 * scripts/styles, and collapses everything down to plain paragraphs — this
 * content is going into an email, not a browser, so anything fancier than
 * <p>/<strong>/<em> won't render reliably anyway.
 */
async function fetchScpContent(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();

  const startMarker = 'id="page-content"';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Could not find page-content on ${url}`);

  // Find the matching close of this div by counting div depth from the
  // opening tag just before startMarker.
  const divOpenIdx = html.lastIndexOf('<div', startIdx);
  let depth = 0;
  let i = divOpenIdx;
  let endIdx = -1;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = divOpenIdx;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '') depth++;
    else depth--;
    if (depth === 0) {
      endIdx = m.index + m[0].length;
      break;
    }
  }
  if (endIdx === -1) throw new Error(`Could not find matching close div on ${url}`);

  let content = html.slice(divOpenIdx, endIdx);

  // Strip the rating widget block entirely — not useful in an email, and
  // it's raw interactive HTML (buttons, onclick handlers) that won't work
  // outside a browser anyway.
  content = content.replace(/<div class="page-rate-widget-box">[\s\S]*?<\/div><\/div>/, '');
  content = content.replace(/<div style="text-align: right;">\s*<\/div>/, '');

  // Strip any script/style blocks defensively.
  content = content.replace(/<script[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Collapsibles ("+ Show X" dropdowns): these can't function in an email —
  // there's no JavaScript to toggle them. Rather than lose the hidden
  // content entirely or leave dangling "Hide list" button text floating in
  // the paragraph, this always shows the content, with the original fold
  // label kept as a bold heading so you still get the section title (e.g.
  // "Addendum 3966-1") the way you would on the live page before clicking.
  //
  // Structure being unwound:
  //   <div class="collapsible-block">
  //     <div class="collapsible-block-folded"><a ...>LABEL</a></div>
  //     <div class="collapsible-block-unfolded" style="display:none">
  //       <div class="collapsible-block-unfolded-link"><a ...>Hide list</a></div>
  //       <div class="collapsible-block-content">CONTENT</div>
  //     </div>
  //   </div>
  content = content.replace(
    /<div class="collapsible-block-unfolded-link">[\s\S]*?<\/div>/g,
    ''
  );
  content = content.replace(
    /<div class="collapsible-block-folded">([\s\S]*?)<\/div>/g,
    (full, labelHtml) => {
      const labelText = labelHtml.replace(/<[^>]+>/g, '').trim();
      return labelText ? `<scplabel>${labelText}</scplabel>` : '';
    }
  );

  // Images: SCP pages wrap these as
  //   <div class="scp-image-block ..."><img src="..." alt="..." />
  //     <div class="scp-image-caption"><p>caption text</p></div>
  //   </div>
  // The source floats these left/right with a fixed width, which isn't
  // reliable in email clients — so this converts each one into a plain
  // centered block instead: image, then caption in small italic text
  // underneath. Pull src/alt out before the generic tag-stripping pass
  // below wipes all attributes, since that pass has no img-specific case.
  content = content.replace(
    /<div class="scp-image-block[^"]*"[^>]*>\s*<img([^>]*)\/?>\s*(?:<div class="scp-image-caption">([\s\S]*?)<\/div>)?\s*<\/div>/gi,
    (full, imgAttrs, captionHtml) => {
      const srcMatch = imgAttrs.match(/src="([^"]*)"/);
      const altMatch = imgAttrs.match(/alt="([^"]*)"/);
      const src = srcMatch ? srcMatch[1] : '';
      const alt = altMatch ? altMatch[1] : '';
      if (!src) return '';
      const captionText = captionHtml ? captionHtml.replace(/<[^>]+>/g, '').trim() : '';
      return (
        `<scpfig>` +
        `<img src="${src}" alt="${alt}" />` +
        (captionText ? `<scpcap>${captionText}</scpcap>` : '') +
        `</scpfig>`
      );
    }
  );

  // Keep only tags that are safe and meaningful in an email body.
  const allowedTags = ['p', 'strong', 'em', 'b', 'i', 'br', 'blockquote', 'hr', 'ul', 'ol', 'li', 'img', 'scpfig', 'scpcap', 'scplabel'];
  content = content.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (full, closing, tag, attrs) => {
    const lower = tag.toLowerCase();
    if (!allowedTags.includes(lower)) return '';
    if (lower === 'img') {
      const srcMatch = attrs.match(/src="([^"]*)"/);
      const altMatch = attrs.match(/alt="([^"]*)"/);
      const src = srcMatch ? srcMatch[1] : '';
      const alt = altMatch ? altMatch[1] : '';
      return `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`;
    }
    if (lower === 'scpfig') {
      return closing === '' ? `<div style="text-align:center;margin:16px 0;">` : `</div>`;
    }
    if (lower === 'scpcap') {
      return closing === ''
        ? `<p style="font-size:13px;font-style:italic;color:#555;margin:6px auto 0;max-width:90%;">`
        : `</p>`;
    }
    if (lower === 'scplabel') {
      // Renders as a bold line, same visual weight as "Testing Log:" or
      // "Addendum:" elsewhere in the article — this used to be a clickable
      // fold toggle; now it's just the heading for the content right below it.
      return closing === '' ? `<p style="margin:14px 0 4px;"><strong>` : `</strong></p>`;
    }
    if (lower === 'blockquote') {
      // Real boxed-log look (dashed border, faint background) matching how
      // Testing Logs / Interview Logs / Audio Logs render on the live wiki —
      // browser default blockquote styling (just an indent, no border) was
      // losing this entirely.
      return closing === ''
        ? `<blockquote style="border:1px dashed #999;padding:10px 16px;margin:14px 0;background:#f7f7f7;">`
        : `</blockquote>`;
    }
    // Drop attributes on everything else — we don't want inline
    // styles/classes/onclick surviving from the source.
    return `<${closing}${lower}>`;
  });

  // Collapse excessive whitespace left behind by stripped tags.
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  // Remove the prev/next article nav line (e.g. "« SCP-172 | SCP-173 | SCP-174 »")
  // and the licensing-guide boilerplate sentence — neither is article content,
  // and both survive the tag-stripping pass since they're bare text nodes.
  content = content.replace(/<p>\s*&#171;[\s\S]*?&#187;\s*<\/p>/g, '');
  content = content.replace(/‡(&nbsp;|\s)*Licensing(&nbsp;|\s)*\/(&nbsp;|\s)*Citation/gi, '');
  content = content.replace(/‡(&nbsp;|\s)*Hide(&nbsp;|\s)*Licensing(&nbsp;|\s)*\/(&nbsp;|\s)*Citation/gi, '');
  content = content.replace(/<p>For information on how to use this component[\s\S]*?<\/p>/gi, '');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return content;
}

module.exports = { fetchScpContent };
