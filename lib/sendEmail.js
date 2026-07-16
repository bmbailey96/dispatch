async function sendEmail({ to, from, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const resolvedFrom = from || process.env.DIGEST_FROM_EMAIL;

  if (!apiKey) throw new Error('RESEND_API_KEY is not set.');
  if (!resolvedFrom) throw new Error('No from address available (pass one in, or set DIGEST_FROM_EMAIL).');
  if (!to) throw new Error('No recipient email set (DIONAEA_TO_EMAIL or DIGEST_TO_EMAIL).');

  // Locks the email to light mode explicitly — without this, some clients
  // (Gmail's mobile app especially) apply their own automatic dark-mode
  // color inversion on top of colors we already chose, producing broken
  // results (inverted text, wrong backgrounds) that have nothing to do
  // with the actual design.
  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin: 0; padding: 0; background: #ffffff; }
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${html}
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from: resolvedFrom, to, subject, html: fullHtml }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = { sendEmail };
