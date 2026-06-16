# Ollama Setup

Sidekick can use Ollama as a local LLM provider/fallback.

## Recommended Default Model

```env
OLLAMA_MODEL=qwen2.5-coder:7b
```

This is the default in `.env.example` and is a good code-oriented local model. If your server is CPU-only or memory constrained, choose a smaller model. If it has more RAM or GPU acceleration, choose a larger model.

## Install the Model

```bash
ollama pull qwen2.5-coder:7b
```

## Confirm Installed Models

```bash
ollama list
```

## Show Running Models

```bash
ollama ps
```

`ollama ps` shows models currently loaded/running. It does not necessarily show what an application is configured to use when idle.

## Test the Model

```bash
ollama run qwen2.5-coder:7b
```

## Inspect the Model

```bash
ollama show qwen2.5-coder:7b
```

## Configure Sidekick

Edit `.env`:

```bash
cd /home/sidekick/sidekick
nano .env
```

Set:

```env
OLLAMA_MODEL=qwen2.5-coder:7b
```

Restart Sidekick:

```bash
sudo systemctl restart sidekick-agent sidekick-mcp
```
