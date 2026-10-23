"use strict";

function abortUpstreamOnDisconnect(response, upstreamRequest) {
  const onClose = () => {
    if (response.writableEnded) return;
    try { upstreamRequest.destroy(); } catch { /* request already ended */ }
  };
  response.on("close", onClose);
  return () => response.removeListener("close", onClose);
}

module.exports = { abortUpstreamOnDisconnect };
