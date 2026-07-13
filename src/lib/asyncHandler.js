// Express 4 does not automatically catch a rejected promise thrown by an
// async route handler — left alone, that becomes an unhandled rejection
// that can crash the whole process instead of just failing that one
// request. Next.js's route handlers get this safety net for free at the
// framework level (several of the original routes, e.g. session deletion,
// deliberately have no try/catch of their own and relied on it), so every
// route here is wrapped with this to forward any thrown/rejected error to
// the global error-handling middleware in server.js instead.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
