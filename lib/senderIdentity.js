/**
 * Computes a real "From" header so mail actually arrives as "Mark
 * Condry <...>" instead of a single shared sender for everything.
 *
 * The display name (what Gmail shows prominently in the inbox list) can
 * be anything -- but the address part has to be on a domain verified
 * with your email provider (Resend), because providers won't let you
 * send from an arbitrary unverified address. So: pick any domain you
 * own, verify it with Resend (their dashboard walks through the DNS
 * records), then set SENDING_DOMAIN to it. The local part (the bit
 * before the @) is auto-generated from the display name and doesn't
 * need to be a real mailbox -- nobody replies to these.
 *
 * Without SENDING_DOMAIN set, this returns null and callers fall back
 * to the single DIGEST_FROM_EMAIL sender -- which, if you're on
 * Resend's sandbox domain rather than a verified one of your own, is
 * where a generic "onboarding@resend.dev" sender comes from. Verifying
 * a domain is the one-time step that actually unlocks per-character
 * senders; this file can't do that part for you.
 */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // "Mark Condry (mobile)" -> "Mark Condry "
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40) || 'noreply';
}

function formatFrom(displayName, localPartHint) {
  const domain = process.env.SENDING_DOMAIN;
  if (!domain || !displayName) return null;
  const localPart = slugify(localPartHint || displayName);
  const safeName = String(displayName).replace(/"/g, "'");
  return `"${safeName}" <${localPart}@${domain}>`;
}

module.exports = { formatFrom };
