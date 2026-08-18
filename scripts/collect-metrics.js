#!/usr/bin/env node

/**
 * Sidekick Metrics Collector
 * Collects system and tool usage metrics and writes to InfluxDB
 * Run via cron every minute: * * * * * /usr/bin/node /home/sidekick/sidekick/scripts/collect-metrics.js
 */

const os = require('os');
const { execFileSync } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');
const { validateInfluxUrl } = require('../src/influx-endpoint-policy');

const INFLUX_URL = process.env.SIDEKICK_INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.SIDEKICK_INFLUX_TOKEN || '';
const INFLUX_ORG = process.env.SIDEKICK_INFLUX_ORG || 'sidekick';
const INFLUX_BUCKET = process.env.SIDEKICK_INFLUX_BUCKET || 'sidekick';
const DB_PATH = process.env.SIDEKICK_DB_FILE || path.join(__dirname, '..', 'data', 'sidekick.db');

// Fail closed on a missing/placeholder token — but only when run directly, so
// requiring this module for tests does not terminate the test process.
if (require.main === module && (!INFLUX_TOKEN || INFLUX_TOKEN === 'sidekick-influx-token')) {
  console.error('SIDEKICK_INFLUX_TOKEN must be set to a non-placeholder value before collecting metrics.');
  process.exit(1);
}

// Write metrics to InfluxDB using line protocol
async function writeMetrics(measurement, tags, fields, timestamp) {
  validateInfluxUrl(INFLUX_URL);
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
    const cpuCount = Math.max(1, os.cpus().length);
    const loadAvg = os.loadavg();
    const load1m = Number(loadAvg[0]) || 0;
    const load5m = Number(loadAvg[1]) || 0;
    const load15m = Number(loadAvg[2]) || 0;
    const cpuPercent = Math.min(100, (load1m / cpuCount) * 100);
    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    const diskOutput = execFileSync('df', ['-B1', '/'], { encoding: 'utf8', timeout: 5000 });
    const diskInfo = diskOutput.trim().split(/\r?\n/).pop().trim().split(/\s+/);
    const diskTotal = parseInt(diskInfo[1], 10) || 0;
    const diskUsed = parseInt(diskInfo[2], 10) || 0;
    const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
    
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
        COUNT(*) as count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
        AVG(duration_ms) as duration_ms
      FROM tool_logs
      WHERE timestamp >= ?
      GROUP BY tool_name
    `).all(oneHourAgo);

    const durations = db.prepare(`
      SELECT tool_name, duration_ms
      FROM tool_logs
      WHERE timestamp >= ? AND duration_ms IS NOT NULL
      ORDER BY tool_name, duration_ms
    `).all(oneHourAgo);
    const byTool = new Map();
    for (const row of durations) {
      if (!byTool.has(row.tool_name)) byTool.set(row.tool_name, []);
      byTool.get(row.tool_name).push(Number(row.duration_ms));
    }
    for (const row of stats) {
      const values = byTool.get(row.tool_name) || [];
      row.p50_ms = percentile(values, 0.50);
      row.p95_ms = percentile(values, 0.95);
      row.p99_ms = percentile(values, 0.99);
      row.min_ms = values.length ? values[0] : 0;
      row.max_ms = values.length ? values[values.length - 1] : 0;
    }
    
    db.close();
    return stats;
  } catch (error) {
    console.error(`Tool metrics collection error: ${error.message}`);
    return [];
  }
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index];
}

// Collect database performance metrics
// Database query stats, derived from the db_* tools' entries in tool_logs.
//
// tool_logs stores CANONICAL (unprefixed) tool names — the dispatcher strips
// the `sidekick_` prefix before logging. This filter matched only the prefixed
// form, so it selected zero rows, returned null, and the database_performance
// measurement was never written: the Grafana dashboard sat empty with nothing
// reporting an error. Both shapes are matched so the metric survives whichever
// form a given deployment has logged historically.
function collectDatabaseMetrics() {
  try {
    const db = new Database(DB_PATH, { readonly: true });

    // Get query stats from tool_logs for db_query tool
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    
    const queryStats = db.prepare(`
      SELECT
        COUNT(*) as query_count,
        AVG(duration_ms) as query_time_ms,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as cache_hit_ratio
      FROM tool_logs
      WHERE (tool_name LIKE 'db_%' OR tool_name LIKE 'sidekick_db_%') AND timestamp >= ?
    `).get(oneHourAgo);
    
    db.close();
    
    if (queryStats && queryStats.query_count > 0) {
      return {
        database: 'sqlite',
        query_count: queryStats.query_count,
        query_time_ms: queryStats.query_time_ms || 0,
        cache_hit_ratio: queryStats.cache_hit_ratio || 0,
        active_connections: 1
      };
    }
    return null;
  } catch (error) {
    console.error(`Database metrics collection error: ${error.message}`);
    return null;
  }
}

// Collect Docker container metrics
function collectDockerMetrics() {
  try {
    const containers = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean);
    const metrics = [];
    
    for (const container of containers) {
      try {
        // Get container stats
        const stats = execFileSync('docker', ['stats', container, '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}'], { encoding: 'utf8', timeout: 10000 }).trim();
        const [cpuPerc, memUsage, netIO, blockIO] = stats.split('|');
        
        // Parse CPU percentage
        const cpuPercent = parseFloat(cpuPerc.replace('%', '')) || 0;
        
        // Parse memory usage (format: "100MiB / 1GiB")
        const memParts = memUsage.split('/');
        const memUsed = parseSize(memParts[0].trim());
        
        // Parse network I/O (format: "1.5kB / 2.3kB")
        const netParts = netIO.split('/');
        const networkRx = parseSize(netParts[0].trim());
        const networkTx = parseSize(netParts[1].trim());
        
        // Parse block I/O (format: "0B / 0B")
        const blockParts = blockIO.split('/');
        const diskRead = parseSize(blockParts[0].trim());
        const diskWrite = parseSize(blockParts[1].trim());
        
        metrics.push({
          container_name: container,
          running: 1,
          cpu_percent: cpuPercent,
          memory_usage: memUsed,
          network_rx: networkRx,
          network_tx: networkTx,
          disk_read: diskRead,
          disk_write: diskWrite
        });
      } catch (err) {
        console.error(`Error collecting stats for ${container}: ${err.message}`);
      }
    }
    
    return metrics;
  } catch (error) {
    console.error(`Docker metrics collection error: ${error.message}`);
    return [];
  }
}

// Parse size strings like "100MiB", "1.5GB", etc. to bytes
function parseSize(sizeStr) {
  const match = sizeStr.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!match) return 0;
  
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  
  const multipliers = {
    'B': 1,
    'KB': 1024,
    'KIB': 1024,
    'MB': 1024 * 1024,
    'MIB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'GIB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024,
    'TIB': 1024 * 1024 * 1024 * 1024
  };
  
  return value * (multipliers[unit] || 1);
}

// Collect Ollama metrics
function collectOllamaMetrics() {
  try {
    // Get list of running models
    const running = execFileSync('curl', ['--silent', '--show-error', '--max-time', '5', 'http://localhost:11434/api/ps'], { encoding: 'utf8', timeout: 10000 });
    const runningData = JSON.parse(running);
    const models = runningData.models || [];
    
    const metrics = [];
    
    for (const model of models) {
      // We don't have detailed per-request stats from Ollama API
      // So we'll just report that the model is loaded
      metrics.push({
        model: model.name,
        request_count: 0,
        avg_response_time_ms: 0,
        total_tokens: 0
      });
    }
    
    return metrics;
  } catch (error) {
    console.error(`Ollama metrics collection error: ${error.message}`);
    return [];
  }
}

// Collect service status
function collectServiceMetrics() {
  try {
    const services = ['sidekick-mcp', 'sidekick-dashboard', 'sidekick-agent'];
    const metrics = {};
    
    for (const service of services) {
      let status = 'inactive';
      try {
        status = execFileSync('systemctl', ['is-active', service], { encoding: 'utf8', timeout: 5000 }).trim();
      } catch {}
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
  const writes = [];
  
  // System metrics
  const systemMetrics = collectSystemMetrics();
  if (systemMetrics) {
    writes.push(writeMetrics('system_health', {}, systemMetrics, timestamp));
  }
  
  // Tool usage metrics
  const toolMetrics = collectToolMetrics();
  for (const tool of toolMetrics) {
    writes.push(writeMetrics('tool_calls', { tool_name: tool.tool_name }, {
      count: tool.count,
      success_rate: tool.success_rate,
      error_count: tool.error_count,
      duration_ms: tool.duration_ms,
      p50_ms: tool.p50_ms,
      p95_ms: tool.p95_ms,
      p99_ms: tool.p99_ms,
      min_ms: tool.min_ms,
      max_ms: tool.max_ms
    }, timestamp));
  }
  
  // Service status
  const serviceMetrics = collectServiceMetrics();
  if (Object.keys(serviceMetrics).length > 0) {
    writes.push(writeMetrics('service_status', {}, serviceMetrics, timestamp));
  }
  
  // Database performance metrics
  const dbMetrics = collectDatabaseMetrics();
  if (dbMetrics) {
    const { database, ...fields } = dbMetrics;
    writes.push(writeMetrics('database_performance', { database }, fields, timestamp));
  }
  
  // Docker container metrics
  const dockerMetrics = collectDockerMetrics();
  for (const container of dockerMetrics) {
    const { container_name, ...fields } = container;
    writes.push(writeMetrics('docker_containers', { container_name }, fields, timestamp));
  }
  
  // Ollama metrics
  const ollamaMetrics = collectOllamaMetrics();
  for (const ollama of ollamaMetrics) {
    const { model, ...fields } = ollama;
    writes.push(writeMetrics('ollama', { model }, fields, timestamp));
  }

  await Promise.all(writes);
  
  console.log(`[${new Date().toISOString()}] Metrics collected: system=${systemMetrics ? 'ok' : 'fail'}, tools=${toolMetrics.length}, db=${dbMetrics ? 'ok' : 'skip'}, docker=${dockerMetrics.length}, ollama=${ollamaMetrics.length}, services=${Object.keys(serviceMetrics).length}`);
}

// Run collection only when invoked directly, so the collector functions can be
// exercised by tests without performing a real collection or writing to InfluxDB.
if (require.main === module) {
  collectAll().catch(error => {
    console.error(`Metrics collection failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { collectToolMetrics, collectDatabaseMetrics, collectSystemMetrics, writeMetrics };
