# Sidekick Migration Plan: VPS → Proxmox

## Overview

Migrate Sidekick from current VPS (149.28.229.13) to Proxmox VM on local NucBox M7 Ultra (AMD Ryzen 7 PRO 6850U, Radeon 680M GPU).

**Benefits:**
- 8 cores / 16 threads vs 2-4 cores on VPS
- Up to 64GB RAM vs limited VPS RAM
- Radeon 680M GPU for local LLM acceleration (ROCm)
- No ongoing VPS fees
- Full control with Proxmox flexibility

## Architecture

```
Proxmox VM (Ubuntu 24.04, 16GB RAM, 8 cores)
├── WireGuard client (10.0.0.10)
├── Caddy reverse proxy (10.0.0.10:443)
│   ├── mcp.home.digitaltrainwreck.com → localhost:4097
│   ├── dashboard.home.digitaltrainwreck.com → localhost:4098
│   └── agent.home.digitaltrainwreck.com → localhost:4099
├── MCP Server (127.0.0.1:4097) - Bearer token auth
├── Dashboard (127.0.0.1:4098) - HTTP Basic Auth
├── Agent Bridge (127.0.0.1:4099) - localhost only
└── Ollama (127.0.0.1:11434) - Radeon 680M GPU acceleration
```

**Security Model:**
- All services bind to 127.0.0.1 only (not exposed to WireGuard network)
- Caddy handles all external access via WireGuard interface
- Bearer token auth for MCP, HTTP Basic Auth for Dashboard, localhost-only for Agent

## Prerequisites (Resolve Before Execution)

1. **Cloudflare API token** - Token with DNS edit permissions for `digitaltrainwreck.com` (Zone → DNS → Edit, Zone → Zone → Read)
2. **Let's Encrypt email** - Email for Caddy's Let's Encrypt account
3. **WireGuard config** - Router's public key and endpoint IP
4. **Split DNS** - A records on local DNS server for subdomains

## Migration Phases

### Phase 1: Code Modifications (Local)

**Add BIND_ADDRESS support to all services:**

Modify `src/index.js`, `src/dashboard.js`, `src/agent.js`:
```javascript
const BIND_ADDRESS = process.env.BIND_ADDRESS || "0.0.0.0";
// Change: app.listen(PORT) → app.listen(PORT, BIND_ADDRESS)
```

### Phase 2: Proxmox VM Setup

**Create Ubuntu 24.04 VM:**
- 16GB RAM, 8 cores, 100GB storage
- Install Ubuntu Server 24.04
- Configure SSH key auth, disable password login
- Create `sidekick` user with restricted sudo

**Base packages:**
```bash
apt update && apt upgrade -y
apt install -y curl git build-essential qemu-guest-agent ufw wireguard
systemctl enable --now qemu-guest-agent
```

### Phase 3: WireGuard Client Setup

**Generate client keys:**
```bash
wg genkey | sudo tee /etc/wireguard/privatekey | sudo wg pubkey | sudo tee /etc/wireguard/publickey
```

**Create `/etc/wireguard/wg0.conf`:**
```ini
[Interface]
PrivateKey = <client-private-key>
Address = 10.0.0.10/24
DNS = 1.1.1.1

[Peer]
PublicKey = <router-public-key>
Endpoint = <router-public-ip>:51820
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
```

**Enable WireGuard:**
```bash
systemctl enable --now wg-quick@wg0
```

### Phase 4: Firewall Configuration

**UFW rules:**
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow in on wg0 to any port 443 proto tcp comment 'Caddy HTTPS'
ufw allow in on wg0 to any port 22 proto tcp comment 'SSH'
ufw enable
```

### Phase 5: Caddy Installation & Configuration

**Install Caddy with Cloudflare DNS plugin:**
```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy xcaddy
xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy
```

**Create `/etc/caddy/Caddyfile`:**
```caddyfile
{
  email your-email@example.com
}

mcp.home.digitaltrainwreck.com {
  reverse_proxy localhost:4097
}

dashboard.home.digitaltrainwreck.com {
  basicauth {
    geoffrey <bcrypt-hash>
  }
  reverse_proxy localhost:4098
}

agent.home.digitaltrainwreck.com {
  reverse_proxy localhost:4099
}
```

**Set Cloudflare API token:**
```bash
systemctl edit caddy
# Add:
# [Service]
# Environment="CLOUDFLARE_API_TOKEN=<your-token>"
```

### Phase 6: Split DNS Configuration

**On your DNS server (pfSense/UniFi/Pi-hole), add A records:**
- `mcp.home.digitaltrainwreck.com` → 10.0.0.10
- `dashboard.home.digitaltrainwreck.com` → 10.0.0.10
- `agent.home.digitaltrainwreck.com` → 10.0.0.10

### Phase 7: Application Setup

**Install Node.js 22.x:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

**Clone and setup:**
```bash
cd /home/sidekick
git clone <repo> mcp-sidekick
cd mcp-sidekick
npm install
```

**Create `.env`:**
```bash
SIDEKICK_API_KEY=<generate-new-key>
SIDEKICK_ALLOWED_IPS=
SIDEKICK_PORT=4097
SIDEKICK_DASHBOARD_PORT=4098
SIDEKICK_AGENT_PORT=4099
SIDEKICK_DASHBOARD_USER=geoffrey
SIDEKICK_DASHBOARD_PASS=<generate-strong-password>
SIDEKICK_DATA_DIR=/home/sidekick/mcp-sidekick/data
OLLAMA_URL=http://127.0.0.1:11434
GROQ_API_KEY=<your-groq-key>
GROQ_MODEL=llama-3.1-8b-instant
SIDEKICK_MAX_ITERATIONS=15
BIND_ADDRESS=127.0.0.1
```

### Phase 8: Ollama + GPU Setup

**Install Ollama:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Install ROCm for Radeon 680M:**
```bash
wget https://repo.radeon.com/rocm/rocm.gpg.key -O - | gpg --dearmor | tee /etc/apt/keyrings/rocm.gpg > /dev/null
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/6.1.2 jammy main" | tee /etc/apt/sources.list.d/rocm.list
apt update
apt install -y rocm
```

**Configure Ollama for GPU:**
```bash
systemctl edit ollama
# Add:
# [Service]
# Environment="HSA_OVERRIDE_GFX_VERSION=10.3.0"
# Environment="PATH=/opt/rocm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Environment="LD_LIBRARY_PATH=/opt/rocm/lib"
systemctl daemon-reload
systemctl restart ollama
```

**Pull models:**
```bash
ollama pull phi3:mini
```

### Phase 9: Systemd Services

**Create `/etc/systemd/system/sidekick-mcp.service`:**
```ini
[Unit]
Description=Sidekick MCP Server
After=network.target

[Service]
WorkingDirectory=/home/sidekick/mcp-sidekick
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
User=sidekick
Group=sidekick
EnvironmentFile=/home/sidekick/mcp-sidekick/.env

[Install]
WantedBy=multi-user.target
```

**Create `/etc/systemd/system/sidekick-dashboard.service`:**
```ini
[Unit]
Description=Sidekick Dashboard
After=network.target

[Service]
WorkingDirectory=/home/sidekick/mcp-sidekick
ExecStart=/usr/bin/node src/dashboard.js
Restart=always
RestartSec=5
User=sidekick
Group=sidekick
EnvironmentFile=/home/sidekick/mcp-sidekick/.env

[Install]
WantedBy=multi-user.target
```

**Create `/etc/systemd/system/sidekick-agent.service`:**
```ini
[Unit]
Description=Sidekick Agent Bridge
After=network.target

[Service]
WorkingDirectory=/home/sidekick/mcp-sidekick
ExecStart=/usr/bin/node src/agent.js
Restart=always
RestartSec=5
User=sidekick
Group=sidekick
EnvironmentFile=/home/sidekick/mcp-sidekick/.env

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
systemctl daemon-reload
systemctl enable --now sidekick-mcp sidekick-dashboard sidekick-agent
```

### Phase 10: Testing & Validation

**From WireGuard client:**
```bash
curl https://mcp.home.digitaltrainwreck.com/api/health
curl -u geoffrey:<pass> https://dashboard.home.digitaltrainwreck.com/api/services
curl https://agent.home.digitaltrainwreck.com/api/health
```

**Test KV store:**
```bash
# Use opencode or curl to test sidekick_sidekick_store and sidekick_sidekick_get
```

**Test GPU acceleration:**
```bash
rocm-smi  # Check GPU status
ollama run phi3:mini "hello"  # Check response time
```

### Phase 11: Update Local Config

**Update `opencode.json`:**
```json
{
  "mcp": {
    "sidekick": {
      "type": "remote",
      "url": "https://mcp.home.digitaltrainwreck.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <new-api-key>"
      }
    }
  }
}
```

**Update `CONTEXT.md` and `AGENTS.md`:**
- Document new IP, architecture, GPU setup
- Update deployment instructions

## Rollback Plan

- Keep VPS running for 1 week after migration
- If issues arise, revert `opencode.json` to VPS IP
- VPS serves as failover

## Estimated Time

30-45 minutes to execute once prerequisites are met.

## Security Decisions

- **Dashboard password**: Generate new 24+ char strong password
- **API key**: Generate new key (more secure than reusing)
- **Auth**: Bearer token (MCP), HTTP Basic Auth (Dashboard), localhost-only (Agent)
- **Network**: All services bind to 127.0.0.1, Caddy handles external access via WireGuard

## Troubleshooting

**GPU Issues:**
- Check `rocm-smi` for GPU status
- Verify `HSA_OVERRIDE_GFX_VERSION=10.3.0` is set
- Check Ollama logs: `journalctl -u ollama -f`
- Fallback to CPU if GPU doesn't work (still faster with 8 cores)

**Caddy Issues:**
- Check Caddy logs: `journalctl -u caddy -f`
- Verify Cloudflare API token has correct permissions
- Check DNS resolution: `nslookup mcp.home.digitaltrainwreck.com`

**WireGuard Issues:**
- Check connection: `wg show`
- Verify router's WireGuard config has client's public key
- Test connectivity: `ping 10.0.0.1` (router)

## Notes

- Current VPS: 149.28.229.13
- New VM IP: 10.0.0.10 (WireGuard)
- Domain: home.digitaltrainwreck.com (split DNS)
- GPU: AMD Radeon 680M (RDNA2, 12 cores)
- Node.js: 22.x (LTS)
- Ubuntu: 24.04 LTS
