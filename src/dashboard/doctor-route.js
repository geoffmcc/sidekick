"use strict";

function registerDoctorRoute({ app, requireIdentityPermission, runDoctor, formatDoctorText, createSupportBundle, errorResponse }) {
  app.get("/api/doctor", (req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    const format = String(req.query.format || "json").toLowerCase();
    if (!new Set(["json", "text"]).has(format)) {
      return res.status(400).json({ ok: false, error: "format must be json or text", code: "invalid_format" });
    }
    try {
      const report = runDoctor();
      res.set("Cache-Control", "no-store");
      if (format === "text") return res.type("text/plain").send(formatDoctorText(report));
      return res.json(createSupportBundle({ report }));
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "internal_error", component: "doctor", publicMessage: "Doctor diagnostics unavailable" });
    }
  });
}

module.exports = { registerDoctorRoute };
