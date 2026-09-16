"use strict";

// Bounded UPnP/DLNA RenderingControl client used to set volume directly on a
// DLNA renderer (e.g. a Samsung TV whose Jellyfin DLNA session rejects the
// generic /Sessions/{id}/Command SetVolume route). This is the out-of-band
// path for issue #506; playback controls keep going through Jellyfin.
//
// Safety model:
//   - Endpoints are never caller-supplied. They come from the profile's
//     dlna_rendering_controls configuration (base_url + optional control_path)
//     or from a device-description fetch against that configured base URL.
//   - The resolved control URL host MUST match the selected active session's
//     RemoteEndPoint host, otherwise the command is refused. This ties the
//     command to the renderer the operator selected, not to an arbitrary URL.
//   - base_url must use a literal IP (LAN renderer), http/https only, and no
//     credentials, query or fragment.
//   - Volume is validated to an integer in 0..100 by the tool schema before
//     any SOAP is built.
//   - Responses are byte-bounded; only GetVolume's CurrentVolume value is
//     extracted (integer, 0..100).

const http = require("http");
const https = require("https");
const net = require("net");
const { JellyfinError } = require("./errors");

const MAX_RESPONSE_BYTES = 256 * 1024;
const RENDERING_CONTROL_TYPE = "urn:schemas-upnp-org:service:RenderingControl:1";

// Samsung AllShare serves its device description here; other renderers answer
// on the conventional paths. Discovery tries these in order and uses the first
// description that actually advertises a RenderingControl service.
const DESCRIPTION_PATHS = [
  "/dmr",
  "/DeviceDescription.xml",
  "/device_description.xml",
  "/",
];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function soapEnvelope(action, inner) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    "<s:Body>" +
    `<u:${action} xmlns:u="${RENDERING_CONTROL_TYPE}">` +
    inner +
    `</u:${action}>` +
    "</s:Body>" +
    "</s:Envelope>"
  );
}

function setVolumeEnvelope(volume) {
  return soapEnvelope(
    "SetVolume",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${xmlEscape(volume)}</DesiredVolume>`,
  );
}

function getVolumeEnvelope() {
  return soapEnvelope("GetVolume", "<InstanceID>0</InstanceID><Channel>Master</Channel>");
}

function parseCurrentVolume(xml) {
  const match = /<CurrentVolume[^>]*>\s*(\d+)\s*<\/CurrentVolume>/i.exec(String(xml || ""));
  if (!match) return null;
  const volume = Number(match[1]);
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : null;
}

// Extract the RenderingControl service control URL from a UPnP device
// description. Bounded regex parsing of a byte-bounded XML document; no XML
// library dependency. controlURL may be relative or absolute.
function extractControlUrl(descriptionXml, baseUrl) {
  const text = String(descriptionXml || "");
  const serviceBlocks = text.match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const block of serviceBlocks) {
    const typeMatch = /<serviceType[^>]*>\s*([^<]+?)\s*<\/serviceType>/i.exec(block);
    const controlMatch = /<controlURL[^>]*>\s*([^<]+?)\s*<\/controlURL>/i.exec(block);
    if (!typeMatch || !controlMatch) continue;
    const type = typeMatch[1].trim();
    const control = controlMatch[1].trim();
    if (!/RenderingControl:1$/i.test(type) || !control) continue;
    try {
      const url = new URL(control, baseUrl);
      return { url, service_type: type };
    } catch {
      return null;
    }
  }
  return null;
}

function hostFromEndPoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    return raw.slice(1, end).toLowerCase();
  }
  const idx = raw.lastIndexOf(":");
  return (idx === -1 ? raw : raw.slice(0, idx)).toLowerCase();
}

function stripBrackets(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
}

function sanitizeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new JellyfinError("invalid_input", `${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new JellyfinError("invalid_input", `${label} must use http or https`);
  if (url.username || url.password)
    throw new JellyfinError("invalid_input", `${label} must not contain credentials`);
  if (url.search || url.hash)
    throw new JellyfinError("invalid_input", `${label} must not contain a query or fragment`);
  if (!net.isIP(stripBrackets(url.hostname)))
    throw new JellyfinError("invalid_input", `${label} must use a literal IP address`);
  return url;
}

function normalizeControlPath(value) {
  const path = String(value || "");
  if (!path.startsWith("/"))
    throw new JellyfinError("invalid_input", "dlna rendering control_path must start with /");
  if (/[?#\s]/.test(path))
    throw new JellyfinError("invalid_input", "dlna rendering control_path must be a plain path");
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(path))
    throw new JellyfinError("invalid_input", "dlna rendering control_path contains unsupported characters");
  return path;
}

function assertHostMatches(hostA, hostB, label) {
  if (!hostA || !hostB || hostA !== hostB) {
    throw new JellyfinError(
      "state_conflict",
      `refusing DLNA ${label}: renderer address does not match the selected active DLNA session`,
    );
  }
}

function request(url, { method, action, body, expectedHost, signal, timeoutMs }) {
  const transport = url.protocol === "https:" ? https : http;
  const payload = body ? Buffer.from(body, "utf8") : null;
  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method,
    timeout: timeoutMs,
    headers: {
      Host: url.host,
      "User-Agent": "Sidekick-Jellyfin-DLNA/1.0",
    },
  };
  if (action) {
    options.headers["Content-Type"] = 'text/xml; charset="utf-8"';
    options.headers["SOAPAction"] = `"${RENDERING_CONTROL_TYPE}#${action}"`;
  }
  if (payload) options.headers["Content-Length"] = payload.length;

  return new Promise((resolve, reject) => {
    let requestHandle;
    const fail = (error) => {
      if (error?.code === "ABORT_ERR")
        return reject(new JellyfinError("timeout", "DLNA renderer request cancelled"));
      if (error?.code === "ETIMEDOUT")
        return reject(new JellyfinError("timeout", "DLNA renderer request timed out"));
      return reject(
        new JellyfinError("connection_failed", `DLNA renderer connection failed: ${String(error?.message || error).slice(0, 300)}`),
      );
    };
    requestHandle = transport.request(options, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          requestHandle.destroy();
          reject(new JellyfinError("server_error", "DLNA renderer response exceeded the bounded response size"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const code =
            response.statusCode >= 400 && response.statusCode < 500
              ? "invalid_input"
              : "server_error";
          reject(
            new JellyfinError(
              code,
              `DLNA renderer ${action || method} was rejected with HTTP ${response.statusCode}`,
              { status: response.statusCode },
            ),
          );
          return;
        }
        resolve({ status: response.statusCode, text });
      });
    });
    requestHandle.on("error", fail);
    requestHandle.on("timeout", () =>
      requestHandle.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    );
    if (signal) {
      if (signal.aborted)
        requestHandle.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
      else
        signal.addEventListener(
          "abort",
          () => requestHandle.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })),
          { once: true },
        );
    }
    if (payload) requestHandle.write(payload);
    requestHandle.end();
  });
}

// Resolve a configured control_path against the renderer base URL without
// touching the network (used for dry-run plans and fast-failing misconfig).
function configuredControlUrl(renderer, expectedHost) {
  const baseUrl = sanitizeBaseUrl(renderer.base_url, "dlna rendering control base_url");
  assertHostMatches(stripBrackets(baseUrl.hostname), expectedHost, "base_url");
  if (!renderer.control_path) {
    throw new JellyfinError(
      "invalid_input",
      "dlna rendering control_path is required for a configured control URL",
    );
  }
  const url = new URL(normalizeControlPath(renderer.control_path), baseUrl);
  assertHostMatches(stripBrackets(url.hostname), expectedHost, "configured control URL");
  return { url, method: "configured", source_url: baseUrl.origin };
}

// Fetch the renderer's device description from the configured base URL and
// pull the RenderingControl control URL out of it. Returns null when no
// RenderingControl service is advertised.
async function discoverControlUrl(baseUrl, { signal, timeoutMs }) {
  const tried = [];
  for (const candidate of DESCRIPTION_PATHS) {
    const url = new URL(candidate, baseUrl);
    tried.push(url.toString());
    let response;
    try {
      response = await request(url, { method: "GET", signal, timeoutMs });
    } catch {
      continue;
    }
    const found = extractControlUrl(response.text, baseUrl);
    if (found) return { ...found, tried, source_url: url.toString() };
  }
  return null;
}

async function resolveControlUrl(renderer, { expectedHost, signal, timeoutMs }) {
  if (renderer.control_path) return configuredControlUrl(renderer, expectedHost);
  const baseUrl = sanitizeBaseUrl(renderer.base_url, "dlna rendering control base_url");
  assertHostMatches(stripBrackets(baseUrl.hostname), expectedHost, "base_url");
  const discovered = await discoverControlUrl(baseUrl, { signal, timeoutMs });
  if (!discovered) {
    throw new JellyfinError(
      "unsupported_capability",
      "DLNA renderer did not advertise a RenderingControl service on the configured base URL",
      { base_url: baseUrl.origin, tried: DESCRIPTION_PATHS.map((p) => new URL(p, baseUrl).toString()) },
    );
  }
  assertHostMatches(stripBrackets(discovered.url.hostname), expectedHost, "discovered control URL");
  return { url: discovered.url, method: "discovered", source_url: discovered.source_url };
}

async function setVolume(controlUrl, volume, { signal, timeoutMs }) {
  await request(controlUrl, {
    method: "POST",
    action: "SetVolume",
    body: setVolumeEnvelope(volume),
    signal,
    timeoutMs,
  });
}

async function getVolume(controlUrl, { signal, timeoutMs }) {
  const response = await request(controlUrl, {
    method: "POST",
    action: "GetVolume",
    body: getVolumeEnvelope(),
    signal,
    timeoutMs,
  });
  const volume = parseCurrentVolume(response.text);
  if (volume === null) {
    throw new JellyfinError(
      "server_error",
      "DLNA renderer GetVolume response did not include a readable CurrentVolume",
    );
  }
  return volume;
}

module.exports = {
  RENDERING_CONTROL_TYPE,
  DESCRIPTION_PATHS,
  MAX_RESPONSE_BYTES,
  setVolumeEnvelope,
  getVolumeEnvelope,
  parseCurrentVolume,
  extractControlUrl,
  hostFromEndPoint,
  sanitizeBaseUrl,
  normalizeControlPath,
  configuredControlUrl,
  resolveControlUrl,
  discoverControlUrl,
  setVolume,
  getVolume,
};