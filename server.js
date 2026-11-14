
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const cors = require("cors");
const { Chess } = require("chess.js");

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Tu dois être connecté."
    });
  }
  next();
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
}

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

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        error: "Tu n'es pas connecté."
      });
    }

    const result = await pool.query(
      `SELECT id, username, kilo
       FROM users
       WHERE id = $1`,
      [req.session.userId]
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

/* NOUVELLE ROUTE DU CLASSEMENT */

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, kilo
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
  const moves = match.chess.moves({ verbose: true });

  return cards.some(card => {
    if (!cardMatches(card, match)) return false;

    return moves.some(move =>
      allowedPiece(card, move.piece)
    );
  });
}
function hasUnoLegalDefense(match, side) {

  // Pas d'échec : pas de mat UNO
  if (!match.chess.isCheck()) return true;

  // Vérifie que c'est bien au tour du joueur en échec
  if (match.chess.turn() !== side) return false;

  // Il doit posséder une carte permettant un déplacement légal
  return hasPlayableAction(match, side);
}
function passChessTurn(match, nextSide) {
  const fields = match.chess.fen().split(" ");

  if (fields[1] === nextSide) return true;

  fields[3] = "-";

  if (fields[1] === "b" && nextSide === "w") {
    fields[5] = String(Number(fields[5]) + 1);
  }

  fields[1] = nextSide;

  return match.chess.load(fields.join(" "));
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

async function handleOnlineAction(socket, data) {
  if (!data || typeof data.room !== "string") return;

  const match = activeRooms.get(data.room);

  if (!match || match.finished) return;
  if (!match.players.includes(socket.id)) return;

  const userId = socketUsers.get(socket.id);
  const side = Number(userId) === Number(match.whiteUser)
    ? "w"
    : "b";

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

  if (match.hands[side].length === 0) {
    await finishOnlineMatch(data.room, match, userId);
    return;
  }

 /* ÉCHEC ET MAT CLASSIQUE OU ÉCHEC ET MAT UNO */

if (
  match.chess.isCheckmate() ||
  !hasUnoLegalDefense(match, opponentSide)
) {
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

  if (match.hands[opponentSide].length === 0) {
    const opponentId =
      opponentSide === "w"
        ? match.whiteUser
        : match.blackUser;

    await finishOnlineMatch(data.room, match, opponentId);
    return;
  }

  sendStates(data.room, match);
}

/* =====================================================
   SOCKET.IO
   ===================================================== */

io.engine.use(sessionMiddleware);

io.on("connection", socket => {
  const userId = socket.request.session.userId;

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socketUsers.set(socket.id, Number(userId));

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
      console.log("JOUEUR AJOUTÉ À LA FILE :", userId);
      socket.emit("waiting");
      console.log("ÉVÉNEMENT WAITING ENVOYÉ");
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
