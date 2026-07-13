import { SignJWT, jwtVerify } from "jose";

// jose (not jsonwebtoken) for parity with the frontend project, which needs
// it for both regular Node route handlers and Edge-runtime middleware —
// keeping the same library here too in case any code is ever shared/compared.

const ACCESS_TOKEN_TTL = "15m";

function getAccessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("Missing JWT_ACCESS_SECRET environment variable.");
  return new TextEncoder().encode(secret);
}

export async function signAccessToken({ userId, role }) {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId.toString())
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getAccessSecret());
}

export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, getAccessSecret());
    return { userId: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}
