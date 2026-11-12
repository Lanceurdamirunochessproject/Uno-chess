
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const cors = require("cors");

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

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Tu dois être connecté."
    });
  }

  next();
}

/* =========================================================
   ÉCONOMIE KILO
   ========================================================= */

function calculateKiloChange(winnerKilo, loserKilo) {
  const difference = Math.abs(
    Number(winnerKilo) - Number(loserKilo)
  );

  return Math.min(
    100,
    10 + Math.floor(difference / 100) * 10
  );
}

/* =========================================================
   BASE DE DONNÉES
   ========================================================= */

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
    CREATE TABLE IF NOT EXISTS match_result_confirmations (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      winner_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (match_id, user_id)
    )
  `);
}

/* =========================================================
   ATTRIBUTION DES KILO
   ========================================================= */

/*
  Cette fonction ne doit être appelée que par une procédure
  de validation fiable du résultat de la partie.

  Ne jamais créer de route publique permettant à un joueur
  de choisir librement le gagnant.
*/

async function updateKiloAfterVerifiedMatch(
  matchId,
  winnerId,
  loserId
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchResult = await client.query(
      `SELECT id, player1, player2, winner, status
       FROM matches
       WHERE id = $1
       FOR UPDATE`,
      [matchId]
    );

    if (!matchResult.rows.length) {
      throw new Error("Partie introuvable.");
    }

    const match = matchResult.rows[0];

    if (match.status === "finished") {
      throw new Error("Cette partie a déjà été comptabilisée.");
    }

    if (
      !(
        (
          Number(match.player1) === Number(winnerId) &&
          Number(match.player2) === Number(loserId)
        ) ||
        (
          Number(match.player2) === Number(winnerId) &&
          Number(match.player1) === Number(loserId)
        )
      )
    ) {
      throw new Error("Les joueurs ne correspondent pas.");
    }

    const usersResult = await client.query(
      `SELECT id, kilo
       FROM users
       WHERE id = ANY($1::integer[])
       ORDER BY id
       FOR UPDATE`,
      [[Number(winnerId), Number(loserId)]]
    );

    if (usersResult.rows.length !== 2) {
      throw new Error("Joueur introuvable.");
    }

    const winner = usersResult.rows.find(
      user => Number(user.id) === Number(winnerId)
    );

    const loser = usersResult.rows.find(
      user => Number(user.id) === Number(loserId)
    );

    const points = calculateKiloChange(
      winner.kilo,
      loser.kilo
    );

    const actualLoss = Math.min(
      points,
      Number(loser.kilo)
    );

    await client.query(
      `UPDATE users
       SET kilo = kilo + $1
       WHERE id = $2`,
      [points, winnerId]
    );

    await client.query(
      `UPDATE users
       SET kilo = GREATEST(0, kilo - $1)
       WHERE id = $2`,
      [actualLoss, loserId]
    );

    await client.query(
      `UPDATE matches
       SET winner = $1,
           status = 'finished',
           settled_at = CURRENT_TIMESTAMP,
           kilo_change = $2
       WHERE id = $3`,
      [winnerId, points, matchId]
    );

    await client.query("COMMIT");

    return {
      winnerGain: points,
      loserLoss: actualLoss
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}

/* =========================================================
   PAGE D'ACCUEIL
   ========================================================= */

app.get("/", (req, res) => {
  res.send("UNO CHESS server is running!");
});

/* =========================================================
   INSCRIPTION
   ========================================================= */

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

    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

/* =========================================================
   CONNEXION
   ========================================================= */

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

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

    res.json({
      user: {
        id: user.id,
        username: user.username,
        kilo: user.kilo
      }
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

/* =========================================================
   PROFIL
   ========================================================= */

app.get("/api/me", requireLogin, async (req, res) => {
  try {
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
    console.error(error);

    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

/* =========================================================
   DÉCONNEXION
   ========================================================= */

app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "Impossible de se déconnecter."
      });
    }

    res.clearCookie("connect.sid", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    res.json({
      success: true
    });
  });
});

/* =========================================================
   CLASSEMENT
   ========================================================= */

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, kilo
       FROM users
       ORDER BY kilo DESC, username ASC
       LIMIT 100`
    );

    res.json({
      leaderboard: result.rows
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Impossible de charger le classement."
    });
  }
});

/* =========================================================
   FILE D'ATTENTE MULTIJOUEUR
   ========================================================= */

const waitingPlayers = new Map();
const socketUsers = new Map();
const activeRooms = new Map();

io.engine.use(sessionMiddleware);

io.on("connection", socket => {
  const userId = socket.request.session.userId;

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socketUsers.set(socket.id, userId);

  /* RECHERCHER UNE PARTIE */

  socket.on("find-game", async () => {
    if (waitingPlayers.has(userId)) return;

    for (const match of activeRooms.values()) {
      if (match.users.includes(userId)) {
        socket.emit("game-error", {
          message: "Tu as déjà une partie en cours."
        });
        return;
      }
    }

    let opponent = null;

    for (const [id, player] of waitingPlayers) {
      if (
        id !== userId &&
        player.connected &&
        socketUsers.has(player.id)
      ) {
        opponent = player;
        waitingPlayers.delete(id);
        break;
      }
    }

    if (!opponent) {
      waitingPlayers.set(userId, socket);
      socket.emit("waiting");
      return;
    }

    try {
      const room = "game-" + opponent.id + "-" + socket.id;

      const firstUser = socketUsers.get(opponent.id);

      const result = await pool.query(
        `INSERT INTO matches (player1, player2, status)
         VALUES ($1, $2, 'pending')
         RETURNING id`,
        [firstUser, userId]
      );

      const matchId = result.rows[0].id;

      opponent.join(room);
      socket.join(room);

      activeRooms.set(room, {
        id: matchId,
        players: [opponent.id, socket.id],
        users: [firstUser, userId],
        finished: false
      });

      opponent.emit("game-found", {
        room,
        matchId,
        color: "black"
      });

      socket.emit("game-found", {
        room,
        matchId,
        color: "white"
      });

    } catch (error) {
      console.error(error);

      socket.emit("game-error", {
        message: "Impossible de créer la partie."
      });

      opponent.emit("game-error", {
        message: "Impossible de créer la partie."
      });
    }
  });

  /* TRANSMISSION DES ACTIONS */

  socket.on("game-action", data => {
    if (
      !data ||
      typeof data.room !== "string" ||
      !data.action
    ) {
      return;
    }

    const match = activeRooms.get(data.room);

    if (!match || match.finished) return;

    if (!match.players.includes(socket.id)) return;

    socket.to(data.room).emit("game-action", {
      action: data.action
    });
  });

  /* ANNULER LA RECHERCHE */

  socket.on("cancel-search", () => {
    if (waitingPlayers.get(userId) === socket) {
      waitingPlayers.delete(userId);
    }
  });

  /* DÉCONNEXION */

  socket.on("disconnect", () => {
    if (waitingPlayers.get(userId) === socket) {
      waitingPlayers.delete(userId);
    }

    socketUsers.delete(socket.id);

    for (const [room, match] of activeRooms) {
      if (match.players.includes(socket.id)) {
        activeRooms.delete(room);

        io.to(room).emit("opponent-disconnected");
      }
    }
  });
});

/* =========================================================
   DÉMARRAGE DU SERVEUR
   ========================================================= */

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
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });
