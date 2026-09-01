"use strict";

const MAX_ROUTE_GROUPS = 100;
const state = { requests: 0, errors: 0, timeouts: 0, aborted: 0, active: 0, total_ms: 0, bytes: 0, by_route: Object.create(null) };

function routeGroup(req) {
  const path = String(req.route?.path || req.path || "unknown");
  if (req.route?.path) return path.slice(0, 120);
  const parts = path.split("/").filter(Boolean);
  return `/${parts.slice(0, 2).concat(parts.length > 2 ? ":param" : []).join("/")}`.slice(0, 120) || "unknown";
}
function observe(req, res, durationMs) {
  const group = routeGroup(req);
  const bucket = state.by_route[group] || (Object.keys(state.by_route).length < MAX_ROUTE_GROUPS ? (state.by_route[group] = { requests: 0, errors: 0, total_ms: 0 }) : (state.by_route.other ||= { requests: 0, errors: 0, total_ms: 0 }));
  state.requests++; state.active = Math.max(0, state.active - 1); state.total_ms += durationMs; state.bytes += Number(res.getHeader("content-length") || 0);
  bucket.requests++; bucket.total_ms += durationMs;
  if (res.statusCode >= 400) { state.errors++; bucket.errors++; }
  if (res.statusCode === 408 || res.statusCode === 504) state.timeouts++;
  if (res.writableEnded !== true) state.aborted++;
}
function middleware(req, res, next) {
  state.active++; const started = process.hrtime.bigint();
  res.once("finish", () => observe(req, res, Number(process.hrtime.bigint() - started) / 1e6));
  res.once("close", () => { if (!res.writableFinished) state.aborted++; });
  next();
}
function snapshot() { return JSON.parse(JSON.stringify({ ...state, by_route: state.by_route })); }
module.exports = { middleware, observe, snapshot, routeGroup };
