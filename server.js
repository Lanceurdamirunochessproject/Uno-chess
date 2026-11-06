const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.get("/", (req, res) => {
  res.send("UNO CHESS server is running!");
});

let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("find-game", () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const opponent = waitingPlayer;
      waitingPlayer = null;

      const room = "game-" + socket.id;
      socket.join(room);
      opponent.join(room);

      socket.emit("game-found", {
        room,
        color: "white"
      });

      opponent.emit("game-found", {
        room,
        color: "black"
      });
    } else {
      waitingPlayer = socket;
      socket.emit("waiting");
    }
  });

  socket.on("game-action", (data) => {
    if (data && data.room) {
      socket.to(data.room).emit("game-action", data);
    }
  });

  socket.on("disconnect", () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
