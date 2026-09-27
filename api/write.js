const { aiUnavailable } = require('./_llm');

/* v693 — POST /api/write (content-v2, .unlazy/content-v2/PLAN.md C-API-2).
   {brandId, bcFields?, source, angle:{belief, why}, format? ('talking'|'statement'|'micro'|
    'carousel', default 'talking'), humanEditedTitles?}
   -> 200 {idea:{title, hook, script, storySlots, onScreen, caption, shots, format, emphasis, belief,
      genFlow:'v2'}, usedStories, usedSpeechSamples, warnings, passes, flow:'v2'}
   Writes ONE picked belief as a spoken script (draft -> spoken pass -> shape, see api/_write.js).
   Metering, brand hydration, the 424 and the 503 are copied from api/remix.js on purpose.
   ONE budget for the whole request, measured from handler start; maxDuration is 300s in
   vercel.json, and the usage write after it (a PATCH, then a fallback POST) is 2 x 8s. */
const FN_BUDGET_MS = 270000;

module.exports = async function handler(req, res) {
  const _t0 = Date.now();
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'write', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const body = req.body || {};
    const { brandId, bcFields, brandContext } = body;
    const W = require('./_write');
    const source = W._internals.normSource(body.source);
    const angle = W._internals.normAngle(body.angle);
    if (!source.text) return res.status(400).json({ error: 'The source is missing — go back and pick it again.', code: 'bad_input' });
    if (!angle.belief) return res.status(400).json({ error: 'Pick an angle first.', code: 'bad_input' });
    if (body.format != null && W.FORMATS.indexOf(body.format) < 0) return res.status(400).json({ error: 'Unknown format.', code: 'bad_input' });
    let bc = (brandContext && typeof brandContext === 'object' && !Array.isArray(brandContext)) ? brandContext : {};
    if (!brandId && !Object.keys(bc).length) return res.status(400).json({ error: 'Pick a brand first.', code: 'bad_input' });

    let hydratedBrandId = null;
    if (brandId) {
      const _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id, humanEdited: body.humanEditedTitles }, '');
      const _thin = _hyd.ok && Number.isFinite(bcFields) && bcFields > 2 && _hyd.fields < Math.ceil(bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
      hydratedBrandId = brandId;
    }

    const out = await W.runWrite({ bc, source, angle, format: body.format || 'talking', deadlineMs: Math.max(1000, FN_BUDGET_MS - (Date.now() - _t0)) });

    // v693 r2 — attribute the usage row ONLY to the brand loadBrandContext just authorised for this
    // user (it fails closed on userCanAccessBrand). A brand id inside a body-sent brandContext is
    // never checked, so it is never trusted; and not re-checking saves two Supabase reads after
    // the AI work, where every second counts against maxDuration.
    const logBrandId = hydratedBrandId;
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'write', model: require('./_write').usageModel(bc) });
    return res.status(200).json(Object.assign({}, out, { flow: 'v2' }));
  } catch (err) {
    const ai = aiUnavailable(err); if (ai) return res.status(ai.status).json(ai.body);
    if (err && err.code === 'BAD_INPUT') return res.status(400).json({ error: 'Pick an angle first.', code: 'bad_input' });
    if (err && err.code === 'TRUNCATED') return res.status(502).json({ error: 'That came back cut off — try again' });
    if (err && err.code === 'EMPTY_RESULT') return res.status(502).json({ error: 'That came back empty — try again' });
    console.error('write error:', err);
    return res.status(500).json({ error: 'Could not write that — try again' });
  }
};
