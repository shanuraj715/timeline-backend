import mongoose from "mongoose";

// Cached across hot-reloads in dev and across serverless invocations so we
// don't open a new connection pool on every request.
let cached = globalThis._mongooseConnection;
if (!cached) {
  cached = globalThis._mongooseConnection = { conn: null, promise: null };
}

export async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    // Read lazily, at call time, rather than at module import — build/CI
    // steps that import route modules would otherwise throw in any
    // environment without a live MONGODB_URI, even though nothing at
    // import time actually needs a database connection.
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
      throw new Error("Missing MONGODB_URI environment variable. Copy .env.example to .env and set it.");
    }

    cached.promise = mongoose
      .connect(MONGODB_URI, {
        bufferCommands: false,
        maxPoolSize: 10,
      })
      .then((mongooseInstance) => mongooseInstance);
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }

  return cached.conn;
}
