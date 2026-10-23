"use strict";

const http = require("http");

const MAX_LOCAL_SERVICE_RESPONSE_BYTES = 256 * 1024;

function getJsonFromLocalService(port, pathName, headers = {}, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET",
      headers,
      timeout,
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_LOCAL_SERVICE_RESPONSE_BYTES) {
          const error = new Error("local service response exceeds the size bound");
          finish(reject, error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(reject, new Error("HTTP " + res.statusCode));
          return;
        }
        try {
          const body = Buffer.concat(chunks, bytes).toString("utf8");
          finish(resolve, JSON.parse(body || "{}"));
        } catch (error) {
          finish(reject, error);
        }
      });
      res.on("aborted", () => finish(reject, new Error("local service response interrupted")));
      res.on("error", error => finish(reject, error));
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", error => finish(reject, error));
    req.end();
  });
}

module.exports = { getJsonFromLocalService, MAX_LOCAL_SERVICE_RESPONSE_BYTES };
