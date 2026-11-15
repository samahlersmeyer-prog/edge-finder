# Edge Finder

Finds FanDuel lines priced better than the "true" price, then sizes and tracks the bets.

- **Fair price**: Pinnacle's no-vig line when available, otherwise the no-vig average of other US books.
- **Edge (EV)** = fair win probability × FanDuel decimal odds − 1.
- **Bet size** = fractional Kelly, capped at a max % of bankroll.
- **Data**: The Odds API (the-odds-api.com). Paste your key in Settings; it's stored only in your browser. With no key, the app runs on demo data.

Credit cost (free tier = 500/month): a game-line scan costs 3 credits per sport. A props scan costs 1 credit per prop market, per game.

No build step: it's static files, so you can host it on GitHub Pages.
