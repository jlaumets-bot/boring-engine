// content-v3 F1 — the daily question bank. The app interviews the founder, one short question a day.
//
// PURE MODULE: no I/O, no clock of its own, no randomness. api/daily-question.js (the app card) and
// api/send-daily.js (the morning push) BOTH pick through questionFor() below, from the SAME rows read
// with the SAME path (answeredPath), so the push and the card show the same question on the same day.
//
// Each question: {id, text, kind}. The id is stored in brand_memory.meta.questionId, so an id must
// NEVER be renamed or reused — retire a question by deleting it, add new ones with new ids.
// Every question is answerable out loud in about 20 seconds from memory by the founder of a small
// product or service brand. No leading questions, nothing medical or legal.
//
// THE DAY is the UTC calendar date (utcDate). Both callers use it, so they agree; a founder far from
// UTC may see the question change at UTC midnight rather than their own midnight. That is accepted.

const KINDS = ['customer', 'mistake', 'opinion', 'behind-the-scenes', 'origin', 'myth', 'win', 'annoyance'];

const QUESTIONS = Object.freeze([
  // customer
  { id: 'cust-surprise',       kind: 'customer', text: 'What did a customer ask you this week that surprised you?' },
  { id: 'cust-first',          kind: 'customer', text: 'Who was your very first customer, and why did they buy?' },
  { id: 'cust-nicest',         kind: 'customer', text: "What's the nicest thing a customer ever said to you?" },
  { id: 'cust-changed-mind',   kind: 'customer', text: 'Think of a customer who almost said no. What changed their mind?' },
  { id: 'cust-misread',        kind: 'customer', text: 'What do new customers usually get wrong about what you do?' },
  { id: 'cust-repeat-q',       kind: 'customer', text: 'What question do you answer over and over again?' },
  { id: 'cust-found-you',      kind: 'customer', text: 'Where do most of your customers first hear about you?' },
  // mistake
  { id: 'mistake-early',       kind: 'mistake', text: "What's a mistake you made early on that you'd warn others about?" },
  { id: 'mistake-waste',       kind: 'mistake', text: "What's something you spent money on that turned out to be a waste?" },
  { id: 'mistake-redo',        kind: 'mistake', text: "What's one thing you'd do differently if you started again tomorrow?" },
  { id: 'mistake-flop',        kind: 'mistake', text: "What's an idea of yours that flopped, and why?" },
  { id: 'mistake-lesson',      kind: 'mistake', text: "What's the most expensive lesson your business has taught you?" },
  { id: 'mistake-turnaround',  kind: 'mistake', text: 'When did something go wrong, and how did you fix it?' },
  // opinion
  { id: 'opinion-wrong',       kind: 'opinion', text: "What's one thing people in your industry get wrong?" },
  { id: 'opinion-unpopular',   kind: 'opinion', text: "What's an opinion about your industry that most people would disagree with?" },
  { id: 'opinion-overrated',   kind: 'opinion', text: "What's something everyone in your field does that you think is overrated?" },
  { id: 'opinion-advice',      kind: 'opinion', text: "What's a popular piece of business advice you ignore?" },
  { id: 'opinion-change',      kind: 'opinion', text: 'If you could change one thing about your industry, what would it be?' },
  { id: 'opinion-good-vs-bad', kind: 'opinion', text: 'What separates a good product in your field from a bad one?' },
  { id: 'opinion-trend',       kind: 'opinion', text: "What's a trend in your industry you think will fade?" },
  // behind-the-scenes
  { id: 'bts-yesterday',       kind: 'behind-the-scenes', text: 'What did your workday look like yesterday?' },
  { id: 'bts-unseen',          kind: 'behind-the-scenes', text: "What's a part of your work that customers never see?" },
  { id: 'bts-habit',           kind: 'behind-the-scenes', text: "What's one tool or habit that saves you hours every week?" },
  { id: 'bts-how-made',        kind: 'behind-the-scenes', text: 'How does one of your products actually get made or delivered?' },
  { id: 'bts-hardest',         kind: 'behind-the-scenes', text: "What's the hardest part of your job that nobody talks about?" },
  { id: 'bts-excited',         kind: 'behind-the-scenes', text: "What are you working on right now that you're excited about?" },
  { id: 'bts-helpers',         kind: 'behind-the-scenes', text: 'Who helps you behind the scenes, and what do they do?' },
  // origin
  { id: 'origin-why',          kind: 'origin', text: 'Why did you start this business in the first place?' },
  { id: 'origin-quit',         kind: 'origin', text: 'What almost made you quit?' },
  { id: 'origin-before',       kind: 'origin', text: 'What were you doing before this, and what made you switch?' },
  { id: 'origin-it-works',     kind: 'origin', text: 'When did you first feel this business might actually work?' },
  { id: 'origin-name',         kind: 'origin', text: "How did you come up with your brand's name?" },
  { id: 'origin-first-sale',   kind: 'origin', text: 'What was your very first sale like?' },
  // myth
  { id: 'myth-common',         kind: 'myth', text: "What's a common myth about your product or service?" },
  { id: 'myth-price',          kind: 'myth', text: "What do people assume about your prices that isn't true?" },
  { id: 'myth-looks-easy',     kind: 'myth', text: 'What looks easy about your work but is actually hard?' },
  { id: 'myth-beginners',      kind: 'myth', text: "What do beginners believe about your field that just isn't true?" },
  { id: 'myth-market-claim',   kind: 'myth', text: 'What do people in your market often say that you think is false?' },
  // win
  { id: 'win-week',            kind: 'win', text: "What's a small win you had this week?" },
  { id: 'win-proud',           kind: 'win', text: "What's the piece of work you're most proud of?" },
  { id: 'win-customer-result', kind: 'win', text: "What's a result a customer got that made your day?" },
  { id: 'win-milestone',       kind: 'win', text: 'What milestone did you hit that once felt impossible?' },
  { id: 'win-solved',          kind: 'win', text: 'What problem did you solve recently that you are glad is gone?' },
  // annoyance
  { id: 'annoy-industry',      kind: 'annoyance', text: 'What annoys you most about how things are done in your industry?' },
  { id: 'annoy-say-no',        kind: 'annoyance', text: "What's a request you get that you always have to say no to?" },
  { id: 'annoy-pet-peeve',     kind: 'annoyance', text: "What's your biggest pet peeve as a business owner?" },
  { id: 'annoy-cringe',        kind: 'annoyance', text: 'What do you see others in your space do that makes you cringe?' },
  { id: 'annoy-still',         kind: 'annoyance', text: "What's something about running a business that still frustrates you?" },
].map(q => Object.freeze(q)));

const BY_ID = new Map(QUESTIONS.map(q => [q.id, q]));
const ANSWERED_LIMIT = 200;   // "answered" = the brand's newest 200 daily-question stories

// FNV-1a, 32-bit. Stable across Node versions and machines, which Math.random / a salted hash is not.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// answeredIds: question ids in answer order, NEWEST FIRST (repeats allowed, unknown ids ignored).
// Deterministic per brand per day; never an answered one while any is unanswered. When every
// question has been answered, the one whose latest answer is the OLDEST comes back.
function pickQuestion(brandId, dateISO, answeredIds) {
  const answered = Array.isArray(answeredIds) ? answeredIds.map(String) : [];
  const done = new Set(answered);
  const open = QUESTIONS.filter(q => !done.has(q.id));
  if (open.length) return open[hash32(String(brandId) + '|' + String(dateISO)) % open.length];
  const newestAt = new Map();
  answered.forEach((id, i) => { if (!newestAt.has(id)) newestAt.set(id, i); });
  let best = QUESTIONS[0], bestAt = -1;
  for (const q of QUESTIONS) { const i = newestAt.get(q.id); if (i > bestAt) { bestAt = i; best = q; } }
  return best;
}

const utcDate = (now) => (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);

// The ONE read both callers make (relative to /rest/v1). `->>` is sent percent-encoded.
function answeredPath(brandId) {
  return '/brand_memory?brand_id=eq.' + encodeURIComponent(String(brandId)) +
    '&kind=eq.story&meta-%3E%3Esource=eq.daily_question' +
    '&select=id,text,meta,created_at&order=created_at.desc,id.desc&limit=' + ANSWERED_LIMIT;
}

const metaOf = (r) => (r && r.meta && typeof r.meta === 'object') ? r.meta : {};
const isDq = (r) => metaOf(r).source === 'daily_question';

// rows: the answeredPath read, newest first.
// -> { question, answeredToday, todayRow }. Answered today: the question is the one they answered.
function questionFor(brandId, dateISO, rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(isDq);
  const todayRow = list.find(r => metaOf(r).date === dateISO) || null;
  if (todayRow && BY_ID.has(String(metaOf(todayRow).questionId))) {
    return { question: BY_ID.get(String(metaOf(todayRow).questionId)), answeredToday: true, todayRow };
  }
  const answeredIds = list.map(r => String(metaOf(r).questionId || '')).filter(id => BY_ID.has(id));
  return { question: pickQuestion(brandId, dateISO, answeredIds), answeredToday: !!todayRow, todayRow };
}

module.exports = { QUESTIONS, KINDS, BY_ID, ANSWERED_LIMIT, hash32, pickQuestion, utcDate, answeredPath, questionFor };
