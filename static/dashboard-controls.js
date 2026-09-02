"use strict";

// Domain controls are delegated here so server-rendered markup stays inert and
// dynamically rendered records use the same action contract as static controls.
(function bindDashboardControls() {
  const invoke = (name, ...args) => {
    if (typeof window[name] === "function") return window[name](...args);
    return undefined;
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
    if (action === "agent") return invoke(control.dataset.handler, id, actionValue, control.dataset.index);
    if (action === "predict") return invoke(control.dataset.handler, id, actionValue);
    if (action === "compute-worker") return invoke("computeWorkerAction", id, actionValue);
    if (action === "compute-job") return invoke("computeJobAction", id, actionValue);
    if (action === "compute-detail") return invoke("showComputeJob", id);
    if (action === "copy-block") return invoke("copyBlockText", control);
    if (action === "copy-modal") return invoke("copyModalValue", control);
    if (action === "copy-element") return invoke("copyElementText", id, control);
    if (action === "expandable") return invoke("toggleExpandable", id, control);
    if (action === "evolve") return invoke(control.dataset.handler, id, actionValue === "true" ? true : actionValue === "false" ? false : actionValue, control.dataset.index);
    if (action === "identity") return invoke(control.dataset.handler, id, actionValue);
    if (action === "database") return invoke(control.dataset.handler);
    if (action === "callback") return invoke(control.dataset.handler, id, actionValue, control.dataset.index, control);
    if (action === "close-overlay") {
      const overlay = control.closest(".tool-detail-overlay");
      if (overlay) overlay.remove();
      return;
    }
    if (action === "research-more") return invoke("loadRepositoryResearch", true);
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
