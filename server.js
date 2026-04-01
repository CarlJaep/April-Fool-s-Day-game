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

const STARTING_GOLD = Number(process.env.STARTING_GOLD || 12);
const PASSIVE_TICK_MS = Number(process.env.PASSIVE_TICK_MS || 1000);
const BOOST_STEP = Number(process.env.BOOST_STEP || 0.25);
const MAX_CLICKS_PER_WINDOW = Number(process.env.MAX_CLICKS_PER_WINDOW || 18);
const CLICK_WINDOW_MS = Number(process.env.CLICK_WINDOW_MS || 1000);
const CLICK_RATE_LIMIT_COOLDOWN_MS = Number(process.env.CLICK_RATE_LIMIT_COOLDOWN_MS || 2500);
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS || 400);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 120);
const PORT = Number(process.env.PORT || 3000);

const UPGRADE_CONFIG = {
  click: {
    baseCost: 20,
    growth: 1.6,
    label: "클릭 증폭기"
  },
  auto: {
    baseCost: 70,
    growth: 1.8,
    label: "자동 드론"
  },
  boost: {
    baseCost: 140,
    growth: 1.95,
    label: "오버드라이브"
  }
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
let teamScores = createEmptyTeamMap(0);
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

function getClickValue(profile) {
  return Math.max(1, Math.round((1 + profile.clickLevel) * getMultiplier(profile)));
}

function getAutoValue(profile) {
  return Math.max(0, Math.round(profile.autoLevel * getMultiplier(profile)));
}

function buildNewProfile(studentId, team) {
  const now = Date.now();

  return {
    studentId,
    team,
    gold: STARTING_GOLD,
    clickLevel: 0,
    autoLevel: 0,
    boostLevel: 0,
    totalClicks: 0,
    totalContributed: 0,
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
    clickLevel: Number(rawProfile.clickLevel ?? base.clickLevel),
    autoLevel: Number(rawProfile.autoLevel ?? base.autoLevel),
    boostLevel: Number(rawProfile.boostLevel ?? base.boostLevel),
    totalClicks: Number(rawProfile.totalClicks ?? base.totalClicks),
    totalContributed: Number(rawProfile.totalContributed ?? base.totalContributed),
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

function recomputeTeamScores() {
  const nextScores = createEmptyTeamMap(0);

  Object.values(profiles).forEach((profile) => {
    nextScores[profile.team] += profile.totalContributed;
  });

  teamScores = nextScores;
}

function restoreState(state) {
  profiles = sanitizeProfiles(state?.profiles || {});
  sessions = {};
  studentToSocketId = {};
  recomputeTeamScores();
}

function getPersistedState() {
  return {
    version: 1,
    savedAt: Date.now(),
    profiles,
    teamScores
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
    .sort((left, right) => right.totalContributed - left.totalContributed)
    .slice(0, 10)
    .map((profile) => ({
      label: maskStudentId(profile.studentId),
      team: profile.team,
      teamLabel: TEAM_LABELS[profile.team],
      totalContributed: profile.totalContributed,
      totalClicks: profile.totalClicks
    }));
}

function getPublicMeta() {
  return {
    onlinePlayers: Object.keys(sessions).length,
    passiveTickMs: PASSIVE_TICK_MS,
    teamScores,
    teamPlayerCounts: getOnlineCounts(),
    topPlayers: getTopPlayers()
  };
}

function getGameState() {
  return {
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
    clickLevel: profile.clickLevel,
    autoLevel: profile.autoLevel,
    boostLevel: profile.boostLevel,
    clickValue: getClickValue(profile),
    autoValue: getAutoValue(profile),
    totalClicks: profile.totalClicks,
    totalContributed: profile.totalContributed,
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

function creditProfile(profile, amount, source) {
  if (amount <= 0) {
    return;
  }

  profile.gold += amount;
  profile.totalContributed += amount;
  teamScores[profile.team] += amount;
  touchProfile(profile);

  if (source === "click") {
    profile.totalClicks += 1;
  }
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

  socket.emit("notice", `${TEAM_LABELS[team]} 소속 클릭러로 입장했습니다.`);
  emitPlayerState(socket);
  queueBroadcast();
  queueSave();
}

function handleClick(socket) {
  const session = getSession(socket.id);
  const profile = getProfileBySocket(socket.id);

  if (!session || !profile) {
    reject(socket, "먼저 입장해야 합니다.");
    return;
  }

  if (!checkClickRateLimit(socket, session)) {
    return;
  }

  creditProfile(profile, getClickValue(profile), "click");
  emitPlayerState(socket);
  queueBroadcast();
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
  queueBroadcast();
  queueSave();
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    onlinePlayers: Object.keys(sessions).length,
    storage: storage.mode,
    teamScores
  });
});

io.on("connection", (socket) => {
  socket.emit("gameState", getGameState());

  socket.on("joinGame", ({ studentId }) => {
    joinPlayer(socket, studentId);
  });

  socket.on("clickReactor", () => {
    handleClick(socket);
  });

  socket.on("buyUpgrade", ({ type }) => {
    handleUpgrade(socket, type);
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

    const passiveIncome = getAutoValue(profile);

    if (passiveIncome <= 0) {
      return;
    }

    creditProfile(profile, passiveIncome, "auto");
    changed = true;

    const socket = io.sockets.sockets.get(session.socketId);
    if (socket) {
      socket.emit("playerState", getPlayerState(profile));
    }
  });

  if (changed) {
    queueBroadcast();
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
