"use strict";

// System-only interaction wiring stays outside the legacy page controller.
(function bindSystemControls() {
  const selector = document.getElementById("toolStatsWindow");
  if (!selector || typeof window.setToolStatsWindow !== "function") return;
  selector.addEventListener("change", event => window.setToolStatsWindow(event.target.value));
})();
