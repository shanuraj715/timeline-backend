import nodemailer from "nodemailer";

// Generic SMTP — the catch-all for any provider without a dedicated driver
// above (Mailgun, Postmark, Gmail, Amazon SES's SMTP interface, a
// self-hosted relay, etc). The transporter is created once per driver
// instance (itself cached by lib/email/index.js) rather than per send.
export function createSmtpDriver({ host, port, secure, username, password, fromEmail, fromName }) {
  const transporter = nodemailer.createTransport({
    host,
    port: Number(port) || 587,
    secure: Boolean(secure),
    auth: username || password ? { user: username, pass: password } : undefined,
  });

  return {
    async send({ to, subject, html }) {
      await transporter.sendMail({
        from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
        to,
        subject,
        html,
      });
    },
  };
}
