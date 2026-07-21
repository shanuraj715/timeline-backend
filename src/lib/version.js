import { createRequire } from "module";

// package.json isn't natively importable in an ESM ("type": "module")
// project without either an import-attribute (version-sensitive across
// Node releases) or createRequire — this is the more portable of the two.
const require = createRequire(import.meta.url);
const packageJson = require("../../package.json");

// Single source of truth: package.json's own "version" field. By policy,
// bumped (patch, unless told otherwise) as part of the PR for a normal
// deploy; left alone for a silent deploy that shouldn't change what
// clients see reported back — see server.js's X-API-Version header and
// GET /api/version.
export const API_VERSION = packageJson.version;
