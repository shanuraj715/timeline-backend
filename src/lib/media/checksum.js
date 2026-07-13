import crypto from "crypto";

export function computeChecksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
