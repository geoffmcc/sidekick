const assert = require("assert");
const metrics = require("../src/dashboard/request-metrics");

assert.strictEqual(metrics.routeGroup({ route: { path: "/api/tasks/:taskId" }, path: "/api/tasks/secret-task-id" }), "/api/tasks/:taskId");
assert.strictEqual(metrics.routeGroup({ path: "/api/tasks/12345678901234567890" }), "/api/tasks/:param");
const res = { statusCode: 200, writableEnded: true, getHeader: () => 12 };
metrics.observe({ path: "/api/test" }, res, 4);
const snapshot = metrics.snapshot();
assert.ok(snapshot.requests >= 1);
assert.ok(snapshot.by_route["/api/test"]);
assert.strictEqual(JSON.stringify(snapshot).includes("secret-task-id"), false);
console.log("Dashboard performance metrics checks passed");
