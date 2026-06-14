# Ollama Setup

Sidekick can use Ollama as a local LLM provider/fallback.

## Recommended Default Model

```env
OLLAMA_MODEL=phi3:3.8b
```

This model was chosen because the reference server does not have GPU access. A small model is more practical for CPU-only hardware.

If your server has a stronger CPU, more RAM, or GPU acceleration, you may want to choose a larger or more capable model.

## Install the Model

```bash
ollama pull phi3:3.8b
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
ollama run phi3:3.8b
```

## Inspect the Model

```bash
ollama show phi3:3.8b
```

## Configure Sidekick

Edit `.env`:

```bash
cd /home/sidekick/sidekick
nano .env
```

Set:

```env
OLLAMA_MODEL=phi3:3.8b
```

Restart Sidekick:

```bash
sudo systemctl restart sidekick
```
