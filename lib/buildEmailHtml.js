const COLORS = {
  bg: '#0a0a0a',
  paper: '#f4f1ea', // aged-paper tone for "document" types
  text: '#1a1a1a',
  muted: '#6b6b6b',
  accent: '#7a1f1f', // dried-blood red, used sparingly
  hairline: '#d8d3c4',
};
const FONT_DOC = "Georgia, 'Times New Roman', serif"; // emails, blogs, lj — reads like a real found document
const FONT_UI = "-apple-system, Helvetica, Arial, sans-serif"; // wrapper chrome
const FONT_MONO = "'Courier New', ui-monospace, monospace"; // AIM log, SMS

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Converts plain pasted text into paragraphs. Assumes plain text input (not HTML) — one blank line = new paragraph. Bare imgur.com links become an actual inline <img>, hotlinked directly to imgur's own server (the image itself never passes through anything generated here) — with the original link kept underneath as a fallback, since some of these may be gallery pages rather than single direct images, and that can't be verified from this environment (imgur is unreachable from here to check). */
function extractImgurId(url) {
  // Some URLs have a descriptive slug before the real ID, e.g.
  // ".../best-guess-its-from-philippenes-FSKwqdI" — the actual ID is
  // always the final hyphen-separated segment.
  const afterDomain = url.split('imgur.com/')[1] || '';
  const segments = afterDomain.split('-');
  return segments[segments.length - 1].replace(/[^a-zA-Z0-9]/g, '');
}

function linkifyImgur(escapedText) {
  return escapedText.replace(/(https?:\/\/(?:www\.)?imgur\.com\/\S+)/g, (url) => {
    const id = extractImgurId(url);
    const directUrl = `https://i.imgur.com/${id}.jpg`;
    return `
      <span style="display:block;margin:10px 0;">
        <img src="${directUrl}" alt="image" style="max-width:100%;height:auto;display:block;border:1px solid #999;" />
        <a href="${url}" style="display:inline-block;margin-top:4px;font-size:12px;color:#7a1f1f;text-decoration:none;">&#128247; view original on imgur &rarr;</a>
      </span>`;
  });
}

/**
 * Converts plain pasted text into paragraphs. Assumes plain text input
 * (not HTML) -- one blank line = new paragraph.
 *
 * The source .txt files are hard-wrapped at a fixed column (typed prose
 * with a real newline every ~60 characters, not just at paragraph
 * breaks) -- so single newlines *within* a paragraph get reflowed into
 * one continuous line here rather than preserved as forced <br/> breaks,
 * which is what was making paragraphs render as a choppy stack of
 * short, seemingly random line fragments.
 *
 * A paragraph block is treated as a quoted reply (something to make
 * visually distinct: italic, indented, a left rule) if ANY of its lines
 * start with "> ", even if the hard-wrap caused some continuation lines
 * within that same quote to lose the "> " prefix -- reflowing the whole
 * block together, instead of line by line, is what actually fixes that,
 * since it no longer matters which physical line the prefix landed on.
 */
const SENTENCE_END = /[.!?"'\u201d]\s*$/;

/**
 * These source files are hard-wrapped typed prose with a real newline
 * every ~60 characters and, in nearly all of them, zero blank lines
 * anywhere -- so there is no blank-line paragraph marker to split on at
 * all, and a quoted reply (a line starting with "> ") can have wrapped
 * continuation lines that lose the "> " prefix entirely (the "was" /
 * "usually" orphan-line problem). This walks the text line by line and
 * decides, line by line, whether it continues the current paragraph,
 * continues an in-progress quote, or starts something new -- rather
 * than relying on blank lines that mostly aren't there.
 *
 * Paragraph breaks are inferred from line length: a line ending in
 * terminal punctuation that's noticeably shorter than this file's own
 * typical wrapped-line length is treated as an intentional paragraph
 * end, since the hard-wrap would otherwise have kept filling the line.
 * This is a heuristic, not a certainty -- it won't be perfect on every
 * file, but it's a solid improvement over one giant undifferentiated
 * block or one line-break per typed line.
 */
function splitIntoBlocks(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const wrapWidth = Math.max(...lines.map((l) => l.length));
  const shortLineThreshold = wrapWidth * 0.72;

  const blocks = [];
  let current = null; // { isQuote, lines: [] }

  for (const rawLine of lines) {
    const startsWithQuote = /^>/.test(rawLine);
    const content = rawLine.replace(/^>\s?/, '');

    if (startsWithQuote) {
      if (!current || !current.isQuote) {
        if (current) blocks.push(current);
        current = { isQuote: true, lines: [] };
      }
      current.lines.push(content);
      continue;
    }

    // Not prefixed with ">" -- either a quote wrap-continuation, or
    // ordinary prose.
    if (current && current.isQuote) {
      const soFar = current.lines.join(' ');
      if (!SENTENCE_END.test(soFar)) {
        // Quote's last sentence isn't finished yet -- this line is the
        // orphaned continuation of it, prefix or no prefix.
        current.lines.push(content);
        continue;
      }
      // Quote had already completed a full sentence -- this line is the
      // start of ordinary prose resuming after the quote.
      blocks.push(current);
      current = { isQuote: false, lines: [content] };
      continue;
    }

    if (!current) {
      current = { isQuote: false, lines: [content] };
      continue;
    }

    // Ordinary prose: does the previous line look like it ended a
    // paragraph (short + terminal punctuation), or is this a wrap
    // continuation of the same paragraph?
    const prevLine = current.lines[current.lines.length - 1];
    const prevLooksLikeParagraphEnd = SENTENCE_END.test(prevLine) && prevLine.length < shortLineThreshold;
    if (prevLooksLikeParagraphEnd) {
      blocks.push(current);
      current = { isQuote: false, lines: [content] };
    } else {
      current.lines.push(content);
    }
  }
  if (current) blocks.push(current);

  return blocks;
}

function textToParagraphs(text) {
  // A bare "***" line marks an inserted physical clipping (only used in
  // one file) -- keep it as its own paragraph-level divider.
  const withDividers = text.replace(/\n\*\*\*\n/g, '\n\n***\n\n');
  const rawBlocks = withDividers.trim().split(/\n\s*\n/);

  const htmlBlocks = [];
  for (const rawBlock of rawBlocks) {
    if (rawBlock.trim() === '***') {
      htmlBlocks.push(`<p style="margin:0 0 14px;border-top:1px solid #ccc;"></p>`);
      continue;
    }
    for (const block of splitIntoBlocks(rawBlock)) {
      const joined = block.lines.join(' ').replace(/\s+/g, ' ').trim();
      if (!joined) continue;
      const escaped = linkifyImgur(escapeHtml(joined));
      if (block.isQuote) {
        htmlBlocks.push(`<p style="margin:0 0 14px;padding-left:14px;border-left:2px solid #ccc;font-style:italic;color:#555;">${escaped}</p>`);
      } else {
        htmlBlocks.push(`<p style="margin:0 0 14px;">${escaped}</p>`);
      }
    }
  }
  return htmlBlocks.join('');
}

// Shown at the very top of every single email, same spot, every time —
// answers "what kind of thing is this" before you even read the sender.
const TYPE_LABELS = {
  'email': 'EMAIL',
  'sms-single': 'TEXT MESSAGE',
  'sms-burst': 'TEXT MESSAGES',
  'comment': 'BLOG COMMENT',
  'lj': 'LIVEJOURNAL ENTRY',
  'blog': 'BLOG POST',
  'aimlog': 'RECOVERED CHAT LOG',
  'bounce': 'UNDELIVERABLE MAIL NOTICE',
  'update-log': 'SITE UPDATE',
  'site-frontpage': 'WEBSITE',
  'epilogue-original': 'FORUM POST',
};

function wrapShell({ innerHtml, item }) {
  const typeLabel = TYPE_LABELS[item.type] || '';
  const senderLine = item.sender ? escapeHtml(item.sender) : '';
  return `
  <div style="background:#ffffff;padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:${FONT_UI};">
      <tr>
        <td style="padding-bottom:6px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#222;border:1px solid #444;border-radius:3px;padding:3px 8px;">
                <span style="font-family:${FONT_MONO};font-size:11px;letter-spacing:0.08em;color:#9dd6c4;">${typeLabel}</span>
              </td>
              ${senderLine ? `<td style="padding-left:8px;"><span style="font-family:${FONT_UI};font-size:12px;color:#999;">${senderLine}</span></td>` : ''}
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:16px;">
          <p style="margin:0;font-size:11px;letter-spacing:0.12em;color:#666;text-transform:uppercase;">Dionaea House &mdash; Part ${item.partTitle ? '' : ''}${item.partTitle || ''}</p>
        </td>
      </tr>
      <tr><td>${innerHtml}</td></tr>
      <tr>
        <td style="padding-top:18px;">
          <p style="margin:0;font-size:11px;color:#555;">${new Date(item.realDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </td>
      </tr>
    </table>
  </div>`;
}

/**
 * Parses raw SMS content (one or more messages, each with its own
 * "from:/date:/subject:" header block from how these were originally
 * captured as emails) into {timestamp, body} pairs, discarding the
 * header noise so only the timestamp and actual text survive.
 */
function parseSmsMessages(text) {
  const blocks = text.trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const dateMatch = block.match(/date:\s*\w+,\s*(\w+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      // The header wraps across two physical lines ("from: ... | date:
      // Tuesday," then "September 21, 2004 4:14 PM | subject: ..."). A
      // per-line filter missed the continuation line since it doesn't
      // itself start with "date:" or "subject:" — strip the whole
      // from:...subject:... span as one unit instead, whatever it spans.
      const body = block.replace(/from:[\s\S]*?subject:[^\n]*\n?/i, '').trim();
      return {
        timestamp: dateMatch ? dateMatch[1] : null,
        body: body.replace(/\n/g, ' ').trim(),
      };
    })
    .filter((m) => m.body);
}

function renderSmsBubbles(messages) {
  return messages
    .map(
      (m) => `
      <div style="margin:0 0 14px;text-align:right;">
        ${m.timestamp ? `<p style="margin:0 0 3px;font-family:${FONT_UI};font-size:10px;color:#666;">${escapeHtml(m.timestamp)}</p>` : ''}
        <div style="display:inline-block;max-width:80%;background:#0b5c3f;color:#e8fff3;border-radius:14px 14px 2px 14px;padding:8px 14px;font-family:${FONT_UI};font-size:14px;line-height:1.4;text-align:left;">
          ${escapeHtml(m.body)}
        </div>
      </div>`
    )
    .join('');
}

/**
 * Parses an AIM chat log into its header/intro lines plus a sequence of
 * {speaker, line} messages, assigning each distinct speaker a consistent
 * color (cycling through a small palette) the way real AIM clients
 * color-coded each buddy in a conversation.
 */
const AIM_PALETTE = ['#cc0000', '#0000cc', '#008000', '#800080'];

function parseAimLog(text) {
  const lines = text.split('\n');
  const introLines = [];
  const messages = [];
  let pastIntro = false;

  for (const line of lines) {
    const msgMatch = line.match(/^(\w+):\s?(.*)$/);
    if (msgMatch && !/^Session Start/i.test(line)) {
      pastIntro = true;
      messages.push({ speaker: msgMatch[1], line: msgMatch[2] });
    } else if (!pastIntro) {
      if (line.trim()) introLines.push(line.trim());
    }
  }

  const speakerColors = {};
  let colorIdx = 0;
  for (const m of messages) {
    if (!(m.speaker in speakerColors)) {
      speakerColors[m.speaker] = AIM_PALETTE[colorIdx % AIM_PALETTE.length];
      colorIdx++;
    }
  }

  return { introLines, messages, speakerColors };
}

function renderAimLog({ introLines, messages, speakerColors }) {
  const messagesHtml = messages
    .map(
      (m) => `
      <p style="margin:0 0 8px;font-family:${FONT_UI};font-size:13px;line-height:1.5;">
        <span style="color:${speakerColors[m.speaker]};font-weight:bold;">${escapeHtml(m.speaker)}:</span>
        <span style="color:#000;">${escapeHtml(m.line)}</span>
      </p>`
    )
    .join('');

  // introLines held the "AIM Chatlog: ..." title and the "Session Start:
  // ..." timestamp — the title is redundant with the type badge shown
  // above this window already, but the session timestamp is real,
  // otherwise-unshown information and shouldn't just vanish.
  const sessionLine = introLines.find((l) => /^Session Start/i.test(l));
  const sessionHtml = sessionLine
    ? `<p style="text-align:center;font-family:${FONT_UI};font-size:11px;color:#888;font-style:italic;margin:0 0 10px;">${escapeHtml(sessionLine)}</p>`
    : '';

  // Real Windows-XP-era IM window chrome: blue gradient title bar with fake
  // window controls, gray body, a toolbar row at the bottom echoing AIM's
  // real Warn/Block/Add Buddy/Talk/Get Info/Send buttons (decorative only —
  // this is a recreation of the LOOK, not a real screenshot).
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #0a3d7a;border-radius:4px 4px 0 0;overflow:hidden;">
      <tr>
        <td style="background:#0a5bc4;background:linear-gradient(#3d8ef7,#0a5bc4);padding:4px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-family:${FONT_UI};font-size:12px;font-weight:bold;color:#fff;">Instant Message</td>
              <td style="text-align:right;">
                <span style="display:inline-block;width:14px;height:14px;background:#dce7f5;border:1px solid #06356b;border-radius:2px;margin-left:3px;font-size:9px;line-height:13px;color:#333;">_</span>
                <span style="display:inline-block;width:14px;height:14px;background:#dce7f5;border:1px solid #06356b;border-radius:2px;margin-left:3px;font-size:9px;line-height:13px;color:#333;">&#9633;</span>
                <span style="display:inline-block;width:14px;height:14px;background:#e5504a;border:1px solid #06356b;border-radius:2px;margin-left:3px;font-size:9px;line-height:13px;color:#fff;">&times;</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="background:#dfe8f5;padding:4px 8px;font-family:${FONT_UI};font-size:11px;color:#333;border-bottom:1px solid #a8bcd8;">
          File &nbsp; Edit &nbsp; Insert &nbsp; People
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:14px 16px;">
          <p style="font-family:${FONT_UI};font-size:11px;color:#888;margin:0 0 10px;border-bottom:1px solid #ddd;padding-bottom:8px;">
            Recovered from Diane M.'s father's PC. Converted to HTML by Eric Heisserer, screen name numbers removed. Original session: February 10, 1999.
          </p>
          ${sessionHtml}
          ${messagesHtml}
        </td>
      </tr>
      <tr>
        <td style="background:#dfe8f5;padding:6px 8px;border-top:1px solid #a8bcd8;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            ${['Warn', 'Block', 'Add Buddy', 'Talk', 'Get Info', 'Send'].map((label) => `
              <td style="padding-right:4px;">
                <span style="display:inline-block;background:#eef3fa;border:1px solid #9fb6d9;border-radius:3px;padding:3px 7px;font-family:${FONT_UI};font-size:10px;color:#333;">${label}</span>
              </td>`).join('')}
          </tr></table>
        </td>
      </tr>
    </table>`;
}

/** Pulls "current mood:"/"current music:" lines out of the end of an LJ entry so they can get their own small footer treatment instead of blending into body paragraphs. */
function extractLjFooter(text) {
  const moodMatch = text.match(/current mood:\s*(.+)/i);
  const musicMatch = text.match(/current music:\s*(.+)/i);
  const withoutFooter = text.replace(/current mood:.*/i, '').replace(/current music:.*/i, '').trim();
  return {
    body: withoutFooter,
    mood: moodMatch ? moodMatch[1].trim() : null,
    music: musicMatch ? musicMatch[1].trim() : null,
  };
}

/** Parses the r/subreddit, date, and username: lines already present at the top of the 2014 post content, separating them from the actual post body. */
function parseRedditPost(text) {
  const lines = text.split('\n');
  let subreddit = null;
  let username = null;
  let lastHeaderLineIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const l = lines[i].trim();
    if (/^r\//.test(l)) {
      subreddit = l;
      lastHeaderLineIdx = i;
    }
    const uMatch = l.match(/^username:\s*(.+)/i);
    if (uMatch) {
      username = uMatch[1].trim();
      lastHeaderLineIdx = i;
    }
    // A plain date line ("October 2014") between the header fields doesn't
    // match either pattern but still needs to count as part of the header,
    // not the start of the body — only stop extending once neither pattern
    // matches AND we've already found at least one header field, and this
    // line looks like body text rather than another header line.
    if (lastHeaderLineIdx === i - 1 && !/^r\//.test(l) && !uMatch && lastHeaderLineIdx !== -1 && /^\w+\s+\d{4}$/.test(l)) {
      lastHeaderLineIdx = i; // e.g. "October 2014"
    }
  }
  const bodyStartIdx = lastHeaderLineIdx + 1;
  const body = lines.slice(bodyStartIdx).join('\n').trim();
  return { subreddit, username, body };
}

function renderRedditPost({ subreddit, username, body, subject }) {
  const bodyHtml = textToParagraphs(body);
  const metaLine =
    subreddit || username
      ? `<p style="margin:0 0 6px;font-family:${FONT_UI};font-size:12px;color:#787c7e;">
          ${subreddit ? `<strong style="color:#1a1a1b;">${escapeHtml(subreddit)}</strong>${username ? ' &middot; ' : ''}` : ''}${username ? `Posted by u/${escapeHtml(username)}` : ''}
        </p>`
      : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #ccc;border-radius:4px;">
      <tr>
        <td style="width:36px;background:#f8f9fa;border-right:1px solid #eee;vertical-align:top;padding:14px 0 0;text-align:center;">
          <div style="width:0;height:0;margin:0 auto;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:14px solid #ff4500;"></div>
        </td>
        <td style="padding:14px 18px;">
          ${metaLine}
          <p style="margin:0 0 12px;font-family:${FONT_UI};font-size:19px;font-weight:600;color:#222;line-height:1.3;">${escapeHtml(subject)}</p>
          <div style="font-family:${FONT_UI};font-size:14px;line-height:1.6;color:#1a1a1b;">
            ${bodyHtml}
          </div>
        </td>
      </tr>
    </table>`;
}

/** Recreates a real Outlook-Express-era email window: gray toolbar with icon buttons, then a From/Date/To/Subject header table, then the message body. This is a CSS recreation of the period chrome, not a screenshot. */
function renderEmailWindow({ from, date, subject, bodyHtml }) {
  const toolbarButtons = ['Reply', 'Reply All', 'Forward', 'Print', 'Delete'];
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #8c8c8c;">
      <tr>
        <td style="background:#ece9d8;padding:6px 8px;border-bottom:1px solid #b8b8a8;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            ${toolbarButtons.map((label) => `
              <td style="padding-right:4px;">
                <span style="display:inline-block;background:#f5f4ee;border:1px solid #ababab;border-radius:2px;padding:3px 8px;font-family:${FONT_UI};font-size:10px;color:#333;">${label}</span>
              </td>`).join('')}
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="background:#f5f4ee;padding:10px 12px;">
          <table role="presentation" width="100%" cellpadding="2" cellspacing="0" style="font-family:${FONT_UI};font-size:12px;color:#000;">
            <tr><td style="width:55px;color:#555;">From:</td><td>${escapeHtml(from)}</td></tr>
            <tr><td style="color:#555;">Date:</td><td>${escapeHtml(date)}</td></tr>
            <tr><td style="color:#555;">Subject:</td><td style="background:#dbe8fb;">${escapeHtml(subject)}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:16px 18px;border-top:1px solid #ddd;">
          <div style="font-family:${FONT_UI};font-size:14px;line-height:1.55;color:#111;">
            ${bodyHtml}
          </div>
        </td>
      </tr>
    </table>`;
}

/** Extracts the real from:/date:/subject: lines directly from the email content (more accurate than schedule metadata for some early items) and strips them from the body so they don't show up twice. */
function parseEmailHeader(text) {
  const fromMatch = text.match(/^from:\s*(.+)$/im);
  const dateMatch = text.match(/^date:\s*(.+)$/im);
  const subjectMatch = text.match(/^subject:\s*(.+)$/im);
  const body = text.replace(/^from:.*$/im, '').replace(/^date:.*$/im, '').replace(/^subject:.*$/im, '').trim();
  return {
    from: fromMatch ? fromMatch[1].replace(/[""]/g, '') : null,
    date: dateMatch ? dateMatch[1] : null,
    subject: subjectMatch ? subjectMatch[1] : null,
    body,
  };
}

/** A real mail-bounce notice looks nothing like a found document — stark monospace, no styling, like a broken automated system message. */
function renderBounceNotice(content, subject) {
  // Strip the from:/date:/subject: header before display — it's already
  // shown in the styled header above, so leaving it in raw would duplicate
  // it (same issue the email renderer had, fixed the same way here).
  const stripped = content
    .replace(/^from:.*$/im, '')
    .replace(/^date:.*$/im, '')
    .replace(/^subject:.*$/im, '')
    .trim();
  const escaped = escapeHtml(stripped).replace(/\n/g, '<br/>');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #999;">
      <tr>
        <td style="background:#f0f0f0;padding:8px 12px;border-bottom:1px solid #999;font-family:${FONT_MONO};font-size:12px;color:#000;">
          <strong>Mail Delivery Subsystem</strong><br/>
          <span style="color:#555;">Subject: ${escapeHtml(subject)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 14px;font-family:${FONT_MONO};font-size:12px;line-height:1.6;color:#111;">
          ${escaped}
        </td>
      </tr>
    </table>`;
}

/** Recreates LiveJournal's actual period branding — purple/orange top bar, the site's real color scheme — rather than reusing the same generic card as everything else. */
function renderLiveJournal({ username, subject, bodyHtml, footer }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #6b3fa0;">
      <tr>
        <td style="background:#6b3fa0;padding:8px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:${FONT_UI};font-size:15px;font-weight:bold;color:#fff;">LiveJournal<span style="color:#ff9933;">.com</span></td>
            <td style="text-align:right;font-family:${FONT_UI};font-size:11px;color:#e2d2f5;">username: ${escapeHtml(username)}</td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="background:#ff9933;height:4px;line-height:4px;font-size:1px;">&nbsp;</td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:18px 20px;">
          <p style="font-family:${FONT_DOC};font-size:19px;font-weight:bold;color:#4a2372;margin:0 0 12px;border-bottom:2px solid #eee0f7;padding-bottom:8px;">${escapeHtml(subject)}</p>
          <div style="font-family:${FONT_UI};font-size:14px;line-height:1.6;color:#222;">
            ${bodyHtml}
          </div>
          ${footer}
        </td>
      </tr>
    </table>`;
}

/** Blogger circa 2004 was deliberately austere — plain white template, black serif text, no color scheme to speak of. That plainness IS its identity, distinct from LiveJournal's colorful branding. */
function renderBlogspot({ subject, bodyHtml, dateStr }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d5d5d5;">
      <tr>
        <td style="padding:4px 0;background:#f2f2f2;border-bottom:1px solid #d5d5d5;text-align:center;">
          <span style="font-family:${FONT_UI};font-size:11px;color:#666;">dionaeahouse.blogspot.com</span>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 22px;">
          <p style="font-family:'Times New Roman',Georgia,serif;font-size:20px;font-weight:bold;color:#000;margin:0 0 4px;">${escapeHtml(subject)}</p>
          <p style="font-family:${FONT_UI};font-size:11px;color:#999;margin:0 0 14px;">${escapeHtml(dateStr)}</p>
          <div style="font-family:'Times New Roman',Georgia,serif;font-size:15px;line-height:1.6;color:#000;">
            ${bodyHtml}
          </div>
          <p style="font-family:${FONT_UI};font-size:11px;color:#999;margin:16px 0 0;border-top:1px solid #eee;padding-top:8px;">posted by Eric Heisserer</p>
        </td>
      </tr>
    </table>`;
}

/** A blog comment isn't its own page — it's a small box attached underneath a post. Recreated as exactly that: a greyed-out echo of the post it's replying to, then the actual comment in Blogger's real comment-box style, with something visually off about it (the reader already knows this voice doesn't belong here). */
function renderBlogComment({ postTitle, commentAuthor, timestamp, bodyHtml }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:10px 14px;background:#f7f7f7;border:1px solid #ddd;border-bottom:none;opacity:0.55;">
          <p style="margin:0;font-family:'Times New Roman',Georgia,serif;font-size:13px;color:#555;">Comment on: <em>${escapeHtml(postTitle)}</em></p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 16px;background:#fff8f8;border:1px solid ${COLORS.accent};">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:28px;vertical-align:top;">
              <div style="width:20px;height:20px;background:#ccc;border-radius:2px;"></div>
            </td>
            <td>
              <p style="margin:0 0 6px;font-family:${FONT_UI};font-size:12px;color:${COLORS.accent};">
                <strong>${escapeHtml(commentAuthor)}</strong> said... <span style="color:#999;font-weight:normal;">${escapeHtml(timestamp)}</span>
              </p>
              <div style="font-family:${FONT_UI};font-size:14px;line-height:1.5;color:#222;">
                ${bodyHtml}
              </div>
            </td>
          </tr></table>
        </td>
      </tr>
    </table>`;
}

/** Eric's running updates log — not a blog, not a diary, just a plain dated list he adds to as things happen. Deliberately more utilitarian than either LiveJournal or Blogspot. */
function renderUpdateLog({ dateStr, bodyHtml }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdfdf8;border:1px solid #ccc;">
      <tr>
        <td style="background:#e8e4d8;padding:6px 12px;border-bottom:1px solid #ccc;">
          <span style="font-family:${FONT_MONO};font-size:11px;color:#555;">dionaea-house.com/updates.htm</span>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 16px;">
          <p style="font-family:${FONT_MONO};font-size:13px;font-weight:bold;color:#333;margin:0 0 10px;border-bottom:1px dotted #aaa;padding-bottom:6px;">${escapeHtml(dateStr)}</p>
          <div style="font-family:'Courier New',monospace;font-size:13px;line-height:1.6;color:#111;">
            ${bodyHtml}
          </div>
        </td>
      </tr>
    </table>`;
}

/** The actual dionaea-house.com front page — a plain, hand-coded early-2000s personal site, not a stylized "found document." Times New Roman, simple table borders, a basic centered title. */
function renderSiteFrontpage({ bodyHtml }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:2px solid #4a4a6a;">
      <tr>
        <td style="background:#4a4a6a;padding:10px;text-align:center;">
          <span style="font-family:'Times New Roman',Georgia,serif;font-size:18px;color:#fff;letter-spacing:1px;">dionaea-house.com</span>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-family:'Times New Roman',Georgia,serif;font-size:15px;line-height:1.6;color:#000;">
            ${bodyHtml}
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:6px;text-align:center;background:#f0f0f0;border-top:1px solid #ccc;">
          <span style="font-family:${FONT_UI};font-size:10px;color:#888;">best viewed at 800x600</span>
        </td>
      </tr>
    </table>`;
}

function buildDocumentCard({ headerHtml, bodyHtml }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.paper};border:1px solid ${COLORS.hairline};">
      <tr>
        <td style="padding:20px 24px;">
          ${headerHtml}
          <div style="font-family:${FONT_DOC};font-size:15px;line-height:1.6;color:${COLORS.text};">
            ${bodyHtml}
          </div>
        </td>
      </tr>
    </table>`;
}

function buildEmailHtml({ item, content, absenceNote }) {
  let inner;

  if (absenceNote) {
    // The most important visual moment in the whole project — this should
    // feel like almost nothing, on purpose. Mostly empty space.
    inner = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:60px 20px;text-align:center;">
            <p style="font-family:${FONT_MONO};font-size:13px;color:#444;letter-spacing:0.05em;margin:0 0 20px;">— nothing arrived today —</p>
            <p style="font-family:${FONT_DOC};font-size:14px;line-height:1.7;color:#999;font-style:italic;max-width:420px;margin:0 auto;">${escapeHtml(absenceNote)}</p>
          </td>
        </tr>
      </table>`;
    return wrapShell({ innerHtml: inner, item });
  }

  const bodyHtml = textToParagraphs(content);

  switch (item.type) {
    case 'email': {
      const parsed = parseEmailHeader(content);
      const emailBodyHtml = textToParagraphs(parsed.body);
      inner = renderEmailWindow({
        from: parsed.from || item.sender,
        date: parsed.date || new Date(item.realDate).toLocaleString('en-US'),
        subject: parsed.subject || item.subject,
        bodyHtml: emailBodyHtml,
      });
      break;
    }
    case 'sms-single':
    case 'sms-burst': {
      const messages = parseSmsMessages(content);
      inner = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};">
          <tr><td style="padding:16px 10px;">
            ${renderSmsBubbles(messages)}
          </td></tr>
        </table>`;
      break;
    }
    case 'comment': {
      inner = renderBlogComment({
        postTitle: 'Early Start',
        commentAuthor: item.sender,
        timestamp: new Date(item.realDate).toLocaleString('en-US', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        bodyHtml,
      });
      break;
    }
    case 'lj': {
      const { body: ljBody, mood, music } = extractLjFooter(content);
      const ljBodyHtml = textToParagraphs(ljBody);
      const footer =
        mood || music
          ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee0f7;">
              ${mood ? `<p style="margin:0;font-family:${FONT_UI};font-size:12px;font-style:italic;color:#888;">current mood: ${escapeHtml(mood)}</p>` : ''}
              ${music ? `<p style="margin:2px 0 0;font-family:${FONT_UI};font-size:12px;font-style:italic;color:#888;">current music: ${escapeHtml(music)}</p>` : ''}
            </div>`
          : '';
      inner = renderLiveJournal({
        username: item.sender,
        subject: item.subject,
        bodyHtml: ljBodyHtml,
        footer,
      });
      break;
    }
    case 'blog': {
      inner = renderBlogspot({
        subject: item.subject,
        bodyHtml,
        dateStr: new Date(item.realDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      });
      break;
    }
    case 'aimlog': {
      inner = renderAimLog(parseAimLog(content));
      break;
    }
    case 'bounce': {
      inner = renderBounceNotice(content, item.subject);
      break;
    }
    case 'update-log': {
      inner = renderUpdateLog({
        dateStr: new Date(item.realDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        bodyHtml,
      });
      break;
    }
    case 'epilogue-original': {
      const parsed = parseRedditPost(content);
      inner = renderRedditPost({ ...parsed, subject: item.subject });
      break;
    }
    case 'site-frontpage':
    default: {
      inner = renderSiteFrontpage({ bodyHtml });
      break;
    }
  }

  return wrapShell({ innerHtml: inner, item });
}

module.exports = { buildEmailHtml };
