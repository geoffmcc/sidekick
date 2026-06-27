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
const INFLUX_TOKEN = process.env.SIDEKICK_INFLUX_TOKEN || '';
const INFLUX_ORG = process.env.SIDEKICK_INFLUX_ORG || 'sidekick';
const INFLUX_BUCKET = process.env.SIDEKICK_INFLUX_BUCKET || 'sidekick';
const DB_PATH = process.env.SIDEKICK_DB_FILE || path.join(__dirname, '..', 'data', 'sidekick.db');

if (!INFLUX_TOKEN || INFLUX_TOKEN === 'sidekick-influx-token') {
  console.error('SIDEKICK_INFLUX_TOKEN must be set to a non-placeholder value before collecting metrics.');
  process.exit(1);
}

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
        COUNT(*) as count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
        AVG(duration_ms) as duration_ms
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

// Collect database performance metrics
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
      WHERE tool_name LIKE 'sidekick_db_%' AND timestamp >= ?
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
    const containers = execSync('docker ps --format "{{.Names}}"').toString().trim().split('\n').filter(Boolean);
    const metrics = [];
    
    for (const container of containers) {
      try {
        // Get container stats
        const stats = execSync(`docker stats ${container} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}"`).toString().trim();
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
    const running = execSync('curl -s http://localhost:11434/api/ps').toString();
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
    await writeMetrics('tool_calls', { tool_name: tool.tool_name }, {
      count: tool.count,
      success_rate: tool.success_rate,
      error_count: tool.error_count,
      duration_ms: tool.duration_ms
    }, timestamp);
  }
  
  // Service status
  const serviceMetrics = collectServiceMetrics();
  if (Object.keys(serviceMetrics).length > 0) {
    await writeMetrics('service_status', {}, serviceMetrics, timestamp);
  }
  
  // Database performance metrics
  const dbMetrics = collectDatabaseMetrics();
  if (dbMetrics) {
    const { database, ...fields } = dbMetrics;
    await writeMetrics('database_performance', { database }, fields, timestamp);
  }
  
  // Docker container metrics
  const dockerMetrics = collectDockerMetrics();
  for (const container of dockerMetrics) {
    const { container_name, ...fields } = container;
    await writeMetrics('docker_containers', { container_name }, fields, timestamp);
  }
  
  // Ollama metrics
  const ollamaMetrics = collectOllamaMetrics();
  for (const ollama of ollamaMetrics) {
    const { model, ...fields } = ollama;
    await writeMetrics('ollama', { model }, fields, timestamp);
  }
  
  console.log(`[${new Date().toISOString()}] Metrics collected: system=${systemMetrics ? 'ok' : 'fail'}, tools=${toolMetrics.length}, db=${dbMetrics ? 'ok' : 'skip'}, docker=${dockerMetrics.length}, ollama=${ollamaMetrics.length}, services=${Object.keys(serviceMetrics).length}`);
}

// Run collection
collectAll().catch(error => {
  console.error(`Metrics collection failed: ${error.message}`);
  process.exit(1);
});
