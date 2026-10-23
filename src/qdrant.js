const http = require("node:http");
const https = require("node:https");
const { Readable } = require("node:stream");
const { resolveOutboundUrl } = require("./security/outbound-url");

const QDRANT_URL = process.env.SIDEKICK_QDRANT_URL || "http://127.0.0.1:6333";
const COLLECTION_NAME = "sidekick_context";
const EMBEDDING_DIM = 768; // nomic-embed-text dimension
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function qdrantRequest(url, options = {}) {
  const target = new URL(url);
  const destination = await resolveOutboundUrl(target.href, "Qdrant endpoint", { allowPrivate: true });
  if (destination.refusal) throw new Error(destination.refusal);

  const signal = options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (signal.aborted) throw signal.reason || new Error("Qdrant request aborted");
  const transport = target.protocol === "https:" ? https : http;
  const requestOptions = {
    hostname: destination.address,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: options.method || "GET",
    headers: { "Accept-Encoding": "identity", Host: target.host, ...(options.headers || {}) },
    ...(target.protocol === "https:" ? { servername: target.hostname.replace(/^\[|\]$/g, "") } : {}),
  };

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, response => {
      const body = [204, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      resolve(new Response(body, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
      }));
    });
    const onAbort = () => request.destroy(signal.reason || new Error("Qdrant request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", onAbort));
    request.on("error", reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response?.body?.getReader?.();
  let text;
  if (!reader) {
    throw new Error("Qdrant response cannot be read with a bounded stream");
  } else {
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("Qdrant response exceeded the configured size limit");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    text = Buffer.concat(chunks, totalBytes).toString("utf8");
  }
  return JSON.parse(text);
}

async function discardResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

class QdrantClient {
  constructor() {
    this.baseUrl = QDRANT_URL;
  }

  async isAvailable() {
    try {
      const response = await qdrantRequest(`${this.baseUrl}/`);
      await discardResponseBody(response);
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureCollection() {
    // Check if collection exists
    const checkResponse = await qdrantRequest(`${this.baseUrl}/collections/${COLLECTION_NAME}`);
    if (checkResponse.ok) {
      await discardResponseBody(checkResponse);
      return;
    }
    await discardResponseBody(checkResponse);
    
    if (!checkResponse.ok) {
      // Create collection
      const createResponse = await qdrantRequest(`${this.baseUrl}/collections/${COLLECTION_NAME}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vectors: {
            size: EMBEDDING_DIM,
            distance: "Cosine"
          }
        })
      });
      
      if (!createResponse.ok) {
        throw new Error(`Failed to create collection: ${createResponse.statusText}`);
      }
      await discardResponseBody(createResponse);
    }
  }

  async upsert(id, vector, payload) {
    await this.ensureCollection();
    
    const response = await qdrantRequest(`${this.baseUrl}/collections/${COLLECTION_NAME}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id: this.hashId(id),
            vector: vector,
            payload: payload
          }
        ]
      })
    });
    
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`Failed to upsert point: ${response.statusText}`);
    }
    await discardResponseBody(response);
  }

  async search(vector, limit = 10, filter = null) {
    await this.ensureCollection();
    
    const body = {
      vector: vector,
      limit: limit,
      with_payload: true
    };
    
    if (filter) {
      body.filter = filter;
    }
    
    const response = await qdrantRequest(`${this.baseUrl}/collections/${COLLECTION_NAME}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`Failed to search: ${response.statusText}`);
    }
    const data = await readBoundedJson(response);
    return data.result || [];
  }

  async delete(id) {
    const response = await qdrantRequest(`${this.baseUrl}/collections/${COLLECTION_NAME}/points/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [this.hashId(id)]
      })
    });
    
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`Failed to delete point: ${response.statusText}`);
    }
    await discardResponseBody(response);
  }

  // Convert string ID to numeric hash (Qdrant requires numeric IDs by default)
  hashId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

module.exports = Object.assign(new QdrantClient(), {
  qdrantRequest,
  readBoundedJson,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
});
