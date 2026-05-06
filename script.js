// ════════════════════════════════════════════════════════════════════
//  CodeForge — Unified Server (Clean Version)
// ════════════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
  });
});

const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JUDGE0_URL = process.env.JUDGE0_URL || 'https://ce.judge0.com';
const JUDGE0_KEY = process.env.JUDGE0_KEY || '';

const JUDGE0_LANG = {
  python: 71,
  cpp:    54,
  c:      50,
  java:   62,
};

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════
//  CODE EXECUTION
// ════════════════════════════════════════════════════════
app.post('/api/run', async (req, res) => {
  const { code, language, stdin = '' } = req.body;

  if (!code || typeof code !== 'string')
    return res.status(400).send('No code provided.');
  if (!language || !JUDGE0_LANG[language])
    return res.status(400).send('Language not supported.');
  if (code.length > 50000)
    return res.status(400).send('Code too large (max 50KB).');

  const useRapidApi = !!JUDGE0_KEY;
  const submitUrl   = useRapidApi
    ? 'https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true'
    : `${JUDGE0_URL}/submissions?base64_encoded=false&wait=true`;

  const headers = { 'Content-Type': 'application/json' };
  if (useRapidApi) {
    headers['X-RapidAPI-Key']  = JUDGE0_KEY;
    headers['X-RapidAPI-Host'] = 'judge0-ce.p.rapidapi.com';
  }

  try {
    const response = await fetch(submitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source_code: code,
        language_id: JUDGE0_LANG[language],
        stdin,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).send(`Judge0 error: ${err}`);
    }

    const result = await response.json();
    const output =
      result.stdout         ||
      result.stderr         ||
      result.compile_output ||
      result.message        ||
      '(No output)';

    return res.status(result.status?.id !== 3 ? 400 : 200).send(output.trimEnd());
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// ════════════════════════════════════════════════════════
//  IN-MEMORY ROOMS
// ════════════════════════════════════════════════════════
const rooms = {};

function makeToken()  { return crypto.randomBytes(24).toString('hex'); }
function makeRoomId() { return crypto.randomBytes(6).toString('hex');  }

app.post('/api/create-room', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim())
    return res.status(400).json({ error: 'Name required' });

  const roomId    = makeRoomId();
  const hostToken = makeToken();

  rooms[roomId] = {
    hostToken,
    hostName:    name.trim(),
    editorOwner: null,
    code:        '# Python\nprint("Hello, World!")\n',
    users:       new Map(),
  };

  res.json({ roomId, token: hostToken, shareUrl: `${BASE_URL}/?room=${roomId}` });
});

app.post('/api/join-room', (req, res) => {
  const { roomId, name } = req.body;
  if (!roomId || !name)
    return res.status(400).json({ error: 'Missing data' });

  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const token = makeToken();
  room._pendingTokens = room._pendingTokens || new Map();
  room._pendingTokens.set(token, name.trim());

  res.json({ token });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════
//  SOCKET.IO AUTH
// ════════════════════════════════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));

  for (const [roomId, room] of Object.entries(rooms)) {
    if (token === room.hostToken && !room._hostConnected) {
      socket._roomId = roomId;
      socket._isHost = true;
      socket._name   = room.hostName;
      room._hostConnected = true;
      return next();
    }
    if (room._pendingTokens?.has(token)) {
      socket._roomId = roomId;
      socket._isHost = false;
      socket._name   = room._pendingTokens.get(token);
      room._pendingTokens.delete(token);
      return next();
    }
  }

  return next(new Error('Invalid token'));
});

// ════════════════════════════════════════════════════════
//  SOCKET.IO EVENTS
// ════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  const roomId = socket._roomId;
  const room   = rooms[roomId];
  if (!room) return socket.disconnect();

  const name   = socket._name;
  const isHost = socket._isHost;

  room.users.set(socket.id, { name, isHost });
  if (isHost && !room.editorOwner) room.editorOwner = socket.id;

  socket.join(roomId);

  // Send full room state to the joining user
  socket.emit('room-state', {
    yourSocketId: socket.id,
    editorOwner:  room.editorOwner,
    code:         room.code,
    users: [...room.users.entries()].map(([id, u]) => ({
      socketId: id,
      name:     u.name,
      isHost:   u.isHost,
    })),
  });

  // Notify everyone else
  socket.to(roomId).emit('user-joined', { socketId: socket.id, name, isHost });

  // ── Code sync ─────────────────────────────────────────
  socket.on('code-change', ({ code }) => {
    if (room.editorOwner !== socket.id) return;
    room.code = code;
    socket.to(roomId).emit('code-update', { code });
  });

  // ── Editor control ────────────────────────────────────

  // Host assigns editor to a member
  socket.on('assign-editor', ({ toSocketId }) => {
    if (!isHost) return;
    if (!room.users.has(toSocketId)) return;
    room.editorOwner = toSocketId;
    io.to(roomId).emit('editor-assigned', { editorOwner: toSocketId });
  });

  // Host reclaims editor back to themselves
  socket.on('reclaim-editor', () => {
    if (!isHost) return;
    room.editorOwner = socket.id;
    io.to(roomId).emit('editor-assigned', { editorOwner: socket.id });
  });

  // Member requests editor access from host
  socket.on('request-editor', () => {
    const host = [...room.users.entries()].find(([, u]) => u.isHost);
    if (host) {
      io.to(host[0]).emit('editor-request', {
        fromSocketId: socket.id,
        fromName:     name,
      });
    }
  });

  // Host denies a member's request
  socket.on('deny-editor-request', ({ toSocketId }) => {
    if (!isHost) return;
    io.to(toSocketId).emit('editor-request-denied');
  });

  // 👈 Member hands editor back to host (or any target)
  socket.on('return-editor', ({ toSocketId }) => {
    // Only the current editor can hand it back
    if (room.editorOwner !== socket.id) return;
    if (!room.users.has(toSocketId)) return;
    room.editorOwner = toSocketId;
    io.to(roomId).emit('editor-assigned', { editorOwner: toSocketId });
  });

  // ── WebRTC signaling ──────────────────────────────────
  socket.on('rtc-offer',  ({ to, offer })     => io.to(to).emit('rtc-offer',  { from: socket.id, name, offer }));
  socket.on('rtc-answer', ({ to, answer })    => io.to(to).emit('rtc-answer', { from: socket.id, answer }));
  socket.on('rtc-ice',    ({ to, candidate }) => io.to(to).emit('rtc-ice',    { from: socket.id, candidate }));

  // ── Disconnect ────────────────────────────────────────
  socket.on('disconnect', () => {
    room.users.delete(socket.id);

    if (room.editorOwner === socket.id) {
      // Pass editor to host, or first available user
      const host = [...room.users.entries()].find(([, u]) => u.isHost);
      const next = host || [...room.users.entries()][0];
      room.editorOwner = next ? next[0] : null;
      io.to(roomId).emit('editor-assigned', { editorOwner: room.editorOwner });
    }

    io.to(roomId).emit('user-left', { socketId: socket.id, name });

    if (room.users.size === 0) delete rooms[roomId];
  });
});

// Serve landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Catch-all still serves index.html for the editor
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`✅ CodeForge running → ${BASE_URL}`);
  console.log(`   Judge0: ${JUDGE0_KEY ? 'RapidAPI ✓' : 'Public API'}`);
});