const { evaluateGuess } = require('./wordle-logic.js');

// A handful of well-known "good opener" words real players favor - gives bots some personality
// instead of always starting from the exact same word.
const OPENERS = ['crane', 'slate', 'adieu', 'stare', 'roast', 'irate', 'arose', 'later', 'feast', 'toast'];

// How often a difficulty level "forgets" some of its own clues and guesses something looser
// than full deduction would allow - this is what actually controls how good the bot is,
// not just how fast it appears to think.
const DIFFICULTY = {
  easy:   { mistakeChance: 0.55, memoryDepth: 1 },  // mostly guesses, barely uses past clues
  medium: { mistakeChance: 0.20, memoryDepth: 3 },  // decent player, occasionally loses the thread
  hard:   { mistakeChance: 0,    memoryDepth: 99 }, // full deduction every time
};

function isConsistent(candidate, guess, result) {
  const r = evaluateGuess(guess, candidate);
  for (let i = 0; i < r.length; i++) if (r[i] !== result[i]) return false;
  return true;
}

// Narrows the candidate pool to only words consistent with what the bot has "remembered" -
// easy/medium bots only look at their most recent few guesses, not the full history,
// which is a very human way of being imperfect (forgetting an earlier clue).
function getCandidates(history, pool, memoryDepth) {
  if (history.length === 0) return pool;
  const recent = history.slice(-memoryDepth);
  const filtered = pool.filter(word => recent.every(h => isConsistent(word, h.guess, h.result)));
  return filtered.length > 0 ? filtered : pool; // safety fallback, shouldn't normally trigger
}

function pickBotGuess(history, pool, difficulty) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.medium;

  if (history.length === 0) {
    return { guess: OPENERS[Math.floor(Math.random() * OPENERS.length)], candidateCount: pool.length };
  }

  // A "mistake" guess: pick from words consistent with letter presence/absence only
  // (ignoring exact positions), which often produces a plausible-looking but suboptimal guess -
  // much more human than a totally random word, but clearly weaker than real deduction.
  if (Math.random() < cfg.mistakeChance) {
    const loose = pool.filter(word => {
      for (const h of history) {
        for (let i = 0; i < h.guess.length; i++) {
          const letter = h.guess[i];
          const wasAbsent = h.result[i] === 'gray' && !h.guess.split('').some((c, j) => c === letter && h.result[j] !== 'gray');
          if (wasAbsent && word.includes(letter)) return false;
        }
      }
      return true;
    });
    const pickFrom = loose.length > 0 ? loose : pool;
    const guess = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    return { guess, candidateCount: pickFrom.length };
  }

  const candidates = getCandidates(history, pool, cfg.memoryDepth);
  const guess = candidates[Math.floor(Math.random() * candidates.length)];
  return { guess, candidateCount: candidates.length };
}

// Human-ish pacing: a quick memorized opener, longer real thinking in the middle guesses,
// quicker again once there's barely anything left to consider. Easy bots ponder longer
// (less confident); hard bots are snappier (more confident).
function botDelayMs(guessNumber, candidateCount, difficulty) {
  const mult = difficulty === 'easy' ? 1.5 : (difficulty === 'hard' ? 0.75 : 1);
  let base;
  if (guessNumber === 0) base = 2500 + Math.random() * 3000;
  else if (candidateCount <= 2) base = 1800 + Math.random() * 2200;
  else if (candidateCount <= 8) base = 4000 + Math.random() * 5000;
  else base = 6000 + Math.random() * 8000;
  return base * mult;
}

module.exports = { pickBotGuess, botDelayMs, DIFFICULTY };
