const { callLLM, callGrokSearch } = require('./_llm');
const { extractJson, fullBrandBlock } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'voicechat');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  try {
    const { messages, brandContext, behavior, currentWork, convoMemory, founderName, brandId } = req.body || {};
    let bc = brandContext || {};

    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'Messages required' });
    }

    // ── LEAN REQUEST: hydrate the brand brain from the database ────────────────
    // The coach is a CHAT, so this is the worst offender per unit of value in the app: the whole
    // ~17KB brand snapshot was re-uploaded on EVERY message of a conversation, to the endpoint
    // that already holds it. A request carrying `brandId` did not upload it; without one the old
    // full-context shape arrived and nothing here runs (cached clients keep working).
    //
    // Refusing matters more here than anywhere else. v626 fixed this endpoint's brand reach from
    // 20/28 fields to 28/28 precisely because a coach that has quietly lost half the brain still
    // answers fluently — it just stops knowing your competitors, reviews and approved work. A 424
    // (client re-sends the full context, one extra round trip) is the only honest failure here.
    if (brandId) {
      const _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id }, '');
      const _thin = _hyd.ok && Number.isFinite(bc.bcFields) && bc.bcFields > 2 &&
        _hyd.fields < Math.ceil(bc.bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
    }

    // ONE RENDERER. This used to hand-roll its own 18-line brand snapshot, which silently saw
    // only 21 of 29 brand fields — the coach never knew your competitor moves, learned signals,
    // approved winners, reviews, web mentions, category gripes, channels or day rotation. That is
    // the SAME defect as v612 (two renderers, each dropping what the other kept), which is exactly
    // how a brand's own data goes missing without anyone noticing. fullBrandBlock is the single
    // source of truth every generator already uses; the coach now reads from it too.
    const brandBlock = fullBrandBlock(bc);

    const COACH_NAME = 'Remy'; // ← the coach's name; change this one word to rename it
    const founder = (founderName && String(founderName).trim()) ? String(founderName).trim().slice(0, 40) : '';
    const behaviorBlock = (behavior && String(behavior).trim()) ? String(behavior).trim().slice(0, 1500) : '';
    const workBlock = (currentWork && String(currentWork).trim()) ? String(currentWork).trim().slice(0, 1200) : '';
    const memoryBlock = (convoMemory && String(convoMemory).trim()) ? String(convoMemory).trim().slice(0, 1200) : '';

    // Live web (Grok web_search) ONLY when the founder asks about current / trend / competitor info.
    // Silent on any failure — the coach still answers from its own knowledge.
    let liveWeb = '';
    try {
      const lastUser = [...(messages || [])].reverse().find(m => m && m.role === 'user');
      const q = lastUser ? String(lastUser.content || '') : '';
      if (q && callGrokSearch && process.env.XAI_API_KEY &&
          /\b(trend|trending|right now|lately|this week|latest|news|competitor|rival|viral|what.?s working|current|happening|202\d)\b/i.test(q)) {
        const niche = [bc.brandName, Array.isArray(bc.communities) ? bc.communities.join(' ') : bc.communities, bc.targetAudience].filter(Boolean).join(' — ').slice(0, 200);
        // Cap the web search HARD so it can never hang the chat past the function budget.
        // callGrokSearch's own timeout is 90s but this function's maxDuration is far less, so a
        // slow (but succeeding) search would otherwise get the whole request killed by Vercel —
        // exactly the "competitor question fails while normal chat works" bug. Race it: if the
        // search isn't back in 18s, drop it and let the coach answer from its own knowledge.
        const web = await Promise.race([
          callGrokSearch(
            `The founder of "${bc.brandName || 'a brand'}" (${niche}) asked their brand coach: "${q.slice(0, 300)}". Using live web search, return the 3-5 most useful CURRENT facts, trends, or competitor moves that actually help answer this — newest first, each on one line with a source. Only real, recent, verifiable items.`,
            { maxTokens: 600 }
          ),
          new Promise(r => setTimeout(() => r(null), 18000))
        ]);
        if (web && web.trim()) liveWeb = web.trim();
      }
    } catch (e) { /* silent */ }

    const systemPrompt = `You are ${COACH_NAME}, ${founder ? founder + "'s" : "the founder's"} brand coach inside Content Shrimp — a sharp, warm content strategist who has been watching how this brand's content actually performs. You are NOT a generic AI assistant. You are THIS founder's coach: you know their brand, you remember your past chats, and you have opinions.

WHO YOU'RE TALKING TO:
${founder ? `The founder's name is ${founder}. Use it naturally — not in every message.` : `You don't know the founder's name yet. You can ask once, early.`}

THE BRAND (${bc.brandName || 'unnamed'}):
${brandBlock || '(No brand settings configured yet — help them start.)'}
${behaviorBlock ? `\nWHAT THEY'VE ACTUALLY BEEN DOING (reference it — this is why you feel like a real coach, not a bot):\n${behaviorBlock}` : ''}
${workBlock ? `\nWHAT THEY'RE WORKING ON RIGHT NOW (react to THIS specific thing, not a hypothetical):\n${workBlock}` : ''}
${memoryBlock ? `\nFROM YOUR EARLIER CHATS (don't repeat it — build on it):\n${memoryBlock}` : ''}
${liveWeb ? `\nLIVE FROM THE WEB, fetched just now (use it, weave it in, mention that it's current):\n${liveWeb}` : ''}

HOW YOU TALK — this is what makes you human:
- Sound like a real person, not a chatbot. Warm, direct, a little wry. Match ${founder || 'their'} energy: casual if they're casual, deep if they go deep.
- Have opinions and push back. If an idea is weak or generic, say so kindly and give a sharper one. A yes-machine is useless to them.
- React to what they've been doing: celebrate a win ("nice, three approvals this week"), name a pattern ("you keep cutting hooks shorter — good instinct"), or call out a rut.
- Vary how you open. Do NOT start every reply the same way. Do NOT end every message with a question.
- Keep it SHORT: 2 to 4 sentences. This is a chat, not an essay.
- Never use em dashes; use commas or periods. No "I'd be happy to", no "Great question", no corporate filler.

WHAT YOU CAN DO — offer an action when doing beats talking (the app turns it into a button they tap):
End your message with at most ONE action block, only when it's the natural next step:
<assistant_action>
{"type":"write_post|generate_ideas|pull_trends|scan_brand","label":"short button label"}
</assistant_action>
write_post = draft a post now, generate_ideas = a fresh batch of ideas, pull_trends = pull what's trending in their niche, scan_brand = re-read their website into the brand brain.

WHEN YOU IMPROVE A BRAND SETTING (one per message, explain WHY first):
<brand_update>
{"field":"fieldName","value":"new value","action":"set|append|replace"}
</brand_update>
Valid fields: brandName, tagline, usps, targetAudience, painPoints, brandVocab, avoidWords, productDetails, ctaStyle, originStory, socialProof, visualStyle, exampleContent, bannedTopics, competitors, coachNotes. For tones or communities, use that field name with a comma-separated value and action "set". coachNotes = Voice Memory: a durable one-line rule (max 15 words) that shapes ALL future content, so only save rules worth applying everywhere and never re-save one already there.

REMEMBER THIS CHAT so next time you continue instead of restarting. If this exchange reached a decision or a real insight, end with:
<coach_memory>
{"note":"one short line, max 20 words — e.g. 'sharpened audience to fasting men 30-45; pushing deadpan over hype'"}
</coach_memory>

If they haven't set the basics yet (brand name, audience), start there before anything fancy.`;

    // Bound input cost: keep only the last 20 turns, cap each message length.
    const trimmedMessages = messages.slice(-20).map(m => ({
      role: m.role,
      content: String(m.content || '').slice(0, 4000)
    }));

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...trimmedMessages
    ];

    const content = await callLLM({ timeoutMs: 44000,
      messages: fullMessages,
      model: 'grok',
      temperature: 0.8,
      max_tokens: 800
    });

    // Extract the structured blocks the coach may append (robust parser handles prose-wrapped JSON).
    let suggestion = null, action = null, memory = null;
    try { const m = content.match(/<brand_update>\s*(\{[\s\S]*?\})\s*<\/brand_update>/); if (m) suggestion = extractJson(m[1]) || null; } catch (e) {}
    try {
      const m = content.match(/<assistant_action>\s*(\{[\s\S]*?\})\s*<\/assistant_action>/);
      if (m) { const a = extractJson(m[1]); if (a && ['write_post','generate_ideas','pull_trends','scan_brand'].includes(a.type)) action = { type: a.type, label: String(a.label || '').slice(0, 40) }; }
    } catch (e) {}
    try { const m = content.match(/<coach_memory>\s*(\{[\s\S]*?\})\s*<\/coach_memory>/); if (m) { const mj = extractJson(m[1]); if (mj && mj.note) memory = String(mj.note).slice(0, 200); } } catch (e) {}
    const cleanContent = content
      .replace(/<brand_update>[\s\S]*?<\/brand_update>/g, '')
      .replace(/<assistant_action>[\s\S]*?<\/assistant_action>/g, '')
      .replace(/<coach_memory>[\s\S]*?<\/coach_memory>/g, '')
      .trim();

    await require('./_usage').logUsage({ userId: _g.user.id, action: 'voicechat' });
    return res.status(200).json({ reply: cleanContent, suggestion, action, memory });

  } catch (err) {
    console.error('Brand voice chat error:', err);
    return res.status(500).json({ error: "The assistant hit a snag — please try again." });
  }
};
