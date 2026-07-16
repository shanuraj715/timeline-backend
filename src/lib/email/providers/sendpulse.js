// SendPulse's SMTP-via-API product needs an OAuth2 client-credentials token
// before every send — https://sendpulse.com/integrations/api/smtp. The
// token is cached in this closure (one per driver instance, itself cached
// by lib/email/index.js) and refetched a minute before its reported expiry
// rather than on every single send.
export function createSendpulseDriver({ clientId, clientSecret, fromEmail, fromName }) {
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

    const res = await fetch("https://api.sendpulse.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`SendPulse auth failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000;
    return cachedToken;
  }

  return {
    async send({ to, subject, html }) {
      const token = await getAccessToken();
      const res = await fetch("https://api.sendpulse.com/smtp/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: {
            html: Buffer.from(html, "utf8").toString("base64"),
            text: "",
            subject,
            from: { name: fromName || undefined, email: fromEmail },
            to: [{ email: to }],
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`SendPulse send failed (${res.status}): ${body.slice(0, 300)}`);
      }
    },
  };
}
