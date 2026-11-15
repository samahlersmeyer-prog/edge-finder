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

  // Parlay of independent legs: legs [{ fairProb, price }]
  function parlay(legs, offeredAmerican) {
    const fairProb = legs.reduce((s, l) => s * l.fairProb, 1);
    const fdDec = legs.reduce((s, l) => s * amToDec(l.price), 1);
    const offeredDec = offeredAmerican != null && offeredAmerican !== '' ? amToDec(Number(offeredAmerican)) : fdDec;
    return { fairProb, fairAm: probToAm(fairProb), straightAm: decToAm(fdDec), offeredAm: decToAm(offeredDec), ev: fairProb * offeredDec - 1 };
  }

  const api = { amToDec, decToAm, amToProb, probToAm, fmtAm, noVig, ev, kelly, scanEvent, parlay, outcomeKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OddsMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
