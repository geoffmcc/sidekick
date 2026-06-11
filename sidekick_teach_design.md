# sidekick_teach - Meta-Learning and Self-Extension Tool

## Overview
A revolutionary tool that enables sidekick to learn new procedures and generate new tools dynamically, transforming it from a fixed tool server into a self-extending platform.

## Core Insight
Every tool built so far is fixed. If you want sidekick to do something new, you have to write code, deploy, restart. `sidekick_teach` breaks this limitation by allowing sidekick to learn new capabilities on the fly.

## What It Does

### 1. Teach Procedures
Store multi-step workflows as reusable procedures:
```javascript
sidekick_teach({
  action: "teach_procedure",
  name: "deploy_app",
  description: "Deploy the application with safety checks",
  steps: [
    {tool: "sidekick_git", args: {action: "status"}},
    {tool: "sidekick_bash", args: {command: "npm test"}},
    {tool: "sidekick_git", args: {action: "push"}},
    {tool: "sidekick_service", args: {action: "restart", service: "app"}},
    {tool: "sidekick_notify", args: {message: "Deployed!"}}
  ]
})
```

### 2. Generate Tools from Descriptions
Use the LLM to generate procedure definitions from natural language:
```javascript
sidekick_teach({
  action: "generate_tool",
  name: "sidekick_backup",
  description: "Backup data directory with rotation",
  implementation: "..." // AI generates the steps
})
```

### 3. Learn from Examples
Store trigger phrases mapped to procedures:
```javascript
sidekick_teach({
  action: "learn_from_example",
  example: "When I say 'deploy', I mean: check tests, push, restart, notify",
  trigger_phrases: ["deploy", "ship it", "push to prod"]
})
```

### 4. Execute Procedures
Run taught procedures by name:
```javascript
sidekick_teach({
  action: "execute",
  name: "deploy_app"
})
```

### 5. List Learned Capabilities
Show all taught procedures and generated tools:
```javascript
sidekick_teach({
  action: "list"
})
```

### 6. Remove Procedures
Delete taught procedures:
```javascript
sidekick_teach({
  action: "remove",
  name: "deploy_app"
})
```

## Data Structure

```json
{
  "procedures": {
    "deploy_app": {
      "name": "deploy_app",
      "description": "Deploy the application with safety checks",
      "steps": [
        {"tool": "sidekick_git", "args": {"action": "status"}},
        {"tool": "sidekick_bash", "args": {"command": "npm test"}},
        {"tool": "sidekick_git", "args": {"action": "push"}},
        {"tool": "sidekick_service", "args": {"action": "restart", "service": "app"}},
        {"tool": "sidekick_notify", "args": {"message": "Deployed!"}}
      ],
      "triggerPhrases": ["deploy", "ship it"],
      "createdAt": "2026-06-11T...",
      "lastUsed": "2026-06-11T...",
      "useCount": 5
    }
  }
}
```

## Implementation Approach

### Storage
- `data/procedures.json` - All taught procedures
- Procedures are stored as JSON (not code) for safety and portability

### Execution
The `execute` action:
1. Looks up the procedure by name
2. For each step, calls `callTool(tool, args)`
3. Collects results from each step
4. Returns a summary of all results

### Tool Generation
The `generate_tool` action:
1. Uses `sidekick_llm` to convert natural language description into procedure steps
2. Stores the generated procedure
3. Makes it immediately available for execution

### Pattern Matching
The `learn_from_example` action:
1. Parses the example to extract steps
2. Maps trigger phrases to the procedure
3. Stores the mapping for future recognition

## Why This Is Gamechanging

1. **Self-Extending System** - Sidekick grows more capable over time without code changes
2. **Compound Learning** - Each teaching session makes future sessions more efficient
3. **Natural Interface** - Teach in natural language, not code
4. **Reusable Workflows** - Complex procedures become one-call actions
5. **Adaptive** - Sidekick learns your preferences and patterns

## Example Workflows

### Session 1: Teaching a Procedure
```
User: "Teach me to backup the database"
sidekick_teach: (learns: dump database, compress, upload to S3, verify, notify)
```

### Session 2: Executing Learned Procedure
```
User: "Backup the database"
sidekick_teach: (executes learned procedure - one call instead of 5)
```

### Session 3: Generating a New Tool
```
User: "Generate a tool that monitors disk usage and alerts when >80%"
sidekick_teach: (generates new tool code, deploys it, makes it available)
```

## Technical Details

### Parameters
```typescript
{
  action: "teach_procedure" | "generate_tool" | "learn_from_example" | "execute" | "list" | "remove",
  name?: string,
  description?: string,
  steps?: Array<{tool: string, args: object}>,
  example?: string,
  trigger_phrases?: string[],
  implementation?: string
}
```

### Safety Features
- Procedures are validated before storage
- Execution has timeout protection
- Failed steps are logged but don't crash the procedure
- Procedures can be removed if they cause issues

## Transformation
This transforms sidekick from "a tool server with 20 tools" into "a learning system that can acquire unlimited capabilities."

## Future Enhancements
- Procedure versioning and rollback
- Procedure sharing between sidekick instances
- Automatic procedure optimization based on usage patterns
- Integration with sidekick_context for smarter procedure selection
