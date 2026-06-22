// Core Wordle evaluation logic. The tricky part is duplicate letters:
// e.g. guess "SPEED" vs answer "ERASE" - the duplicate E's must be handled correctly,
// matching exactly the number of E's actually present in the answer, not more.

function evaluateGuess(guess, answer) {
  guess = guess.toLowerCase();
  answer = answer.toLowerCase();
  const len = answer.length;
  const result = new Array(len).fill('gray');
  const answerChars = answer.split('');
  const guessChars = guess.split('');

  // Pass 1: exact position matches (green) - consume those answer letters first
  for (let i = 0; i < len; i++) {
    if (guessChars[i] === answerChars[i]) {
      result[i] = 'green';
      answerChars[i] = null; // consumed, can't be matched again
      guessChars[i] = null; // mark as handled
    }
  }

  // Pass 2: remaining letters - yellow if present elsewhere in what's left of the answer
  for (let i = 0; i < len; i++) {
    if (guessChars[i] === null) continue; // already green
    const idx = answerChars.indexOf(guessChars[i]);
    if (idx !== -1) {
      result[i] = 'yellow';
      answerChars[idx] = null; // consume so it can't be double-counted
    }
  }

  return result;
}

function isSolved(result) {
  return result.every(r => r === 'green');
}

module.exports = { evaluateGuess, isSolved };
