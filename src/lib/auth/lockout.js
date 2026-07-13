// Progressive account lockout: 5 failed attempts -> 15 min, 10 -> 1 hour,
// 20 -> 24 hours. The failed-attempt counter is cumulative and is only
// reset by a successful login, not by a lock expiring, so escalation
// persists across unlocks (a 6th failure after the 15-minute lock lapses
// immediately counts toward the next threshold rather than starting over).

const THRESHOLDS = [
  { attempts: 20, lockMs: 24 * 60 * 60 * 1000, level: 3 },
  { attempts: 10, lockMs: 60 * 60 * 1000, level: 2 },
  { attempts: 5, lockMs: 15 * 60 * 1000, level: 1 },
];

export async function recordFailedLogin(user) {
  user.failedLoginAttempts += 1;

  const hit = THRESHOLDS.find((t) => user.failedLoginAttempts === t.attempts);
  if (hit) {
    user.lockLevel = hit.level;
    user.lockUntil = new Date(Date.now() + hit.lockMs);
  }

  await user.save();
  return user;
}

export async function recordSuccessfulLogin(user) {
  user.failedLoginAttempts = 0;
  user.lockLevel = 0;
  user.lockUntil = null;
  user.lastLoginAt = new Date();
  await user.save();
  return user;
}

export function lockoutMessage(user) {
  const minutesLeft = Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000);
  if (minutesLeft >= 60) {
    const hours = Math.ceil(minutesLeft / 60);
    return `Too many failed attempts. Try again in ${hours} hour${hours === 1 ? "" : "s"}.`;
  }
  return `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`;
}
