// Shared auth gate for endpoints that spend money (LLM / image / scrape / transcription).
// Returns the Supabase user object for a valid Bearer token, or null.
// Usage in a handler (after the method check):
//   const user = await require('./_requireUser')(req);
//   if (!user) return res.status(401).json({ error: 'Please sign in again.' });
const store = require('./_publish/store');

module.exports = async function requireUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  try { return await store.getUser(token); }
  catch (e) { return null; }
};
