
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
   ÉCONOMIE KILO UNO.CHESS
   ========================================================= */

/*
  Règles :
  - 0 à 99 KILO de différence : 10 points
  - 100 à 199 : 20 points
  - 200 à 299 : 30 points
  - 500 à 599 : 60 points
  - 900 et plus : 100 points maximum
*/

function calculateKiloChange(winnerKilo, loserKilo) {
  const difference = Math.abs(winnerKilo - loserKilo);

  return Math.min(
    100,
    10 + Math.floor(difference / 100) * 10
  );
}

/* =========================================================
   ATTRIBUTION DES KILO APRÈS UNE VICTOIRE VALIDÉE
   ========================================================= */

async function updateKiloAfterVerifiedMatch(
  winnerId,
  loserId
) {
  if (
    !Number.isInteger(Number(winnerId)) ||
    !Number.isInteger(Number(loserId)) ||
    Number(winnerId) === Number(loserId)
  ) {
    throw new Error("Identifiants des joueurs invalides.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, kilo
       FROM users
       WHERE id = ANY($1::integer[])
       ORDER BY id
       FOR UPDATE`,
      [[Number(winnerId), Number(loserId)]]
    );

    if (result.rows.length !== 2) {
      throw new Error("Joueur introuvable.");
    }

    const winner = result.rows.find(
      user => Number(user.id) === Number(winnerId)
    );

    const loser = result.rows.find(
      user => Number(user.id) === Number(loserId)
    );

    const points = calculateKiloChange(
      Number(winner.kilo),
      Number(loser.kilo)
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
}

app.get("/", (req, res) => {
  res.send("UNO CHESS server is running!");
});

/* INSCRIPTION */

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

/* CONNEXION */

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
       FROM users WHERE email = $1`,
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
    res.status(500).json({ error: "Erreur du serveur." });
  }
});

/* PROFIL */

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, kilo
       FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Compte introuvable."
      });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur du serveur." });
  }
});

/* DÉCONNEXION */

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

    res.json({ success: true });
  });
});

/* CLASSEMENT */

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, kilo
       FROM users
       ORDER BY kilo DESC, username ASC
       LIMIT 100`
    );

    res.json({ leaderboard: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Impossible de charger le classement."
    });
  }
});

/* FILE D'ATTENTE MULTIJOUEUR */

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

  socket.on("find-game", () => {
    if (waitingPlayers.has(userId)) return;

    let opponent = null;

    for (const [id, player] of waitingPlayers) {
      if (id !== userId && player.connected) {
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

    const room = "game-" + opponent.id + "-" + socket.id;

    opponent.join(room);
    socket.join(room);

    activeRooms.set(room, {
      players: [opponent.id, socket.id],
      users: [socketUsers.get(opponent.id), userId],
      finished: false
    });

    opponent.emit("game-found", {
      room,
      color: "black"
    });

    socket.emit("game-found", {
      room,
      color: "white"
    });
  });

  socket.on("game-action", data => {
    if (!data || typeof data.room !== "string") return;

    const match = activeRooms.get(data.room);

    if (!match || match.finished) return;
    if (!match.players.includes(socket.id)) return;

    socket.to(data.room).emit("game-action", {
      action: data.action
    });
  });

  socket.on("cancel-search", () => {
    if (waitingPlayers.get(userId) === socket) {
      waitingPlayers.delete(userId);
    }
  });

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

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log("UNO.CHESS server started on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
