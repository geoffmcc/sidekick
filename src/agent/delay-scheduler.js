function createDelayScheduler({ loadDelays, executeDelay }) {
  const delayTimers = {};

  function clearDelayTimer(id) {
    if (delayTimers[id]) {
      clearTimeout(delayTimers[id]);
      delete delayTimers[id];
    }
  }

  function scheduleDelay(delay) {
    const executeAt = new Date(delay.when).getTime();
    const msUntil = executeAt - Date.now();
    clearDelayTimer(delay.id);
    const run = () => {
      delete delayTimers[delay.id];
      return executeDelay(delay).catch(e => console.error(`Delay ${delay.id} dispatch failed: ${e.message}`));
    };

    if (msUntil <= 0) {
      run();
      return;
    }

    delayTimers[delay.id] = setTimeout(run, msUntil);
    console.log(`Scheduled delay ${delay.id} for ${delay.when} (${Math.round(msUntil / 60000)} minutes)`);
  }

  function loadAndScheduleDelays() {
    for (const id of Object.keys(delayTimers)) clearDelayTimer(id);
    const pending = loadDelays().filter(d => d.status === "pending");
    for (const delay of pending) scheduleDelay(delay);
    console.log(`Loaded ${pending.length} pending delays`);
  }

  return { delayTimers, scheduleDelay, loadAndScheduleDelays };
}

module.exports = { createDelayScheduler };
