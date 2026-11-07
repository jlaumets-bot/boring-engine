/* Fake supabase-js for the v718 gates (copied from the desktop-audit harness; v718: .single() works — the instance flag no longer shadows it). In-memory tables, chainable query builder. */
(function () {
  var UID = 'u-audit-1', BID = 'b-acme', BID2 = 'b-second';
  var now = Date.now(), iso = function (msAgo) { return new Date(now - msAgo).toISOString(); };
  var H = 3600e3;
  var voiceExtra = {
    painPoints: 'Teams waste hours on spreadsheets nobody reads.\nManagers cannot see which projects are late.',
    brandVocab: 'clarity, calm, momentum', avoidWords: 'synergy, leverage, game-changer',
    coachNotes: 'Short sentences. Talk like a friend who runs a studio.', socialUrl: 'https://instagram.com/acmestudio',
    productDetails: 'Project planning tool for small creative studios. EUR 19 per seat.',
    exampleContent: 'Stop planning on sticky notes. Here is what we do instead.',
    ctaStyle: 'Soft: "try it on your next project"', originStory: 'Started after losing a client because a deadline slipped.',
    socialProof: '1,200 studios, 4.8 on Capterra', voiceSample: 'Honestly, most project tools are built for people who love spreadsheets. We are not those people.',
    channels: 'Instagram, TikTok, LinkedIn', categoryGripes: 'Too many features, slow, ugly', reviewInsights: 'People love the weekly view',
    paaKeywords: 'project planning, studio management'
  };
  var DB = {
    brands: [
      { id: BID, user_id: UID, brand_name: 'Acme Studio', website: 'https://acmestudio.example', tagline: 'Plans that do not fall apart',
        usps: 'Weekly view in one screen\nNo setup\nBuilt for 2-20 person studios', tones: ['Witty', 'Direct', 'Warm'],
        target_audience: 'Owners of small design and video studios', onboarding_complete: true,
        platforms: { instagram: 2, tiktok: 1, linkedin: 1, youtube: 0 }, format_mix: { video: 3, carousel: 2, statement: 2, micro: 1, static: 1, bonus: 1, qna: 99 },
        competitors_text: 'Monday.com, Asana', banned_topics: 'politics', communities: ['Studio operations', 'Pricing and clients', 'Team culture'], day_rotation: {}, team_members: ['Jamie', 'Priya'],
        voice_extra: voiceExtra, auto_trends: { at: now - 3 * H, competitorMoves: 'Monday.com launched an AI planner and is pushing it hard on Instagram Reels. Asana is quiet.', compAt: now - 20 * H,
          items: [ { text: 'Studios moving off spreadsheets to visual planners', hot: true, link: 'https://example.com/a' }, { text: 'Four-day weeks in creative agencies', link: 'https://example.com/b' }, { text: 'AI scheduling tools backlash', hot: true, link: 'https://example.com/c' }, { text: 'Freelancer burnout surveys 2026', link: '' } ],
          topPosts: [ { text: 'I run a 6-person studio and we stopped using Asana. Here is the one-page plan we use instead, every Monday.', link: 'https://www.tiktok.com/@studioops/video/1', likes: 48200, author: 'studioops' }, { text: 'The real reason your creative team is always late is not talent, it is that nobody sees the whole week.', link: 'https://www.tiktok.com/@calmfounder/video/2', likes: 22100, author: 'calmfounder' } ] },
        created_at: iso(90 * 24 * H), updated_at: iso(2 * H) },
      { id: BID2, user_id: UID, brand_name: 'Northwind Coffee', onboarding_complete: true, tones: ['Warm'], voice_extra: {}, created_at: iso(30 * 24 * H), updated_at: iso(48 * H) }
    ],
    brand_members: [], brand_invites: [],
    ideas: [], remixes: [], notebook_notes: [], product_refs: [], prompt_history: [], competitors: [], edit_signals: [], push_subscriptions: [], dfy_requests: []
  };
  var ideas = [
    ['Monday', 'video', 'Why your studio misses deadlines (it is not your team)', 'pending', 0.2 * H],
    ['Tuesday', 'carousel', '5 signs your project plan is lying to you', 'pending', 0.3 * H],
    ['Wednesday', 'statement', 'A plan nobody reads is a wish list.', 'pending', 5 * H],
    ['Thursday', 'micro', 'The 15-minute Monday review that saves the week', 'pending', 6 * H],
    ['Friday', 'qna', '"How do you price a rush job?" — answered', 'pending', 7 * H],
    ['Saturday', 'static', 'The weekly view, explained in one picture', 'pending', 8 * H],
    ['Sunday', 'video', 'I lost a client over one missed deadline. Here is what changed.', 'pending', 9 * H],
    ['Monday', 'video', 'Stop using spreadsheets to run a studio', 'filming', 20 * H],
    ['Wednesday', 'carousel', 'Our 3-step kickoff checklist', 'filming', 22 * H],
    ['Tuesday', 'statement', 'Busy is not the same as on time.', 'filming', 23 * H],
    ['Friday', 'video', 'What a calm studio looks like on a Friday', 'done', 40 * H],
    ['Thursday', 'micro', 'Too many tools, not enough plan', 'dismissed', 50 * H]
  ];
  ideas.forEach(function (r, i) {
    DB.ideas.push({ id: 'i' + i, brand_id: BID, day: r[0], format: r[1], title: r[2], status: r[3], created_at: iso(r[4]), updated_at: iso(r[4]),
      hook: 'Most studios do not have a talent problem. They have a visibility problem.',
      script: 'Most studios do not have a talent problem. They have a visibility problem.\n\nHere is the thing: when nobody can see the whole week in one place, every deadline is a surprise.\n\nWe fixed it with one weekly view and a 15-minute Monday review. That is it.\n\nTry it on your next project and tell me what breaks.',
      shots: '1. Close-up: messy whiteboard\n2. Wide: team at desk\n3. Screen recording of the weekly view',
      screen: 'Your plan is lying to you', caption: 'Deadlines do not slip. They get hidden. #studiolife #projectmanagement',
      reel_title: 'The real reason deadlines slip', tags: '#studiolife #projectmanagement #creativebusiness',
      bold_text: r[1] === 'statement' ? r[2] : '', community: '', is_generated: true, assignee: i === 7 ? 'Jamie' : '' });
  });
  DB.notebook_notes = [
    { id: 'n1', brand_id: BID, text: 'Client said: "I finally know what everyone is doing this week." Use as a testimonial hook.', created_at: iso(3 * H) },
    { id: 'n2', brand_id: BID, text: 'Idea: film the Monday review live, 15 minutes timer on screen.', created_at: iso(26 * H) },
    { id: 'n3', brand_id: BID, text: 'Competitor launched AI planning. Our angle: you do not need AI to read a calendar.', created_at: iso(80 * H) }
  ];
  DB.competitors = [{ id: 'c1', brand_id: BID, name: '__bookmarks__', created_at: iso(5 * H), notes: JSON.stringify([
    { id: 'bc1', name: 'Competitors', entries: [
      { id: 'be1', name: 'Monday.com', links: { ig: 'https://instagram.com/mondaydotcom', tt: 'https://tiktok.com/@mondaydotcom', web: 'https://monday.com' } },
      { id: 'be2', name: 'Asana', links: { ig: 'https://instagram.com/asana', li: 'https://linkedin.com/company/asana' }, note: 'Watch how they launch features' } ] },
    { id: 'bc2', name: 'Creators I like', entries: [
      { id: 'be3', name: 'Studio Ops Daily', links: { tt: 'https://tiktok.com/@studioops', yt: 'https://youtube.com/@studioops' }, note: 'Best hooks in my niche' },
      { id: 'be4', name: 'Calm Founder', links: { ig: 'https://instagram.com/calmfounder' } } ] }
  ]) }];
  DB.remixes = [{ id: 'r1', brand_id: BID, source_type: 'tiktok', source_url: 'https://www.tiktok.com/@studioops/video/123', source_text: 'Creator talks about weekly reviews', remixed_text: '', created_at: iso(10 * H) }];
  if (window.__AUDIT_EMPTY) { DB.ideas = []; DB.notebook_notes = []; DB.competitors = []; DB.remixes = []; DB.brands[0].auto_trends = null; }
  if (window.__AUDIT_NOBRAND) { DB.brands = []; DB.ideas = []; DB.notebook_notes = []; DB.competitors = []; DB.remixes = []; }
  window.__FAKE_DB = DB;

  function Q(table) { this.t = table; this.f = []; this.op = 'select'; this._one = 0; this.payload = null; this.lim = null; }
  ['select', 'order', 'range', 'neq', 'gte', 'lte', 'gt', 'lt', 'or', 'ilike', 'like', 'not', 'filter', 'match', 'contains', 'textSearch', 'returns', 'csv', 'abortSignal'].forEach(function (m) {
    Q.prototype[m] = function () { return this; };
  });
  Q.prototype.select = function () { return this; };
  Q.prototype.eq = function (k, v) { this.f.push(function (r) { return r[k] === v; }); return this; };
  Q.prototype.is = function (k, v) { this.f.push(function (r) { return (r[k] == null) === (v == null); }); return this; };
  Q.prototype.in = function (k, arr) { this.f.push(function (r) { return arr.indexOf(r[k]) >= 0; }); return this; };
  Q.prototype.limit = function (n) { this.lim = n; return this; };
  Q.prototype.maybeSingle = function () { this._one = 1; return this; };
  Q.prototype.single = function () { this._one = 2; return this; };
  Q.prototype.insert = function (p) { this.op = 'insert'; this.payload = p; return this; };
  Q.prototype.upsert = function (p) { this.op = 'insert'; this.payload = p; return this; };
  Q.prototype.update = function (p) { this.op = 'update'; this.payload = p; return this; };
  Q.prototype.delete = function () { this.op = 'delete'; return this; };
  Q.prototype._run = function () {
    var rows = DB[this.t] || (DB[this.t] = []);
    var f = this.f, match = function (r) { return f.every(function (fn) { return fn(r); }); };
    if (this.op === 'insert') {
      var arr = Array.isArray(this.payload) ? this.payload : [this.payload];
      var out = arr.map(function (p, i) { return Object.assign({ id: 'x' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6), created_at: new Date().toISOString() }, p); });
      // keep the audit data stable: do not actually persist inserts for ideas (saves replace by title)
      out.forEach(function (o) { rows.push(o); });
      return { data: this._one ? out[0] : out, error: null };
    }
    if (this.op === 'update') { var self = this; var hit = rows.filter(match); hit.forEach(function (r) { Object.assign(r, self.payload); }); return { data: this._one ? hit[0] || null : hit, error: null }; }
    if (this.op === 'delete') { var gone = rows.filter(match); DB[this.t] = rows.filter(function (r) { return !match(r); }); return { data: gone, error: null }; }
    var res = rows.filter(match);
    if (this.lim != null) res = res.slice(0, this.lim);
    res = JSON.parse(JSON.stringify(res));
    if (this._one) return { data: res[0] || null, error: null };
    return { data: res, error: null, count: res.length };
  };
  Q.prototype.then = function (ok, bad) { var r; try { r = this._run(); } catch (e) { r = { data: null, error: { message: e.message } }; } return Promise.resolve(r).then(ok, bad); };

  var session = { access_token: 'fake-token', refresh_token: 'r', expires_at: Math.floor(now / 1000) + 3600 * 24,
    user: { id: UID, email: 'owner@acmestudio.example', user_metadata: {}, created_at: iso(90 * 24 * H) } };
  window.supabase = {
    createClient: function () {
      return {
        from: function (t) { return new Q(t); },
        rpc: function () { return Promise.resolve({ data: null, error: null }); },
        storage: { from: function () { return { upload: function () { return Promise.resolve({ data: {}, error: null }); }, getPublicUrl: function () { return { data: { publicUrl: '' } }; } }; } },
        channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; }, unsubscribe: function () {} }; return c; },
        removeChannel: function () {},
        auth: {
          getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
          getUser: function () { return Promise.resolve({ data: { user: session.user }, error: null }); },
          refreshSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
          onAuthStateChange: function (cb) { setTimeout(function () { cb('SIGNED_IN', session); }, 30); return { data: { subscription: { unsubscribe: function () {} } } }; },
          signOut: function () { return Promise.resolve({ error: null }); },
          signInWithOtp: function () { return Promise.resolve({ error: null }); }
        }
      };
    }
  };
})();
