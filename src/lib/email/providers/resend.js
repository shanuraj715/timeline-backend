// Resend's Send Email API — a single authenticated POST, no SDK needed.
// https://resend.com/docs/api-reference/emails/send-email
export function createResendDriver({ apiKey, fromEmail, fromName }) {
  return {
    async send({ to, subject, html }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
          to: [to],
          subject,
          html,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Resend send failed (${res.status}): ${body.slice(0, 300)}`);
      }
    },
  };
}
