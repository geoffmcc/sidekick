"use strict";

// Domain controls are delegated here so server-rendered markup stays inert and
// dynamically rendered records use the same action contract as static controls.
(function bindDashboardControls() {
  // Markup is data, not permission to call an arbitrary window property.
  const DASHBOARD_HANDLER_REGISTRY = Object.freeze({
    loadMissionControl, runQuickAction, routeToPage, clearData, setMemoryCategory,
    selectResearchRepository, showResearchSnapshot, researchSelect, researchVerify,
    researchIndex, researchArchive, researchRemove, loadMoreLogs, copyText,
    copySelectedKVValue, openEditModal, deleteKV, disableMemory, enableMemory,
    deleteMemory, startAgentContinuation, submitFollowup, reviewAgentLearningCandidate,
    pauseAgentTask,
    resumeAgentTask, stopAgent, newAgentTask, runAgent, clearAgent, sendAgentGuidance,
    toggleHistory, validateEvolve, approveEvolve, promoteEvolve, runEvolveTrial,
    watchEvolveExecution, rejectEvolve, deprecateEvolve, feedbackEvolve,
    openExecutionActivity, cancelEvolveExecution, clearComputeJobDetail,
    showComputeJob, copyBlockText, copyModalValue, copyElementText, toggleExpandable,
    showPredictDetail, predictFeedback, predictOutcome, predictDismiss, predictBack,
    approveRequest, rejectRequest, loadApprovalPreview, resolveReconciliation,
    showToolDetail, showProcedureDetail, showBlackboxIncident, analyzeBlackboxIncident,
    pinBlackboxIncident, exportBlackboxIncident, retryBlackboxCapture, openBlackboxSource,
    setNetworkScopeState, updateNetworkScope, capabilityDetail, capabilityHealth,
    capabilityMaturity, capabilityAction, capabilityUpgrade, capabilityUninstall,
    inspectBundledCapability, installBundledCapability,
    startBlackboxCapture, loadBlackbox, showNewEntryModal, exportKV, importKV,
    expireStaleMemories, exportMemories, importMemories, loadResearchSources,
    researchImport, researchRecover, loadRepositoryResearch, loadHandoffs,
    loadApprovals, loadReconciliations, loadDbStats, createBackup, runQuery,
    runDbSearch, runEvolveAnalyze, loadCapabilities, inspectLocalCapability,
    installLocalCapability, loadNetworkScopes, createNetworkScope, loadIdentityAdmin,
    createIdentityUser, createComputeEnrollment, loadCompute, recoverComputeJobs,
    runPredictAnalyze, loadPredictStatus, runPredictPurgePreview, loadBrainControlRoom,
    closeEditModal, saveKVEdit, closeConfirmModal, executeConfirmAction,
    closeNewEntryModal, saveNewEntry, filterKV, filterMemories, filterTools,
    loadComputeJobs, loadPredict, loadGrafanaDashboard, checkConfirmInput,
    toggleIdentityPrincipal, assignIdentityRole, computeWorkerAction, computeJobAction
  });
  const reportFailure = (message, control) => {
    console.error(message, control);
    if (typeof showToast === "function") showToast(message, "error");
  };
  const invoke = (name, ...args) => {
    const handler = DASHBOARD_HANDLER_REGISTRY[name];
    if (typeof handler !== "function") {
      reportFailure("Dashboard handler is not allowlisted: " + String(name || "(missing)"));
      return undefined;
    }
    return handler(...args);
  };
  const invokeCompute = (kind, id, action, control) => {
    const allowed = kind === "worker" ? ["enable", "disable", "revoke"] : ["cancel", "retry"];
    if (!allowed.includes(action)) {
      reportFailure("Unsupported compute " + kind + " action: " + String(action || "(missing)"), control);
      return undefined;
    }
    return invoke(kind === "worker" ? "computeWorkerAction" : "computeJobAction", id, action);
  };
  const value = (control, name) => control.dataset[name] || control.value;

  document.addEventListener("click", event => {
    const overlay = event.target.closest(".tool-detail-overlay");
    if (overlay && event.target === overlay) {
      overlay.classList.remove("active");
      return;
    }
    const control = event.target.closest("[data-dashboard-action]");
    if (!control) return;
    const action = control.dataset.dashboardAction;
    const id = value(control, "id");
    const actionValue = value(control, "value");
    if (action === "refresh") return invoke(control.dataset.handler);
    if (action === "quick-action") return invoke("runQuickAction", control.dataset.action, control.dataset.service ? { service: control.dataset.service } : undefined);
    if (action === "page") return invoke("routeToPage", control.dataset.page);
    if (action === "clear-data") return invoke("clearData", control.dataset.type);
    if (action === "memory-category") return invoke("setMemoryCategory", actionValue);
    if (action === "research-select") return invoke("selectResearchRepository", id, control.dataset.campaign);
    if (action === "research-snapshot") return invoke("showResearchSnapshot", id);
    if (action === "research-action") return invoke(control.dataset.handler, id);
    if (action === "modal") return invoke(control.dataset.handler);
    if (action === "agent") {
      if (control.dataset.handler === "startAgentContinuation") return invoke("startAgentContinuation", actionValue);
      if (control.dataset.handler === "submitFollowup") return invoke("submitFollowup", id || undefined);
      return invoke(control.dataset.handler, id, actionValue, control.dataset.index);
    }
    if (action === "predict") return invoke(control.dataset.handler, id, actionValue);
    if (action === "compute-worker") return invokeCompute("worker", id, actionValue, control);
    if (action === "compute-job") return invokeCompute("job", id, actionValue, control);
    if (action === "compute-detail") return invoke("showComputeJob", id);
    if (action === "copy-block") return invoke("copyBlockText", control);
    if (action === "copy-modal") return invoke("copyModalValue", control);
    if (action === "copy-element") return invoke("copyElementText", id, control);
    if (action === "expandable") return invoke("toggleExpandable", id, control);
    if (action === "evolve") {
      if (control.dataset.handler === "runEvolveTrial") return invoke("runEvolveTrial", id, control.dataset.index);
      return invoke(control.dataset.handler, id, actionValue === "true" ? true : actionValue === "false" ? false : actionValue, control.dataset.index);
    }
    if (action === "identity") return invoke(control.dataset.handler, id, actionValue);
    if (action === "database") return invoke(control.dataset.handler);
    if (action === "callback") {
      if (control.dataset.handler === "reviewAgentLearningCandidate") return invoke("reviewAgentLearningCandidate", id, control.dataset.index, actionValue);
      if (control.dataset.handler === "retryBlackboxCapture") return invoke("retryBlackboxCapture", id, control.dataset.index);
      return invoke(control.dataset.handler, id, actionValue, control.dataset.index, control);
    }
    // dashboard-system.js is the single owner of this control.
    if (action === "tool-stats-window") return;
    if (action === "close-overlay") {
      const overlay = control.closest(".tool-detail-overlay");
      if (overlay) overlay.remove();
      return;
    }
    if (action === "research-more") return invoke("loadRepositoryResearch", true);
    reportFailure("Unsupported dashboard action: " + String(action || "(missing)"), control);
  });

  document.addEventListener("input", event => {
    const control = event.target.closest("[data-dashboard-input]");
    if (!control) return;
    invoke(control.dataset.dashboardInput);
  });

  document.addEventListener("change", event => {
    const control = event.target.closest("[data-dashboard-change]");
    if (!control) return;
    invoke(control.dataset.dashboardChange, control.value);
  });
})();
