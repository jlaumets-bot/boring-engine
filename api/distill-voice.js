// Brand-brain distillation: turn raw taste signals (edits, dismissals, approvals)
// into a few DURABLE voice rules the user can confirm into permanent Voice Memory.
const { callLLM } = require('./_llm.js');
const { extractJson } = require('./_brain');

// ── INPUT CAPS ───────────────────────────────────────────────────────────────
// Client-supplied free text lands directly in the prompt below, so it must be BOUNDED — every
// other such string in this codebase is (_brain.js FIELD_CAP 4000 / TOTAL_CAP 30000, remix.js
// MAX_DESC 12000, viral-analyze.js slice(0,6000)). These were not, in either length OR count
// (`existingRules` was uncapped on both axes). And because `distill` is billed at a FLAT
// per-action cost, the €25 cost fuse computes the same tiny number no matter how large the
// prompt actually was — it can never see an oversized payload.
//
// Every limit sits far above what app.html actually sends, so no real user can be truncated:
//   existingRules — app.html caps coachNotes at 25 one-sentence rules; we allow 40 × 300 chars
//   field         — an edit-signal key: "hook", "script", "sharpen:boldText"
//   format        — one of 7 fixed values (video, carousel, static, statement, micro, bonus, qna)
//   reason        — a fixed approve/dismiss chip, or a custom note (~60 words at 300 chars)
//   title         — a "Short descriptive title" per our own generation schema
//   brandName     — crawl-brand already rejects anything over 48 chars as a description
// (edits' before/after were already capped at 160 each — those stay as they are.)
// Worst-case bound on the assembled prompt after capping: ~36KB. Before: unbounded.
const RULES_MAX = 40, RULE_CAP = 300, EDIT_FIELD_CAP = 80,
      FORMAT_CAP = 40, REASON_CAP = 300, TITLE_CAP = 200, BRAND_CAP = 100;
const cap = (v, n) => String(v == null ? '' : v).slice(0, n);

module.exports = async function handler(req, res) {
  const _g = await require('./_usage').guard(req, 'distill');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);
  try {
    const body = req.body || {};
    const edits = Array.isArray(body.edits) ? body.edits : [];
    const dismissals = Array.isArray(body.dismissals) ? body.dismissals : [];
    const approvals = Array.isArray(body.approvals) ? body.approvals : [];
    const existingRules = Array.isArray(body.existingRules) ? body.existingRules : [];
    const brandName = cap(body.brandName, BRAND_CAP) || 'the brand';

    if (edits.length + dismissals.length + approvals.length < 2) {
      return res.status(200).json({ rules: [] });
    }

    /* v665: SEPARATE WHAT THE USER TYPED FROM WHAT THE MODEL REWROTE.
       Every edit used to be rendered under "HOW THE USER EDITED OUR DRAFTS (strongest signal —
       their real voice)", including the ones produced by the Sharpen and Viral-twist buttons,
       whose `after` is the MODEL's own text. So the distiller mined the model's prose for
       "durable voice rules" and wrote them into Voice Memory, where they render near the top of
       every future prompt. That is the system learning its own average and calling it the brand.
       The AI-authored ones are still useful — the user CHOSE that version over the draft — but
       they are a preference signal, not evidence of how the person writes, and the prompt now
       says which is which. Signals with no `by` predate the tagging and are treated as typed. */
    const typedEdits = edits.filter(e => !e || e.by !== 'ai');
    const chosenEdits = edits.filter(e => e && e.by === 'ai');
    const editLines = typedEdits.slice(-15).map(e =>
      `• ${cap(e.field, EDIT_FIELD_CAP)}: AI wrote "${(e.before||'').slice(0,160)}" → user changed to "${(e.after||'').slice(0,160)}"`).join('\n');
    const chosenLines = chosenEdits.slice(-8).map(e =>
      `• ${cap(e.field, EDIT_FIELD_CAP)}: they preferred "${(e.after||'').slice(0,160)}" over "${(e.before||'').slice(0,160)}"`).join('\n');
    const dismissLines = dismissals.slice(-15).map(d =>
      `• rejected a ${cap(d.format, FORMAT_CAP)} — reason: ${cap(d.reason, REASON_CAP) || 'unspecified'}${d.title ? ` ("${cap(d.title, TITLE_CAP)}")` : ''}`).join('\n');
    const approveLines = approvals.slice(-15).map(a =>
      `• kept a ${cap(a.format, FORMAT_CAP)}${a.reason ? ` — loved: ${cap(a.reason, REASON_CAP)}` : ''}${a.title ? ` ("${cap(a.title, TITLE_CAP)}")` : ''}`).join('\n');

    const prompt = `You maintain the living brand-voice memory for ${brandName}. Below are recent real signals from the user reviewing AI-generated content. Your job: find DURABLE PATTERNS and write them as permanent voice rules — the kind that should shape every future post.

HOW THE USER EDITED OUR DRAFTS IN THEIR OWN WORDS (strongest signal — their real voice):
${editLines || '(none)'}

WHICH OF OUR OWN REWRITES THEY PREFERRED (a taste signal about direction — these are NOT the user's writing, so never treat them as their voice):
${chosenLines || '(none)'}

WHAT THEY REJECTED:
${dismissLines || '(none)'}

WHAT THEY KEPT / LOVED:
${approveLines || '(none)'}

RULES ALREADY IN MEMORY (do NOT repeat or restate these):
${existingRules.slice(-RULES_MAX).map(r => `• ${cap(r, RULE_CAP)}`).join('\n') || '(none yet)'}

Extract 1-3 NEW durable rules. Each rule must:
- Describe a PATTERN seen across multiple signals, not a one-off reaction.
- Be a concrete, imperative voice instruction (e.g. "Cut exclamation marks and hype words — state claims flat.", "Lead with a number or mechanism, never a question.").
- Be genuinely new vs the existing rules.
- Be short (one sentence).
If there is no real repeated pattern yet, return fewer rules or none. Quality over quantity — a wrong rule poisons all future content.

Return ONLY JSON: {"rules": [{"rule": "...", "evidence": "one short phrase citing what it's based on"}]}`;

    const content = await callLLM({ timeoutMs: 48000,
      messages: [{ role: 'user', content: prompt }],
      model: 'grok',
      max_tokens: 700
    });
    if (!content) return res.status(500).json({ error: 'No content from AI' });

    const parsed = extractJson(content);
    if (!parsed) return res.status(502).json({ error: "Couldn't refine the voice notes — please try again." });

    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'distill' });
    return res.status(200).json({ rules: Array.isArray(parsed.rules) ? parsed.rules.slice(0, 3) : [] });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't refine the voice notes — please try again." });
  }
};
