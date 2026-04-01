import fs from "node:fs/promises";
import path from "node:path";

import { createClient } from "redis";

const DEFAULT_STATE_FILE = path.resolve(process.cwd(), "data", "game-state.json");
const DEFAULT_REDIS_KEY = process.env.REDIS_KEY || "hex-reactor:state";

export async function createStorage() {
  const redisUrl = String(process.env.REDIS_URL || "").trim();

  if (redisUrl) {
    try {
      const client = createClient({
        url: redisUrl
      });

      client.on("error", (error) => {
        console.error("[storage] redis client error:", error);
      });

      await client.connect();

      return {
        mode: "redis",
        async load() {
          const raw = await client.get(DEFAULT_REDIS_KEY);
          return raw ? JSON.parse(raw) : null;
        },
        async save(state) {
          await client.set(DEFAULT_REDIS_KEY, JSON.stringify(state));
        }
      };
    } catch (error) {
      console.error("[storage] redis unavailable, falling back to file storage:", error);
    }
  }

  const stateFile = path.resolve(process.env.STATE_FILE || DEFAULT_STATE_FILE);

  return {
    mode: `file:${stateFile}`,
    async load() {
      try {
        const raw = await fs.readFile(stateFile, "utf8");
        return JSON.parse(raw);
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }

        throw error;
      }
    },
    async save(state) {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
    }
  };
}
