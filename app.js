/* Edge Finder — finds FanDuel prices that beat the sharp/consensus fair price. */
const M = window.OddsMath;
const API = 'https://api.the-odds-api.com/v4';
const SPORTS = {
  americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'NCAAF',
  basketball_nba: 'NBA', basketball_ncaab: 'NCAAB',
};
// 10 books = 1 "region" of quota. FanDuel is the target; the rest set the fair price.
const BOOKS = ['fanduel', 'pinnacle', 'draftkings', 'betmgm', 'williamhill_us', 'betrivers', 'espnbet', 'fanatics', 'lowvig', 'betonlineag'];
const PROP_MARKETS = {
  basketball_nba: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists', 'player_points_alternate', 'player_rebounds_alternate', 'player_assists_alternate', 'player_threes_alternate'],
  basketball_ncaab: ['player_points', 'player_rebounds', 'player_assists', 'player_threes'],
  americanfootball_nfl: ['player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_anytime_td', 'player_pass_yds_alternate', 'player_rush_yds_alternate', 'player_reception_yds_alternate', 'player_receptions_alternate'],
  americanfootball_ncaaf: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_pass_tds'],
};
const MARKET_LABEL = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ef.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ef.' + k, JSON.stringify(v)); } catch {} },
};
const DEFAULTS = { apiKey: '', bankroll: 500, kellyFraction: 0.25, maxStakePct: 3, minEV: 1, method: 'sharp-first', sports: Object.keys(SPORTS), includeLive: false, dailyLimit: 100 };
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let legs = store.get('legs', []);
let bets = store.get('bets', []);
let scanRows = store.get('lastScan', []);
let propRows = store.get('lastProps', []);
const demo = () => !settings.apiKey;

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const pct = (n) => (n * 100).toFixed(1) + '%';
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
function when(iso) {
  const d = new Date(iso); const today = new Date();
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
  return `${day} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function pickLabel(r) {
  const o = r.outcome; const pt = o.point != null ? (r.market === 'spreads' && o.point > 0 ? `+${o.point}` : o.point) : '';
  if (r.market === 'h2h') return `${o.name} ML`;
  if (r.market === 'spreads') return `${o.name} ${pt}`;
  if (r.market === 'totals') return `${o.name} ${pt}`;
  const stat = r.market.replace('player_', '').replace('_alternate', '').replace(/_/g, ' ');
  if (r.milestone) return `${o.description} ${Math.ceil(o.point)}+ ${stat}`;
  return `${o.description} ${o.name}${pt !== '' ? ' ' + pt : ''} ${stat}`;
}
const stakeFor = (fairProb, price) => {
  const f = M.kelly(fairProb, price, Number(settings.kellyFraction), Number(settings.maxStakePct) / 100);
  return Math.round(f * Number(settings.bankroll) * 100) / 100;
};
function todayStaked() {
  const t = new Date().toDateString();
  return bets.filter((b) => new Date(b.date).toDateString() === t).reduce((s, b) => s + b.stake, 0);
}

// ---------- API ----------
async function apiGet(path, params) {
  const url = new URL(API + path);
  Object.entries({ apiKey: settings.apiKey, ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining != null) { store.set('quota', { remaining, used: res.headers.get('x-requests-used'), at: Date.now() }); renderStatus(); }
  if (!res.ok) {
    let msg = `${res.status}`; try { msg = (await res.json()).message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const fetchOdds = (sport) => demo() ? Promise.resolve(OddsDemo.events(sport))
  : apiGet(`/sports/${sport}/odds`, { bookmakers: BOOKS.join(','), markets: 'h2h,spreads,totals', oddsFormat: 'american' });
const fetchEvents = (sport) => demo() ? Promise.resolve(OddsDemo.events(sport))
  : apiGet(`/sports/${sport}/events`, {});
const fetchEventProps = (sport, ev, markets) => demo() ? Promise.resolve(OddsDemo.eventProps(ev))
  : apiGet(`/sports/${sport}/events/${ev.id}/odds`, { bookmakers: BOOKS.join(','), markets: markets.join(','), oddsFormat: 'american' });

// ---------- scanning ----------
function scanOpts() { return { target: 'fanduel', sharp: ['pinnacle'], method: settings.method, minBooks: 2 }; }
function upcoming(events) {
  const now = Date.now();
  return settings.includeLive ? events : events.filter((e) => new Date(e.commence_time).getTime() > now);
}
function withMovement(rows) {
  const prev = store.get('lastFD', {}); const next = {};
  rows.forEach((r) => {
    const k = `${r.eventId}|${r.market}|${M.outcomeKey(r.outcome)}`;
    next[k] = r.fdPrice;
    if (prev[k] != null && prev[k] !== r.fdPrice) r.prevPrice = prev[k];
  });
  store.set('lastFD', { ...prev, ...next });
  return rows;
}

async function runScan() {
  const btn = $('#scanBtn'); btn.disabled = true; btn.textContent = 'Scanning…';
  const sports = settings.sports; const all = []; const errors = [];
  for (const s of sports) {
    try { const evs = upcoming(await fetchOdds(s)); evs.forEach((e) => all.push(...M.scanEvent(e, scanOpts()))); }
    catch (e) { errors.push(`${SPORTS[s]}: ${e.message}`); }
  }
  scanRows = withMovement(all).sort((a, b) => b.ev - a.ev);
  store.set('lastScan', scanRows); store.set('lastScanAt', Date.now());
  btn.disabled = false; btn.textContent = 'Scan game lines';
  if (errors.length) toast(errors.join(' · '));
  renderScan();
}

function card(r, where) {
  const pos = r.ev > 0; const stake = pos ? stakeFor(r.fairProb, r.fdPrice) : 0;
  const moved = r.prevPrice != null ? `<span class="moved">was ${M.fmtAm(r.prevPrice)}</span>` : '';
  return `<div class="card ${pos ? 'pos' : ''}">
    <div class="top"><span class="tag">${esc(SPORTS[r.sport] || r.sport)}</span><span class="muted small">${esc(r.away)} @ ${esc(r.home)} · ${when(r.commence)}</span></div>
    <div class="pick">${esc(pickLabel(r))}</div>
    <div class="nums">
      <div><b>${M.fmtAm(r.fdPrice)}</b><small>FanDuel ${moved}</small></div>
      <div><b>${M.fmtAm(r.fairAm)}</b><small>Fair (${esc(r.source)}${r.source === 'consensus' ? ', ' + r.books + ' books' : ''})</small></div>
      <div><b class="${pos ? 'good' : 'bad'}">${pos ? '+' : ''}${pct(r.ev)}</b><small>Edge</small></div>
      <div><b>${stake ? money(stake) : '—'}</b><small>Bet size</small></div>
    </div>
    <div class="actions">
      <button data-act="leg" data-where="${where}" data-id="${esc(rowId(r))}">+ Parlay</button>
      <button data-act="log" data-where="${where}" data-id="${esc(rowId(r))}">Log bet</button>
      <button data-act="fd" data-where="${where}" data-id="${esc(rowId(r))}" class="fd">Copy & open FanDuel</button>
    </div>
  </div>`;
}
const rowId = (r) => `${r.eventId}|${r.market}|${M.outcomeKey(r.outcome)}`;
const findRow = (where, id) => (where === 'props' ? propRows : scanRows).find((r) => rowId(r) === id);

function renderScan() {
  const sport = $('#fSport').value, market = $('#fMarket').value, posOnly = $('#fPos').checked;
  const min = Number(settings.minEV) / 100;
  const rows = scanRows.filter((r) => (!sport || r.sport === sport) && (!market || r.market === market) && (!posOnly || r.ev >= min));
  const at = store.get('lastScanAt');
  const nPos = scanRows.filter((r) => r.ev >= min).length;
  $('#scanInfo').textContent = at ? `Last scan ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${scanRows.length} FanDuel lines checked · ${nPos} with ${settings.minEV}%+ edge${demo() ? ' · DEMO DATA' : ''}` : 'Tap Scan to pull current lines.';
  $('#scanResults').innerHTML = rows.length ? rows.slice(0, 150).map((r) => card(r, 'scan')).join('') : (at ? '<p class="muted">Nothing clears your edge filter right now. That is normal; good edges are rare and short-lived.</p>' : '');
  $('#scanCost').textContent = demo() ? 'Demo mode' : `Uses ${settings.sports.length * 3} credits`;
}

// ---------- props ----------
let propEvents = [];
async function loadPropGames() {
  const sport = $('#pSport').value;
  try {
    propEvents = upcoming(await fetchEvents(sport));
    $('#pGame').innerHTML = propEvents.map((e) => `<option value="${esc(e.id)}">${esc(e.away_team)} @ ${esc(e.home_team)} · ${when(e.commence_time)}</option>`).join('') || '<option>No upcoming games</option>';
    $('#pGame').hidden = false;
    $('#pMarkets').innerHTML = (PROP_MARKETS[sport] || []).map((m, i) => `<label><input type="checkbox" value="${m}" ${i < 3 ? 'checked' : ''}> ${m.endsWith('_alternate') ? m.replace('player_', '').replace('_alternate', '').replace(/_/g, ' ') + ' X+' : m.replace('player_', '').replace(/_/g, ' ')}</label>`).join('');
    $('#pMarkets').hidden = false; $('#pScanBtn').hidden = false; updatePropCost();
  } catch (e) { toast('Could not load games: ' + e.message); }
}
const chosenPropMarkets = () => {
  const picked = [...document.querySelectorAll('#pMarkets input:checked')].map((i) => i.value);
  // Milestone (X+) lines are priced from the player's main line, so fetch that too.
  picked.filter((m) => m.endsWith('_alternate')).forEach((m) => { const main = m.replace('_alternate', ''); if (!picked.includes(main)) picked.push(main); });
  return picked;
};
function updatePropCost() { $('#pCost').textContent = demo() ? 'Demo mode' : `Up to ${chosenPropMarkets().length} credits`; }
async function runPropScan() {
  const sport = $('#pSport').value; const ev = propEvents.find((e) => e.id === $('#pGame').value);
  const markets = chosenPropMarkets(); if (!ev || !markets.length) return toast('Pick a game and at least one prop');
  const btn = $('#pScanBtn'); btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    const data = await fetchEventProps(sport, ev, markets);
    const seen = new Set();
    const rows = [...M.scanEvent(data, scanOpts()), ...M.scanMilestones(data, scanOpts())].filter((r) => { const k = rowId(r); if (seen.has(k)) return false; seen.add(k); return true; });
    propRows = withMovement(rows).sort((a, b) => b.ev - a.ev);
    store.set('lastProps', propRows);
    renderProps();
  } catch (e) { toast('Props failed: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Scan props';
}
function renderProps() {
  const min = Number(settings.minEV) / 100; const posOnly = $('#pPos').checked;
  const rows = propRows.filter((r) => !posOnly || r.ev >= min);
  $('#propsInfo').textContent = propRows.length ? `${propRows.length} FanDuel props checked · ${propRows.filter((r) => r.ev >= min).length} with ${settings.minEV}%+ edge${demo() ? ' · DEMO DATA' : ''}` : '';
  $('#propsResults').innerHTML = rows.map((r) => card(r, 'props')).join('') || (propRows.length ? '<p class="muted">No props clear your edge filter.</p>' : '');
}

// ---------- parlay ----------
function renderParlay() {
  $('#legCount').textContent = legs.length ? `(${legs.length})` : '';
  $('#legs').innerHTML = legs.map((l, i) => `<div class="leg"><div><b>${esc(l.label)}</b><div class="muted small">${M.fmtAm(l.price)} FD · fair ${M.fmtAm(M.probToAm(l.fairProb))} · ${esc(l.event)}</div></div><button data-rm="${i}">✕</button></div>`).join('') || '<p class="muted">No legs yet.</p>';
  if (legs.length < 2) { $('#parlayOut').innerHTML = ''; return; }
  const offered = $('#offered').value.trim();
  const p = M.parlay(legs, offered ? Number(offered.replace('+', '')) : null);
  const sameGame = new Set(legs.map((l) => l.eventId)).size < legs.length;
  $('#parlayOut').innerHTML = `
    <div class="nums">
      <div><b>${M.fmtAm(p.offeredAm)}</b><small>${offered ? 'FanDuel price' : 'Parlay price'}</small></div>
      <div><b>${M.fmtAm(p.fairAm)}</b><small>Fair price</small></div>
      <div><b class="${p.ev > 0 ? 'good' : 'bad'}">${p.ev > 0 ? '+' : ''}${pct(p.ev)}</b><small>Edge</small></div>
      <div><b>${pct(p.fairProb)}</b><small>Win chance</small></div>
    </div>
    ${sameGame ? '<p class="warn small">Two or more legs are from the same game. Those legs are correlated, so this fair price is only an estimate.</p>' : ''}
    ${p.ev <= 0 ? '<p class="warn small">This parlay is -EV: FanDuel\'s margin stacks with every leg.</p>' : ''}`;
}
function addLeg(r) {
  if (legs.some((l) => l.id === rowId(r))) return toast('Already in parlay');
  legs.push({ id: rowId(r), eventId: r.eventId, label: pickLabel(r), price: r.fdPrice, fairProb: r.fairProb, event: `${r.away} @ ${r.home}`, sport: r.sport });
  store.set('legs', legs); renderParlay(); toast('Added to parlay');
}

function renderSuggestions() {
  const size = Number($('#sugSize').value);
  const pool = [...scanRows, ...propRows];
  const list = M.suggestParlays(pool, { sizes: [size], minEV: Number(settings.minEV) / 100 });
  window._suggestions = list;
  $('#suggestions').innerHTML = list.length ? list.map((p, i) => `<div class="card pos">
      <div class="pick">${p.legs.length}-leg parlay · ${M.fmtAm(p.straightAm)}</div>
      ${p.legs.map((l) => `<div class="small">• ${esc(pickLabel(l))} <span class="muted">${M.fmtAm(l.fdPrice)} · ${esc(l.away)} @ ${esc(l.home)}</span></div>`).join('')}
      <div class="nums" style="margin-top:8px">
        <div><b>${M.fmtAm(p.fairAm)}</b><small>Fair price</small></div>
        <div><b class="good">+${pct(p.ev)}</b><small>Edge</small></div>
        <div><b>${pct(p.fairProb)}</b><small>Win chance</small></div>
        <div><b>${money(stakeFor(p.fairProb, p.straightAm))}</b><small>Bet size</small></div>
      </div>
      <div class="actions"><button data-sug="${i}" class="fd">Use these legs</button></div>
    </div>`).join('') : `<p class="muted">Not enough +EV legs from different games yet. Run Scan (and Props) first, or lower your minimum edge in Settings.</p>`;
}

// ---------- role risers ----------
let rGames = [], rResults = [], rLines = {}; // rLines[espnGameId] = { byPlayer: { norm: { main, mainOverP, alts: [{point, price}] } }, oddsEventId }
async function loadRiserGames() {
  try {
    rGames = await Risers.todaysGames();
    $('#rGames').innerHTML = rGames.map((g) => `<label><input type="checkbox" value="${g.id}" ${g.state === 'pre' ? 'checked' : ''}> ${esc(g.away.abbr)} @ ${esc(g.home.abbr)} <span class="muted">${g.state === 'pre' ? new Date(g.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : g.state === 'in' ? 'live' : 'final'}</span></label>`).join('') || '<p class="muted">No NBA games today.</p>';
    $('#rGames').hidden = false; $('#rFilters').hidden = !rGames.length;
  } catch (e) { toast('ESPN not reachable: ' + e.message); }
}
async function runRisers() {
  const ids = [...document.querySelectorAll('#rGames input:checked')].map((i) => i.value);
  const games = rGames.filter((g) => ids.includes(g.id));
  if (!games.length) return toast('Pick at least one game');
  const btn = $('#rScan'); btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    rResults = await Risers.scan(games, {
      maxPPG: Number($('#rMaxPPG').value) || 14, minMinUp: Number($('#rMinUp').value) || 0,
      onProgress: (d, n) => { $('#rInfo').textContent = `Checking players… ${d}/${n}`; },
    });
    $('#rInfo').textContent = `${rResults.length} risers found in ${games.length} game${games.length > 1 ? 's' : ''} · stats via ESPN`;
    renderRisers();
  } catch (e) { toast('Riser scan failed: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Find risers';
}
async function getRiserLines(espnGameId) {
  const g = rGames.find((x) => x.id === espnGameId); if (!g) return;
  if (demo()) return toast('Add your Odds API key in Settings to pull FanDuel lines');
  try {
    const events = await fetchEvents('basketball_nba');
    const ev = events.find((e) => Risers.nickname(e.home_team) === Risers.nickname(g.home.name) && Risers.nickname(e.away_team) === Risers.nickname(g.away.name));
    if (!ev) return toast('Could not match this game in the odds feed');
    const data = await fetchEventProps('basketball_nba', ev, ['player_points', 'player_points_alternate']);
    const byPlayer = {};
    for (const b of data.bookmakers || []) {
      for (const m of b.markets) {
        for (const o of m.outcomes) {
          const k = Risers.normName(o.description); const rec = (byPlayer[k] = byPlayer[k] || { alts: [], mains: [] });
          if (b.key === 'fanduel' && m.key === 'player_points_alternate' && o.name === 'Over') rec.alts.push({ point: o.point, price: o.price });
          if (b.key === 'fanduel' && m.key === 'player_points' && o.name === 'Over') rec.fdMain = { point: o.point, price: o.price };
        }
      }
    }
    // Market-based fair prices for the X+ lines, reusing the main scanner
    const msRows = M.scanMilestones(data, scanOpts());
    msRows.forEach((r) => { const rec = byPlayer[Risers.normName(r.outcome.description)]; if (rec) { const a = rec.alts.find((x) => x.point === r.outcome.point); if (a) a.marketFair = r.fairProb; } });
    rLines[espnGameId] = { byPlayer, ev };
    renderRisers();
  } catch (e) { toast('Lines failed: ' + e.message); }
}
function riserCard(p, idx) {
  const s = p.stats; const f1 = (x) => x.toFixed(1);
  const lines = rLines[p.game.id]; const rec = lines && lines.byPlayer[Risers.normName(p.name)];
  let linesHtml = '';
  if (lines && !rec) linesHtml = '<p class="muted small">No FanDuel points lines posted for him yet.</p>';
  if (rec) {
    const alts = rec.alts.filter((a) => a.point >= 4.5 && a.point <= 29.5).sort((a, b) => a.point - b.point).slice(0, 5);
    linesHtml = `${rec.fdMain ? `<div class="small">FanDuel line: <b>${rec.fdMain.point}</b> pts (${M.fmtAm(rec.fdMain.price)} over) · last-5 avg <b class="${s.recent.pts > rec.fdMain.point ? 'good' : ''}">${f1(s.recent.pts)}</b></div>` : ''}
      <table class="xt"><tr><th>Bet</th><th>FanDuel</th><th>Market fair</th><th>Form fair</th><th>Form edge</th><th></th></tr>
      ${alts.map((a, j) => {
        const fp = Risers.formProb(s.recent.pts, a.point); const edge = M.ev(fp, a.price);
        return `<tr><td>${Math.ceil(a.point)}+</td><td>${M.fmtAm(a.price)}</td><td>${a.marketFair ? M.fmtAm(M.probToAm(a.marketFair)) : '—'}</td><td>${M.fmtAm(M.probToAm(fp))}</td><td class="${edge > 0 ? 'good' : 'bad'}">${edge > 0 ? '+' : ''}${pct(edge)}</td><td><button data-rleg="${idx}|${a.point}">+</button></td></tr>`;
      }).join('')}</table>`;
  }
  const hit = (n) => s.last.filter((x) => x >= n).length;
  return `<div class="card">
    <div class="top"><span class="tag">${esc(p.team.abbr)}</span><span class="muted small">vs ${esc(p.opp.abbr)} · ${new Date(p.game.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>${p.status ? `<span class="tag warnbg">${esc(p.status.status)}</span>` : ''}</div>
    <div class="pick">${esc(p.name)} <span class="muted small">${esc(p.pos)}</span></div>
    <div class="nums">
      <div><b>${f1(s.before.min)} → ${f1(s.recent.min)}</b><small>Minutes (+${f1(s.minUp)})</small></div>
      <div><b>${f1(s.before.pts)} → ${f1(s.recent.pts)}</b><small>Points</small></div>
      <div><b>${f1(s.before.fga)} → ${f1(s.recent.fga)}</b><small>Shots (FGA)</small></div>
      <div><b>${hit(10)}/5</b><small>10+ pts last 5</small></div>
    </div>
    <div class="small muted" style="margin-top:6px">Last 5 (newest first): ${s.last.join(', ')} pts · ${s.lastMin.join(', ')} min</div>
    ${p.teammatesOut.length ? `<div class="small warn">Teammates out: ${p.teammatesOut.map((t) => esc(t.name)).join(', ')} (minutes may drop when they return)</div>` : ''}
    ${p.status?.note ? `<div class="small muted">${esc(p.status.note)}</div>` : ''}
    ${linesHtml}
    ${!lines ? `<div class="actions"><button data-rlines="${p.game.id}" class="fd">Get FanDuel lines for this game</button></div>` : ''}
  </div>`;
}
function renderRisers() {
  $('#rResults').innerHTML = rResults.map(riserCard).join('') || (rResults && $('#rInfo').textContent.includes('found') ? '<p class="muted">No one fits those filters. Try a lower minutes increase or a higher max PPG.</p>' : '');
}
function addRiserLeg(idx, point) {
  const p = rResults[idx]; const rec = rLines[p.game.id].byPlayer[Risers.normName(p.name)];
  const a = rec.alts.find((x) => x.point === point); const fp = Risers.formProb(p.stats.recent.pts, point);
  addLeg({ eventId: 'espn' + p.game.id, sport: 'basketball_nba', home: p.game.home.name, away: p.game.away.name, market: 'player_points_alternate', milestone: true, outcome: { name: 'Over', description: p.name, point }, fdPrice: a.price, fairProb: fp, ev: M.ev(fp, a.price) });
}

// ---------- bets ----------
function logBet(entry) {
  const suggested = entry.stake || 0;
  const input = prompt(`Stake for:\n${entry.pick} ${M.fmtAm(entry.price)}\n\nSuggested: ${money(suggested)}`, suggested ? suggested.toFixed(2) : '');
  if (input == null) return;
  const stake = Number(input); if (!(stake > 0)) return toast('Enter a stake');
  if (todayStaked() + stake > Number(settings.dailyLimit)) {
    if (!confirm(`This puts you over your ${money(Number(settings.dailyLimit))} daily limit. Log anyway?`)) return;
  }
  bets.unshift({ id: Date.now(), date: new Date().toISOString(), status: 'open', ...entry, stake });
  store.set('bets', bets); renderBets(); toast('Bet logged');
}
function betProfit(b) { if (b.status === 'won') return b.stake * (M.amToDec(b.price) - 1); if (b.status === 'lost') return -b.stake; return 0; }
function renderBets() {
  const settled = bets.filter((b) => ['won', 'lost', 'push'].includes(b.status));
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const profit = settled.reduce((s, b) => s + betProfit(b), 0);
  const expected = settled.reduce((s, b) => s + b.stake * (b.ev || 0), 0);
  const wins = settled.filter((b) => b.status === 'won').length, losses = settled.filter((b) => b.status === 'lost').length;
  $('#betSummary').innerHTML = `
    <div><b>${wins}-${losses}</b><small>Record</small></div>
    <div><b class="${profit >= 0 ? 'good' : 'bad'}">${money(profit)}</b><small>Profit</small></div>
    <div><b>${staked ? pct(profit / staked) : '—'}</b><small>ROI</small></div>
    <div><b>${money(expected)}</b><small>Expected profit</small></div>
    <div><b>${money(bets.filter((b) => b.status === 'open').reduce((s, b) => s + b.stake, 0))}</b><small>Open action</small></div>
    <div><b>${money(todayStaked())} / ${money(Number(settings.dailyLimit))}</b><small>Today vs limit</small></div>`;
  $('#betList').innerHTML = bets.map((b) => `<div class="bet ${b.status}">
    <div><b>${esc(b.pick)}</b> <span class="muted">${M.fmtAm(b.price)}</span>
      <div class="muted small">${esc(b.event || '')} · ${new Date(b.date).toLocaleDateString()} · ${money(b.stake)} · edge ${b.ev != null ? pct(b.ev) : '—'}</div></div>
    <div class="status-btns">${['won', 'lost', 'push', 'open'].map((s) => `<button data-bet="${b.id}" data-status="${s}" class="${b.status === s ? 'on' : ''}">${s}</button>`).join('')}<button data-del="${b.id}">✕</button></div>
  </div>`).join('') || '<p class="muted">No bets logged yet. Results here show whether your edge is real over time; give it 100+ bets before judging.</p>';
}
function exportBets() {
  const head = ['date', 'sport', 'event', 'pick', 'price', 'stake', 'fair_prob', 'edge', 'status', 'profit'];
  const lines = bets.map((b) => [b.date, b.sport, b.event, b.pick, b.price, b.stake, b.fairProb, b.ev, b.status, betProfit(b).toFixed(2)].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bets.csv'; a.click();
}

// ---------- settings / status ----------
function renderSettings() {
  const f = $('#settingsForm');
  ['apiKey', 'bankroll', 'kellyFraction', 'maxStakePct', 'minEV', 'method', 'dailyLimit'].forEach((k) => (f.elements[k].value = settings[k]));
  f.elements.includeLive.checked = !!settings.includeLive;
  $('#sportChecks').innerHTML = Object.entries(SPORTS).map(([k, v]) => `<label><input type="checkbox" value="${k}" ${settings.sports.includes(k) ? 'checked' : ''}> ${v}</label>`).join('');
  const q = store.get('quota');
  $('#quota').textContent = q ? `API credits remaining: ${q.remaining} (used ${q.used}) as of ${new Date(q.at).toLocaleString()}` : '';
}
function renderStatus() {
  const q = store.get('quota');
  $('#status').textContent = demo() ? 'DEMO' : q ? `${q.remaining} credits` : 'Live';
  $('#status').className = 'status ' + (demo() ? 'demo' : '');
}

// ---------- wiring ----------
function init() {
  Object.entries(SPORTS).forEach(([k, v]) => {
    $('#fSport').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
    $('#pSport').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
  });
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button, .tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); $('#' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'bets') renderBets(); if (b.dataset.tab === 'parlay') renderParlay();
  }));
  $('#scanBtn').addEventListener('click', runScan);
  ['#fSport', '#fMarket', '#fPos'].forEach((s) => $(s).addEventListener('change', renderScan));
  $('#pLoadGames').addEventListener('click', loadPropGames);
  $('#pMarkets').addEventListener('change', updatePropCost);
  $('#pScanBtn').addEventListener('click', runPropScan);
  $('#pPos').addEventListener('change', renderProps);

  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.act) {
      const r = findRow(t.dataset.where, t.dataset.id); if (!r) return;
      if (t.dataset.act === 'leg') addLeg(r);
      if (t.dataset.act === 'log') logBet({ sport: r.sport, event: `${r.away} @ ${r.home}`, pick: pickLabel(r), price: r.fdPrice, fairProb: r.fairProb, ev: r.ev, stake: r.ev > 0 ? stakeFor(r.fairProb, r.fdPrice) : 0 });
      if (t.dataset.act === 'fd') {
        try { await navigator.clipboard.writeText(`${pickLabel(r)} ${M.fmtAm(r.fdPrice)}`); } catch {}
        window.open('https://sportsbook.fanduel.com/', '_blank');
      }
    }
    if (t.dataset.sug != null) {
      const p = window._suggestions[Number(t.dataset.sug)];
      legs = []; p.legs.forEach((r) => legs.push({ id: rowId(r), eventId: r.eventId, label: pickLabel(r), price: r.fdPrice, fairProb: r.fairProb, event: `${r.away} @ ${r.home}`, sport: r.sport }));
      store.set('legs', legs); $('#offered').value = ''; renderParlay(); window.scrollTo(0, 0); toast('Legs loaded — check them in FanDuel');
    }
    if (t.dataset.rlines) getRiserLines(t.dataset.rlines);
    if (t.dataset.rleg) { const [i, pt] = t.dataset.rleg.split('|'); addRiserLeg(Number(i), Number(pt)); }
    if (t.dataset.rm != null) { legs.splice(Number(t.dataset.rm), 1); store.set('legs', legs); renderParlay(); }
    if (t.dataset.bet) { const b = bets.find((x) => x.id === Number(t.dataset.bet)); b.status = t.dataset.status; store.set('bets', bets); renderBets(); }
    if (t.dataset.del) { if (confirm('Delete this bet?')) { bets = bets.filter((x) => x.id !== Number(t.dataset.del)); store.set('bets', bets); renderBets(); } }
  });
  $('#offered').addEventListener('input', renderParlay);
  $('#sugBtn').addEventListener('click', renderSuggestions);
  $('#rLoad').addEventListener('click', loadRiserGames);
  $('#rScan').addEventListener('click', runRisers);
  $('#clearLegs').addEventListener('click', () => { legs = []; store.set('legs', legs); renderParlay(); });
  $('#logParlay').addEventListener('click', () => {
    if (legs.length < 2) return toast('Add at least 2 legs');
    const offered = $('#offered').value.trim();
    const p = M.parlay(legs, offered ? Number(offered.replace('+', '')) : null);
    logBet({ sport: 'parlay', event: legs.map((l) => l.event).join(' / '), pick: `${legs.length}-leg parlay: ${legs.map((l) => l.label).join(' + ')}`, price: p.offeredAm, fairProb: p.fairProb, ev: p.ev, stake: p.ev > 0 ? stakeFor(p.fairProb, p.offeredAm) : 0 });
  });
  $('#exportBets').addEventListener('click', exportBets);
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    settings = {
      ...settings, apiKey: f.elements.apiKey.value.trim(), bankroll: Number(f.elements.bankroll.value) || 0,
      kellyFraction: Number(f.elements.kellyFraction.value), maxStakePct: Number(f.elements.maxStakePct.value) || 3,
      minEV: Number(f.elements.minEV.value) || 0, method: f.elements.method.value, includeLive: f.elements.includeLive.checked,
      dailyLimit: Number(f.elements.dailyLimit.value) || 0,
      sports: [...document.querySelectorAll('#sportChecks input:checked')].map((i) => i.value),
    };
    store.set('settings', settings); renderStatus(); renderScan(); toast('Saved');
  });

  renderSettings(); renderStatus(); renderScan(); renderParlay();
}
init();
