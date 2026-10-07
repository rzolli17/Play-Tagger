// Play-call matcher: turns a noisy transcript into the closest calls on the play sheet.
(function (root) {
  const NUM_WORDS = {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const TENS = new Set([20, 30, 40, 50, 60, 70, 80, 90]);
  // Lead-in words a caller says before the actual call; ignored when matching.
  const FILLER = new Set(['mike', 'just', 'called', 'call', 'calling', 'the', 'a', 'uh', 'um', 'okay', 'ok', 'and', 'its', "it's", 'next', 'play', 'is']);

  function normalize(text) {
    const raw = String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ')
      .split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const w = raw[i];
      if (w in NUM_WORDS) {
        let n = NUM_WORDS[w];
        const next = raw[i + 1];
        if (TENS.has(n) && next in NUM_WORDS && NUM_WORDS[next] > 0 && NUM_WORDS[next] < 10) {
          n += NUM_WORDS[next];
          i++;
        }
        out.push(String(n));
      } else {
        out.push(w);
      }
    }
    // "2 4" spoken digit by digit -> "24"
    const merged = [];
    for (const w of out) {
      const prev = merged[merged.length - 1];
      if (/^\d$/.test(w) && prev && /^\d$/.test(prev)) merged[merged.length - 1] = prev + w;
      else merged.push(w);
    }
    return merged;
  }

  // Rough sound-alike key so "trips"/"trip"/"tripps" or "ace"/"ase" land close together.
  function soundKey(word) {
    if (/^\d+$/.test(word)) return word;
    let w = word
      .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw')
      .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/x/g, 'ks')
      .replace(/z/g, 's').replace(/dg/g, 'j').replace(/wr/g, 'r').replace(/kn/g, 'n')
      .replace(/(.)\1+/g, '$1');
    if (w.length > 3) w = w.replace(/e?s$/, '');
    const head = w[0];
    const rest = w.slice(1).replace(/[aeiouyhw]/g, '');
    return head + rest;
  }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function wordSim(a, b) {
    if (a === b) return 1;
    const numA = /^\d+$/.test(a), numB = /^\d+$/.test(b);
    if (numA || numB) return 0; // numbers must match exactly
    const spell = 1 - lev(a, b) / Math.max(a.length, b.length);
    const sa = soundKey(a), sb = soundKey(b);
    const sound = sa === sb ? 0.95 : 1 - lev(sa, sb) / Math.max(sa.length, sb.length, 1);
    return Math.max(spell, sound * 0.95);
  }

  // Best alignment of the entry's words to a contiguous window of transcript words.
  function scoreWindow(entryWords, words, start, len) {
    const win = words.slice(start, start + len);
    const n = entryWords.length;
    // DP alignment: each entry word matched in order to a window word or skipped.
    let best = 0;
    const dp = Array.from({ length: n + 1 }, () => new Array(win.length + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= win.length; j++) {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + wordSim(entryWords[i - 1], win[j - 1]));
      }
    }
    best = dp[n][win.length];
    const extra = Math.max(0, win.length - n);
    return best / n - extra * 0.08;
  }

  function bestSpan(entryWords, words, used) {
    let top = { score: 0, start: -1, len: 0 };
    const n = entryWords.length;
    for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
      for (let s = 0; s + len <= words.length; s++) {
        let clash = false;
        for (let k = s; k < s + len; k++) if (used[k]) { clash = true; break; }
        if (clash) continue;
        const sc = scoreWindow(entryWords, words, s, len);
        // Prefer longer, more specific entries on near-ties.
        const adj = sc + n * 0.001;
        if (adj > top.score) top = { score: adj, start: s, len };
      }
    }
    return top;
  }

  // Parse play sheet text. "# Heading" lines start a category; "Name | alias | alias" per line.
  function parseSheet(text) {
    const cats = [];
    let cur = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('#')) {
        cur = { name: t.replace(/^#+/, '').trim() || 'Call', entries: [] };
        cats.push(cur);
        continue;
      }
      if (!cur) { cur = { name: 'Call', entries: [] }; cats.push(cur); }
      const parts = t.split('|').map(s => s.trim()).filter(Boolean);
      const name = parts[0];
      const forms = parts.map(p => normalize(p).filter(w => !FILLER.has(w) || normalize(name).includes(w)));
      cur.entries.push({ name, forms: forms.filter(f => f.length) });
    }
    return cats.filter(c => c.entries.length);
  }

  const THRESHOLD = 0.62; // below this a category is left blank
  const SURE = 0.85; // at or above every filled category = green

  function matchOne(transcript, cats) {
    const allWords = normalize(transcript);
    const words = allWords.filter(w => !FILLER.has(w) || cats.some(c => c.entries.some(e => e.forms.some(f => f.includes(w)))));
    const used = new Array(words.length).fill(false);
    // Score every candidate in every category, then greedily assign the strongest non-overlapping ones.
    const cands = [];
    cats.forEach((cat, ci) => {
      cat.entries.forEach(entry => {
        entry.forms.forEach(form => {
          const sp = bestSpan(form, words, used);
          if (sp.start >= 0) cands.push({ ci, entry, form, ...sp });
        });
      });
    });
    cands.sort((a, b) => b.score - a.score);
    const tags = cats.map(() => null);
    const scores = cats.map(() => 0);
    for (const c of cands) {
      if (tags[c.ci] || c.score < THRESHOLD) continue;
      let clash = false;
      for (let k = c.start; k < c.start + c.len; k++) if (used[k]) { clash = true; break; }
      if (clash) {
        const again = bestSpan(c.form, words, used);
        if (again.start < 0 || again.score < THRESHOLD) continue;
        Object.assign(c, again);
      }
      for (let k = c.start; k < c.start + c.len; k++) used[k] = true;
      tags[c.ci] = c.entry.name;
      scores[c.ci] = Math.min(1, c.score);
    }
    const filled = scores.filter((s, i) => tags[i]);
    let conf = filled.length ? Math.min(...filled) : 0;
    if (filled.length && filled.length < cats.length) conf = Math.min(conf, SURE - 0.01); // partial = needs a look
    return { tags, scores, confidence: conf, heard: transcript };
  }

  // Try each recognizer alternative; keep the one that fits the sheet best.
  function match(alternatives, cats) {
    const alts = (Array.isArray(alternatives) ? alternatives : [alternatives]).filter(Boolean);
    let best = null;
    for (const a of alts) {
      const r = matchOne(a, cats);
      if (!best || r.confidence > best.confidence) best = r;
    }
    if (!best) best = { tags: cats.map(() => null), scores: cats.map(() => 0), confidence: 0, heard: '' };
    best.level = best.confidence >= SURE ? 'good' : best.confidence >= THRESHOLD ? 'check' : 'miss';
    return best;
  }

  const api = { normalize, soundKey, parseSheet, match, THRESHOLD, SURE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
