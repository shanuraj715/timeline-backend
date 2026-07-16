// SendGrid's v3 Mail Send API — a single authenticated POST, no SDK needed.
// https://docs.sendgrid.com/api-reference/mail-send/mail-send
export function createSendgridDriver({ apiKey, fromEmail, fromName }) {
  return {
    async send({ to, subject, html }) {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: fromName || undefined },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`SendGrid send failed (${res.status}): ${body.slice(0, 300)}`);
      }
    },
  };
}
