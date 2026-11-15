// Fake but realistically shaped Odds API data so the app can be tried without an API key.
(function (root) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = (s) => (rand() - 0.5) * 2 * s;
  const M = root.OddsMath || (typeof require !== 'undefined' ? require('./math.js') : null);

  const BOOKS = [
    ['fanduel', 'FanDuel', 0.045, 0.016], ['pinnacle', 'Pinnacle', 0.025, 0.006],
    ['draftkings', 'DraftKings', 0.045, 0.015], ['betmgm', 'BetMGM', 0.05, 0.018],
    ['williamhill_us', 'Caesars', 0.05, 0.018], ['espnbet', 'ESPN BET', 0.05, 0.02],
  ];
  const price = (p, vig, n) => M.probToAm(Math.min(0.97, Math.max(0.03, p * (1 + vig) + noise(n))));
  const twoWay = (p, vig, n) => [price(p, vig / 2, n), price(1 - p, vig / 2, n)];

  const GAMES = [
    ['basketball_nba', 'NBA', 'Indiana Pacers', 'Boston Celtics', 0.38, 4.5, 226.5],
    ['basketball_nba', 'NBA', 'Denver Nuggets', 'Phoenix Suns', 0.6, -4.5, 231.5],
    ['basketball_nba', 'NBA', 'Chicago Bulls', 'Milwaukee Bucks', 0.42, 3, 229],
    ['basketball_ncaab', 'NCAAB', 'Purdue Boilermakers', 'Marquette Golden Eagles', 0.58, -3.5, 148.5],
    ['basketball_ncaab', 'NCAAB', 'Indiana Hoosiers', 'Kentucky Wildcats', 0.47, 1, 152.5],
    ['americanfootball_nfl', 'NFL', 'Indianapolis Colts', 'Houston Texans', 0.52, -1.5, 44.5],
    ['americanfootball_nfl', 'NFL', 'Detroit Lions', 'Green Bay Packers', 0.64, -3.5, 49.5],
    ['americanfootball_ncaaf', 'NCAAF', 'Notre Dame Fighting Irish', 'USC Trojans', 0.71, -7.5, 55.5],
    ['americanfootball_ncaaf', 'NCAAF', 'Ohio State Buckeyes', 'Michigan Wolverines', 0.66, -6.5, 47.5],
  ];

  function events(sportKey) {
    seed = 7;
    const now = Date.now();
    return GAMES.map((g, i) => {
      const [sk, title, home, away, pHome, spread, total] = g;
      const bookmakers = BOOKS.map(([key, t, vig, n]) => {
        const ml = twoWay(pHome, vig, n);
        const sp = twoWay(0.5 + noise(0.01), vig, n);
        const to = twoWay(0.5 + noise(0.01), vig, n);
        return {
          key, title: t,
          markets: [
            { key: 'h2h', last_update: new Date(now - 60000).toISOString(), outcomes: [{ name: home, price: ml[0] }, { name: away, price: ml[1] }] },
            { key: 'spreads', last_update: new Date(now - 60000).toISOString(), outcomes: [{ name: home, price: sp[0], point: spread }, { name: away, price: sp[1], point: -spread }] },
            { key: 'totals', last_update: new Date(now - 60000).toISOString(), outcomes: [{ name: 'Over', price: to[0], point: total }, { name: 'Under', price: to[1], point: total }] },
          ],
        };
      });
      return { id: `demo${i}`, sport_key: sk, sport_title: title, home_team: home, away_team: away, commence_time: new Date(now + (i + 2) * 3600e3).toISOString(), bookmakers };
    }).filter((e) => !sportKey || e.sport_key === sportKey);
  }

  const PROP_PLAYERS = {
    basketball_nba: [['Tyrese Haliburton', 'player_points', 19.5], ['Tyrese Haliburton', 'player_assists', 9.5], ['Pascal Siakam', 'player_points', 21.5], ['Jayson Tatum', 'player_points', 27.5], ['Jayson Tatum', 'player_rebounds', 8.5], ['Jaylen Brown', 'player_threes', 2.5]],
    default: [['Starting QB', 'player_pass_yds', 239.5], ['Starting QB', 'player_pass_tds', 1.5], ['Lead RB', 'player_rush_yds', 64.5], ['WR1', 'player_reception_yds', 71.5], ['WR1', 'player_receptions', 5.5]],
  };

  function eventProps(event) {
    seed = 99 + event.id.length;
    const list = PROP_PLAYERS[event.sport_key] || PROP_PLAYERS.default;
    const bookmakers = BOOKS.map(([key, t, vig, n]) => {
      const markets = {};
      for (const [player, mk, line] of list) {
        const p = 0.5 + noise(0.04);
        const [o, u] = twoWay(p, vig * 1.3, n * 1.6);
        (markets[mk] = markets[mk] || { key: mk, last_update: new Date().toISOString(), outcomes: [] }).outcomes.push(
          { name: 'Over', description: player, price: o, point: line }, { name: 'Under', description: player, price: u, point: line });
      }
      // Milestone "X+" lines (Over only), priced off the main line with some book noise.
      for (const [player, mk, line] of list) {
        if (!['player_points', 'player_rush_yds', 'player_reception_yds'].includes(mk)) continue;
        const altKey = mk + '_alternate';
        const step = mk === 'player_points' ? 5 : 25;
        const alt = (markets[altKey] = markets[altKey] || { key: altKey, last_update: new Date().toISOString(), outcomes: [] });
        for (const n of [Math.round(line / step) * step - step, Math.round(line / step) * step, Math.round(line / step) * step + step]) {
          if (n <= 0) continue;
          const p = M.milestoneProb(altKey, line, 0.5, n - 0.5);
          alt.outcomes.push({ name: 'Over', description: player, price: price(p, vig * 1.6, n * 0 + (key === 'fanduel' ? 0.03 : 0.015)), point: n - 0.5 });
        }
      }
      return { key, title: t, markets: Object.values(markets) };
    });
    return { ...event, bookmakers };
  }

  const api = { events, eventProps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OddsDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
