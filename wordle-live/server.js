const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWebSocketServer } = require('./ws-server.js');
const { evaluateGuess, isSolved } = require('./wordle-logic.js');
const { pickBotGuess, botDelayMs } = require('./wordle-bot-ai.js');
const { ANSWERS, GUESS_SET } = require('./words.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 1; // allow solo practice too
const MAX_GUESSES = 6;
const WORD_LEN = 5;
const DEFAULT_ROUND_MS = 3 * 60 * 1000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (server kept running):', err);
});

// ===================== ROOM STATE =====================
const rooms = new Map();

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
function genToken() { return crypto.randomBytes(12).toString('hex'); }

function createRoom() {
  const code = genRoomCode();
  const room = {
    code,
    players: [], // { seatIndex, name, token, connId, score }
    settings: { roundMinutes: 3, totalRounds: 5 },
    phase: 'lobby', // lobby | racing | round-over
    roundNumber: 0,
    currentAnswer: null,
    roundDeadline: null,
    usedAnswers: new Set(),
    playerStates: {}, // seatIndex -> { guesses: [{guess, result}], solved, finishedAt, startedAt }
    pendingTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function findPlayerBySeat(room, seatIndex) {
  return room.players.find(p => p.seatIndex === seatIndex);
}
function nextSeatIndex(room) {
  let i = 0;
  while (room.players.some(p => p.seatIndex === i)) i++;
  return i;
}

// ===================== CONNECTIONS =====================
let connCounter = 1;
const connections = new Map();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function sendError(ws, message) { send(ws, { type: 'error', message }); }

// ===================== ROUND LOGIC =====================
function pickAnswer(room) {
  let pool = ANSWERS.filter(w => !room.usedAnswers.has(w));
  if (pool.length === 0) { room.usedAnswers.clear(); pool = ANSWERS; }
  const word = pool[crypto.randomInt(pool.length)];
  room.usedAnswers.add(word);
  return word;
}

function clearPendingTimer(room) {
  if (room.pendingTimer) { clearTimeout(room.pendingTimer); room.pendingTimer = null; }
}

function activePlayers(room) {
  return room.players.filter(p => !p.removed);
}

function startRound(room) {
  clearPendingTimer(room);
  room.roundNumber += 1;
  room.currentAnswer = pickAnswer(room);
  console.log(`[room ${room.code}] round ${room.roundNumber} word: ${room.currentAnswer}`);
  room.phase = 'racing';
  const roundMs = Math.max(1, Number(room.settings.roundMinutes) || 3) * 60 * 1000;
  room.roundDeadline = Date.now() + roundMs;
  room.playerStates = {};
  for (const p of activePlayers(room)) {
    room.playerStates[p.seatIndex] = { guesses: [], solved: false, finishedAt: null, startedAt: Date.now() };
  }
  room.pendingTimer = setTimeout(() => {
    try { endRound(room); } catch (err) { console.error('Round timeout error in room', room.code, err); }
  }, roundMs);
  for (const p of activePlayers(room)) {
    if (p.isBot) scheduleBotGuess(room, p);
  }
  broadcast(room);
}

function allFinished(room) {
  const active = activePlayers(room);
  if (active.length === 0) return false;
  return active.every(p => {
    const st = room.playerStates[p.seatIndex];
    return st && st.finishedAt != null;
  });
}

function endRound(room) {
  clearPendingTimer(room);
  if (room.phase !== 'racing') return;
  room.phase = 'round-over';

  // Anyone still mid-round when time runs out is marked DNF now.
  for (const p of activePlayers(room)) {
    const st = room.playerStates[p.seatIndex];
    if (st && st.finishedAt == null) st.finishedAt = Date.now();
  }

  // Rank: solved players first (fewer guesses wins, then faster time), then DNF players.
  const results = activePlayers(room).map(p => {
    const st = room.playerStates[p.seatIndex];
    return { seatIndex: p.seatIndex, name: p.name, solved: st.solved, guessCount: st.guesses.length, timeMs: st.finishedAt - st.startedAt };
  });
  results.sort((a, b) => {
    if (a.solved !== b.solved) return a.solved ? -1 : 1;
    if (a.solved) {
      if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
      return a.timeMs - b.timeMs;
    }
    return 0;
  });
  const solvedCount = results.filter(r => r.solved).length;
  results.forEach((r, i) => {
    const points = r.solved ? Math.max(1, solvedCount - i) : 0;
    r.points = points;
    const player = findPlayerBySeat(room, r.seatIndex);
    if (player) {
      player.score = (player.score || 0) + points;
      player.totalGuesses = (player.totalGuesses || 0) + r.guessCount;
      player.totalTimeMs = (player.totalTimeMs || 0) + r.timeMs;
    }
  });
  room.lastRoundResults = results;
  room.gameOver = room.roundNumber >= (room.settings.totalRounds || 5);
  if (room.gameOver) {
    room.finalStandings = activePlayers(room).map(p => ({
      seatIndex: p.seatIndex, name: p.name,
      score: p.score || 0, totalGuesses: p.totalGuesses || 0, totalTimeMs: p.totalTimeMs || 0,
    })).sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.totalGuesses !== b.totalGuesses) return a.totalGuesses - b.totalGuesses;
      return a.totalTimeMs - b.totalTimeMs;
    });
  }
  clearBotTimers(room);
  broadcast(room);
}

// Core guess processing, shared by real players (via WS) and bots (via timer).
// Returns null on success, or an error string.
function processGuess(room, player, rawGuess) {
  const st = room.playerStates[player.seatIndex];
  if (!st) return 'no active board';
  if (st.solved || st.finishedAt != null || st.guesses.length >= MAX_GUESSES) return 'already finished';

  const guess = String(rawGuess || '').trim().toLowerCase();
  if (guess.length !== WORD_LEN || !/^[a-z]+$/.test(guess)) return 'Guess must be a 5-letter word.';
  if (!GUESS_SET.has(guess)) return "That's not in the word list.";

  const result = evaluateGuess(guess, room.currentAnswer);
  st.guesses.push({ guess, result });
  if (isSolved(result)) {
    st.solved = true;
    st.finishedAt = Date.now();
  } else if (st.guesses.length >= MAX_GUESSES) {
    st.finishedAt = Date.now();
  }
  return null;
}

function scheduleBotGuess(room, player) {
  const st = room.playerStates[player.seatIndex];
  if (!st || st.solved || st.finishedAt != null || room.phase !== 'racing') return;
  const history = st.guesses;
  const { guess, candidateCount } = pickBotGuess(history, ANSWERS);
  const delay = botDelayMs(history.length, candidateCount);
  const timer = setTimeout(() => {
    try {
      if (room.phase !== 'racing') return;
      const st2 = room.playerStates[player.seatIndex];
      if (!st2 || st2.solved || st2.finishedAt != null) return;
      processGuess(room, player, guess);
      broadcast(room);
      if (allFinished(room)) { endRound(room); return; }
      scheduleBotGuess(room, player);
    } catch (err) {
      console.error('Bot guess error in room', room.code, err);
    }
  }, delay);
  room.botTimers = room.botTimers || {};
  room.botTimers[player.seatIndex] = timer;
}

function clearBotTimers(room) {
  if (!room.botTimers) return;
  for (const seat in room.botTimers) clearTimeout(room.botTimers[seat]);
  room.botTimers = {};
}

// ===================== SERIALIZATION =====================
function publicPlayerView(room, p) {
  const st = room.playerStates[p.seatIndex];
  const view = {
    seatIndex: p.seatIndex, name: p.name, isBot: !!p.isBot, connected: p.isBot ? true : !!p.connId,
    score: p.score || 0, totalGuesses: p.totalGuesses || 0, totalTimeMs: p.totalTimeMs || 0,
  };
  if (room.phase !== 'lobby' && st) {
    view.guessCount = st.guesses.length;
    view.solved = st.solved;
    view.finished = st.finishedAt != null;
    view.patterns = st.guesses.map(g => g.result); // colors only, never the letters, for opponents watching live
  }
  return view;
}

function buildPublicState(room) {
  const base = {
    type: 'state',
    roomCode: room.code,
    phase: room.phase,
    settings: room.settings,
    roundNumber: room.roundNumber,
    roundDeadline: room.phase === 'racing' ? room.roundDeadline : null,
    players: room.players.slice().sort((a, b) => a.seatIndex - b.seatIndex).map(p => publicPlayerView(room, p)),
  };
  if (room.phase === 'round-over') {
    base.lastRoundResults = room.lastRoundResults || [];
    base.answer = room.currentAnswer;
    base.gameOver = !!room.gameOver;
    base.finalStandings = room.finalStandings || null;
  }
  return base;
}

function buildYouState(room, player) {
  const st = room.playerStates[player.seatIndex];
  const you = { type: 'you', seatIndex: player.seatIndex, token: player.token, name: player.name };
  if (room.phase !== 'lobby' && st) {
    you.guesses = st.guesses; // includes actual letters + result for the player's own board
    you.solved = st.solved;
    you.finished = st.finishedAt != null;
    you.canGuess = room.phase === 'racing' && !st.solved && st.guesses.length < MAX_GUESSES && st.finishedAt == null;
  } else {
    you.guesses = []; you.solved = false; you.finished = false; you.canGuess = false;
  }
  return you;
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const pub = buildPublicState(room);
  for (const p of room.players) {
    if (!p.connId) continue;
    const conn = connections.get(p.connId);
    if (!conn) continue;
    send(conn.ws, pub);
    send(conn.ws, buildYouState(room, p));
  }
}

// ===================== MESSAGE HANDLERS =====================
async function handleMessage(connId, raw) {
  const conn = connections.get(connId);
  if (!conn) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return sendError(conn.ws, 'Bad message'); }
  if (!msg || typeof msg.type !== 'string') return;

  try {
    switch (msg.type) {
      case 'create_room': return onCreateRoom(connId, msg);
      case 'join_room': return onJoinRoom(connId, msg);
      case 'update_settings': return onUpdateSettings(connId, msg);
      case 'start_round': return onStartRound(connId, msg);
      case 'new_game': return onNewGame(connId, msg);
      case 'submit_guess': return onSubmitGuess(connId, msg);
      case 'remove_player': return onRemovePlayer(connId, msg);
      case 'add_bot': return onAddBot(connId, msg);
      case 'leave_room': return onLeaveRoom(connId, msg);
      case 'ping': return;
    }
  } catch (err) {
    console.error('Error handling message type', msg.type, err);
    sendError(conn.ws, 'Something went wrong with that action - please try again.');
  }
}

function onCreateRoom(connId, msg) {
  const conn = connections.get(connId);
  const room = createRoom();
  const name = String(msg.name || '').trim().slice(0, 18) || 'Player 1';
  const token = genToken();
  const player = { seatIndex: 0, name, token, connId, score: 0, removed: false };
  room.players.push(player);
  conn.roomCode = room.code;
  conn.seatIndex = 0;
  send(conn.ws, { type: 'joined', roomCode: room.code, token, seatIndex: 0 });
  broadcast(room);
}

function onJoinRoom(connId, msg) {
  const conn = connections.get(connId);
  const code = String(msg.roomCode || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(conn.ws, 'Room not found. Check the code and try again.');

  if (msg.token) {
    const existing = room.players.find(p => p.token === msg.token);
    if (existing) {
      existing.connId = connId;
      conn.roomCode = room.code;
      conn.seatIndex = existing.seatIndex;
      send(conn.ws, { type: 'joined', roomCode: room.code, token: existing.token, seatIndex: existing.seatIndex });
      broadcast(room);
      return;
    }
  }

  // rejoin-by-name fallback if the round's already started and the token is gone
  const typedName = String(msg.name || '').trim().toLowerCase();
  if (typedName) {
    const reclaimable = room.players.find(p => !p.isBot && !p.connId && p.name.trim().toLowerCase() === typedName);
    if (reclaimable) {
      reclaimable.token = genToken();
      reclaimable.connId = connId;
      conn.roomCode = room.code;
      conn.seatIndex = reclaimable.seatIndex;
      send(conn.ws, { type: 'joined', roomCode: room.code, token: reclaimable.token, seatIndex: reclaimable.seatIndex });
      broadcast(room);
      return;
    }
  }

  const activeCount = activePlayers(room).length;
  if (activeCount >= MAX_PLAYERS) return sendError(conn.ws, 'This room is full.');

  const name = String(msg.name || '').trim().slice(0, 18) || ('Player ' + (activeCount + 1));
  const seatIndex = nextSeatIndex(room);
  const token = genToken();
  const player = { seatIndex, name, token, connId, score: 0, removed: false };
  room.players.push(player);
  conn.roomCode = room.code;
  conn.seatIndex = seatIndex;
  // joining mid-race: give them a fresh board for the CURRENT round if it's racing
  if (room.phase === 'racing') {
    room.playerStates[seatIndex] = { guesses: [], solved: false, finishedAt: null, startedAt: Date.now() };
  }
  send(conn.ws, { type: 'joined', roomCode: room.code, token, seatIndex });
  broadcast(room);
}

function onUpdateSettings(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  const s = msg.settings || {};
  if (Number.isFinite(s.roundMinutes) && s.roundMinutes >= 1 && s.roundMinutes <= 15) {
    room.settings.roundMinutes = Math.floor(s.roundMinutes);
  }
  if (Number.isFinite(s.totalRounds) && s.totalRounds >= 1 && s.totalRounds <= 20) {
    room.settings.totalRounds = Math.floor(s.totalRounds);
  }
  broadcast(room);
}

function onStartRound(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  if (room.phase === 'racing') return;
  if (room.gameOver) return sendError(conn.ws, 'This game is over - start a new game to play again.');
  if (activePlayers(room).length < MIN_PLAYERS) return sendError(conn.ws, 'Need at least one player.');
  startRound(room);
}

function onNewGame(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || !room.gameOver) return;
  clearBotTimers(room);
  room.roundNumber = 0;
  room.gameOver = false;
  room.lastRoundResults = null;
  room.finalStandings = null;
  room.usedAnswers.clear();
  room.phase = 'lobby';
  for (const p of room.players) { p.score = 0; p.totalGuesses = 0; p.totalTimeMs = 0; }
  broadcast(room);
}

function onSubmitGuess(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'racing') return;
  const player = findPlayerBySeat(room, conn.seatIndex);
  if (!player) return;

  const err = processGuess(room, player, msg.guess);
  if (err && err !== 'already finished' && err !== 'no active board') return sendError(conn.ws, err);
  if (err) return;

  broadcast(room);
  if (allFinished(room)) endRound(room);
}

function onRemovePlayer(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  room.players = room.players.filter(p => p.seatIndex !== msg.seatIndex);
  broadcast(room);
}

function onAddBot(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  if (activePlayers(room).length >= MAX_PLAYERS) return sendError(conn.ws, 'This room is full.');
  const seatIndex = nextSeatIndex(room);
  const botNames = ['Rex', 'Nova', 'Echo', 'Sable', 'Jett', 'Lucky', 'Diesel', 'Spark'];
  const name = 'Bot ' + botNames[seatIndex % botNames.length];
  room.players.push({ seatIndex, name, isBot: true, token: null, connId: null, score: 0, totalGuesses: 0, totalTimeMs: 0, removed: false });
  broadcast(room);
}

function onLeaveRoom(connId) { disconnectFromRoom(connId); }

function disconnectFromRoom(connId) {
  const conn = connections.get(connId);
  if (!conn || !conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  const player = findPlayerBySeat(room, conn.seatIndex);
  if (player) {
    player.connId = null;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.seatIndex !== conn.seatIndex);
    }
  }
  broadcast(room);
  maybeCleanupRoom(room);
}

function maybeCleanupRoom(room) {
  const anyoneConnected = room.players.some(p => p.connId);
  if (!anyoneConnected) {
    clearPendingTimer(room);
    clearBotTimers(room);
    rooms.delete(room.code);
  }
}

// ===================== HTTP + STATIC FILES =====================
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = attachWebSocketServer(server, { path: '/ws' });

wss.on('connection', (ws) => {
  const connId = connCounter++;
  connections.set(connId, { ws, roomCode: null, seatIndex: null });
  ws.on('message', (raw) => { handleMessage(connId, raw).catch(err => console.error('Unhandled error in handleMessage:', err)); });
  ws.on('close', () => {
    disconnectFromRoom(connId);
    connections.delete(connId);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = room.players.some(p => p.connId);
    if (!anyoneConnected && now - room.lastActivity > 5 * 60 * 1000) {
      clearPendingTimer(room);
      clearBotTimers(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Wordle Royale LIVE server running on port ${PORT}`);
});
