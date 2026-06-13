# Tool Creation Guide

## Quick Reference

**Files to edit (in order):**
1. `src/tools.js` - implementation + TOOLS export + TOOL_DEFS entry
2. `src/index.js` - TOOL_SCHEMAS Zod schema
3. `src/dashboard.js` - TOOL_CATEGORIES addition

## Registration Pattern

### 1. Add function to `src/tools.js`

```javascript
async function sidekick_<name>({ action, param1, param2 }) {
  // Return success:
  return { content: [{ type: "text", text: "result message" }] };
  
  // Return error:
  return { content: [{ type: "text", text: "error message" }], isError: true };
}
```

### 2. Add to TOOLS export (bottom of `src/tools.js`)

```javascript
const TOOLS = {
  // ... existing tools ...
  sidekick_<name>,
};
```

### 3. Add to TOOL_DEFS array (bottom of `src/tools.js`)

```javascript
const TOOL_DEFS = [
  // ... existing defs ...
  { 
    name: "sidekick_<name>", 
    description: "Description of what this tool does", 
    args: { 
      action: "string (list|create|update|delete)", 
      param1: "string",
      param2: "number (optional)"
    } 
  },
];
```

### 4. Add Zod schema to `src/index.js`

```javascript
const TOOL_SCHEMAS = {
  // ... existing schemas ...
  sidekick_<name>: z.object({
    action: z.enum(["list", "create", "update", "delete"]).describe("Tool action"),
    param1: z.string().describe("Parameter description"),
    param2: z.number().optional().describe("Optional parameter")
  }),
};
```

### 5. Add to TOOL_CATEGORIES in `src/dashboard.js`

```javascript
const TOOL_CATEGORIES = {
  // ... existing categories ...
  'CategoryName': { 
    icon: 'fa-icon-name', 
    tools: ['sidekick_<name>'] 
  },
};
```

**Available categories:**
Core, Storage, Git & GitHub, Services, Scheduling, Communication, Context & Learning, Data Pipeline, Monitoring, Workflow, Meta, Efficiency, Security, Development, Reliability, Archive

## Data Persistence Pattern

For tools that need to store state:

```javascript
const MYDATA_FILE = path.join(DATA_DIR, "mydata.json");

function loadMydata() {
  try {
    if (fs.existsSync(MYDATA_FILE)) {
      return JSON.parse(fs.readFileSync(MYDATA_FILE, "utf8"));
    }
  } catch {}
  return { items: {} };
}

function saveMydata(data) {
  fs.writeFileSync(MYDATA_FILE, JSON.stringify(data, null, 2));
}
```

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Function name | `sidekick_<name>` | `sidekick_circuit` |
| Constants | `MAX_<NAME>_<THING>`, `<NAME>_FILE`, `<NAME>_DIR` | `MAX_CIRCUIT_TARGETS`, `CIRCUITS_FILE` |
| Load/save helpers | `load<Name>()`, `save<Name>(data)` | `loadCircuits()`, `saveCircuits(data)` |
| Actions | Enum of verbs | `["list", "create", "update", "delete"]` |

## Security Considerations

### Output Redaction
Call `redactSensitive()` on outputs that may contain:
- Command output
- HTTP responses
- File content
- Logs
- User-provided text

```javascript
const output = await someOperation();
return { content: [{ type: "text", text: redactSensitive(output) }] };
```

### Confirmation Gates
For destructive actions, require explicit confirmation:

```javascript
if (action === "delete" && !confirm) {
  return { 
    content: [{ type: "text", text: "Destructive action requires confirm: true" }], 
    isError: true 
  };
}
```

### Rate Limiting
For sensitive operations, implement rate limiting:

```javascript
const MAX_OPERATIONS_PER_HOUR = 10;

function checkRateLimit(data, operation) {
  const now = Date.now();
  const recentOps = data.operations.filter(op => 
    op.type === operation && (now - op.timestamp) < 3600000
  );
  return recentOps.length < MAX_OPERATIONS_PER_HOUR;
}
```

### Logging
All tool calls are automatically logged via `logToolCall()` in the MCP server.

## Complete Example

```javascript
// In src/tools.js

const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const MAX_ALERTS = 100;

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    }
  } catch {}
  return { alerts: [], last_updated: null };
}

function saveAlerts(data) {
  data.last_updated = new Date().toISOString();
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
}

async function sidekick_alert({ action, name, severity, message, confirm }) {
  const data = loadAlerts();

  if (action === "list") {
    const summary = data.alerts.map(a => `${a.name}: ${a.severity}`).join("\n");
    return { content: [{ type: "text", text: summary || "No alerts" }] };
  }

  if (action === "create") {
    if (!name || !severity || !message) {
      return { content: [{ type: "text", text: "name, severity, and message required" }], isError: true };
    }
    if (data.alerts.length >= MAX_ALERTS) {
      return { content: [{ type: "text", text: `Max ${MAX_ALERTS} alerts reached` }], isError: true };
    }
    data.alerts.push({ name, severity, message, created: new Date().toISOString() });
    saveAlerts(data);
    return { content: [{ type: "text", text: `Alert '${name}' created` }] };
  }

  if (action === "delete") {
    if (!confirm) {
      return { content: [{ type: "text", text: "Destructive action requires confirm: true" }], isError: true };
    }
    data.alerts = data.alerts.filter(a => a.name !== name);
    saveAlerts(data);
    return { content: [{ type: "text", text: `Alert '${name}' deleted` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: list, create, delete" }], isError: true };
}

// Add to TOOLS export
const TOOLS = {
  // ... existing tools ...
  sidekick_alert,
};

// Add to TOOL_DEFS
const TOOL_DEFS = [
  // ... existing defs ...
  { 
    name: "sidekick_alert", 
    description: "Manage system alerts and notifications", 
    args: { 
      action: "string (list|create|delete)", 
      name: "string (alert name)",
      severity: "string (low|medium|high|critical)",
      message: "string (alert message)",
      confirm: "boolean (required for delete)"
    } 
  },
];
```

```javascript
// In src/index.js

const TOOL_SCHEMAS = {
  // ... existing schemas ...
  sidekick_alert: z.object({
    action: z.enum(["list", "create", "delete"]).describe("Alert action"),
    name: z.string().optional().describe("Alert name"),
    severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Alert severity"),
    message: z.string().optional().describe("Alert message"),
    confirm: z.boolean().optional().describe("Required for destructive actions")
  }),
};
```

```javascript
// In src/dashboard.js

const TOOL_CATEGORIES = {
  // ... existing categories ...
  'Monitoring': { 
    icon: 'fa-heartbeat', 
    tools: ['sidekick_alert', /* ... other monitoring tools */] 
  },
};
```

## Testing

After implementing your tool:

1. Restart the MCP server: `sudo systemctl restart sidekick-mcp`
2. Test via MCP client or dashboard
3. Check logs: `sudo journalctl -u sidekick-mcp -f`
4. Run existing tests: `node test/run-all.js`

## Resources

- This guide is also stored in KV store for fast retrieval: `sidekick_get key="tool_making_guide" project="sidekick"`
- See `docs/development.md` for project structure and architecture overview
- See `docs/tools-reference.md` for documentation on existing tools
