// ════════════════════════════════════════════════════════════════════
//  CodeForge — Unified Server  (server.js)
// ════════════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JUDGE0_URL = process.env.JUDGE0_URL || 'https://ce.judge0.com';
const JUDGE0_KEY = process.env.JUDGE0_KEY || '';

const SAFEPAY_SECRET_KEY = process.env.SAFEPAY_SECRET_KEY || '';
const SAFEPAY_PUBLISHABLE_KEY = process.env.SAFEPAY_PUBLISHABLE_KEY || '';
const SAFEPAY_ENV = process.env.SAFEPAY_ENV || 'sandbox';
const SAFEPAY_BASE = SAFEPAY_ENV === 'production'
  ? 'https://api.getsafepay.com'
  : 'https://sandbox.api.getsafepay.com';

const JUDGE0_LANG = {
  python: 71,
  cpp: 54,
  c: 50,
  java: 62,
};

// ════════════════════════════════════════════════════════════════════
//  MONGODB — Connect
// ════════════════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ════════════════════════════════════════════════════════════════════
//  MONGOOSE MODELS
// ════════════════════════════════════════════════════════════════════

// ── User ─────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  name: { type: String, default: '' },
  avatar: { type: String, default: '' },
  plan: { type: String, enum: ['free', 'pro'], default: 'free' },
  planActivatedAt: { type: Date, default: null },

  // Usage stats
  totalRuns: { type: Number, default: 0 },
  totalRoomsCreated: { type: Number, default: 0 },
  totalSessionMins: { type: Number, default: 0 },
  lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// ── Payment ───────────────────────────────────────────────────────────
const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tracker: { type: String, required: true, unique: true },
  amount: { type: Number, default: 280000 },   // paisas
  currency: { type: String, default: 'PKR' },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  paidAt: { type: Date, default: null },
  raw: { type: mongoose.Schema.Types.Mixed }, // full Safepay response
}, { timestamps: true });

const Payment = mongoose.model('Payment', paymentSchema);

// ════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '100kb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'codeforge_secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

app.use(passport.initialize());
app.use(passport.session());

// ════════════════════════════════════════════════════════════════════
//  PASSPORT — Google OAuth
// ════════════════════════════════════════════════════════════════════
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });

    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email: profile.emails?.[0]?.value || '',
        name: profile.displayName || '',
        avatar: profile.photos?.[0]?.value || '',
      });
      console.log(`✅ New user: ${user.email}`);
    } else {
      user.lastSeen = new Date();
      await user.save();
    }

    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// ════════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required' });
}

// ════════════════════════════════════════════════════════════════════
//  SERVE PUBLIC FOLDER
// ════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/plans.html?auth=failed' }),
  (req, res) => {
    res.redirect('/plans.html?auth=success');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── GET /api/me — current user info ──────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    name: req.user.name,
    email: req.user.email,
    avatar: req.user.avatar,
    plan: req.user.plan,
    totalRuns: req.user.totalRuns,
    joinedAt: req.user.createdAt,
  });
});

// ════════════════════════════════════════════════════════════════════
//  POST /api/run  —  Judge0 code execution
// ════════════════════════════════════════════════════════════════════
app.post('/api/run', async (req, res) => {
  const { code, language, stdin = '' } = req.body;

  if (!code || typeof code !== 'string')
    return res.status(400).send('No code provided.');
  if (!language || !JUDGE0_LANG[language])
    return res.status(400).send(`Language "${language}" is not supported.`);
  if (code.length > 50000)
    return res.status(400).send('Code too large. Maximum is 50 KB.');

  if (req.isAuthenticated()) {
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalRuns: 1 }, lastSeen: new Date() });
  }

  const useRapidApi = !!JUDGE0_KEY;
  const submitUrl = useRapidApi
    ? 'https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true'
    : `${JUDGE0_URL}/submissions?base64_encoded=false&wait=true`;

  const headers = { 'Content-Type': 'application/json' };
  if (useRapidApi) {
    headers['X-RapidAPI-Key'] = JUDGE0_KEY;
    headers['X-RapidAPI-Host'] = 'judge0-ce.p.rapidapi.com';
  }

  try {
    const submitRes = await fetch(submitUrl, {
      method: 'POST', headers,
      body: JSON.stringify({
        source_code: code,
        language_id: JUDGE0_LANG[language],
        stdin: stdin || '',
      }),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return res.status(502).send(`Judge0 error: ${errText}`);
    }

    const result = await submitRes.json();
    const output =
      result.stdout ||
      result.stderr ||
      result.compile_output ||
      result.message ||
      '(No output)';

    const isError = result.status?.id !== 3;
    return res.status(isError ? 400 : 200).send(output.trimEnd());

  } catch (err) {
    return res.status(500).send(`Runner error: ${err.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
//  SAFEPAY — Create checkout session
// ════════════════════════════════════════════════════════════════════
app.post('/api/create-safepay-session', requireAuth, async (req, res) => {
  if (!SAFEPAY_SECRET_KEY)
    return res.status(500).json({ error: 'Safepay not configured.' });

  if (req.user.plan === 'pro')
    return res.status(400).json({ error: 'Already on Pro plan.' });

  try {
    const trackerRes = await fetch(`${SAFEPAY_BASE}/order/v1/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SFPY-SECRET': SAFEPAY_SECRET_KEY,
      },
      body: JSON.stringify({
        plan_id: process.env.SAFEPAY_PLAN_ID,
        merchant_api_key: SAFEPAY_PUBLISHABLE_KEY,
        currency: 'PKR',
      }),
    });

    if (!trackerRes.ok) {
      const err = await trackerRes.text();
      console.error('❌ Safepay tracker error:', err);
      return res.status(502).json({ error: 'Failed to create tracker' });
    }

    const trackerData = await trackerRes.json();
    const tracker = trackerData.data?.tracker?.token;

    if (!tracker)
      return res.status(502).json({ error: 'No tracker returned' });

    await Payment.create({
      userId: req.user._id,
      tracker,
      amount: 280000,
      status: 'pending',
    });

    const checkoutBase = SAFEPAY_ENV === 'production'
      ? 'https://checkout.getsafepay.com'
      : 'https://sandbox.checkout.getsafepay.com';

    const params = new URLSearchParams({
      tracker,
      source: 'custom',
      cancel_url: `${BASE_URL}/plans.html?payment=cancelled`,
      redirect_url: `${BASE_URL}/plans.html?payment=success&tracker=${tracker}`,
    });

    const checkoutUrl = `${checkoutBase}/?${params.toString()}`;
    console.log(`✅ Safepay session — user: ${req.user.email}, tracker: ${tracker}`);

    return res.json({ tracker, checkoutUrl });

  } catch (err) {
    console.error('❌ Safepay session error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  SAFEPAY — Verify payment after redirect
// ════════════════════════════════════════════════════════════════════
app.get('/api/verify-safepay/:tracker', requireAuth, async (req, res) => {
  const { tracker } = req.params;

  try {
    const payment = await Payment.findOne({ tracker, userId: req.user._id });
    if (!payment)
      return res.status(404).json({ error: 'Payment not found' });

    if (payment.status === 'paid')
      return res.json({ paid: true, alreadyVerified: true });

    const verifyRes = await fetch(`${SAFEPAY_BASE}/order/v1/inquiry?tracker=${tracker}`, {
      headers: { 'X-SFPY-SECRET': SAFEPAY_SECRET_KEY },
    });

    if (!verifyRes.ok)
      return res.status(502).json({ error: 'Verification failed' });

    const data = await verifyRes.json();
    const state = data.data?.tracker?.state;
    const paid = state === 'PAID';

    if (paid) {
      await Payment.findOneAndUpdate(
        { tracker },
        { status: 'paid', paidAt: new Date(), raw: data }
      );
      await User.findByIdAndUpdate(req.user._id, {
        plan: 'pro',
        planActivatedAt: new Date(),
      });
      console.log(`🎉 Pro activated — user: ${req.user.email}`);
    }

    return res.json({ paid, state });

  } catch (err) {
    console.error('❌ Verify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  SAFEPAY — Webhook
// ════════════════════════════════════════════════════════════════════
app.post('/api/safepay-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const event = JSON.parse(req.body);
      console.log('📦 Safepay webhook:', event.type);

      if (event.type === 'subscription.paid') {
        const tracker = event.data?.tracker?.token;
        const payment = await Payment.findOne({ tracker });

        if (payment && payment.status !== 'paid') {
          await Payment.findOneAndUpdate(
            { tracker },
            { status: 'paid', paidAt: new Date(), raw: event.data }
          );
          await User.findByIdAndUpdate(payment.userId, {
            plan: 'pro',
            planActivatedAt: new Date(),
          });
          console.log(`✅ Webhook Pro activated — tracker: ${tracker}`);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(400);
    }
  }
);

// ════════════════════════════════════════════════════════════════════
//  In-memory room store
// ════════════════════════════════════════════════════════════════════
const rooms = {};

function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function makeRoomId() { return crypto.randomBytes(6).toString('hex'); }

app.post('/api/create-room', async (req, res) => {
  const { name, password } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required.' });

  const roomId = makeRoomId();
  const hostToken = makeToken();

  rooms[roomId] = {
    password: password || null,
    hostToken,
    hostName: name.trim(),
    editorOwner: null,
    code: '# Python\nprint("Hello, World!")\n',
    users: new Map(),
  };

  if (req.isAuthenticated()) {
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalRoomsCreated: 1 } });
  }

  const shareUrl = `${BASE_URL}/?room=${roomId}`;
  return res.json({ roomId, token: hostToken, shareUrl });
});

app.post('/api/join-room', (req, res) => {
  const { roomId, name, password } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required.' });
  if (!roomId)
    return res.status(400).json({ error: 'Room ID is required.' });

  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  if (room.password && room.password !== password)
    return res.status(403).json({ error: 'Wrong password.' });

  const token = makeToken();
  room._pendingTokens = room._pendingTokens || new Map();
  room._pendingTokens.set(token, name.trim());

  return res.json({ token });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════════════════
//  Socket.io
// ════════════════════════════════════════════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));

  for (const [roomId, room] of Object.entries(rooms)) {
    if (token === room.hostToken && !room._hostConnected) {
      socket._roomId = roomId;
      socket._isHost = true;
      socket._name = room.hostName;
      socket._token = token;
      room._hostConnected = true;
      return next();
    }
    if (room._pendingTokens?.has(token)) {
      socket._roomId = roomId;
      socket._isHost = false;
      socket._name = room._pendingTokens.get(token);
      socket._token = token;
      room._pendingTokens.delete(token);
      return next();
    }
  }
  return next(new Error('Invalid token'));
});

io.on('connection', (socket) => {
  const roomId = socket._roomId;
  const room = rooms[roomId];
  if (!room) return socket.disconnect();

  const name = socket._name;
  const isHost = socket._isHost;

  room.users.set(socket.id, { name, isHost, token: socket._token });
  if (isHost && !room.editorOwner) room.editorOwner = socket.id;
  socket.join(roomId);

  socket.emit('room-state', {
    yourSocketId: socket.id,
    editorOwner: room.editorOwner,
    code: room.code,
    users: serializeUsers(room),
  });

  socket.to(roomId).emit('user-joined', { socketId: socket.id, name, isHost });

  socket.on('code-change', ({ code }) => {
    if (room.editorOwner !== socket.id) return;
    room.code = code;
    socket.to(roomId).emit('code-update', { code });
  });

  socket.on('assign-editor', ({ toSocketId }) => {
    if (!isHost || !room.users.has(toSocketId)) return;
    room.editorOwner = toSocketId;
    io.to(roomId).emit('editor-assigned', { editorOwner: toSocketId });
  });

  socket.on('reclaim-editor', () => {
    if (!isHost) return;
    room.editorOwner = socket.id;
    io.to(roomId).emit('editor-assigned', { editorOwner: socket.id });
  });

  socket.on('request-editor', () => {
    const host = [...room.users.entries()].find(([, u]) => u.isHost);
    if (host) io.to(host[0]).emit('editor-request', { fromSocketId: socket.id, fromName: name });
  });

  socket.on('deny-editor-request', ({ toSocketId }) => {
    if (isHost) io.to(toSocketId).emit('editor-request-denied');
  });

  socket.on('rtc-offer', ({ to, offer }) => io.to(to).emit('rtc-offer', { from: socket.id, name, offer }));
  socket.on('rtc-answer', ({ to, answer }) => io.to(to).emit('rtc-answer', { from: socket.id, answer }));
  socket.on('rtc-ice', ({ to, candidate }) => io.to(to).emit('rtc-ice', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    room.users.delete(socket.id);
    if (room.editorOwner === socket.id) {
      const host = [...room.users.entries()].find(([, u]) => u.isHost);
      room.editorOwner = host ? host[0] : null;
      io.to(roomId).emit('editor-assigned', { editorOwner: room.editorOwner });
    }
    io.to(roomId).emit('user-left', { socketId: socket.id, name });
    if (room.users.size === 0) delete rooms[roomId];
  });
});

function serializeUsers(room) {
  return [...room.users.entries()].map(([socketId, u]) => ({
    socketId, name: u.name, isHost: u.isHost,
  }));
}

server.listen(PORT, () => {
  console.log(`✅ CodeForge  →  ${BASE_URL}`);
  console.log(`   Judge0:  ${JUDGE0_KEY ? 'RapidAPI ✓' : 'public (rate-limited)'}`);
  console.log(`   Safepay: ${SAFEPAY_SECRET_KEY ? `${SAFEPAY_ENV} ✓` : 'not configured'}`);
  console.log(`   MongoDB: connecting...`);
});