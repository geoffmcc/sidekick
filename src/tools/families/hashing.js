"use strict";

const crypto = require("crypto");
const { z } = require("zod");
const { enforcePathPolicy } = require("../path-policy");
const { requireToolExecution } = require("../read-authorization");
const { hashFile: hashFileDetails, HASH_STREAM_HIGH_WATER_MARK, HASH_FILE_TIMEOUT_MS } = require("../../core/stream-file-hash");

function hashFile(filePath, algorithm, timeoutMs = HASH_FILE_TIMEOUT_MS) {
  return hashFileDetails(filePath, algorithm, { timeoutMs }).then(result => result.hash);
}

async function sidekick_hash({ input, algorithm, verify, path: filePath }) {
  if (filePath) {
    const authError = requireToolExecution({ tool: "hash", path: filePath }, "tools.execute", "hash");
    if (authError) return authError;
  }
  const algo = algorithm || "sha256";
  const validAlgorithms = ["md5", "sha1", "sha256", "sha512"];

  if (!validAlgorithms.includes(algo)) {
    return { content: [{ type: "text", text: `Invalid algorithm. Use: ${validAlgorithms.join(", ")}` }], isError: true };
  }

  let hash;

  if (filePath) {
    const policyError = enforcePathPolicy(filePath, "read");
    if (policyError) return policyError;
    // Stream files through a bounded buffer rather than allocating memory in
    // proportion to an operator-authorized file's size.
    try {
      hash = await hashFile(filePath, algo);
    } catch (e) {
      return { content: [{ type: "text", text: `File read error: ${e.message}` }], isError: true };
    }
  } else if (input) {
    hash = crypto.createHash(algo).update(input, "utf-8").digest("hex");
  } else {
    return { content: [{ type: "text", text: "input or path required" }], isError: true };
  }

  if (verify) {
    const matches = hash === verify.toLowerCase();
    return { content: [{ type: "text", text: matches ? `✓ Hash matches (${algo}: ${hash})` : `✗ Hash mismatch\nExpected: ${verify}\nActual:   ${hash}` }] };
  }

  return { content: [{ type: "text", text: `${algo.toUpperCase()}: ${hash}` }] };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "hash",
    description: "Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification",
    schema: z.object({
      input: z.string().optional().describe("Data to hash (string content)"),
      path: z.string().optional().describe("File path to hash"),
      algorithm: z.string().optional().describe("Hash algorithm: md5, sha1, sha256, sha512 (default: sha256)"),
      verify: z.string().optional().describe("Expected hash value to verify against"),
    }),
    args: {
      input: "string (optional, data to hash)",
      path: "string (optional, file path to hash)",
      algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)",
      verify: "string (optional, expected hash to verify against)",
    },
    risk: "medium",
    category: "Data Pipeline",
    source: "builtin",
    family: "hashing",
    handler: sidekick_hash,
  }),
]);

module.exports = { descriptors, sidekick_hash, hashFile, HASH_STREAM_HIGH_WATER_MARK, HASH_FILE_TIMEOUT_MS };
