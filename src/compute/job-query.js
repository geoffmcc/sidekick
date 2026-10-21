function createJobQuery({ ensureSchema, db, rowToJob, rowToAttempt }) {
  function getJob(jobId) { ensureSchema(); return rowToJob(db().prepare("SELECT * FROM compute_jobs WHERE job_id = ?").get(jobId)); }
  function listJobs({ status, jobType, project, providerId, workerId, capability, limit = 50 } = {}) { ensureSchema(); let sql = "SELECT * FROM compute_jobs WHERE 1=1"; const params = []; if (status) { sql += " AND status = ?"; params.push(status); } if (jobType) { sql += " AND job_type = ?"; params.push(jobType); } if (project) { sql += " AND project = ?"; params.push(project); } if (providerId) { sql += " AND selected_provider_id = ?"; params.push(providerId); } if (workerId) { sql += " AND selected_worker_id = ?"; params.push(workerId); } if (capability) { sql += " AND capability = ?"; params.push(capability); } sql += " ORDER BY created_at DESC LIMIT ?"; params.push(Math.max(1, Math.min(Number(limit) || 50, 1000))); return db().prepare(sql).all(...params).map(rowToJob); }
  function listAttempts(jobId) { ensureSchema(); return db().prepare("SELECT * FROM compute_job_attempts WHERE job_id = ? ORDER BY attempt_number, created_at").all(jobId).map(rowToAttempt); }
  function getJobStats({ project } = {}) {
    ensureSchema();
    const database = db();
    const scoped = project ? " WHERE project = ?" : "";
    const scopedJobJoin = project ? " JOIN compute_jobs j ON j.job_id = child.job_id WHERE j.project = ?" : "";
    const param = project ? [project] : [];
    const stats = database.prepare(`SELECT status, COUNT(*) as count FROM compute_jobs${scoped} GROUP BY status`).all(...param);
    const byType = database.prepare(`SELECT job_type, COUNT(*) as count FROM compute_jobs${scoped} GROUP BY job_type`).all(...param);
    const total = database.prepare(`SELECT COUNT(*) as count FROM compute_jobs${scoped}`).get(...param);
    const activeLeases = database.prepare(`SELECT COUNT(*) as count FROM compute_jobs${scoped}${project ? " AND" : " WHERE"} lease_id IS NOT NULL AND status IN ('leased','starting','running','cancelling')`).get(...param);
    const attempts = database.prepare(`SELECT COUNT(*) as count FROM compute_job_attempts child${scopedJobJoin}`).get(...param);
    const artifacts = database.prepare(`SELECT state, COUNT(*) as count FROM compute_artifacts child${scopedJobJoin} GROUP BY state`).all(...param);
    return { total: total?.count || 0, activeLeases: activeLeases?.count || 0, attempts: attempts?.count || 0, artifacts: Object.fromEntries(artifacts.map(a => [a.state || "unknown", a.count])), byStatus: Object.fromEntries(stats.map(s => [s.status, s.count])), byType: Object.fromEntries(byType.map(t => [t.job_type, t.count])) };
  }
  return { getJob, listJobs, listAttempts, getJobStats };
}
module.exports = { createJobQuery };
