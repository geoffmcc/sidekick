function validLangCode(value, fallback = "eng") {
  const lang = value || fallback;
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(lang)) throw new Error("Invalid language code");
  return lang;
}

function validWhisperModel(value) {
  const model = value || "base";
  if (!/^(tiny|base|small|medium|large|large-v[123])$/.test(model)) throw new Error("Invalid transcription model");
  return model;
}

function validTimestamp(value, fallback = "00:00:01") {
  const ts = value || fallback;
  if (!/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(ts)) throw new Error("Invalid timestamp; use HH:MM:SS[.mmm]");
  return ts;
}

function validScale(value, fallback = "800:-1") {
  const scale = value || fallback;
  if (!/^-?\d{1,5}:-?\d{1,5}$/.test(scale)) throw new Error("Invalid scale; use WIDTH:HEIGHT");
  return scale;
}

function validDownloadFormat(value) {
  if (!value) return null;
  if (!/^[A-Za-z0-9_.,:+\-/\[\]=<>]+$/.test(value) || value.length > 120) throw new Error("Invalid download format");
  return value;
}

function validIdentifier(value, label, max = 80) {
  const text = String(value || "");
  if (!new RegExp(`^[A-Za-z0-9._-]{1,${max}}$`).test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function validPort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
  return String(port);
}

function validDomainName(value) {
  const text = String(value || "");
  if (!/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(text)) throw new Error("Invalid domain");
  return text;
}

function validWireGuardPublicKey(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9+/]{42,44}=*$/.test(text)) throw new Error("Invalid WireGuard public key");
  return text;
}

function validWireGuardEndpoint(value) {
  if (!value) return null;
  const text = String(value);
  if (!/^[A-Za-z0-9._:-]{1,255}:\d{1,5}$/.test(text)) throw new Error("Invalid WireGuard endpoint");
  return text;
}

function validAllowedIps(value) {
  const text = String(value || "10.0.0.0/24");
  if (!/^([A-Fa-f0-9:.]+|\d{1,3}(?:\.\d{1,3}){3})\/\d{1,3}(?:,([A-Fa-f0-9:.]+|\d{1,3}(?:\.\d{1,3}){3})\/\d{1,3})*$/.test(text)) throw new Error("Invalid allowed IPs");
  return text;
}

module.exports = {
  validAllowedIps,
  validDomainName,
  validDownloadFormat,
  validIdentifier,
  validLangCode,
  validPort,
  validScale,
  validTimestamp,
  validWhisperModel,
  validWireGuardEndpoint,
  validWireGuardPublicKey,
};
