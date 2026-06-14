# Configuration

Sidekick uses a `.env` file for runtime configuration.

Start from the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before deploying.

## Server Path

Use this path for server-side examples:

```bash
/home/sidekick/sidekick
```

Example:

```bash
cd /home/sidekick/sidekick
nano .env
```

## Remote IP Placeholder

Use this placeholder consistently:

```text
YOUR_REMOTE_IP
```

## Ollama Model

Recommended default:

```env
OLLAMA_MODEL=phi3:3.8b
```

This model was chosen because the reference server does not have GPU access, so it needs a small model that can run reasonably on CPU-only hardware.

Users with a stronger CPU, more RAM, or GPU acceleration may want to use a larger or more capable Ollama model instead.

## Groq vs Ollama

If `GROQ_API_KEY` is configured, Sidekick can use Groq for faster cloud LLM responses.

If Groq is not configured, Sidekick can use local Ollama as a fallback.

## Useful Checks

Check the configured Ollama model:

```bash
grep "^OLLAMA_MODEL=" .env
```

Check installed Ollama models:

```bash
ollama list
```

Check currently loaded/running Ollama models:

```bash
ollama ps
```

Inspect a model:

```bash
ollama show phi3:3.8b
```
