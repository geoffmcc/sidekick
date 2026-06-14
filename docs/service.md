# Service Management

Sidekick uses systemd on the remote server.

## Restart Sidekick

```bash
sudo systemctl restart sidekick
```

## Check Status

```bash
sudo systemctl status sidekick
```

## Follow Logs

```bash
sudo journalctl -u sidekick -f
```

## Recent Logs

```bash
sudo journalctl -u sidekick -n 100 --no-pager
```

## Enable at Boot

```bash
sudo systemctl enable sidekick
```

## Start / Stop

```bash
sudo systemctl start sidekick
sudo systemctl stop sidekick
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
sudo systemctl status sidekick
sudo journalctl -u sidekick -n 100 --no-pager
```
