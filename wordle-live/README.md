# Wordle Royale — Live

Same word, same moment, everyone racing live on their own phone. First to solve wins
the round; cumulative points carry across rounds for a running leaderboard.

Zero npm dependencies — same architecture as the poker app, so the deploy process is
identical if you've already done it once.

## How to play

1. One person opens the link, taps **Create a Room**, gets a 4-letter code.
2. Everyone else opens the same link, taps **Join a Room**, enters their name + that code.
3. Anyone can tap **Start Race** once everyone's in. Everyone gets the same secret
   5-letter word at the same time, 6 guesses, with a countdown timer per round
   (default 3 minutes, adjustable in the lobby).
4. You see your own letters and colors as you type. You only ever see *how many*
   guesses opponents have used and the color pattern of their past guesses (green/
   yellow/gray) — never their actual letters, so there's no spoiler risk.
5. Whoever solves it in the fewest guesses (fastest as tiebreaker) ranks #1 for the
   round and gets the most points. Scores carry over — tap the trophy icon any time
   to see the running leaderboard.
6. If someone gets disconnected mid-race, they can rejoin with the room code + the
   exact same name they used before, same as the poker app.

## Deploying it (same steps as the poker app)

**Option A — tonight only, no accounts:** run `node server.js` on your laptop, then
use `cloudflared tunnel --url http://localhost:3000` for a free temporary public link.
See the poker app's README for the exact install steps if you need a refresher.

**Option B — permanent free link:** push this folder to a GitHub repo (drag-and-drop
upload works fine, no git command line needed), then connect it on Render.com as a
new Web Service (free tier, no card). Same exact process you already did for the
poker app.

## What's inside

- `server.js` — rooms, live races, scoring, reconnection, crash-hardened the same way
  the poker server is (one bad message can't take down everyone else's game)
- `wordle-logic.js` — the guess-evaluation engine (green/yellow/gray, with correct
  handling of duplicate letters) — tested against 5,000+ randomized cases
- `words.js` — ~650 curated common words used as secret answers, ~4,400 words accepted
  as valid guesses (built from a standard English dictionary, family-filtered)
- `ws-server.js` — the same dependency-free WebSocket server from the poker app
- `public/index.html` — everything players see in their browser
