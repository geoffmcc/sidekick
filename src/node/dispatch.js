"use strict";

const crypto = require("crypto");
const manager = require("./manager");
const { selectNode } = require("./placement");

const POLL_MS = 100;
const MAX_WAIT_MS = 30 * 60 * 1000;

function requestId(context = {}) { return context.requestId || `node_req_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function workspaceIdFromArgs(args = {}) { return args.workspace_id || args.workspaceId || null; }
function repositoryIdFromArgs(args = {}) { return args.repository_id || args.repositoryId || null; }
function isNodeDispatchEnabled(context = {}) { return context.executionLocation !== "server" && context.allowNodeExecution !== false; }

async function maybeExecute(descriptor, args, context = {}) {
  if (!isNodeDispatchEnabled(context) || !descriptor?.placement?.nodeSafe) return null;
  manager.ensureSchema();
  const nodes = manager.list().filter(node => node.worker && node.worker.connectionState === "online");
  const placement = selectNode(nodes.map(node => ({ nodeId: node.nodeId, capabilities: {
    ...node.capabilities,
    nodeId: node.nodeId,
    protocolVersion: node.protocolVersion,
    descriptorSetHash: node.descriptorSetHash,
    workspaces: node.authorizedWorkspaces,
    networkScopes: node.authorizedNetworkScopes,
    healthy: node.capabilityState === "healthy",
    authorized: node.worker.adminState === "enabled" && node.worker.credentialState === "active",
  }, node })), descriptor, { descriptorSetHash: context.descriptorSetHash, protocolVersion: "1" });
  if (!placement.selected) return null;
  const selected = placement.selected.candidate.node;
  const job = manager.enqueue({
    workerId: selected.workerId,
    requestId: requestId(context),
    taskId: context.taskId,
    toolName: descriptor.name,
    descriptor,
    args,
    context: {
      actor: context.actor,
      source: context.source,
      project: context.project,
      taskId: context.taskId,
      requestId: requestId(context),
      executionId: context.executionId,
      operationId: context.operationId,
      approvalId: context.approvalId,
      idempotencyKey: context.idempotencyKey,
    },
    workspaceId: workspaceIdFromArgs(args),
    repositoryId: repositoryIdFromArgs(args),
    idempotencyKey: context.idempotencyKey || null,
  });
  const started = Date.now();
  while (Date.now() - started < Math.min(MAX_WAIT_MS, Number(context.timeoutMs) || MAX_WAIT_MS)) {
    const current = manager.getJob(job.jobId);
    if (current?.state === "completed") return {
      ...current.result,
      nodeExecution: {
        location: "node",
        nodeId: selected.nodeId,
        workerId: selected.workerId,
        jobId: current.jobId,
        receipt: current.receipt,
        placement: { reasons: placement.selected.reasons, descriptorIdentity: placement.selected.descriptorIdentity },
      },
    };
    if (current?.state === "failed") return { content: [{ type: "text", text: `Node execution failed: ${current.errorMessage || current.errorCode}` }], isError: true, code: current.errorCode || "node_execution_failed", nodeExecution: { location: "node", jobId: current.jobId, nodeId: selected.nodeId } };
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return { content: [{ type: "text", text: "Node execution timed out; the operation was not automatically repeated" }], isError: true, code: "node_execution_timeout", operationMayContinue: true, nodeExecution: { location: "node", jobId: job.jobId, nodeId: selected.nodeId } };
}

module.exports = { maybeExecute };
