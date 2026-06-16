# Service Management

Sidekick uses systemd on the remote server.

## Restart Sidekick

```bash
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

## Check Status

```bash
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
```

## Follow Logs

```bash
sudo journalctl -u sidekick-mcp -f
```

## Recent Logs

```bash
sudo journalctl -u sidekick-mcp -n 100 --no-pager
sudo journalctl -u sidekick-dashboard -n 100 --no-pager
sudo journalctl -u sidekick-agent -n 100 --no-pager
```

## Enable at Boot

```bash
sudo systemctl enable sidekick-mcp sidekick-dashboard sidekick-agent
```

## Start / Stop

```bash
sudo systemctl start sidekick-mcp sidekick-dashboard sidekick-agent
sudo systemctl stop sidekick-mcp sidekick-dashboard sidekick-agent
```

## Install Path

The expected service working directory is:

```bash
/home/sidekick/sidekick
```

If service startup fails, check:

```bash
cd /home/sidekick/sidekick
ls -la
cat .env
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
sudo journalctl -u sidekick-mcp -n 100 --no-pager
```
