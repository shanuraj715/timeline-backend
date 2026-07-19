// The fixed catalog of email events. Adding a new one here means also
// adding the sendTemplatedEmail(key, ...) call at whatever code path
// actually triggers it — there's no admin UI to invent new keys, since a
// key with nothing wired to send it would just be dead configuration.
//
// Default subject/bodyHtml are seed content only (see bootstrap.js) — the
// admin can freely edit them afterward, this is just what a fresh install
// starts with. Inline styles throughout: email clients don't reliably
// support external/`<style>`-block CSS.

const CARD_OPEN = `<div style="max-width:480px;margin:0 auto;padding:32px 28px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f;">`;
const CARD_CLOSE = `<p style="margin-top:32px;font-size:12px;color:#6e6e73;">{site_name} &middot; {current_year}</p></div>`;

export const EVENT_KEYS = [
  {
    eventKey: "welcome",
    name: "Welcome email",
    description: "Sent right after a new account registers.",
    subject: "Welcome to {site_name}, {fname}!",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Welcome, {fname}!</h2>
<p>Your account (<strong>{email}</strong>) is ready. {site_name} is your private, timeless home for your family's photos and videos.</p>
<p><a href="{app_url}/dashboard" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0a84ff;color:#fff;border-radius:999px;text-decoration:none;">Go to your dashboard</a></p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "password_reset_otp",
    name: "Password reset code",
    description: "Sent when a user requests a password reset. Contains a one-time code.",
    subject: "Your {site_name} password reset code",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Reset your password</h2>
<p>Hi {fname}, use this code to reset your {site_name} password. It expires in {otp_expiry_minutes} minutes.</p>
<p style="font-size:32px;font-weight:600;letter-spacing:6px;text-align:center;margin:24px 0;">{otp_code}</p>
<p>If you didn't request this, you can safely ignore this email.</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "purchase_complete",
    name: "Purchase complete",
    description: "Sent when a credit purchase is successfully paid for.",
    subject: "Your {site_name} purchase is complete",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Thanks, {fname}!</h2>
<p>Your purchase of <strong>{plan_name}</strong> ({credits_purchased} credits) for {currency} {amount_paid} is complete.</p>
<p>Your account now has <strong>{total_credit} credits</strong>.</p>
<p style="font-size:12px;color:#6e6e73;">Order ID: {order_id}</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "credits_added",
    name: "Credits added",
    description: "Sent when a superadmin manually grants credits to an account.",
    subject: "{credits_amount} credits added to your account",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Credits added</h2>
<p>Hi {fname}, <strong>{credits_amount} credits</strong> were just added to your {site_name} account.</p>
<p>Your account now has <strong>{total_credit} credits</strong>.</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "invitation",
    name: "Timeline invitation",
    description: "Sent when someone is invited to join a timeline.",
    subject: "{inviter_name} invited you to a timeline on {site_name}",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">You've been invited</h2>
<p><strong>{inviter_name}</strong> invited you to join <strong>{timeline_title}</strong> (role: {invite_role}) on {site_name}.</p>
<p><a href="{invite_url}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0a84ff;color:#fff;border-radius:999px;text-decoration:none;">Accept invitation</a></p>
<p style="font-size:12px;color:#6e6e73;">This invitation expires in {invite_expiry_days} days.</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "account_locked",
    name: "Account locked",
    description: "Sent the moment a login's failed attempts trip a new lockout threshold.",
    subject: "Your {site_name} account was temporarily locked",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Account temporarily locked</h2>
<p>Hi {fname}, we locked your {site_name} account (<strong>{email}</strong>) after too many failed login attempts. It will unlock automatically in {lock_duration}.</p>
<p>If this wasn't you, consider resetting your password once it unlocks.</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "verify_email",
    name: "Verify your email",
    description: "Sent right after a password-based account registers, to confirm they own the email address.",
    subject: "Confirm your {site_name} email address",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Confirm your email</h2>
<p>Hi {fname}, please confirm that <strong>{email}</strong> is yours to finish setting up your {site_name} account.</p>
<p><a href="{verify_url}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0a84ff;color:#fff;border-radius:999px;text-decoration:none;">Confirm email address</a></p>
<p style="font-size:12px;color:#6e6e73;">This link expires in {verify_expiry_hours} hours. If you didn't create this account, you can safely ignore this email.</p>
${CARD_CLOSE}`,
  },
  {
    eventKey: "security_alert",
    name: "Security alert",
    description: "Sent when a sensitive account change happens (password changed or reset), as an out-of-band signal in case it wasn't the account owner.",
    subject: "Your {site_name} password was just changed",
    bodyHtml: `${CARD_OPEN}
<h2 style="margin:0 0 16px;">Your password was changed</h2>
<p>Hi {fname}, this confirms the password on your {site_name} account (<strong>{email}</strong>) was just changed{security_alert_context}. All other sessions were signed out.</p>
<p><strong>If you didn't make this change</strong>, reset your password immediately and contact support.</p>
${CARD_CLOSE}`,
  },
];

export const EVENT_KEY_VALUES = EVENT_KEYS.map((e) => e.eventKey);
