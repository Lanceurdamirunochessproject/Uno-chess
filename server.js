
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const cors = require("cors");
const { Chess } = require("chess.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const tokenTableReady = pool.query(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  )
`);
const app = express();
const server = http.createServer(app);

const FRONTEND_URL =
  "https://lanceurdamirunochessproject.github.io";

app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));


const sessionMiddleware = session({
  store: new PgSession({
    pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
sameSite: "none",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});
app.use((req, res, next) => {
  console.log("REQUÊTE HTTP REÇUE :", req.method, req.url);
  next();
});
app.use(sessionMiddleware);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

const waitingPlayers = new Map();
const activeRooms = new Map();
const socketUsers = new Map();

const COLORS = ["rouge", "jaune", "vert", "bleu"];

async function requireLogin(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;

    let userId = null;

    if (token) {
      await tokenTableReady;

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const result = await pool.query(
        `SELECT user_id
         FROM auth_tokens
         WHERE token_hash = $1
         AND expires_at > NOW()`,
        [tokenHash]
      );
console.log("AUTH TOKEN TROUVÉ :", result.rows.length);
      if (result.rows.length) {
        userId = result.rows[0].user_id;
      }
    }

    if (!userId && req.session.userId) {
      userId = req.session.userId;
    }

    if (!userId) {
      return res.status(401).json({
        error: "Tu dois être connecté."
      });
    }

    req.userId = userId;
    next();

  } catch (error) {
    console.error("Erreur authentification :", error);

    res.status(500).json({
      error: "Erreur lors de la vérification de la connexion."
    });
  }
}
/* =====================================================
   KILO
   ===================================================== */

function calculateKiloChange(winnerKilo, loserKilo) {
  const difference = Math.abs(
    Number(winnerKilo) - Number(loserKilo)
  );

  return Math.min(
    100,
    10 + Math.floor(difference / 100) * 10
  );
}

async function settleMatch(matchId, winnerId, loserId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, player1, player2, status
       FROM matches
       WHERE id = $1
       FOR UPDATE`,
      [matchId]
    );

    if (!result.rows.length) {
      throw new Error("Partie introuvable.");
    }

    const match = result.rows[0];

    if (match.status !== "pending") {
      throw new Error("Partie déjà terminée.");
    }

    const validPlayers =
      (
        Number(match.player1) === Number(winnerId) &&
        Number(match.player2) === Number(loserId)
      ) ||
      (
        Number(match.player2) === Number(winnerId) &&
        Number(match.player1) === Number(loserId)
      );

    if (!validPlayers) {
      throw new Error("Joueurs invalides.");
    }

    const users = await client.query(
      `SELECT id, kilo
       FROM users
       WHERE id = ANY($1::integer[])
       ORDER BY id
       FOR UPDATE`,
      [[Number(winnerId), Number(loserId)]]
    );

    if (users.rows.length !== 2) {
      throw new Error("Joueur introuvable.");
    }

    const winner = users.rows.find(
      u => Number(u.id) === Number(winnerId)
    );

    const loser = users.rows.find(
      u => Number(u.id) === Number(loserId)
    );

    const gain = calculateKiloChange(
      winner.kilo,
      loser.kilo
    );

    const loss = Math.min(gain, Number(loser.kilo));

    await client.query(
      "UPDATE users SET kilo = kilo + $1 WHERE id = $2",
      [gain, winnerId]
    );

    await client.query(
      "UPDATE users SET kilo = GREATEST(0, kilo - $1) WHERE id = $2",
      [loss, loserId]
    );

    await client.query(
      `UPDATE matches
       SET winner = $1,
           status = 'finished',
           settled_at = CURRENT_TIMESTAMP,
           kilo_change = $2
       WHERE id = $3`,
      [winnerId, gain, matchId]
    );

    await client.query("COMMIT");

    return { gain, loss };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finishDraw(matchId) {
  await pool.query(
    `UPDATE matches
     SET status = 'finished',
         winner = NULL,
         settled_at = CURRENT_TIMESTAMP,
         kilo_change = 0
     WHERE id = $1 AND status = 'pending'`,
    [matchId]
  );
}

async function abandonMatch(matchId) {
  await pool.query(
    `UPDATE matches
     SET status = 'abandoned',
         settled_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'`,
    [matchId]
  );
}

/* =====================================================
   BASE DE DONNÉES
   ===================================================== */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      kilo INTEGER NOT NULL DEFAULT 1000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
    ON users (LOWER(username))
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      player1 INTEGER NOT NULL REFERENCES users(id),
      player2 INTEGER NOT NULL REFERENCES users(id),
      winner INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
  `);

  await pool.query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS kilo_change INTEGER
  `);
  
   await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sender_id, receiver_id),
      CHECK(sender_id <> receiver_id),
      CHECK(status IN ('pending', 'accepted', 'rejected'))
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/* =====================================================
   COMPTES
   ===================================================== */

/* =====================================================
   COMPTES
   ===================================================== */

app.get("/", (req, res) => {
  res.send("UNO CHESS server is running!");
});

app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Informations invalides."
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({
        error: "Adresse email invalide."
      });
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Pseudo : 3 à 20 caractères, lettres, chiffres ou _."
      });
    }

    if (password.length < 8 || password.length > 100) {
      return res.status(400).json({
        error: "Mot de passe : 8 à 100 caractères."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, kilo`,
      [cleanEmail, cleanUsername, hash]
    );

    req.session.userId = result.rows[0].id;

    res.status(201).json({
      user: result.rows[0]
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Cet email ou ce pseudo est déjà utilisé."
      });
    }

    console.error(error);
    res.status(500).json({ error: "Erreur du serveur." });
  }
});

const activeTokens = new Map();
app.post("/api/login", async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Informations invalides."
      });
    }

    const result = await pool.query(
      `SELECT id, username, kilo, password_hash
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Email ou mot de passe incorrect."
      });
    }

    const user = result.rows[0];

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Email ou mot de passe incorrect."
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    req.session.userId = user.id;
const token = crypto.randomBytes(32).toString("hex");
await tokenTableReady;

const tokenHash = crypto
  .createHash("sha256")
  .update(token)
  .digest("hex");

const tokenDuration = rememberMe === true
  ? 30 * 24 * 60 * 60 * 1000
  : 7 * 24 * 60 * 60 * 1000;

await pool.query(
  `INSERT INTO auth_tokens (token_hash, user_id, expires_at)
   VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
   ON CONFLICT (token_hash)
   DO UPDATE SET user_id = EXCLUDED.user_id,
                 expires_at = EXCLUDED.expires_at`,
  [tokenHash, user.id, tokenDuration]
);
    req.session.cookie.maxAge = rememberMe === true
      ? 30 * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;

    req.session.save(error => {
      if (error) {
        console.error("Erreur sauvegarde session :", error);

        return res.status(500).json({
          error: "Impossible de finaliser la connexion."
        });
      }

     res.json({
  token: token,
  user: {
    id: user.id,
    username: user.username,
    kilo: user.kilo
  }
});
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    console.log("SESSION /api/me :", req.session.userId);
    console.log("TOKEN REÇU :", req.headers.authorization ? "OUI" : "NON");
   if (!req.userId) {
  return res.status(401).json({
    error: "Tu n'es pas connecté."
  });
}

    const result = await pool.query(
      `SELECT id, username, kilo
       FROM users
       WHERE id = $1`,
  [req.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Compte introuvable."
      });
    }

    res.json({
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Erreur /api/me :", error);
    res.status(500).json({
      error: "Erreur lors du chargement du profil."
    });
  }
});
app.post("/api/change-username", requireLogin, async (req, res) => {
  try {
    const username = req.body.username;

    if (
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_]{3,20}$/.test(username.trim())
    ) {
      return res.status(400).json({
        error: "Pseudo invalide : 3 à 20 caractères."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET username = $1
       WHERE id = $2
       RETURNING id, username, kilo`,
      [username.trim(), req.userId]
    );

    res.json({ user: result.rows[0] });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Ce pseudo est déjà utilisé."
      });
    }

    console.error(error);
    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});
app.post("/api/change-password", requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 100
    ) {
      return res.status(400).json({
        error: "Le nouveau mot de passe doit contenir entre 8 et 100 caractères."
      });
    }

    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Compte introuvable." });
    }

    const valid = await bcrypt.compare(
      currentPassword,
      result.rows[0].password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Mot de passe actuel incorrect."
      });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [hash, req.userId]
    );

    res.json({ message: "Mot de passe modifié avec succès !" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur du serveur." });
  }
});
app.post("/api/change-password", requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 100
    ) {
      return res.status(400).json({
        error: "Le nouveau mot de passe doit contenir entre 8 et 100 caractères."
      });
    }

    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Compte introuvable." });
    }

    const valid = await bcrypt.compare(
      currentPassword,
      result.rows[0].password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Mot de passe actuel incorrect."
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [hashedPassword, req.userId]
    );

    res.json({ message: "Mot de passe modifié avec succès !" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur du serveur." });
  }
});
/* NOUVELLE ROUTE DU CLASSEMENT */

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, kilo
       FROM users
       ORDER BY kilo DESC, username ASC
       LIMIT 50`
    );

    res.json({
      leaderboard: result.rows
    });

  } catch (error) {
    console.error("Erreur classement :", error);
    res.status(500).json({
      error: "Impossible de charger le classement."
    });
  }
});
/* =====================================================
   MESSAGES PRIVÉS
   ===================================================== */

app.post("/api/messages", requireLogin, async (req, res) => {
  try {
    const receiverId = Number(req.body.receiverId);
    const content = req.body.content;

    if (
      !Number.isInteger(receiverId) ||
      receiverId <= 0 ||
   receiverId === Number(req.userId) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.trim().length > 1000
    ) {
      return res.status(400).json({
        error: "Message invalide."
      });
    }

 
    const result = await pool.query(
      `INSERT INTO private_messages
       (sender_id, receiver_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, receiver_id, content, created_at`,
      [
      Number(req.userId),
        receiverId,
        content.trim()
      ]
    );

    res.status(201).json({
      message: result.rows[0]
    });

  } catch (error) {
    console.error("Erreur envoi DM :", error);

    res.status(500).json({
      error: "Impossible d'envoyer le message."
    });
  }
});
app.get("/api/messages/:friendId", requireLogin, async (req, res) => {
  try {
    const userId = Number(req.userId);
    const friendId = Number(req.params.friendId);

    if (
      !Number.isInteger(friendId) ||
      friendId <= 0 ||
      friendId === userId
    ) {
      return res.status(400).json({
        error: "Joueur invalide."
      });
    }

  

    const result = await pool.query(
      `SELECT id, sender_id, receiver_id, content, created_at
       FROM private_messages
       WHERE
         (sender_id = $1 AND receiver_id = $2)
         OR
         (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at ASC, id ASC
       LIMIT 200`,
      [userId, friendId]
    );

    res.json({
      messages: result.rows
    });

  } catch (error) {
    console.error("Erreur lecture DM :", error);

    res.status(500).json({
      error: "Impossible de charger la conversation."
    });
  }
});

app.get("/api/inbox", requireLogin, async (req, res) => {
  try {
    const userId = Number(req.userId);

    const result = await pool.query(
      `SELECT DISTINCT ON (u.id)
         u.id AS sender_id,
         u.username,
         pm.content,
         pm.created_at
       FROM private_messages pm
       JOIN users u ON u.id = pm.sender_id
       WHERE pm.receiver_id = $1
       ORDER BY u.id, pm.created_at DESC, pm.id DESC`,
      [userId]
    );

    res.json({
      messages: result.rows
    });

  } catch (error) {
    console.error("Erreur boîte de réception :", error);

    res.status(500).json({
      error: "Impossible de charger la boîte de réception."
    });
  }
});

/* =====================================================
   CARTES UNO CÔTÉ SERVEUR
   ===================================================== */

function makeDeck() {
  const deck = [];

  for (const color of COLORS) {
    for (let n = 0; n <= 9; n++) {
      deck.push({ value: String(n), color });
    }

    for (const value of ["+2", "↔", "PASSE"]) {
      deck.push({ value, color });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ value: "JOKER", color: "joker" });
    deck.push({ value: "+4", color: "joker" });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function drawCard(match) {
  if (match.deck.length === 0) {
    match.deck = makeDeck();
  }

  return match.deck.pop();
}

function cardMatches(card, match) {
  return !!card && (
    card.color === "joker" ||
    card.color === match.activeColor ||
    card.value === match.discard.value
  );
}

function allowedPiece(card, piece) {
  if (card.color === "joker") return true;
  if (card.color === "rouge") return piece === "r" || piece === "q";
  if (card.color === "bleu") return piece === "n";
  if (card.color === "vert") return piece === "b";
  if (card.color === "jaune") return piece === "p";
  return false;
}

function bestColorFor(cards) {
  const counts = {
    rouge: 0,
    jaune: 0,
    vert: 0,
    bleu: 0
  };

  for (const card of cards) {
    if (counts[card.color] !== undefined) {
      counts[card.color]++;
    }
  }

  let best = "rouge";

  for (const color of COLORS) {
    if (counts[color] > counts[best]) best = color;
  }

  return best;
}


function hasPlayableAction(match, side) {
  const cards = match.hands[side];

  if (match.chess.turn() !== side) return false;

  const moves = match.chess.moves({ verbose: true });
console.log("CARTES ET DÉFENSES :", {
  side,
  activeColor: match.activeColor,
  discard: match.discard,
  cards: cards.map(card => ({
    value: card.value,
    color: card.color,
    matches: cardMatches(card, match)
  })),
  moves: moves.map(move => ({
    from: move.from,
    to: move.to,
    piece: move.piece
  }))
});
  return cards.some(card => {
    if (!cardMatches(card, match)) return false;

    return moves.some(move => {
      if (!allowedPiece(card, move.piece)) return false;

      const playedMove = match.chess.move({
        from: move.from,
        to: move.to,
        promotion: "q"
      });

      if (!playedMove) return false;

      const kingSafe = !match.chess.isCheck();

      match.chess.undo();

      return kingSafe;
    });
  });
}

function hasUnoLegalDefense(match, side) {

  // Pas d'échec : pas de mat UNO
  if (!match.chess.isCheck()) return true;

  // Si ce n'est pas le tour du joueur, ne pas déclarer mat
  if (match.chess.turn() !== side) return true;

  // Vérifier s'il possède une défense autorisée par ses cartes
  return hasPlayableAction(match, side);
}
function passChessTurn(match, nextSide) {
  const fen = match.chess.fen();
  const fields = fen.split(" ");

  console.log("AVANT PASSAGE :", {
    fen,
    nextSide,
    currentTurn: fields[1]
  });

  if (fields[1] === nextSide) return true;

  fields[3] = "-";

  if (fields[1] === "b" && nextSide === "w") {
    fields[5] = String(Number(fields[5]) + 1);
  }

  fields[1] = nextSide;

  const newFen = fields.join(" ");
  const result = match.chess.load(newFen);

  console.log("RÉSULTAT PASSAGE :", {
    newFen,
    result,
    finalFen: match.chess.fen()
  });

return match.chess.turn() === nextSide;
}

/* =====================================================
   ÉTAT DE PARTIE ET SYNCHRONISATION
   ===================================================== */

function publicState(match, userId) {
  const side = Number(userId) === Number(match.whiteUser)
    ? "w"
    : "b";

  const opponentSide = side === "w" ? "b" : "w";

  return {
    matchId: match.id,
    history: match.history || [],
    fen: match.chess.fen(),
    color: side === "w" ? "white" : "black",
    turn: match.chess.turn(),
    yourTurn: match.chess.turn() === side,
    hand: match.hands[side],
    opponentCardCount: match.hands[opponentSide].length,
    discard: match.discard,
    activeColor: match.activeColor,
    finished: match.finished
  };
}

function sendStates(room, match) {
  for (const socketId of match.players) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    const userId = socketUsers.get(socketId);

    socket.emit(
      "online-state",
      publicState(match, userId)
    );
  }
}

function createMatchState(id, whiteUser, blackUser) {
  const match = {
    id,
    chess: new Chess(),
    deck: makeDeck(),
    hands: { w: [], b: [] },
    discard: null,
    activeColor: "rouge",
    whiteUser,
    blackUser,
    players: [],
    finished: false
  };

  for (let i = 0; i < 5; i++) {
    match.hands.w.push(drawCard(match));
    match.hands.b.push(drawCard(match));
  }

  match.discard = drawCard(match);

  while (
    match.discard.value === "JOKER" ||
    match.discard.value === "+4"
  ) {
    match.deck.push(match.discard);
    match.discard = drawCard(match);
  }

  match.activeColor = match.discard.color;

  return match;
}

/* =====================================================
   FIN DE PARTIE
   ===================================================== */

async function finishOnlineMatch(room, match, winnerId) {
  if (match.finished) return;

  match.finished = true;

  try {
    if (winnerId === null) {
      await finishDraw(match.id);

      io.to(room).emit("online-finished", {
        draw: true,
        message: "Match nul ! Aucun KILO gagné ou perdu."
      });

      return;
    }

    const loserId =
      Number(winnerId) === Number(match.whiteUser)
        ? match.blackUser
        : match.whiteUser;

    const result = await settleMatch(
      match.id,
      winnerId,
      loserId
    );

    io.to(room).emit("online-finished", {
      draw: false,
      winnerId: Number(winnerId),
      winnerGain: result.gain,
      loserLoss: result.loss
    });

  } catch (error) {
    console.error("Settlement error:", error);

    io.to(room).emit("online-finished", {
      draw: false,
      kiloAwarded: false,
      message: "Résultat enregistré, mais les KILO doivent être vérifiés."
    });
  }
}

/* =====================================================
   ACTIONS DE PARTIE VALIDÉES
   ===================================================== */

function evaluateOnlinePosition(match) {
  const chess = match.chess;

  if (chess.isCheckmate()) {
    return chess.turn() === "b" ? -100000 : 100000;
  }

  if (chess.isDraw() || chess.isStalemate()) return 0;

  let score = 0;

  const values = {
    p: 100,
    n: 320,
    b: 330,
    r: 500,
    q: 900,
    k: 0
  };

  const position = chess.board();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = position[r][c];
      if (!piece) continue;

      const value = values[piece.type] || 0;
      score += piece.color === "b" ? value : -value;

      const centerBonus =
        (3.5 - Math.abs(3.5 - r)) +
        (3.5 - Math.abs(3.5 - c));

      score += piece.color === "b"
        ? centerBonus * 3
        : -centerBonus * 3;
    }
  }

  const whiteHand = match.hands.w || [];
  const blackHand = match.hands.b || [];

  score += (whiteHand.length - blackHand.length) * 65;

  score += blackHand.filter(c => c.color === "joker").length * 18;
  score -= whiteHand.filter(c => c.color === "joker").length * 18;

  return score;
}

async function handleOnlineAction(socket, data) {
  if (!data || typeof data.room !== "string") return;

  const match = activeRooms.get(data.room);

  if (!match || match.finished) return;
  if (!match.players.includes(socket.id)) return;

const userId = socketUsers.get(socket.id);

if (userId === undefined || userId === null) {
  socket.emit("game-error", {
    message: "Identité du joueur introuvable."
  });
  return;
}

let side;

if (Number(userId) === Number(match.whiteUser)) {
  side = "w";
} else if (Number(userId) === Number(match.blackUser)) {
  side = "b";
} else {
  socket.emit("game-error", {
    message: "Ce compte ne participe pas à cette partie."
  });
  return;
}
  console.log("DIAGNOSTIC TOUR :", {
  room: data.room,
  userId,
  whiteUser: match.whiteUser,
  blackUser: match.blackUser,
  side,
  chessTurn: match.chess.turn()
});
  if (match.chess.turn() !== side) {
    socket.emit("game-error", {
      message: "Ce n'est pas ton tour."
    });
    return;
  }

  if (data.type === "draw") {
    if (hasPlayableAction(match, side)) {
      socket.emit("game-error", {
        message: "Tu as une carte jouable : tu dois la jouer."
      });
      return;
    }

    match.hands[side].push(drawCard(match));

    const nextSide = side === "w" ? "b" : "w";

    if (!passChessTurn(match, nextSide)) {
      socket.emit("game-error", {
        message: "Impossible de passer le tour."
      });
      return;
    }

    sendStates(data.room, match);
    return;
  }

  if (data.type !== "move") return;

  if (
    !Number.isInteger(data.cardIndex) ||
    data.cardIndex < 0 ||
    data.cardIndex >= match.hands[side].length ||
    typeof data.from !== "string" ||
    typeof data.to !== "string"
  ) {
    socket.emit("game-error", {
      message: "Action invalide."
    });
    return;
  }

  const card = match.hands[side][data.cardIndex];

  if (!cardMatches(card, match)) {
    socket.emit("game-error", {
      message: "Cette carte ne correspond pas à la carte défaussée."
    });
    return;
  }

  const piece = match.chess.get(data.from);

  if (!piece || piece.color !== side) {
    socket.emit("game-error", {
      message: "Cette pièce ne t'appartient pas."
    });
    return;
  }

  if (!allowedPiece(card, piece.type)) {
    socket.emit("game-error", {
      message: "Cette carte ne permet pas de déplacer cette pièce."
    });
    return;
  }

  const legalMoves = match.chess.moves({
    square: data.from,
    verbose: true
  });

  if (!legalMoves.some(move => move.to === data.to)) {
    socket.emit("game-error", {
      message: "Déplacement illégal."
    });
    return;
  }

const beforeFen = match.chess.fen();
const beforeScore = evaluateOnlinePosition(match);

const move = match.chess.move({
  from: data.from,
  to: data.to,
  promotion: "q"
});

if (!move) {
  socket.emit("game-error", {
    message: "Déplacement impossible."
  });
  return;
}




match.hands[side].splice(data.cardIndex, 1);
match.discard = card;


  const opponentSide = side === "w" ? "b" : "w";

  if (card.value === "+2") {
    match.hands[opponentSide].push(
      drawCard(match),
      drawCard(match)
    );
  }

  if (card.value === "+4") {
    for (let i = 0; i < 4; i++) {
      match.hands[opponentSide].push(drawCard(match));
    }
  }

  if (
    card.value === "PASSE" &&
    match.hands[opponentSide].length > 0
  ) {
    match.hands[opponentSide].splice(0, 1);
  }

  if (card.value === "↔" || card.color === "joker") {
    match.activeColor = bestColorFor(match.hands[side]);
  } else {
    match.activeColor = card.color;
  }
const afterScore = evaluateOnlinePosition(match);

const beforeAdvantage = side === "b"
  ? beforeScore
  : -beforeScore;

const afterAdvantage = side === "b"
  ? afterScore
  : -afterScore;

const change = afterAdvantage - beforeAdvantage;

const precision = Math.max(0, Math.min(100,
  80 + Math.max(-20, Math.min(20, change / 25))
));
const risky =
  !!move.captured ||
  move.san.includes("+") ||
  card.value === "+2" ||
  card.value === "+4" ||
  card.value === "PASSE" ||
  card.value === "JOKER";

let category;

if (change >= 250) {
  category = "brilliant";
} else if (change >= 80) {
  category = "excellent";
} else if (risky && change >= -180) {
  category = "gambling";
} else if (change >= -30) {
  category = "good";
} else if (change >= -100) {
  category = "inaccuracy";
} else if (change >= -250) {
  category = "error";
} else {
  category = "blunder";
}
  if (!Array.isArray(match.history)) {
  match.history = [];
}

const number = Math.floor(match.history.length / 2) + 1;

match.history.push({
  ply: match.history.length,
  number,
  side,
  san: move.san,
  from: move.from,
  to: move.to,
  piece: move.piece,
  captured: move.captured || null,
  card: card.value,
  color: card.color,
  uno: card.value,
  category,
  precision,
  change,
  beforeScore,
  afterScore,
  explanation: "Évaluation estimée de la position.",
  beforeFen,
  afterFen: match.chess.fen()
});
if (match.hands[side].length === 0) {

  sendStates(data.room, match);
  await finishOnlineMatch(data.room, match, userId);
  return;
}

 /* ÉCHEC ET MAT CLASSIQUE OU ÉCHEC ET MAT UNO */

console.log("DIAGNOSTIC FIN DE PARTIE :", {
  chessCheck: match.chess.isCheck(),
  chessCheckmate: match.chess.isCheckmate(),
  chessTurn: match.chess.turn(),
  opponentSide,
  opponentCards: match.hands[opponentSide].length,
  opponentHasDefense: hasUnoLegalDefense(match, opponentSide)
});

if (match.chess.isCheckmate() || !hasUnoLegalDefense(match, opponentSide)) {
  console.log("VICTOIRE DÉCLARÉE PAR LE BLOC ÉCHEC ET MAT");
  sendStates(data.room, match);
  await finishOnlineMatch(data.room, match, userId);
  return;
}

  if (
    match.chess.isDraw() ||
    match.chess.isStalemate()
  ) {
    await finishOnlineMatch(data.room, match, null);
    return;
  }



  sendStates(data.room, match);
}

/* =====================================================
   SOCKET.IO
   ===================================================== */

io.engine.use(sessionMiddleware);
// =====================================================
// DÉFIS DIRECTS ENTRE JOUEURS
// =====================================================

const pendingChallenges = new Map();
io.on("connection", async socket => {
  let userId = null;

  try {
    const authorization = socket.handshake.auth?.token;

    if (authorization) {
      await tokenTableReady;

      const tokenHash = crypto
        .createHash("sha256")
        .update(authorization)
        .digest("hex");

      const result = await pool.query(
        `SELECT user_id
         FROM auth_tokens
         WHERE token_hash = $1
         AND expires_at > NOW()`,
        [tokenHash]
      );

      if (result.rows.length) {
        userId = result.rows[0].user_id;
      }
    }

    if (!userId) {
      userId = socket.request.session?.userId;
    }

  } catch (error) {
    console.error("Erreur authentification Socket.IO :", error);
    socket.disconnect(true);
    return;
  }

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socketUsers.set(socket.id, Number(userId));
// ENVOYER UNE DEMANDE D'AMI
socket.on("send-friend-request", async (targetId) => {
  try {
    const senderId = Number(userId);
    targetId = Number(targetId);

    if (
      !Number.isInteger(targetId) ||
      targetId <= 0 ||
      targetId === senderId
    ) {
      socket.emit("friend-request-error", "Joueur invalide.");
      return;
    }

    const targetOnline = [...socketUsers.entries()].find(
      ([, id]) => id === targetId
    );

    if (!targetOnline) {
      socket.emit("friend-request-error", "Ce joueur n'est pas connecté.");
      return;
    }

    const result = await pool.query(
      `SELECT id, username FROM users WHERE id = $1`,
      [senderId]
    );

    if (!result.rows.length) {
      socket.emit("friend-request-error", "Compte introuvable.");
      return;
    }

    const existing = await pool.query(
      `SELECT id, status FROM friend_requests
       WHERE (sender_id = $1 AND receiver_id = $2)
          OR (sender_id = $2 AND receiver_id = $1)`,
      [senderId, targetId]
    );

    if (existing.rows.some(row => row.status === "accepted")) {
      socket.emit("friend-request-error", "Vous êtes déjà amis.");
      return;
    }

    if (existing.rows.some(row => row.status === "pending")) {
      socket.emit("friend-request-error", "Une demande existe déjà.");
      return;
    }

    await pool.query(
      `DELETE FROM friend_requests
       WHERE (sender_id = $1 AND receiver_id = $2)
          OR (sender_id = $2 AND receiver_id = $1)`,
      [senderId, targetId]
    );

    const inserted = await pool.query(
      `INSERT INTO friend_requests (sender_id, receiver_id)
       VALUES ($1, $2)
       RETURNING id`,
      [senderId, targetId]
    );

    const targetSocket = io.sockets.sockets.get(targetOnline[0]);

    if (targetSocket) {
      targetSocket.emit("friend-request-received", {
        requestId: inserted.rows[0].id,
        senderId,
        username: result.rows[0].username
      });
    }

    socket.emit("friend-request-sent", {
      message: "Demande d'ami envoyée !"
    });

  } catch (error) {
    console.error("Erreur demande d'ami :", error);
    socket.emit("friend-request-error", "Impossible d'envoyer la demande.");
  }
});

// ACCEPTER UNE DEMANDE D'AMI
socket.on("accept-friend-request", async (requestId) => {
  try {
    const result = await pool.query(
      `UPDATE friend_requests
       SET status = 'accepted'
       WHERE id = $1
         AND receiver_id = $2
         AND status = 'pending'
       RETURNING sender_id`,
      [Number(requestId), Number(userId)]
    );

    if (!result.rows.length) {
      socket.emit("friend-request-error", "Demande invalide ou expirée.");
      return;
    }

    socket.emit("friend-request-accepted", {
      message: "Vous êtes maintenant amis !"
    });

    const senderId = result.rows[0].sender_id;

    const senderSocket = [...socketUsers.entries()].find(
      ([, id]) => id === senderId
    );

    if (senderSocket) {
      const connectedSocket = io.sockets.sockets.get(senderSocket[0]);

      if (connectedSocket) {
        connectedSocket.emit("friend-request-accepted", {
          message: "Ta demande d'ami a été acceptée !"
        });
      }
    }

  } catch (error) {
    console.error("Erreur acceptation ami :", error);
    socket.emit("friend-request-error", "Impossible d'accepter la demande.");
  }
});

// REFUSER UNE DEMANDE D'AMI
socket.on("reject-friend-request", async (requestId) => {
  try {
    const result = await pool.query(
      `UPDATE friend_requests
       SET status = 'rejected'
       WHERE id = $1
         AND receiver_id = $2
         AND status = 'pending'
       RETURNING sender_id`,
      [Number(requestId), Number(userId)]
    );

    if (!result.rows.length) {
      socket.emit("friend-request-error", "Demande invalide ou expirée.");
      return;
    }

    socket.emit("friend-request-rejected", {
      message: "Demande refusée."
    });

  } catch (error) {
    console.error("Erreur refus ami :", error);
    socket.emit("friend-request-error", "Impossible de refuser la demande.");
  }
});

// ENVOYER UN DÉFI
socket.on("send-challenge", async (targetId) => {
  try {
    targetId = Number(targetId);
    const challengerId = Number(userId);

    if (
      !Number.isInteger(targetId) ||
      targetId <= 0 ||
      targetId === challengerId
    ) {
      socket.emit("challenge-error", "Joueur invalide.");
      return;
    }

    const alreadyPlaying = [...activeRooms.values()].some(
      match =>
        match.whiteUser === challengerId ||
        match.blackUser === challengerId ||
        match.whiteUser === targetId ||
        match.blackUser === targetId
    );

    if (alreadyPlaying) {
      socket.emit("challenge-error", "Un des joueurs a déjà une partie en cours.");
      return;
    }

    const targetOnline = [...socketUsers.entries()].find(
      ([, id]) => id === targetId
    );

    if (!targetOnline) {
      socket.emit("challenge-error", "Ce joueur n'est pas connecté.");
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetOnline[0]);

    if (!targetSocket) {
      socket.emit("challenge-error", "Ce joueur n'est plus connecté.");
      return;
    }

    const challengeId = `${challengerId}-${targetId}-${Date.now()}`;

    pendingChallenges.set(challengeId, {
      challengerId,
      targetId,
      challengerSocket: socket.id
    });

    const challenger = await pool.query(
      "SELECT username FROM users WHERE id = $1",
      [challengerId]
    );

    targetSocket.emit("challenge-received", {
      challengeId,
      challengerId,
      username: challenger.rows[0]?.username || "Joueur"
    });

    socket.emit("challenge-sent", {
      message: "Défi envoyé !"
    });

  } catch (error) {
    console.error("Erreur défi :", error);
    socket.emit("challenge-error", "Impossible d'envoyer le défi.");
  }
});

// ACCEPTER UN DÉFI
socket.on("accept-challenge", async (challengeId) => {
  try {
    const challenge = pendingChallenges.get(challengeId);

    if (!challenge || challenge.targetId !== Number(userId)) {
      socket.emit("challenge-error", "Défi invalide ou expiré.");
      return;
    }

    const challengerSocket = io.sockets.sockets.get(
      challenge.challengerSocket
    );

    if (!challengerSocket || !challengerSocket.connected) {
      pendingChallenges.delete(challengeId);
      socket.emit("challenge-error", "Le joueur qui t'a défié est déconnecté.");
      return;
    }

    const alreadyPlaying = [...activeRooms.values()].some(
      match =>
        match.whiteUser === challenge.challengerId ||
        match.blackUser === challenge.challengerId ||
        match.whiteUser === challenge.targetId ||
        match.blackUser === challenge.targetId
    );

    if (alreadyPlaying) {
      pendingChallenges.delete(challengeId);
      socket.emit("challenge-error", "Un des joueurs a déjà une partie en cours.");
      return;
    }

    const result = await pool.query(
      `INSERT INTO matches (player1, player2, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [challenge.challengerId, challenge.targetId]
    );

    const matchId = result.rows[0].id;
    const room = "uno-chess-" + matchId;

    const match = createMatchState(
      matchId,
      challenge.challengerId,
      challenge.targetId
    );

    match.players = [challengerSocket.id, socket.id];

    activeRooms.set(room, match);

    challengerSocket.join(room);
    socket.join(room);

    challengerSocket.emit("game-found", {
      room,
      color: "white"
    });

    socket.emit("game-found", {
      room,
      color: "black"
    });

    sendStates(room, match);

    pendingChallenges.delete(challengeId);

  } catch (error) {
    console.error("Erreur acceptation défi :", error);
    socket.emit("challenge-error", "Impossible de démarrer la partie.");
  }
});

// REFUSER UN DÉFI
socket.on("reject-challenge", (challengeId) => {
  const challenge = pendingChallenges.get(challengeId);

  if (!challenge || challenge.targetId !== Number(userId)) return;

  const challengerSocket = io.sockets.sockets.get(
    challenge.challengerSocket
  );

  if (challengerSocket) {
    challengerSocket.emit("challenge-rejected", {
      message: "Ton défi a été refusé."
    });
  }

  pendingChallenges.delete(challengeId);
});

  socket.on("find-game", async () => {
    console.log("RECHERCHE REÇUE POUR :", userId);
    const alreadyPlaying = [...activeRooms.values()].some(
      match =>
        match.whiteUser === Number(userId) ||
        match.blackUser === Number(userId)
    );

    if (alreadyPlaying) {
      socket.emit("game-error", {
        message: "Tu as déjà une partie en cours."
      });
      return;
    }

    if (waitingPlayers.has(Number(userId))) return;

    let opponent = null;

    for (const [id, waitingSocket] of waitingPlayers) {
      if (
        id !== Number(userId) &&
        waitingSocket.connected &&
        socketUsers.has(waitingSocket.id)
      ) {
        opponent = waitingSocket;
        waitingPlayers.delete(id);
        break;
      }
    }

   if (!opponent) {
  waitingPlayers.set(Number(userId), socket);

  console.log("JOUEUR EN ATTENTE :", userId);

  socket.emit("waiting");

  console.log("SIGNAL WAITING ENVOYÉ");

  return;
}
    const opponentId = socketUsers.get(opponent.id);

    try {
      const result = await pool.query(
        `INSERT INTO matches (player1, player2, status)
         VALUES ($1, $2, 'pending')
         RETURNING id`,
        [opponentId, Number(userId)]
      );

      const matchId = result.rows[0].id;
      const room = "uno-chess-" + matchId;

      const match = createMatchState(
        matchId,
        opponentId,
        Number(userId)
      );

      match.players = [opponent.id, socket.id];

      activeRooms.set(room, match);

      opponent.join(room);
      socket.join(room);

      opponent.emit("game-found", {
        room,
        color: "white"
      });

      socket.emit("game-found", {
        room,
        color: "black"
      });

      sendStates(room, match);

    } catch (error) {
      console.error(error);

      waitingPlayers.delete(opponentId);

      socket.emit("game-error", {
        message: "Impossible de créer la partie."
      });

      opponent.emit("game-error", {
        message: "Impossible de créer la partie."
      });
    }
  });
// CHAT EN DIRECT PENDANT UNE PARTIE
socket.on("game-chat-send", async (message) => {
  try {
    if (typeof message !== "string") return;

    const cleanMessage = message.trim().slice(0, 200);
    if (!cleanMessage) return;

    // Vérifier que le joueur participe à une partie
    for (const [room, match] of activeRooms) {
      if (!match.players.includes(socket.id)) continue;

      const result = await pool.query(
        "SELECT username FROM users WHERE id = $1",
        [Number(userId)]
      );

      const username = result.rows[0]?.username || "Joueur";

      io.to(room).emit("game-chat-message", {
        username,
        message: cleanMessage
      });

      return;
    }
  } catch (error) {
    console.error("Erreur chat :", error);
  }
});
  socket.on("game-action", data => {
    handleOnlineAction(socket, data).catch(error => {
      console.error(error);

      socket.emit("game-error", {
        message: "Erreur pendant cette action."
      });
    });
  });

  socket.on("cancel-search", () => {
    if (waitingPlayers.get(Number(userId)) === socket) {
      waitingPlayers.delete(Number(userId));
    }
  });

  socket.on("disconnect", () => {
    if (waitingPlayers.get(Number(userId)) === socket) {
      waitingPlayers.delete(Number(userId));
    }

    socketUsers.delete(socket.id);

    for (const [room, match] of activeRooms) {
      if (!match.players.includes(socket.id)) continue;

      activeRooms.delete(room);

      if (!match.finished) {
        abandonMatch(match.id).catch(console.error);

        socket.to(room).emit("opponent-disconnected", {
          message: "Ton adversaire s'est déconnecté. Aucun KILO n'est attribué."
        });
      }
    }
  });
});

/* =====================================================
   DÉMARRAGE
   ===================================================== */

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        "UNO.CHESS server started on port " + PORT
      );
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
