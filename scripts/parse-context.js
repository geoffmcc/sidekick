#!/usr/bin/env node
/**
 * Parse CONTEXT.md and insert structured knowledge entries into the database
 * This script extracts key information and categorizes it for the knowledge base
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const CONTEXT_FILE = path.join(__dirname, '..', 'CONTEXT.md');

function parseContext() {
  const content = fs.readFileSync(CONTEXT_FILE, 'utf-8');
  const entries = [];

  // Extract architecture section
  const archMatch = content.match(/## Architecture Notes\n\n([\s\S]*?)(?=\n## |\n---|\n$)/);
  if (archMatch) {
    entries.push({
      category: 'architecture',
      title: 'Service Architecture',
      content: archMatch[1].trim(),
      tags: 'architecture,services,deployment'
    });
  }

  // Extract security layers
  const securityMatch = content.match(/### Security Layers\n\| Layer \| Measure \|\n\|-------\|---------\|\n([\s\S]*?)(?=\n\n|\n## )/);
  if (securityMatch) {
    const tableContent = securityMatch[1].trim();
    entries.push({
      category: 'security',
      title: 'Security Layers and Measures',
      content: `| Layer | Measure |\n|-------|---------|\n${tableContent}`,
      tags: 'security,authentication,authorization'
    });
  }

  // Extract key files
  const filesMatch = content.match(/### Key Files\n([\s\S]*?)(?=\n### |\n## )/);
  if (filesMatch) {
    entries.push({
      category: 'architecture',
      title: 'Key Source Files',
      content: filesMatch[1].trim(),
      tags: 'architecture,files,source'
    });
  }

  // Extract lessons learned
  const lessonsMatch = content.match(/## Lessons Learned\n\n([\s\S]*?)(?=\n## |\n---|\n$)/);
  if (lessonsMatch) {
    const lessons = lessonsMatch[1].trim().split(/\n\d+\.\s+/).filter(l => l.trim());
    lessons.forEach((lesson, idx) => {
      if (lesson.trim()) {
        entries.push({
          category: 'lessons',
          title: `Lesson ${idx + 1}`,
          content: lesson.trim(),
          tags: 'lessons,best-practices'
        });
      }
    });
  }

  // Extract testing strategy summary
  const testingMatch = content.match(/## Testing Strategy\n\n([\s\S]*?)(?=\n## |\n---|\n$)/);
  if (testingMatch) {
    entries.push({
      category: 'testing',
      title: 'Testing Strategy Overview',
      content: testingMatch[1].trim(),
      tags: 'testing,strategy,priorities'
    });
  }

  // Extract current status
  const statusMatch = content.match(/## Current Status \(([\d-]+)\)([\s\S]*?)(?=\n## |\n---)/);
  if (statusMatch) {
    entries.push({
      category: 'status',
      title: `Current Status (${statusMatch[1]})`,
      content: statusMatch[2].trim(),
      tags: 'status,services,deployment'
    });
  }

  // Extract migration info
  const migrationMatch = content.match(/## Migration: VPS → Proxmox VM([\s\S]*?)(?=\n## |\n---)/);
  if (migrationMatch) {
    entries.push({
      category: 'deployment',
      title: 'Migration: VPS to Proxmox VM',
      content: migrationMatch[1].trim(),
      tags: 'migration,deployment,infrastructure'
    });
  }

  // Extract MCP connection issues resolution
  const mcpMatch = content.match(/## MCP Connection Issues — Resolved([\s\S]*?)(?=\n## |\n---)/);
  if (mcpMatch) {
    entries.push({
      category: 'troubleshooting',
      title: 'MCP Connection Issues - Resolution',
      content: mcpMatch[1].trim(),
      tags: 'mcp,troubleshooting,connection,sessions'
    });
  }

  return entries;
}

function insertKnowledge(entries) {
  const now = new Date().toISOString();
  
  for (const entry of entries) {
    try {
      db.prepare(`
        INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        entry.category,
        entry.title,
        entry.content,
        entry.tags,
        now,
        now
      );
      console.log(`✓ Inserted: ${entry.category} - ${entry.title}`);
    } catch (error) {
      console.error(`✗ Failed to insert ${entry.title}:`, error.message);
    }
  }
}

function main() {
  console.log('Parsing CONTEXT.md...');
  const entries = parseContext();
  console.log(`Found ${entries.length} knowledge entries\n`);

  console.log('Inserting into database...');
  insertKnowledge(entries);

  console.log('\nDone! Knowledge base populated.');
}

main();
