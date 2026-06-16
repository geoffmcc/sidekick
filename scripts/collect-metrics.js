#!/usr/bin/env node

/**
 * Sidekick Metrics Collector
 * Collects system and tool usage metrics and writes to InfluxDB
 * Run via cron every minute: * * * * * /usr/bin/node /home/sidekick/sidekick/scripts/collect-metrics.js
 */

const { execSync } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');

const INFLUX_URL = process.env.SIDEKICK_INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.SIDEKICK_INFLUX_TOKEN || 'sidekick-influx-token';
const INFLUX_ORG = process.env.SIDEKICK_INFLUX_ORG || 'sidekick';
const INFLUX_BUCKET = process.env.SIDEKICK_INFLUX_BUCKET || 'sidekick';
const DB_PATH = process.env.SIDEKICK_DB_FILE || path.join(__dirname, '..', 'data', 'sidekick.db');

// Write metrics to InfluxDB using line protocol
async function writeMetrics(measurement, tags, fields, timestamp) {
  const ts = timestamp || Date.now() * 1000000; // nanoseconds
  
  // Build line protocol
  let line = measurement;
  
  // Add tags (sorted for consistency)
  const tagKeys = Object.keys(tags).sort();
  if (tagKeys.length > 0) {
    const tagPairs = tagKeys.map(k => `${k}=${tags[k]}`);
    line += ',' + tagPairs.join(',');
  }
  
  // Add fields
  const fieldPairs = Object.entries(fields).map(([k, v]) => {
    if (typeof v === 'number') {
      return `${k}=${v}`;
    } else if (typeof v === 'boolean') {
      return `${k}=${v}`;
    } else {
      return `${k}="${String(v).replace(/"/g, '\\"')}"`;
    }
  });
  line += ' ' + fieldPairs.join(',');
  line += ' ' + ts;
  
  try {
    const response = await fetch(`${INFLUX_URL}/api/v2/write?org=${INFLUX_ORG}&bucket=${INFLUX_BUCKET}&precision=ns`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: line
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`InfluxDB write failed: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error(`InfluxDB write error: ${error.message}`);
  }
}

// Collect system metrics
function collectSystemMetrics() {
  try {
    // CPU usage (1 minute average)
    const cpuLine = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'").toString().trim();
    const cpuPercent = parseFloat(cpuLine) || 0;
    
    // Memory usage
    const memInfo = execSync("free -b | grep Mem").toString().trim().split(/\s+/);
    const memTotal = parseInt(memInfo[1]) || 0;
    const memUsed = parseInt(memInfo[2]) || 0;
    const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    
    // Disk usage
    const diskInfo = execSync("df -B1 / | tail -1").toString().trim().split(/\s+/);
    const diskTotal = parseInt(diskInfo[1]) || 0;
    const diskUsed = parseInt(diskInfo[2]) || 0;
    const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
    
    // Load average
    const loadAvg = execSync("cat /proc/loadavg").toString().trim().split(/\s+/);
    const load1m = parseFloat(loadAvg[0]) || 0;
    const load5m = parseFloat(loadAvg[1]) || 0;
    const load15m = parseFloat(loadAvg[2]) || 0;
    
    return {
      cpu_percent: cpuPercent,
      memory_total: memTotal,
      memory_used: memUsed,
      memory_percent: memPercent,
      disk_total: diskTotal,
      disk_used: diskUsed,
      disk_percent: diskPercent,
      load_1m: load1m,
      load_5m: load5m,
      load_15m: load15m
    };
  } catch (error) {
    console.error(`System metrics collection error: ${error.message}`);
    return null;
  }
}

// Collect tool usage metrics from SQLite
function collectToolMetrics() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    
    // Get tool usage stats for the last hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    
    const stats = db.prepare(`
      SELECT 
        tool_name,
        COUNT(*) as call_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        MIN(duration_ms) as min_duration_ms
      FROM tool_logs
      WHERE timestamp >= ?
      GROUP BY tool_name
    `).all(oneHourAgo);
    
    db.close();
    return stats;
  } catch (error) {
    console.error(`Tool metrics collection error: ${error.message}`);
    return [];
  }
}

// Collect service status
function collectServiceMetrics() {
  try {
    const services = ['sidekick-mcp', 'sidekick-dashboard', 'sidekick-agent'];
    const metrics = {};
    
    for (const service of services) {
      const status = execSync(`systemctl is-active ${service} 2>/dev/null || echo "inactive"`).toString().trim();
      metrics[service.replace(/-/g, '_')] = status === 'active' ? 1 : 0;
    }
    
    return metrics;
  } catch (error) {
    console.error(`Service metrics collection error: ${error.message}`);
    return {};
  }
}

// Main collection function
async function collectAll() {
  const timestamp = Date.now() * 1000000;
  
  // System metrics
  const systemMetrics = collectSystemMetrics();
  if (systemMetrics) {
    await writeMetrics('system_health', {}, systemMetrics, timestamp);
  }
  
  // Tool usage metrics
  const toolMetrics = collectToolMetrics();
  for (const tool of toolMetrics) {
    await writeMetrics('tool_usage', { tool_name: tool.tool_name }, {
      call_count: tool.call_count,
      success_count: tool.success_count,
      error_count: tool.error_count,
      avg_duration_ms: tool.avg_duration_ms,
      max_duration_ms: tool.max_duration_ms,
      min_duration_ms: tool.min_duration_ms
    }, timestamp);
  }
  
  // Service status
  const serviceMetrics = collectServiceMetrics();
  if (Object.keys(serviceMetrics).length > 0) {
    await writeMetrics('service_status', {}, serviceMetrics, timestamp);
  }
  
  console.log(`[${new Date().toISOString()}] Metrics collected: system=${systemMetrics ? 'ok' : 'fail'}, tools=${toolMetrics.length}, services=${Object.keys(serviceMetrics).length}`);
}

// Run collection
collectAll().catch(error => {
  console.error(`Metrics collection failed: ${error.message}`);
  process.exit(1);
});
