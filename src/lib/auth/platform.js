const MOBILE_PLATFORMS = ["android", "ios"];

// A mobile client identifies itself with this header on every request —
// same "a bare cross-site request can't attach a custom header" trick
// csrf.js already relies on for x-requested-with, just carrying which
// native platform instead of "is this our own frontend at all." Absent or
// unrecognized always resolves to "web", which is every existing web/admin
// request today (neither of those clients ever sends this header).
export function getClientPlatform(req) {
  const header = String(req.headers["x-client-platform"] || "").toLowerCase();
  return MOBILE_PLATFORMS.includes(header) ? header : "web";
}

export function isMobileClient(req) {
  return getClientPlatform(req) !== "web";
}
