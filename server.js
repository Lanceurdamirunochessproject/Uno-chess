

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const FRONTEND_URL =
  "https://lanceurdamirunochessproject.github.io";

app.set("trust proxy", 1);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// Autorisation du site GitHub Pages
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));

app.use(express.json());

// Sessions enregistrées dans PostgreSQL
const sessionMiddleware = session({
  store: new pgSession({
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
io.engine.use(sessionMiddleware);

// Création de la table des joueurs
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username VARCHAR(20) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      kilo INTEGER NOT NULL DEFAULT 1000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Page d'accueil du serveur
app.get("/", (req, res) => {
  res.send("UNO CHESS server is running!");
});

// INSCRIPTION
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
        error: "Adresse e-mail invalide."
      });
    }

    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Le pseudo doit contenir 3 à 20 caractères."
      });
    }

    if (password.length < 12 || password.length > 72) {
      return res.status(400).json({
        error: "Le mot de passe doit contenir entre 12 et 72 caractères."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, kilo`,
      [cleanEmail, cleanUsername, passwordHash]
    );

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error(sessionError);
        return res.status(500).json({
          error: "Erreur de session."
        });
      }

      req.session.user = result.rows[0];

      req.session.save((saveError) => {
        if (saveError) {
          console.error(saveError);
          return res.status(500).json({
            error: "Impossible d'enregistrer la session."
          });
        }

        res.status(201).json({
          message: "Compte créé !",
          user: result.rows[0]
        });
      });
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Cet e-mail ou ce pseudo est déjà utilisé."
      });
    }

    console.error(error);
    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

// CONNEXION
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

    if (
      result.rows.length === 0 ||
      !(await bcrypt.compare(
        password,
        result.rows[0].password_hash
      ))
    ) {
      return res.status(401).json({
        error: "E-mail ou mot de passe incorrect."
      });
    }

    const user = {
      id: result.rows[0].id,
      username: result.rows[0].username,
      kilo: result.rows[0].kilo
    };

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error(sessionError);
        return res.status(500).json({
          error: "Erreur de session."
        });
      }

      req.session.user = user;

      req.session.save((saveError) => {
        if (saveError) {
          console.error(saveError);
          return res.status(500).json({
            error: "Impossible d'enregistrer la session."
          });
        }

        res.json({
          message: "Connexion réussie !",
          user
        });
      });
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur du serveur."
    });
  }
});

// JOUEUR CONNECTÉ
app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Non connecté."
    });
  }

  res.json({
    user: req.session.user
  });
});

// DÉCONNEXION
app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        error: "Erreur lors de la déconnexion."
      });
    }

    res.clearCookie("connect.sid", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    res.json({
      message: "Déconnexion réussie."
    });
  });
});

// CLASSEMENT KILO
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
      error: "Erreur du serveur."
    });
  }
});

// MULTIJOUEUR : RELAIS TEMPORAIRE
// Les résultats ne modifient pas encore les KILO.
let waitingPlayer = null;

io.on("connection", (socket) => {

  socket.on("find-game", () => {
    const user = socket.request.session.user;

    if (!user) {
      socket.emit(
        "online-error",
        "Connecte-toi avant de jouer."
      );
      return;
    }

    if (
      waitingPlayer &&
      waitingPlayer.id !== socket.id &&
      waitingPlayer.connected &&
      waitingPlayer.request.session.user
    ) {
      const opponent = waitingPlayer;
      waitingPlayer = null;

      const room = "game-" + socket.id;

      socket.join(room);
      opponent.join(room);

      socket.emit("game-found", {
        room,
        color: "white",
        opponent: opponent.request.session.user.username
      });

      opponent.emit("game-found", {
        room,
        color: "black",
        opponent: user.username
      });

    } else {
      waitingPlayer = socket;
      socket.emit("waiting");
    }
  });

  socket.on("game-action", (data) => {
    if (
      data &&
      typeof data.room === "string" &&
      socket.rooms.has(data.room)
    ) {
      socket.to(data.room).emit("game-action", data);
    }
  });

  socket.on("disconnect", () => {
    if (
      waitingPlayer &&
      waitingPlayer.id === socket.id
    ) {
      waitingPlayer = null;
    }
  });
});

// DÉMARRAGE DU SERVEUR
const PORT = process.env.PORT || 3000;

initializeDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        "UNO CHESS server running on port " + PORT
      );
    });
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error
    );
    process.exit(1);
  });

