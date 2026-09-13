// RETIRED 2026-08-27. The blog feature is not part of this product.
//
// The in-app blog UI has been shelved since v444 (CS_SHELVED.blog), and the whole marketing
// blog engine (blog-index / blog-post / sitemap-blog / cs-blog-cron / _csblog) was deleted in
// v627. This file stays only because app.html still holds references behind the shelved UI —
// deleting it would leave those dangling. It is a stub so the endpoint cannot be called
// directly to burn LLM credits.
//
// Do NOT "fix" this by restoring the generator. The feature was retired on purpose.
module.exports = (req, res) => res.status(410).json({ error: 'The blog feature has been retired.' });
