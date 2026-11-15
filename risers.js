/* Role Risers — finds role players whose minutes and scoring are climbing faster than their prop lines.
   Data: ESPN's public (unofficial) NBA feeds. Free, no key. Odds: The Odds API (optional, per game). */
(function (root) {
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
  const ESPN_LOG = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes';

  const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');
  const nickname = (team) => String(team || '').trim().split(/\s+/).pop().toLowerCase();
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  // Parse an ESPN gamelog payload into [{ id, date, min, pts, fga, tpa }], newest first.
  function parseGamelog(g) {
    const labels = g.labels || [];
    const ix = (l) => labels.indexOf(l);
    const iMin = ix('MIN'), iPts = ix('PTS'), iFg = ix('FG'), i3 = ix('3PT');
    const st = (g.seasonTypes || []).find((s) => /Regular Season/i.test(s.displayName)) || (g.seasonTypes || [])[0];
    if (!st) return [];
    const games = [];
    for (const c of st.categories || []) {
      for (const e of c.events || []) {
        const s = e.stats || [];
        if (!s.length) continue;
        const meta = (g.events || {})[e.eventId] || {};
        games.push({
          id: e.eventId, date: meta.gameDate || '', opp: meta.opponent?.abbreviation || '',
          min: Number(s[iMin]) || 0, pts: Number(s[iPts]) || 0,
          fga: Number(String(s[iFg] || '0-0').split('-')[1]) || 0,
          tpa: Number(String(s[i3] || '0-0').split('-')[1]) || 0,
        });
      }
    }
    const seen = new Set();
    return games.filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => b.date.localeCompare(a.date));
  }

  // Compare the last N games against everything before them.
  function riserStats(games, n = 5) {
    const recent = games.slice(0, n), before = games.slice(n);
    if (recent.length < 3 || before.length < 3) return null;
    const pick = (arr, k) => avg(arr.map((x) => x[k]));
    const r = { min: pick(recent, 'min'), pts: pick(recent, 'pts'), fga: pick(recent, 'fga'), tpa: pick(recent, 'tpa') };
    const b = { min: pick(before, 'min'), pts: pick(before, 'pts'), fga: pick(before, 'fga'), tpa: pick(before, 'tpa') };
    const season = { pts: pick(games, 'pts'), min: pick(games, 'min') };
    return {
      recent: r, before: b, season, last: recent.map((x) => x.pts), lastMin: recent.map((x) => x.min),
      minUp: r.min - b.min, ptsUp: r.pts - b.pts, fgaUp: r.fga - b.fga,
      score: (r.min - b.min) + (r.pts - b.pts) + 0.5 * (r.fga - b.fga),
      games: games.length,
    };
  }

  // Probability of reaching X+ points if he keeps scoring like his last 5 (normal approx).
  function formProb(recentPts, point) {
    const sd = 0.28 * Math.max(recentPts, 4) + 2.5;
    return 1 - root.OddsMath.normCdf((point - recentPts) / sd);
  }

  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }

  async function pool(items, limit, fn, onProgress) {
    const out = []; let i = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } onProgress && onProgress(++done, items.length); }
    }));
    return out;
  }

  async function todaysGames() {
    const j = await getJSON(`${ESPN}/scoreboard`);
    return (j.events || []).map((e) => {
      const c = e.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === 'home'), away = c.competitors.find((x) => x.homeAway === 'away');
      return {
        id: e.id, date: e.date, state: e.status?.type?.state, // pre | in | post
        home: { id: home.team.id, abbr: home.team.abbreviation, name: home.team.displayName },
        away: { id: away.team.id, abbr: away.team.abbreviation, name: away.team.displayName },
      };
    });
  }

  async function injuries() {
    const j = await getJSON(`${ESPN}/injuries`);
    const byPlayer = {}, byTeam = {};
    for (const t of j.injuries || []) {
      for (const inj of t.injuries || []) {
        const name = inj.athlete?.displayName || inj.displayName || '';
        const status = inj.status || inj.type?.description || '';
        const item = { name, status, note: inj.shortComment || '' };
        byPlayer[normName(name)] = item;
        (byTeam[t.displayName] = byTeam[t.displayName] || []).push(item);
      }
    }
    return { byPlayer, byTeam };
  }

  // Cache compact game logs per player per day so re-runs are instant.
  function cachedLog(id) {
    try { const c = JSON.parse(localStorage.getItem('ef.glog.' + id) || 'null'); if (c && c.day === new Date().toDateString()) return c.games; } catch {}
    return null;
  }
  function saveLog(id, games) { try { localStorage.setItem('ef.glog.' + id, JSON.stringify({ day: new Date().toDateString(), games })); } catch {} }

  async function playerLog(id) {
    const c = cachedLog(id); if (c) return c;
    const games = parseGamelog(await getJSON(`${ESPN_LOG}/${id}/gamelog`));
    saveLog(id, games);
    return games;
  }

  /** Scan the chosen games. opts: { maxPPG, minMinUp, onProgress } */
  async function scan(games, opts = {}) {
    const maxPPG = opts.maxPPG ?? 14, minMinUp = opts.minMinUp ?? 3;
    const inj = await injuries().catch(() => ({ byPlayer: {}, byTeam: {} }));
    const teams = [];
    games.forEach((g) => { teams.push({ team: g.home, game: g, opp: g.away }); teams.push({ team: g.away, game: g, opp: g.home }); });
    const rosters = await pool(teams, 6, async (t) => (await getJSON(`${ESPN}/teams/${t.team.id}/roster`)).athletes || []);
    const players = [];
    teams.forEach((t, i) => (rosters[i] || []).forEach((a) => players.push({ id: a.id, name: a.displayName, pos: a.position?.abbreviation || '', ...t })));
    const logs = await pool(players, 8, (p) => playerLog(p.id), opts.onProgress);
    const out = [];
    players.forEach((p, i) => {
      const s = logs[i] && riserStats(logs[i]);
      if (!s) return;
      if (s.season.pts > maxPPG || s.minUp < minMinUp || s.recent.pts <= s.before.pts) return;
      const status = inj.byPlayer[normName(p.name)];
      if (status && /out/i.test(status.status)) return; // he's not playing
      const teammatesOut = (inj.byTeam[p.team.name] || []).filter((x) => /out/i.test(x.status) && normName(x.name) !== normName(p.name));
      out.push({ ...p, stats: s, status, teammatesOut });
    });
    return out.sort((a, b) => b.stats.score - a.stats.score);
  }

  const api = { scan, todaysGames, parseGamelog, riserStats, formProb, normName, nickname };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Risers = api;
})(typeof window !== 'undefined' ? window : globalThis);
