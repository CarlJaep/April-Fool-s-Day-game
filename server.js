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
const CHAT_COOLDOWN_MS = Number(process.env.CHAT_COOLDOWN_MS || 700);
const CHAT_HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT || 40);
const MAX_CHAT_LENGTH = Number(process.env.MAX_CHAT_LENGTH || 140);
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
const REBUILD_COST = Number(process.env.REBUILD_COST || 28);
const EXPAND_COST = Number(process.env.EXPAND_COST || 34);
const EXPANDED_TILE_STRENGTH = Number(process.env.EXPANDED_TILE_STRENGTH || 18);

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

const ACHIEVEMENT_DEFS = [
  { id: "first_capture", title: "첫 점령", description: "처음으로 적 또는 중립 영토를 점령했습니다." },
  { id: "frontier_builder", title: "개척자", description: "미개척 지대에 새로운 땅을 만들었습니다." },
  { id: "restorer", title: "복구반", description: "폐허를 재건했습니다." },
  { id: "demolition", title: "폭파 전문가", description: "폭탄을 3번 사용했습니다." },
  { id: "fortress", title: "성벽 장인", description: "방어력을 120 이상 보강했습니다." },
  { id: "field_commander", title: "전장 지휘관", description: "전투 행동을 50번 수행했습니다." },
  { id: "warlord", title: "워로드", description: "전쟁 점수 500점을 달성했습니다." },
  { id: "chatter", title: "수다 지휘관", description: "채팅을 10번 보냈습니다." }
];

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
let chatHistory = [];

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

function parseTileKey(tileKey) {
  const [qRaw, rRaw] = String(tileKey).split(",");
  const q = Number(qRaw);
  const r = Number(rRaw);

  if (!Number.isFinite(q) || !Number.isFinite(r)) {
    return null;
  }

  return { q, r };
}

function isBasePosition(q, r) {
  return Object.values(BASE_POSITIONS).some((position) => position.q === q && position.r === r);
}

function sanitizeChatHistory(rawChatHistory) {
  if (!Array.isArray(rawChatHistory)) {
    return [];
  }

  return rawChatHistory
    .filter((entry) => entry && typeof entry === "object")
    .slice(-CHAT_HISTORY_LIMIT)
    .map((entry) => ({
      id: String(entry.id || `${Date.now()}-${Math.random()}`),
      team: typeof entry.team === "string" && TEAM_LABELS[entry.team] ? entry.team : "blue",
      teamLabel: TEAM_LABELS[typeof entry.team === "string" && TEAM_LABELS[entry.team] ? entry.team : "blue"],
      author: String(entry.author || "알 수 없음"),
      text: String(entry.text || "").slice(0, MAX_CHAT_LENGTH),
      createdAt: Number(entry.createdAt || Date.now())
    }));
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

  Object.entries(rawTiles).forEach(([tileKey, rawTile]) => {
    const parsed = parseTileKey(tileKey);

    if (!parsed || !rawTile || typeof rawTile !== "object") {
      return;
    }

    const freshTile = freshTiles[tileKey] || {
      q: parsed.q,
      r: parsed.r,
      owner: null,
      active: true,
      strength: NEUTRAL_TILE_STRENGTH,
      base: isBasePosition(parsed.q, parsed.r)
    };

    freshTiles[tileKey] = freshTile;

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

function calculateUpgradeCost(type, level) {
  const config = UPGRADE_CONFIG[type];
  return Math.round(config.baseCost * (config.growth ** level));
}

function getMultiplier(profile) {
  return 1 + (profile.boostLevel * BOOST_STEP);
}

function getAttackPower(profile) {
  return Math.max(2, Math.round((2 + profile.clickLevel * 2) * getMultiplier(profile)));
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
    totalBombsUsed: 0,
    totalRebuilds: 0,
    totalExpansions: 0,
    totalMessages: 0,
    warPoints: 0,
    achievements: [],
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
    totalBombsUsed: Number(rawProfile.totalBombsUsed ?? base.totalBombsUsed),
    totalRebuilds: Number(rawProfile.totalRebuilds ?? base.totalRebuilds),
    totalExpansions: Number(rawProfile.totalExpansions ?? base.totalExpansions),
    totalMessages: Number(rawProfile.totalMessages ?? base.totalMessages),
    warPoints: Number(rawProfile.warPoints ?? rawProfile.totalContributed ?? base.warPoints),
    achievements: Array.isArray(rawProfile.achievements) ? rawProfile.achievements.map((value) => String(value)) : [],
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
  chatHistory = sanitizeChatHistory(state?.chatHistory);
  sessions = {};
  studentToSocketId = {};
  recomputeBoardStats();
}

function getPersistedState() {
  return {
    version: 2,
    savedAt: Date.now(),
    profiles,
    tiles,
    chatHistory
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
      label: profile.studentId,
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
    rebuildCost: REBUILD_COST,
    expandCost: EXPAND_COST,
    teamTileCounts,
    teamStrengthTotals,
    teamPlayerCounts: getOnlineCounts(),
    topPlayers: getTopPlayers(),
    chatHistory,
    achievementDefs: ACHIEVEMENT_DEFS
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
    totalBombsUsed: profile.totalBombsUsed,
    totalRebuilds: profile.totalRebuilds,
    totalExpansions: profile.totalExpansions,
    totalMessages: profile.totalMessages,
    warPoints: profile.warPoints,
    teamTerritoryCount: teamTileCounts[profile.team],
    achievements: profile.achievements,
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

function buildChatMessage(profile, text) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    team: profile.team,
    teamLabel: TEAM_LABELS[profile.team],
    author: profile.studentId,
    text,
    createdAt: Date.now()
  };
}

function appendChatMessage(message) {
  chatHistory = [...chatHistory, message].slice(-CHAT_HISTORY_LIMIT);
}

function evaluateAchievements(profile) {
  const unlocked = [];
  const owned = new Set(profile.achievements);

  const maybeUnlock = (id, condition) => {
    if (!owned.has(id) && condition) {
      owned.add(id);
      unlocked.push(ACHIEVEMENT_DEFS.find((entry) => entry.id === id));
    }
  };

  maybeUnlock("first_capture", profile.totalCaptures >= 1);
  maybeUnlock("frontier_builder", profile.totalExpansions >= 1);
  maybeUnlock("restorer", profile.totalRebuilds >= 1);
  maybeUnlock("demolition", profile.totalBombsUsed >= 3);
  maybeUnlock("fortress", profile.totalFortifies >= 120);
  maybeUnlock("field_commander", profile.totalActions >= 50);
  maybeUnlock("warlord", profile.warPoints >= 500);
  maybeUnlock("chatter", profile.totalMessages >= 10);

  profile.achievements = Array.from(owned);
  return unlocked.filter(Boolean);
}

function emitUnlockedAchievements(socket, profile) {
  const unlocked = evaluateAchievements(profile);

  unlocked.forEach((achievement) => {
    socket.emit("achievementUnlocked", achievement);
  });

  return unlocked;
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
    lastRateLimitNoticeAt: 0,
    lastChatAt: 0
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

  profile.bombCount -= 1;
  profile.totalActions += 1;
  profile.totalBombsUsed += 1;
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

function rebuildTile(profile, tile) {
  if (tile.active) {
    return { ok: false, reason: "활성 칸은 재건 대상이 아닙니다." };
  }

  if (!hasAdjacentTeam(tile, profile.team)) {
    return { ok: false, reason: "우리 영토와 맞닿은 폐허만 재건할 수 있습니다." };
  }

  if (profile.gold < REBUILD_COST) {
    return { ok: false, reason: "폐허를 재건할 골드가 부족합니다." };
  }

  profile.gold -= REBUILD_COST;
  profile.totalActions += 1;
  profile.totalCaptures += 1;
  profile.totalRebuilds += 1;
  profile.warPoints += EXPANDED_TILE_STRENGTH;
  touchProfile(profile);

  tile.active = true;
  tile.owner = profile.team;
  tile.strength = EXPANDED_TILE_STRENGTH;

  return {
    ok: true,
    notice: "폐허를 재건해 새로운 전초기지로 만들었습니다."
  };
}

function expandTerritory(profile, q, r) {
  const nextKey = key(q, r);

  if (tiles[nextKey]) {
    return { ok: false, reason: "이미 존재하는 칸입니다." };
  }

  if (!hasAdjacentTeam({ q, r }, profile.team)) {
    return { ok: false, reason: "우리 영토와 맞닿은 바깥 칸만 개척할 수 있습니다." };
  }

  if (profile.gold < EXPAND_COST) {
    return { ok: false, reason: "개척에 필요한 골드가 부족합니다." };
  }

  profile.gold -= EXPAND_COST;
  profile.totalActions += 1;
  profile.totalCaptures += 1;
  profile.totalExpansions += 1;
  profile.warPoints += EXPANDED_TILE_STRENGTH;
  touchProfile(profile);

  tiles[nextKey] = {
    q,
    r,
    owner: profile.team,
    active: true,
    strength: EXPANDED_TILE_STRENGTH,
    base: false
  };

  return {
    ok: true,
    notice: "미개척 지대를 열어 새 영토를 만들었습니다."
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

  const targetQ = Number(q);
  const targetR = Number(r);
  const tile = tiles[key(targetQ, targetR)];
  const actionMode = mode === "bomb" || mode === "rebuild" || mode === "expand" ? mode : "battle";

  if (actionMode === "expand") {
    const result = expandTerritory(profile, targetQ, targetR);

    if (!result.ok) {
      reject(socket, result.reason);
      return;
    }

    recomputeBoardStats();
    emitUnlockedAchievements(socket, profile);
    socket.emit("notice", result.notice);
    emitPlayerState(socket);
    queueBroadcast();
    queueSave();
    return;
  }

  if (!tile) {
    reject(socket, "존재하지 않는 타일입니다.");
    return;
  }

  const result = actionMode === "bomb"
    ? bombTile(profile, tile)
    : (actionMode === "rebuild"
      ? rebuildTile(profile, tile)
      : (tile.owner === profile.team ? fortifyTile(profile, tile) : attackTile(profile, tile)));

  if (!result.ok) {
    reject(socket, result.reason);
    return;
  }

  recomputeBoardStats();
  emitUnlockedAchievements(socket, profile);
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

function handleChatMessage(socket, rawText) {
  const session = getSession(socket.id);
  const profile = getProfileBySocket(socket.id);

  if (!session || !profile) {
    reject(socket, "먼저 입장해야 합니다.");
    return;
  }

  const now = Date.now();

  if (now - session.lastChatAt < CHAT_COOLDOWN_MS) {
    reject(socket, "채팅을 너무 빠르게 보내고 있습니다.");
    return;
  }

  const text = String(rawText || "").trim().replace(/\s+/g, " ").slice(0, MAX_CHAT_LENGTH);

  if (!text) {
    reject(socket, "빈 메시지는 보낼 수 없습니다.");
    return;
  }

  session.lastChatAt = now;
  profile.totalMessages += 1;
  touchProfile(profile);

  const message = buildChatMessage(profile, text);
  appendChatMessage(message);
  emitUnlockedAchievements(socket, profile);
  io.emit("chatMessage", message);
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

  socket.on("chatMessage", (text) => {
    handleChatMessage(socket, text);
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
