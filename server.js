import express from "express";
import http from "node:http";
import cors from "cors";
import { Server } from "socket.io";

import { createStorage } from "./storage.js";

const TEAM_LABELS = {
  blue: "1반",
  red: "2반",
  green: "3반",
  yellow: "4반"
};

const MAP_RADIUS = Number(process.env.MAP_RADIUS || 7);
const STARTING_GOLD = Number(process.env.STARTING_GOLD || 16);
const PASSIVE_TICK_MS = Number(process.env.PASSIVE_TICK_MS || 1000);
const BOOST_STEP = Number(process.env.BOOST_STEP || 0.25);
const MAX_CLICKS_PER_WINDOW = Number(process.env.MAX_CLICKS_PER_WINDOW || 18);
const CLICK_WINDOW_MS = Number(process.env.CLICK_WINDOW_MS || 1000);
const CLICK_RATE_LIMIT_COOLDOWN_MS = Number(process.env.CLICK_RATE_LIMIT_COOLDOWN_MS || 2500);
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS || 400);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 120);
const PORT = Number(process.env.PORT || 3000);

const BASE_TILE_STRENGTH = Number(process.env.BASE_TILE_STRENGTH || 36);
const NEUTRAL_TILE_STRENGTH = Number(process.env.NEUTRAL_TILE_STRENGTH || 22);
const CAPTURED_TILE_STRENGTH = Number(process.env.CAPTURED_TILE_STRENGTH || 22);
const MAX_TILE_STRENGTH = Number(process.env.MAX_TILE_STRENGTH || 60);
const FORTIFY_RATIO = Number(process.env.FORTIFY_RATIO || 0.6);
const ACTION_GOLD_REWARD = Number(process.env.ACTION_GOLD_REWARD || 1);
const CAPTURE_BONUS_GOLD = Number(process.env.CAPTURE_BONUS_GOLD || 8);
const BOMB_COST = Number(process.env.BOMB_COST || 55);

const UPGRADE_CONFIG = {
  click: {
    baseCost: 24,
    growth: 1.55,
    label: "공성 장갑"
  },
  auto: {
    baseCost: 80,
    growth: 1.8,
    label: "보급 드론"
  },
  boost: {
    baseCost: 150,
    growth: 1.95,
    label: "지휘 증폭기"
  }
};

const BASE_POSITIONS = {
  blue: { q: -MAP_RADIUS, r: 0 },
  red: { q: MAP_RADIUS, r: -MAP_RADIUS },
  green: { q: -MAP_RADIUS, r: MAP_RADIUS },
  yellow: { q: MAP_RADIUS, r: 0 }
};

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const app = express();
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true
}));
app.use(express.static("."));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true
  }
});

const storage = await createStorage();

let profiles = {};
let tiles = buildFreshTiles();
let teamTileCounts = createEmptyTeamMap(0);
let teamStrengthTotals = createEmptyTeamMap(0);
let sessions = {};
let studentToSocketId = {};

let saveTimer = null;
let saveChain = Promise.resolve();
let broadcastTimer = null;

restoreState(await storage.load());

function parseAllowedOrigins(value) {
  const normalized = String(value || "").trim();

  if (!normalized || normalized === "*") {
    return [];
  }

  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createEmptyTeamMap(initialValue) {
  return {
    blue: initialValue,
    red: initialValue,
    green: initialValue,
    yellow: initialValue
  };
}

function key(q, r) {
  return `${q},${r}`;
}

function buildFreshTiles() {
  const nextTiles = {};

  for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q += 1) {
    const rMin = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
    const rMax = Math.min(MAP_RADIUS, -q + MAP_RADIUS);

    for (let r = rMin; r <= rMax; r += 1) {
      nextTiles[key(q, r)] = {
        q,
        r,
        owner: null,
        active: true,
        strength: NEUTRAL_TILE_STRENGTH,
        base: false
      };
    }
  }

  Object.entries(BASE_POSITIONS).forEach(([team, position]) => {
    const tile = nextTiles[key(position.q, position.r)];

    if (tile) {
      tile.owner = team;
      tile.base = true;
      tile.strength = BASE_TILE_STRENGTH;
    }
  });

  return nextTiles;
}

function sanitizeTiles(rawTiles) {
  const freshTiles = buildFreshTiles();

  if (!rawTiles || typeof rawTiles !== "object") {
    return freshTiles;
  }

  Object.entries(freshTiles).forEach(([tileKey, freshTile]) => {
    const rawTile = rawTiles[tileKey];

    if (!rawTile || typeof rawTile !== "object") {
      return;
    }

    const isBase = freshTile.base;
    const owner = typeof rawTile.owner === "string" && TEAM_LABELS[rawTile.owner] ? rawTile.owner : null;
    const active = rawTile.active !== false;
    const strength = Number(rawTile.strength);

    if (isBase) {
      freshTile.owner = freshTile.owner;
      freshTile.active = true;
      freshTile.strength = Math.max(BASE_TILE_STRENGTH, Number.isFinite(strength) ? Math.round(strength) : BASE_TILE_STRENGTH);
      return;
    }

    freshTile.active = active;
    freshTile.owner = owner;
    freshTile.strength = active
      ? clampStrength(Number.isFinite(strength) ? Math.round(strength) : NEUTRAL_TILE_STRENGTH)
      : 0;
  });

  return freshTiles;
}

function neighbors(tile) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

  return dirs
    .map(([dq, dr]) => tiles[key(tile.q + dq, tile.r + dr)])
    .filter(Boolean);
}

function hasAdjacentTeam(tile, team) {
  return neighbors(tile).some((neighbor) => neighbor.active && neighbor.owner === team);
}

function getTeamFromStudentId(studentId) {
  const normalized = String(studentId || "").trim();

  if (normalized.length < 2) {
    return null;
  }

  const teamMap = {
    "1": "blue",
    "2": "red",
    "3": "green",
    "4": "yellow"
  };

  return teamMap[normalized[1]] || null;
}

function maskStudentId(studentId) {
  const normalized = String(studentId || "").trim();

  if (normalized.length <= 2) {
    return normalized || "익명";
  }

  return `${normalized.slice(0, 2)}***`;
}

function calculateUpgradeCost(type, level) {
  const config = UPGRADE_CONFIG[type];
  return Math.round(config.baseCost * (config.growth ** level));
}

function getMultiplier(profile) {
  return 1 + (profile.boostLevel * BOOST_STEP);
}

function getAttackPower(profile) {
  return Math.max(4, Math.round((5 + profile.clickLevel * 2) * getMultiplier(profile)));
}

function getAutoIncome(profile) {
  return Math.max(0, Math.round(profile.autoLevel * getMultiplier(profile)));
}

function clampStrength(value) {
  return Math.max(1, Math.min(MAX_TILE_STRENGTH, value));
}

function buildNewProfile(studentId, team) {
  const now = Date.now();

  return {
    studentId,
    team,
    gold: STARTING_GOLD,
    bombCount: 0,
    clickLevel: 0,
    autoLevel: 0,
    boostLevel: 0,
    totalActions: 0,
    totalCaptures: 0,
    totalFortifies: 0,
    warPoints: 0,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now
  };
}

function normalizeProfile(studentId, rawProfile) {
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const normalizedId = String(studentId || rawProfile.studentId || "").trim();
  const team = getTeamFromStudentId(normalizedId);

  if (!normalizedId || !team) {
    return null;
  }

  const base = buildNewProfile(normalizedId, team);

  return {
    ...base,
    ...rawProfile,
    studentId: normalizedId,
    team,
    gold: Number(rawProfile.gold ?? base.gold),
    bombCount: Number(rawProfile.bombCount ?? base.bombCount),
    clickLevel: Number(rawProfile.clickLevel ?? base.clickLevel),
    autoLevel: Number(rawProfile.autoLevel ?? base.autoLevel),
    boostLevel: Number(rawProfile.boostLevel ?? base.boostLevel),
    totalActions: Number(rawProfile.totalActions ?? rawProfile.totalClicks ?? base.totalActions),
    totalCaptures: Number(rawProfile.totalCaptures ?? base.totalCaptures),
    totalFortifies: Number(rawProfile.totalFortifies ?? base.totalFortifies),
    warPoints: Number(rawProfile.warPoints ?? rawProfile.totalContributed ?? base.warPoints),
    createdAt: Number(rawProfile.createdAt ?? base.createdAt),
    updatedAt: Number(rawProfile.updatedAt ?? base.updatedAt),
    lastSeenAt: Number(rawProfile.lastSeenAt ?? base.lastSeenAt)
  };
}

function sanitizeProfiles(rawProfiles) {
  const nextProfiles = {};

  Object.entries(rawProfiles || {}).forEach(([studentId, rawProfile]) => {
    const profile = normalizeProfile(studentId, rawProfile);

    if (profile) {
      nextProfiles[profile.studentId] = profile;
    }
  });

  return nextProfiles;
}

function recomputeBoardStats() {
  const nextTileCounts = createEmptyTeamMap(0);
  const nextStrengthTotals = createEmptyTeamMap(0);

  Object.values(tiles).forEach((tile) => {
    if (!tile.active || !tile.owner) {
      return;
    }

    nextTileCounts[tile.owner] += 1;
    nextStrengthTotals[tile.owner] += tile.strength;
  });

  teamTileCounts = nextTileCounts;
  teamStrengthTotals = nextStrengthTotals;
}

function restoreState(state) {
  profiles = sanitizeProfiles(state?.profiles || {});
  tiles = sanitizeTiles(state?.tiles);
  sessions = {};
  studentToSocketId = {};
  recomputeBoardStats();
}

function getPersistedState() {
  return {
    version: 2,
    savedAt: Date.now(),
    profiles,
    tiles
  };
}

function queueSave() {
  if (saveTimer) {
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  const payload = getPersistedState();

  saveChain = saveChain
    .catch(() => {})
    .then(() => storage.save(payload))
    .catch((error) => {
      console.error("[storage] save failed:", error);
    });

  return saveChain;
}

function queueBroadcast() {
  if (broadcastTimer) {
    return;
  }

  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    io.emit("gameState", getGameState());
  }, BROADCAST_INTERVAL_MS);
}

function getOnlineCounts() {
  const counts = createEmptyTeamMap(0);

  Object.values(sessions).forEach((session) => {
    const profile = profiles[session.studentId];

    if (profile) {
      counts[profile.team] += 1;
    }
  });

  return counts;
}

function getTopPlayers() {
  return Object.values(profiles)
    .sort((left, right) => {
      if (right.totalCaptures !== left.totalCaptures) {
        return right.totalCaptures - left.totalCaptures;
      }

      return right.warPoints - left.warPoints;
    })
    .slice(0, 10)
    .map((profile) => ({
      label: maskStudentId(profile.studentId),
      team: profile.team,
      teamLabel: TEAM_LABELS[profile.team],
      totalCaptures: profile.totalCaptures,
      warPoints: profile.warPoints,
      totalActions: profile.totalActions
    }));
}

function getPublicMeta() {
  return {
    onlinePlayers: Object.keys(sessions).length,
    passiveTickMs: PASSIVE_TICK_MS,
    mapRadius: MAP_RADIUS,
    bombCost: BOMB_COST,
    teamTileCounts,
    teamStrengthTotals,
    teamPlayerCounts: getOnlineCounts(),
    topPlayers: getTopPlayers()
  };
}

function getGameState() {
  return {
    tiles,
    meta: getPublicMeta()
  };
}

function getPlayerState(profile) {
  return {
    team: profile.team,
    teamLabel: TEAM_LABELS[profile.team],
    studentId: profile.studentId,
    maskedStudentId: maskStudentId(profile.studentId),
    gold: profile.gold,
    bombCount: profile.bombCount,
    clickLevel: profile.clickLevel,
    autoLevel: profile.autoLevel,
    boostLevel: profile.boostLevel,
    attackPower: getAttackPower(profile),
    autoIncome: getAutoIncome(profile),
    totalActions: profile.totalActions,
    totalCaptures: profile.totalCaptures,
    totalFortifies: profile.totalFortifies,
    warPoints: profile.warPoints,
    teamTerritoryCount: teamTileCounts[profile.team],
    nextCosts: {
      click: calculateUpgradeCost("click", profile.clickLevel),
      auto: calculateUpgradeCost("auto", profile.autoLevel),
      boost: calculateUpgradeCost("boost", profile.boostLevel)
    }
  };
}

function reject(socket, message) {
  socket.emit("actionRejected", message);
}

function getSession(socketId) {
  return sessions[socketId] || null;
}

function getProfileBySocket(socketId) {
  const session = getSession(socketId);
  return session ? profiles[session.studentId] || null : null;
}

function emitPlayerState(socket) {
  const profile = getProfileBySocket(socket.id);

  if (profile) {
    socket.emit("playerState", getPlayerState(profile));
  }
}

function touchProfile(profile) {
  const now = Date.now();
  profile.updatedAt = now;
  profile.lastSeenAt = now;
}

function ensureProfile(studentId, team) {
  const existing = normalizeProfile(studentId, profiles[studentId]);

  if (existing) {
    profiles[studentId] = existing;
    return existing;
  }

  const profile = buildNewProfile(studentId, team);
  profiles[studentId] = profile;
  return profile;
}

function removeSession(socketId) {
  const session = sessions[socketId];

  if (!session) {
    return;
  }

  const profile = profiles[session.studentId];

  if (profile) {
    touchProfile(profile);
  }

  delete sessions[socketId];

  if (studentToSocketId[session.studentId] === socketId) {
    delete studentToSocketId[session.studentId];
  }
}

function kickExistingSession(studentId, incomingSocketId) {
  const existingSocketId = studentToSocketId[studentId];

  if (!existingSocketId || existingSocketId === incomingSocketId) {
    return;
  }

  const existingSocket = io.sockets.sockets.get(existingSocketId);

  if (existingSocket) {
    existingSocket.emit("notice", "다른 곳에서 로그인되어 기존 세션이 종료되었습니다.");
    existingSocket.disconnect(true);
  }

  removeSession(existingSocketId);
}

function createSession(socket, studentId) {
  sessions[socket.id] = {
    socketId: socket.id,
    studentId,
    clickWindowStartedAt: 0,
    clicksInWindow: 0,
    cooldownUntil: 0,
    lastRateLimitNoticeAt: 0
  };

  studentToSocketId[studentId] = socket.id;
}

function checkClickRateLimit(socket, session) {
  const now = Date.now();

  if (session.cooldownUntil > now) {
    if (now - session.lastRateLimitNoticeAt > 800) {
      session.lastRateLimitNoticeAt = now;
      reject(socket, `클릭이 너무 빠릅니다. ${Math.ceil((session.cooldownUntil - now) / 1000)}초 뒤 다시 시도하세요.`);
    }

    return false;
  }

  if (now - session.clickWindowStartedAt >= CLICK_WINDOW_MS) {
    session.clickWindowStartedAt = now;
    session.clicksInWindow = 0;
  }

  session.clicksInWindow += 1;

  if (session.clicksInWindow > MAX_CLICKS_PER_WINDOW) {
    session.cooldownUntil = now + CLICK_RATE_LIMIT_COOLDOWN_MS;
    session.lastRateLimitNoticeAt = now;
    reject(socket, "클릭 속도 제한에 걸렸습니다. 잠시 후 다시 시도하세요.");
    return false;
  }

  return true;
}

function joinPlayer(socket, studentId) {
  if (sessions[socket.id]) {
    socket.emit("notice", "이미 입장한 상태입니다.");
    emitPlayerState(socket);
    socket.emit("gameState", getGameState());
    return;
  }

  const normalizedId = String(studentId || "").trim();
  const team = getTeamFromStudentId(normalizedId);

  if (!team) {
    reject(socket, "학번 두 번째 자리로 반을 판별할 수 없습니다.");
    return;
  }

  kickExistingSession(normalizedId, socket.id);

  const profile = ensureProfile(normalizedId, team);
  touchProfile(profile);
  createSession(socket, normalizedId);

  socket.emit("notice", `${TEAM_LABELS[team]} 소속 영토 사령관으로 입장했습니다.`);
  emitPlayerState(socket);
  queueBroadcast();
  queueSave();
}

function rewardAction(profile, amount) {
  profile.gold += amount;
  touchProfile(profile);
}

function fortifyTile(profile, tile) {
  if (!tile.active) {
    return { ok: false, reason: "비활성화된 칸은 강화할 수 없습니다." };
  }

  const fortifyAmount = Math.max(2, Math.round(getAttackPower(profile) * FORTIFY_RATIO));

  if (tile.strength >= MAX_TILE_STRENGTH) {
    return { ok: false, reason: "이 타일은 이미 최대 방어력입니다." };
  }

  tile.strength = clampStrength(tile.strength + fortifyAmount);
  profile.totalActions += 1;
  profile.totalFortifies += fortifyAmount;
  profile.warPoints += fortifyAmount;
  rewardAction(profile, ACTION_GOLD_REWARD);

  return {
    ok: true,
    notice: `아군 타일 방어력 +${fortifyAmount}`
  };
}

function attackTile(profile, tile) {
  if (!tile.active) {
    return { ok: false, reason: "비활성화된 칸은 공격할 수 없습니다." };
  }

  if (tile.base && tile.owner && tile.owner !== profile.team) {
    return { ok: false, reason: "적 본진은 직접 점령할 수 없습니다." };
  }

  if (!hasAdjacentTeam(tile, profile.team)) {
    return { ok: false, reason: "우리 땅과 맞닿은 타일만 공격할 수 있습니다." };
  }

  const attackPower = getAttackPower(profile);
  const wasOwner = tile.owner;

  tile.strength -= attackPower;
  profile.totalActions += 1;
  profile.warPoints += attackPower;
  rewardAction(profile, ACTION_GOLD_REWARD);

  if (tile.strength > 0) {
    return {
      ok: true,
      notice: `${tile.owner ? "적 영토" : "중립 영토"}에 ${attackPower} 피해`
    };
  }

  tile.owner = profile.team;
  tile.strength = CAPTURED_TILE_STRENGTH;
  profile.totalCaptures += 1;
  profile.warPoints += CAPTURED_TILE_STRENGTH;
  rewardAction(profile, CAPTURE_BONUS_GOLD);

  return {
    ok: true,
    notice: wasOwner && wasOwner !== profile.team ? "적 영토 점령 성공" : "새 영토 점령 성공"
  };
}

function bombTile(profile, tile) {
  if (!tile.active) {
    return { ok: false, reason: "이미 비활성화된 칸입니다." };
  }

  if (tile.base) {
    return { ok: false, reason: "본진에는 폭탄을 사용할 수 없습니다." };
  }

  if (profile.bombCount <= 0) {
    return { ok: false, reason: "보유한 폭탄이 없습니다." };
  }

  if (!tile.owner && !hasAdjacentTeam(tile, profile.team)) {
    return { ok: false, reason: "중립 칸은 우리 땅과 맞닿아 있을 때만 폭탄을 사용할 수 있습니다." };
  }

  profile.bombCount -= 1;
  profile.totalActions += 1;
  profile.warPoints += Math.max(8, tile.strength);
  touchProfile(profile);

  tile.active = false;
  tile.owner = null;
  tile.strength = 0;

  return {
    ok: true,
    notice: "폭탄 투하 성공, 타일이 비활성화되었습니다."
  };
}

function handleTileClick(socket, { q, r, mode }) {
  const session = getSession(socket.id);
  const profile = getProfileBySocket(socket.id);

  if (!session || !profile) {
    reject(socket, "먼저 입장해야 합니다.");
    return;
  }

  if (!checkClickRateLimit(socket, session)) {
    return;
  }

  const tile = tiles[key(Number(q), Number(r))];

  if (!tile) {
    reject(socket, "존재하지 않는 타일입니다.");
    return;
  }

  const actionMode = mode === "bomb" ? "bomb" : "battle";
  const result = actionMode === "bomb"
    ? bombTile(profile, tile)
    : (tile.owner === profile.team ? fortifyTile(profile, tile) : attackTile(profile, tile));

  if (!result.ok) {
    reject(socket, result.reason);
    return;
  }

  recomputeBoardStats();
  socket.emit("notice", result.notice);
  emitPlayerState(socket);
  queueBroadcast();
  queueSave();
}

function handleBuyBomb(socket) {
  const profile = getProfileBySocket(socket.id);

  if (!profile) {
    reject(socket, "먼저 입장해야 합니다.");
    return;
  }

  if (profile.gold < BOMB_COST) {
    reject(socket, "폭탄을 사기 위한 골드가 부족합니다.");
    return;
  }

  profile.gold -= BOMB_COST;
  profile.bombCount += 1;
  touchProfile(profile);

  socket.emit("notice", "폭탄 1개를 확보했습니다.");
  emitPlayerState(socket);
  queueSave();
}

function handleUpgrade(socket, type) {
  const profile = getProfileBySocket(socket.id);

  if (!profile) {
    reject(socket, "먼저 입장해야 합니다.");
    return;
  }

  if (!UPGRADE_CONFIG[type]) {
    reject(socket, "알 수 없는 업그레이드입니다.");
    return;
  }

  const levelKey = `${type}Level`;
  const cost = calculateUpgradeCost(type, profile[levelKey]);

  if (profile.gold < cost) {
    reject(socket, "자금이 부족합니다.");
    return;
  }

  profile.gold -= cost;
  profile[levelKey] += 1;
  touchProfile(profile);

  socket.emit("notice", `${UPGRADE_CONFIG[type].label} 업그레이드 완료`);
  emitPlayerState(socket);
  queueSave();
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    onlinePlayers: Object.keys(sessions).length,
    storage: storage.mode,
    bombCost: BOMB_COST,
    teamTileCounts,
    teamStrengthTotals
  });
});

io.on("connection", (socket) => {
  socket.emit("gameState", getGameState());

  socket.on("joinGame", ({ studentId }) => {
    joinPlayer(socket, studentId);
  });

  socket.on("tileClick", ({ q, r, mode }) => {
    handleTileClick(socket, { q, r, mode });
  });

  socket.on("buyUpgrade", ({ type }) => {
    handleUpgrade(socket, type);
  });

  socket.on("buyBomb", () => {
    handleBuyBomb(socket);
  });

  socket.on("disconnect", () => {
    if (sessions[socket.id]) {
      removeSession(socket.id);
      queueBroadcast();
      queueSave();
    }
  });
});

setInterval(() => {
  let changed = false;

  Object.values(sessions).forEach((session) => {
    const profile = profiles[session.studentId];

    if (!profile) {
      return;
    }

    const passiveIncome = getAutoIncome(profile);

    if (passiveIncome <= 0) {
      return;
    }

    profile.gold += passiveIncome;
    touchProfile(profile);
    changed = true;

    const socket = io.sockets.sockets.get(session.socketId);
    if (socket) {
      socket.emit("playerState", getPlayerState(profile));
    }
  });

  if (changed) {
    queueSave();
  }
}, PASSIVE_TICK_MS);

async function shutdown(signal) {
  console.log(`[server] received ${signal}, flushing state...`);

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  await flushSave();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT} using ${storage.mode} storage`);
});
