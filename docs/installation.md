# Installation and Deployment

## Requirements

Sidekick is a Node.js project. The codebase expects:

- Node.js 18 or newer.
- npm for dependency installation.
- A Linux remote host for the intended deployment model.
- Git for deployment and repository management.
- systemd if using the service management model shown by the project.
- Optional: Ollama on `127.0.0.1:11434` for local LLM fallback.
- Optional: a Groq API key for faster cloud LLM calls.

## Quick Deploy (Recommended)

The deploy scripts handle everything automatically:

```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP"

# Linux/macOS
./deploy.sh YOUR_REMOTE_IP
```

### What the Deploy Script Does

**First deploy:**
1. Generates SSH key at `~/.ssh/sidekick` if it doesn't exist
2. Installs the SSH key on the remote (prompts for password)
3. Configures sudoers for passwordless service management (prompts for password)
4. Creates remote directories (`/home/sidekick/sidekick/src`, `/home/sidekick/sidekick/data`)
5. Installs systemd service files from `systemd/` directory
6. Enables all services (sidekick-mcp, sidekick-dashboard, sidekick-agent)
7. Opens firewall ports 4097, 4098, 4099 (if UFW is active)
8. Syncs source files, package.json, and .env
9. Runs `npm install --production` on remote
10. Starts all services

**Subsequent deploys:**
- Fully automated (no password prompts)
- Syncs changed files
- Restarts services

### Deploy Script Options

**Windows (PowerShell):**
```powershell
.\deploy.ps1 -IP "192.168.1.10"              # Deploy to specific IP
.\deploy.ps1 -IP "192.168.1.10" -Password "sidekick"  # For automation/CI
```

**Linux/macOS (Bash):**
```bash
./deploy.sh 192.168.1.10                     # Deploy to specific IP
./deploy.sh 192.168.1.10 sidekick            # For automation/CI
```

| Parameter | Description |
|-----------|-------------|
| `-IP` / `$1` | Remote machine IP address (default: `192.168.1.10`) |
| `-Password` / `$2` | Sidekick user password (optional, for automation) |

### First Deploy Experience

When you run the deploy script for the first time:

1. **SSH key generation** (automatic if missing)
2. **Password prompt #1:** "Enter sidekick password when prompted to install SSH key"
   - This installs your public key to `~/.ssh/authorized_keys` on the remote
3. **Password prompt #2:** "Enter sidekick password when prompted to install sudoers"
   - This configures passwordless sudo for service management commands
4. **Automated setup:** Services installed, enabled, and started

After the first deploy, you never need to enter the password again.

### For Automation/CI

Pass the password as a parameter to skip interactive prompts:

```powershell
# Windows
.\deploy.ps1 -IP "192.168.1.10" -Password "sidekick"

# Linux/macOS
./deploy.sh 192.168.1.10 sidekick
```

**Security note:** The password is used only during the initial setup and is cleared from memory immediately after use. For security, prefer interactive prompts when possible.

### Security Model

The deploy script follows a two-phase security approach based on the principle of least privilege:

**Phase 1: First Deploy (Password Required)**

During the initial deployment, the script performs privileged operations that require the sidekick user password:
- Install SSH public key to `~/.ssh/authorized_keys`
- Copy sudoers file to `/etc/sudoers.d/sidekick`
- Copy systemd service files to `/etc/systemd/system/`
- Run `systemctl daemon-reload`
- Run `systemctl enable` for all services
- Run `ufw allow` for firewall ports

All these operations are performed once during first-time setup. The script detects if services are already installed and skips this phase entirely on subsequent deploys.

**Phase 2: Subsequent Deploys (No Password)**

After the initial setup, the deploy script only uses commands that are explicitly allowed in the sudoers file without a password:
- `systemctl start/stop/restart/status sidekick-*`
- `journalctl -u sidekick-*`
- `ufw allow 4097/4098/4099` (already configured, idempotent)

The sidekick user **cannot** perform these privileged operations after initial setup:
- Cannot run `systemctl daemon-reload`
- Cannot run `systemctl enable/disable`
- Cannot copy files to `/etc/systemd/system/`
- Cannot modify `/etc/sudoers.d/`
- Cannot perform arbitrary sudo operations

This ensures that even if the SSH key is compromised, the attacker cannot reload systemd configuration, enable/disable services, or modify the system beyond managing the Sidekick services.

## Manual Setup (Advanced)

If you need to customize the deployment or the automated script doesn't work for your environment:

### 1. Prepare Remote Machine

Create the sidekick user and directories:

```bash
# On remote machine
sudo useradd -m -s /bin/bash sidekick
sudo mkdir -p /home/sidekick/sidekick/src /home/sidekick/sidekick/data
sudo chown -R sidekick:sidekick /home/sidekick/sidekick
```

### 2. Install SSH Key

Copy your public key to the remote:

```bash
# From local machine
ssh-copy-id -i ~/.ssh/sidekick.pub sidekick@YOUR_REMOTE_IP
```

Or manually:

```bash
# On remote machine
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "YOUR_PUBLIC_KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 3. Configure Sudoers

Install the sudoers file for passwordless service management:

```bash
# On remote machine
sudo cp /path/to/systemd/sidekick-sudoers /etc/sudoers.d/sidekick
sudo chmod 440 /etc/sudoers.d/sidekick
```

### 4. Install Service Files

Copy and enable the systemd services:

```bash
# On remote machine
sudo cp systemd/sidekick-mcp.service /etc/systemd/system/
sudo cp systemd/sidekick-dashboard.service /etc/systemd/system/
sudo cp systemd/sidekick-agent.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable sidekick-mcp sidekick-dashboard sidekick-agent
```

### 5. Deploy Files

Sync source files and install dependencies:

```bash
# From local machine
scp -r src/* sidekick@YOUR_REMOTE_IP:/home/sidekick/sidekick/src/
scp package.json sidekick@YOUR_REMOTE_IP:/home/sidekick/sidekick/
scp .env sidekick@YOUR_REMOTE_IP:/home/sidekick/sidekick/

# On remote machine
cd /home/sidekick/sidekick
npm install --production
```

### 6. Start Services

```bash
sudo systemctl start sidekick-mcp sidekick-dashboard sidekick-agent
```

### 7. Configure Firewall (Optional)

If using UFW:

```bash
sudo ufw allow 4097/tcp comment 'Sidekick MCP'
sudo ufw allow 4098/tcp comment 'Sidekick Dashboard'
sudo ufw allow 4099/tcp comment 'Sidekick Agent'
```

## Local Development Setup

For local development or testing:

```bash
git clone <repository-url> sidekick
cd sidekick
npm install
cp .env.example .env
# Edit .env with your settings

# Start services manually
npm run start      # MCP server on port 4097
npm run dashboard  # Dashboard on port 4098
npm run agent      # Agent bridge on port 4099
```

## opencode Integration

The repository contains `.opencode/agents/sidekick.md`, which defines a Sidekick subagent for opencode. The project README also describes using `AGENTS.md` to teach opencode about Sidekick.

A typical integration needs:

1. Sidekick services running on the remote host.
2. The MCP endpoint configured in the opencode environment.
3. The same API key configured in Sidekick and the client.
4. Agent instructions that tell opencode when to delegate work to Sidekick.

The MCP endpoint is:

```text
http://<host>:4097/mcp
```

The legacy SSE endpoint is:

```text
http://<host>:4097/sse
```

## Verification

After deployment, verify services are running:

```bash
# Check service status
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent

# Check health endpoints
curl http://YOUR_REMOTE_IP:4097/health
curl http://YOUR_REMOTE_IP:4098/api/system
curl http://YOUR_REMOTE_IP:4099/api/health

# Open dashboard in browser
# http://YOUR_REMOTE_IP:4098/
```

When dashboard authentication is configured, browser/API access requires HTTP Basic authentication except for the agent event-stream path.

## Troubleshooting

### SSH Key Issues

**Problem:** "Permission denied (publickey)"
**Solution:** Ensure your SSH key is installed on the remote:
```bash
ssh-copy-id -i ~/.ssh/sidekick.pub sidekick@YOUR_REMOTE_IP
```

### Sudo Permission Issues

**Problem:** "sudo: a terminal is required to read the password"
**Solution:** Install the sudoers file:
```bash
sudo cp systemd/sidekick-sudoers /etc/sudoers.d/sidekick
sudo chmod 440 /etc/sudoers.d/sidekick
```

### Services Not Starting

**Problem:** Services fail to start
**Solution:** Check logs:
```bash
sudo journalctl -u sidekick-mcp -n 50
sudo journalctl -u sidekick-dashboard -n 50
sudo journalctl -u sidekick-agent -n 50
```

### Firewall Blocking Ports

**Problem:** Can't connect to services
**Solution:** Check if UFW is active and open ports:
```bash
sudo ufw status
sudo ufw allow 4097/tcp
sudo ufw allow 4098/tcp
sudo ufw allow 4099/tcp
```
