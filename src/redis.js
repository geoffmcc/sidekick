const Redis = require("ioredis");

const REDIS_URL = process.env.SIDEKICK_REDIS_URL || "redis://127.0.0.1:6379";

let client = null;

function getClient() {
  if (!client) {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
    });
  }
  return client;
}

async function connect() {
  const c = getClient();
  if (c.status === "wait" || c.status === "end") {
    await c.connect();
  }
  return c;
}

async function testConnection() {
  try {
    const c = await connect();
    const result = await c.ping();
    return { connected: result === "PONG" };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

async function get(key) {
  const c = await connect();
  return await c.get(key);
}

async function set(key, value, ttlSeconds) {
  const c = await connect();
  if (ttlSeconds) {
    await c.set(key, value, "EX", ttlSeconds);
  } else {
    await c.set(key, value);
  }
  return true;
}

async function del(key) {
  const c = await connect();
  return await c.del(key);
}

async function keys(pattern = "*") {
  const c = await connect();
  return await c.keys(pattern);
}

async function ttl(key) {
  const c = await connect();
  return await c.ttl(key);
}

async function info() {
  const c = await connect();
  const serverInfo = await c.info("server");
  const memoryInfo = await c.info("memory");
  const statsInfo = await c.info("stats");
  
  const parseInfo = (str) => {
    const obj = {};
    str.split("\n").forEach(line => {
      line = line.trim();
      if (line && !line.startsWith("#")) {
        const [key, val] = line.split(":");
        if (key && val) obj[key.trim()] = val.trim();
      }
    });
    return obj;
  };

  return {
    server: parseInfo(serverInfo),
    memory: parseInfo(memoryInfo),
    stats: parseInfo(statsInfo),
  };
}

async function flush() {
  const c = await connect();
  return await c.flushdb();
}

module.exports = {
  getClient,
  connect,
  testConnection,
  get,
  set,
  del,
  keys,
  ttl,
  info,
  flush,
};
