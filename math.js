// Odds math: conversions, no-vig fair prices, EV and Kelly sizing.
// Works in the browser (window.OddsMath) and in Node (module.exports) for tests.
(function (root) {
  const amToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
  const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
  const amToProb = (a) => 1 / amToDec(a);
  const probToAm = (p) => decToAm(1 / p);
  const fmtAm = (a) => (a > 0 ? `+${a}` : `${a}`);

  // Remove the book's margin from a set of outcome prices (American).
  function noVig(prices) {
    const raw = prices.map(amToProb);
    const total = raw.reduce((s, x) => s + x, 0);
    return { probs: raw.map((p) => p / total), hold: total - 1 };
  }

  const ev = (fairProb, american) => fairProb * amToDec(american) - 1;

  // Fractional Kelly stake as a share of bankroll, capped.
  function kelly(fairProb, american, fraction = 0.25, cap = 0.03) {
    const d = amToDec(american);
    const full = (d * fairProb - 1) / (d - 1);
    return Math.max(0, Math.min(cap, full * fraction));
  }

  // Key that identifies "the same bet" across books.
  const outcomeKey = (o) => `${o.description || ''}|${o.name}|${o.point ?? ''}`;
  // Key for the two-sided pair an outcome belongs to (spread sides have opposite points).
  function pairKey(marketKey, o) {
    const isOverUnder = /^(Over|Under)$/.test(o.name);
    if (!isOverUnder && o.point != null) return `${o.description || ''}|${Math.abs(o.point)}`; // spreads
    return `${o.description || ''}|${o.point ?? ''}`; // totals, props, moneylines
  }

  // For one book's market, return a map outcomeKey -> no-vig prob (only complete 2-way pairs).
  function bookFairMap(market) {
    const groups = {};
    for (const o of market.outcomes) {
      const k = pairKey(market.key, o);
      (groups[k] = groups[k] || []).push(o);
    }
    const out = {};
    for (const g of Object.values(groups)) {
      if (g.length !== 2) continue; // need both sides to strip vig
      const { probs, hold } = noVig(g.map((o) => o.price));
      g.forEach((o, i) => (out[outcomeKey(o)] = { p: probs[i], hold }));
    }
    return out;
  }

  /**
   * Find FanDuel prices that beat the fair price.
   * event: Odds API event object. opts: { target, sharp, method, minBooks }
   * Returns rows: { market, outcome, fdPrice, fairProb, fairAm, ev, books, source }
   */
  function scanEvent(event, opts = {}) {
    const target = opts.target || 'fanduel';
    const sharp = opts.sharp || ['pinnacle'];
    const method = opts.method || 'sharp-first';
    const minBooks = opts.minBooks ?? 2;
    const books = event.bookmakers || [];
    const fd = books.find((b) => b.key === target);
    if (!fd) return [];
    const rows = [];
    for (const m of fd.markets) {
      const fairByBook = {};
      for (const b of books) {
        if (b.key === target) continue;
        const bm = b.markets.find((x) => x.key === m.key);
        if (bm) fairByBook[b.key] = bookFairMap(bm);
      }
      for (const o of m.outcomes) {
        const k = outcomeKey(o);
        const others = Object.entries(fairByBook).filter(([, map]) => map[k]).map(([bk, map]) => ({ bk, p: map[k].p }));
        const sharpHit = others.find((x) => sharp.includes(x.bk));
        let fairProb, source;
        if (method === 'sharp-first' && sharpHit) {
          fairProb = sharpHit.p; source = sharpHit.bk;
        } else {
          if (others.length < minBooks) continue;
          fairProb = others.reduce((s, x) => s + x.p, 0) / others.length; source = 'consensus';
        }
        rows.push({
          eventId: event.id, sport: event.sport_key, home: event.home_team, away: event.away_team,
          commence: event.commence_time, market: m.key, outcome: o, fdPrice: o.price,
          fairProb, fairAm: probToAm(fairProb), ev: ev(fairProb, o.price), books: others.length, source,
          lastUpdate: m.last_update,
        });
      }
    }
    return rows;
  }

  // ---- Normal distribution helpers (for milestone "X+" lines) ----
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function normInv(p) { // Acklam's approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858589980243, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) return -normInv(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // Rough game-to-game spread of a stat around its average, by stat type.
  function statSd(market, line) {
    const m = market.replace('_alternate', '');
    if (/points_rebounds_assists/.test(m)) return 0.25 * line + 3;
    if (/player_points/.test(m)) return 0.28 * line + 2.5;
    if (/rebounds|assists/.test(m)) return 0.3 * line + 1.2;
    if (/threes/.test(m)) return 0.45 * line + 0.8;
    if (/pass_yds/.test(m)) return 0.2 * line + 25;
    if (/rush_yds|reception_yds/.test(m)) return 0.4 * line + 10;
    if (/receptions/.test(m)) return 0.35 * line + 1;
    return 0.35 * line + 1;
  }
  /**
   * Price a one-sided milestone line ("10+ points" = Over 9.5) from a player's main line.
   * mainLine: main O/U point, pOver: no-vig P(over main line), point: milestone point (e.g. 9.5)
   */
  function milestoneProb(market, mainLine, pOver, point) {
    const sd = statSd(market, mainLine);
    const mu = mainLine + sd * normInv(Math.min(0.99, Math.max(0.01, pOver)));
    return 1 - normCdf((point - mu) / sd);
  }

  // Add estimated fair prices for FanDuel alternate/milestone props using other books' main lines.
  function scanMilestones(event, opts = {}) {
    const target = opts.target || 'fanduel';
    const books = event.bookmakers || [];
    const fd = books.find((b) => b.key === target);
    if (!fd) return [];
    const rows = [];
    for (const m of fd.markets.filter((x) => x.key.endsWith('_alternate'))) {
      const mainKey = m.key.replace('_alternate', '');
      for (const o of m.outcomes.filter((x) => x.name === 'Over' && x.point != null)) {
        // Collect each other book's main line + no-vig over prob for this player
        const mains = [];
        for (const b of books) {
          if (b.key === target) continue;
          const bm = b.markets.find((x) => x.key === mainKey);
          if (!bm) continue;
          const pair = bm.outcomes.filter((x) => x.description === o.description);
          const ov = pair.find((x) => x.name === 'Over'), un = pair.find((x) => x.name === 'Under');
          if (ov && un && ov.point === un.point) mains.push({ bk: b.key, line: ov.point, p: noVig([ov.price, un.price]).probs[0] });
        }
        if (!mains.length) continue;
        const sharp = mains.find((x) => x.bk === 'pinnacle');
        const use = sharp ? [sharp] : mains;
        const modelProb = use.reduce((s, x) => s + milestoneProb(m.key, x.line, x.p, o.point), 0) / use.length;
        // Model is rough, so shrink halfway toward FanDuel's own implied price (conservative edge).
        const fairProb = 0.5 * modelProb + 0.5 * amToProb(o.price);
        if (fairProb <= 0.005 || fairProb >= 0.995) continue;
        rows.push({
          eventId: event.id, sport: event.sport_key, home: event.home_team, away: event.away_team,
          commence: event.commence_time, market: m.key, outcome: o, fdPrice: o.price,
          fairProb, fairAm: probToAm(fairProb), ev: ev(fairProb, o.price), books: use.length,
          source: (sharp ? 'pinnacle' : 'consensus') + ' model', milestone: true, lastUpdate: m.last_update,
        });
      }
    }
    return rows;
  }

  // Build the best parlays from +EV legs, one leg per game. legs: rows with fairProb, fdPrice, eventId
  function suggestParlays(rows, { sizes = [2, 3], pool = 12, top = 6, minEV = 0 } = {}) {
    const best = {};
    rows.filter((r) => r.ev > minEV).sort((a, b) => b.ev - a.ev).forEach((r) => { if (!best[r.eventId]) best[r.eventId] = r; });
    const legs = Object.values(best).slice(0, pool);
    const out = [];
    const combo = (start, chosen, size) => {
      if (chosen.length === size) {
        const p = parlay(chosen.map((l) => ({ fairProb: l.fairProb, price: l.fdPrice })));
        out.push({ legs: chosen.slice(), ...p });
        return;
      }
      for (let i = start; i < legs.length; i++) { chosen.push(legs[i]); combo(i + 1, chosen, size); chosen.pop(); }
    };
    sizes.forEach((s) => combo(0, [], s));
    return out.sort((a, b) => b.ev - a.ev).slice(0, top);
  }

  // Parlay of independent legs: legs [{ fairProb, price }]
  function parlay(legs, offeredAmerican) {
    const fairProb = legs.reduce((s, l) => s * l.fairProb, 1);
    const fdDec = legs.reduce((s, l) => s * amToDec(l.price), 1);
    const offeredDec = offeredAmerican != null && offeredAmerican !== '' ? amToDec(Number(offeredAmerican)) : fdDec;
    return { fairProb, fairAm: probToAm(fairProb), straightAm: decToAm(fdDec), offeredAm: decToAm(offeredDec), ev: fairProb * offeredDec - 1 };
  }

  const api = { amToDec, decToAm, amToProb, probToAm, fmtAm, noVig, ev, kelly, scanEvent, scanMilestones, milestoneProb, suggestParlays, parlay, outcomeKey, normCdf, normInv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OddsMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
