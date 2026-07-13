import { ZodError } from "zod";

export function badRequest(res, message = "Invalid request", extra = {}) {
  res.status(400).json({ error: message, code: "BAD_REQUEST", ...extra });
}

export function fromZodError(res, error) {
  const first = error.issues[0];
  badRequest(res, first?.message || "Invalid input", {
    fieldErrors: error.flatten().fieldErrors,
  });
}

/**
 * Validates req.body (already parsed by the express.json() middleware in
 * server.js) against a zod schema. Writes a 400 and returns null if
 * invalid; returns the parsed/coerced data otherwise. Malformed-JSON-body
 * handling (the original's `request.json()` throwing on bad syntax) lives
 * in server.js's dedicated JSON-parse-error middleware instead, matching
 * this same response shape.
 */
export function parseJson(req, res, schema) {
  try {
    return schema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      fromZodError(res, err);
      return null;
    }
    throw err;
  }
}

export function serverError(res, err, message = "Something went wrong") {
  console.error(message, err);
  res.status(500).json({ error: message, code: "SERVER_ERROR" });
}
