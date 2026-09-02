"use strict";

(function bindActivityControls() {
  const invoke = (name, ...args) => typeof window[name] === "function" && window[name](...args);
  document.querySelectorAll("[data-activity-filter]").forEach(control => {
    control.addEventListener("input", () => invoke("filterLogs"));
    control.addEventListener("change", () => invoke("filterLogs"));
  });
  document.querySelectorAll("[data-activity-view]").forEach(control => control.addEventListener("click", () => invoke("setActivityView", control.dataset.activityView)));
  document.querySelectorAll("[data-activity-action]").forEach(control => control.addEventListener("click", () => invoke("clearData", control.dataset.activityAction === "clear-all" ? "all" : "logs")));
})();
