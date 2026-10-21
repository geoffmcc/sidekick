"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const manager = require("./manager");
const { selectNode, pathWithinRoot } = require("./placement");
const { stableId } = require("./workspace");

const POLL_MS = 100;
const MAX_WAIT_MS = 30 * 60 * 1000;

function requestId(context = {}) { return context.requestId || `node_req_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function workspaceIdFromArgs(args = {}) { return args.workspace_id || args.workspaceId || null; }
function repositoryIdFromArgs(args = {}) { return args.repository_id || args.repositoryId || null; }
function isNodeDispatchEnabled(context = {}) { return context.executionLocation !== "server" && context.allowNodeExecution !== false; }
function pathArguments(args = {}) {
  return Object.entries(args).filter(([key, value]) => typeof value === "string" && /(?:^path$|_path$|^path_[ab]$|^destination$|^output$|^cwd$)/i.test(key)).map(([, value]) => value);
}
function visibleOnServer(target) {
  const candidate = path.resolve(String(target));
  // File-backed tools can create or diagnose one missing leaf under an
  // existing parent. Do not send those to a remote node just because the leaf
  // is absent; a path whose parent is also absent remains unproven locally.
  return fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate));
}
function authorizedWorkspaceCapabilities(node) {
  const authorized = new Map(manager.listWorkspaces(node.workerId).map(item => [item.name, item]));
  const advertised = Array.isArray(node.capabilities.workspaces) ? node.capabilities.workspaces : [];
  const roots = advertised.filter(item => item && typeof item === "object" && item.root).filter(item => {
    const workspace = authorized.get(String(item.name || ""));
    return workspace && workspace.rootIdentity === stableId("root", item.root);
  });
  return roots.map(item => ({ ...authorized.get(String(item.name || "")), root: item.root }));
}

async function maybeExecute(descriptor, args, context = {}, nodeAuthorization = null) {
  if (!isNodeDispatchEnabled(context) || !descriptor?.placement?.nodeSafe) return null;
  manager.ensureSchema();
  const requestedPaths = pathArguments(args);
  const requiredWorkspacePermission = manager.workspacePermissionForTool(descriptor.name, args);
  const nodes = manager.list().filter(node => node.worker && node.worker.connectionState === "online");
  const placement = selectNode(nodes.map(node => ({ nodeId: node.nodeId, capabilities: {
    ...node.capabilities,
    nodeId: node.nodeId,
    protocolVersion: node.protocolVersion,
    descriptorSetHash: node.descriptorSetHash,
    workspaces: authorizedWorkspaceCapabilities(node),
    networkScopes: node.authorizedNetworkScopes,
    healthy: node.capabilityState === "healthy",
    authorized: node.worker.adminState === "enabled" && node.worker.credentialState === "active",
  }, node })), descriptor, { descriptorSetHash: context.descriptorSetHash, protocolVersion: "1", requestedPaths, requiredWorkspacePermission });
  if (!placement.selected) {
    const pathIsRemoteOnly = requestedPaths.length > 0 && requestedPaths.some(target => !visibleOnServer(target));
    if (pathIsRemoteOnly) return {
      content: [{ type: "text", text: "Repository path is not visible on the server and no authorized execution node proved that it can access the requested path; execution was not queued" }],
      isError: true,
      code: "node_path_visibility_unverified",
      nodeExecution: { location: "node", requestedPaths, candidates: placement.candidates.map(item => ({ nodeId: item.nodeId, reasons: item.reasons })) },
    };
    return null;
  }
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
      authIdentity: context.authIdentity ? {
        principal_id: context.authIdentity.principal_id || null,
        principal_type: context.authIdentity.principal_type || null,
        credential_id: context.authIdentity.credential_id || null,
        authentication_method: context.authIdentity.authentication_method || null,
        scopes: Array.isArray(context.authIdentity.scopes) ? context.authIdentity.scopes.slice(0, 128) : null,
        delegation_id: context.authIdentity.delegation_id || context.authIdentity.delegationId || null,
        acting_for_principal_id: context.authIdentity.acting_for_principal_id || null,
      } : null,
      nodeAuthorization: nodeAuthorization ? {
        principalId: nodeAuthorization.principalId || null,
        permission: nodeAuthorization.permission || null,
        credentialScopes: Array.isArray(nodeAuthorization.credentialScopes) ? nodeAuthorization.credentialScopes.slice(0, 128) : null,
        delegationId: nodeAuthorization.delegationId || null,
        resource: nodeAuthorization.resource && typeof nodeAuthorization.resource === "object" ? {
          tool: nodeAuthorization.resource.tool || descriptor.name,
          source: nodeAuthorization.resource.source || context.source || null,
        } : { tool: descriptor.name, source: context.source || null },
      } : null,
      project: context.project,
      taskId: context.taskId,
      requestId: requestId(context),
      executionId: context.executionId,
      operationId: context.operationId,
      approvalId: context.approvalId,
      idempotencyKey: context.idempotencyKey,
      approvedExecution: context.approvedExecution === true,
      timeoutMs: Number(context.timeoutMs) > 0 ? Number(context.timeoutMs) : null,
      deadlineAt: Number(context.timeoutMs) > 0 ? new Date(Date.now() + Number(context.timeoutMs)).toISOString() : null,
    },
    workspaceId: (() => {
      const authorizedWorkspaces = placement.selected.candidate.capabilities.workspaces || [];
      const explicitlyRequested = workspaceIdFromArgs(args);
      const workspace = authorizedWorkspaces.find(item => item && item.workspaceId === explicitlyRequested && (!requiredWorkspacePermission || item.permissions?.[requiredWorkspacePermission] === true) && (!requestedPaths.length || item.root && requestedPaths.every(target => pathWithinRoot(item.root, target))))
        || (!explicitlyRequested && authorizedWorkspaces.find(item => item && item.workspaceId && (!requiredWorkspacePermission || item.permissions?.[requiredWorkspacePermission] === true) && (!requestedPaths.length || item.root && requestedPaths.every(target => pathWithinRoot(item.root, target)))));
      return workspace?.workspaceId || null;
    })(),
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
  const cancellation = manager.requestCancel(job.jobId);
  return { content: [{ type: "text", text: "Node execution timed out; cancellation was requested and the operation will not be automatically repeated" }], isError: true, code: "node_execution_timeout", operationMayContinue: cancellation?.state === "leased", nodeExecution: { location: "node", jobId: job.jobId, nodeId: selected.nodeId, timeoutMs: Number(context.timeoutMs) || null, timedOutAt: new Date().toISOString(), cancellation_requested: Boolean(cancellation) } };
}

module.exports = { maybeExecute };
