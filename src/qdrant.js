const QDRANT_URL = process.env.SIDEKICK_QDRANT_URL || "http://127.0.0.1:6333";
const COLLECTION_NAME = "sidekick_context";
const EMBEDDING_DIM = 768; // nomic-embed-text dimension

class QdrantClient {
  constructor() {
    this.baseUrl = QDRANT_URL;
  }

  async isAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureCollection() {
    // Check if collection exists
    const checkResponse = await fetch(`${this.baseUrl}/collections/${COLLECTION_NAME}`);
    
    if (!checkResponse.ok) {
      // Create collection
      const createResponse = await fetch(`${this.baseUrl}/collections/${COLLECTION_NAME}`, {
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
    }
  }

  async upsert(id, vector, payload) {
    await this.ensureCollection();
    
    const response = await fetch(`${this.baseUrl}/collections/${COLLECTION_NAME}/points`, {
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
      throw new Error(`Failed to upsert point: ${response.statusText}`);
    }
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
    
    const response = await fetch(`${this.baseUrl}/collections/${COLLECTION_NAME}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to search: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.result || [];
  }

  async delete(id) {
    const response = await fetch(`${this.baseUrl}/collections/${COLLECTION_NAME}/points/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [this.hashId(id)]
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete point: ${response.statusText}`);
    }
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

module.exports = new QdrantClient();
