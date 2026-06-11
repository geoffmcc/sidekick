# sidekick_context - Persistent Intelligent Context Management

## The Problem
Every time you start a new session, sidekick (and you) start from scratch. The KV store holds data, but not *understanding*. There's no continuity of thought, no memory of decisions, no awareness of what you're working on across sessions.

## The Solution
A tool that builds and maintains a rich, semantic context model of your work - not just storing data, but *understanding* it.

## What It Does

### 1. Automatic Context Tracking
- Tracks what projects you're working on
- Records decisions made and why
- Logs problems encountered and solutions found
- Captures your preferences and patterns

### 2. Intelligent Recall
- "What was I working on last week?"
- "Why did we choose this approach?"
- "What problems have we solved before?"
- Semantic search across all past context

### 3. Proactive Suggestions
- "You're starting project X - last time you encountered issue Y"
- "Based on your patterns, you might want to..."
- "This decision is similar to one you made 3 months ago"

### 4. Context Summarization
- Auto-generates project summaries
- Creates decision logs
- Builds knowledge graphs of relationships

## Implementation Approach

### Context Structure
```json
{
  "projects": {
    "sidekick": {
      "active": true,
      "lastWorked": "2026-06-11",
      "decisions": [...],
      "problems": [...],
      "patterns": [...]
    }
  },
  "decisions": [
    {
      "id": "dec_123",
      "date": "2026-06-10",
      "context": "Choosing deployment strategy",
      "decision": "Use SSH key auth instead of password",
      "reasoning": "More secure, no password management",
      "outcome": "success"
    }
  ],
  "embeddings": {
    // Vector embeddings for semantic search
  }
}
```

### Key Features
- Uses embeddings for semantic similarity search
- LLM summarizes and organizes context
- Tracks relationships between decisions, problems, solutions
- Builds a "knowledge graph" of your work

## Example Workflows

### Session 1:
```
User: "I'm setting up SSH authentication for sidekick"
sidekick_context: (records: project=sidekick, task=ssh_setup, decision=use_ed25519)
```

### Session 2 (weeks later):
```
User: "I need to set up SSH for another service"
sidekick_context: "Last time you set up SSH (2026-06-10), you chose ED25519 keys because they're more secure. You encountered an issue with key permissions and fixed it with chmod 600. Want me to apply the same approach?"
```

## Why This Is Gamechanging

1. **True Continuity** - Sidekick becomes a persistent collaborator, not just a tool server
2. **Compound Value** - Gets more useful the longer you use it
3. **Eliminates Repetition** - No more re-explaining context every session
4. **Institutional Memory** - Captures tribal knowledge that would otherwise be lost
5. **Pattern Recognition** - Identifies your workflows and suggests optimizations

## Technical Approach

1. **Context Capture** - Hook into tool calls to automatically extract context
2. **Embedding Generation** - Use LLM to create semantic embeddings
3. **Vector Storage** - Store embeddings for similarity search
4. **Context Retrieval** - Semantic search + LLM reasoning
5. **Proactive Suggestions** - Pattern matching on current work vs. past context

## Transformation
This transforms sidekick from "a tool that waits for commands" into "a collaborator that understands your work and helps you build on it."
