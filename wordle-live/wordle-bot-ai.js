const { evaluateGuess } = require('./wordle-logic.js');

// A handful of well-known "good opener" words real players favor - gives bots some personality
// instead of always starting from the exact same word.
const OPENERS = ['crane', 'slate', 'adieu', 'stare', 'roast', 'irate', 'arose', 'later', 'feast', 'toast'];

function isConsistent(candidate, guess, result) {
  const r = evaluateGuess(guess, candidate);
  for (let i = 0; i < r.length; i++) if (r[i] !== result[i]) return false;
  return true;
}

// Narrows the candidate pool to only words consistent with everything the bot has learned
// so far from its own guesses - this is genuine deduction, not peeking at the answer.
function getCandidates(history, pool) {
  if (history.length === 0) return pool;
  const filtered = pool.filter(word => history.every(h => isConsistent(word, h.guess, h.result)));
  return filtered.length > 0 ? filtered : pool; // safety fallback, shouldn't normally trigger
}

function pickBotGuess(history, pool) {
  if (history.length === 0) {
    return { guess: OPENERS[Math.floor(Math.random() * OPENERS.length)], candidateCount: pool.length };
  }
  const candidates = getCandidates(history, pool);
  const guess = candidates[Math.floor(Math.random() * candidates.length)];
  return { guess, candidateCount: candidates.length };
}

// Human-ish pacing: a quick memorized opener, longer real thinking in the middle guesses,
// quicker again once there's barely anything left to consider.
function botDelayMs(guessNumber, candidateCount) {
  if (guessNumber === 0) return 2500 + Math.random() * 3000; // 2.5-5.5s
  if (candidateCount <= 2) return 1800 + Math.random() * 2200; // 1.8-4s, "got it"
  if (candidateCount <= 8) return 4000 + Math.random() * 5000; // 4-9s
  return 6000 + Math.random() * 8000; // 6-14s, genuinely thinking
}

module.exports = { pickBotGuess, botDelayMs };
