import express from "express";
import http from "node:http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const RADIUS = 10;
const CLAIM_COST = 50;
const CAPTURE_COST = 200;
const REMOTE_COST = 500;
const DESTROY_COST = 250;

let players = {};
let tiles = {};

function key(q, r) {
  return `${q},${r}`;
}

function buildMap() {
  tiles = {};

  for (let q = -RADIUS; q <= RADIUS; q++) {
    const rMin = Math.max(-RADIUS, -q - RADIUS);
    const rMax = Math.min(RADIUS, -q + RADIUS);

    for (let r = rMin; r <= rMax; r++) {
      tiles[key(q, r)] = {
        q,
        r,
        owner: null,
        active: true
      };
    }
  }

  tiles[key(-RADIUS, 0)].owner = "blue";
  tiles[key(RADIUS, -RADIUS)].owner = "red";
  tiles[key(-RADIUS, RADIUS)].owner = "green";
  tiles[key(RADIUS, 0)].owner = "yellow";
}

function neighbors(tile) {
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  return dirs
    .map(([dq, dr]) => tiles[key(tile.q + dq, tile.r + dr)])
    .filter(Boolean);
}

function hasAdjacentMine(tile, team) {
  return neighbors(tile).some(n => n.active && n.owner === team);
}

function getState() {
  return { tiles };
}

buildMap();

app.get("/", (req, res) => {
  res.send("Hex Dominion Socket.IO server is running.");
});

io.on("connection", (socket) => {
  socket.emit("gameState", getState());

  socket.on("joinGame", ({ team }) => {
    players[socket.id] = { team };
    socket.emit("gameState", getState());
  });

  socket.on("tileAction", ({ action, q, r, team }) => {
    const tile = tiles[key(q, r)];
    if (!tile || !tile.active) {
      socket.emit("actionRejected", "invalid tile");
      return;
    }

    if (action === "claim") {
      if (tile.owner) return;
      if (!hasAdjacentMine(tile, team)) return;
      tile.owner = team;
    }

    if (action === "capture") {
      if (!tile.owner || tile.owner === team) return;
      if (!hasAdjacentMine(tile, team)) return;
      tile.owner = team;
    }

    if (action === "remote") {
      if (tile.owner === team) return;
      tile.owner = team;
    }

    if (action === "destroy") {
      if (!tile.owner || tile.owner === team) return;
      tile.owner = null;
      tile.active = false;
    }

    io.emit("gameState", getState());
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});