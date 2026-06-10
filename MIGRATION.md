# Sidekick Migration Plan: VPS → Proxmox

## Overview

Migrate Sidekick from current VPS (149.28.229.13) to local Proxmox VM on NucBox M7 Ultra (AMD Ryzen 7 PRO 6850U, Radeon 680M GPU).

**Status:** Planned  
**Timeline:** After MCP connection issues are resolved (Week 4+)  
**Priority:** 🔴 HIGH - Must fix MCP issues first

## Architecture (Updated 2026-06-10)

### VM Specifications
- **RAM:** 12GB (conservative, leaves 10GB buffer for Proxmox + Jellyfin)
- **CPU:** 8 cores
- **Storage:** 100GB VM disk + 50-100GB separate for Ollama models
- **OS:** Ubuntu 24.04
- **Network:** Behind WireGuard (10.0.0.10)

### Service Architecture
```
Proxmox VM (Ubuntu 24.04, 12GB RAM)
├── Node.js services (systemd)
│   ├── MCP Server (:4097)
│   ├── Dashboard (:4098)
│   └── Agent Bridge (:4099)
├── Ollama (native, on-demand)
│   └── Models stored on separate volume
└── WireGuard client (10.0.0.10)
    └── Caddy reverse proxy (:443)
```

### Key Strategy: On-Demand Ollama
- **Idle state:** 2.5GB RAM (OS + Node.js services, Ollama stopped)
- **Active state:** 10.5GB RAM (with Ollama + 8B model)
- **Implementation:** `systemctl start ollama` when LLM needed, `systemctl stop ollama` when done
- **Benefit:** Saves 8GB RAM when just using MCP/Dashboard

### Resource Budget (12GB VM)
| Component | RAM Usage | Notes |
|-----------|-----------|-------|
| Ubuntu OS overhead | ~2GB | OS, systemd, qemu-guest-agent |
| Node.js services (3) | ~0.5GB | MCP + Dashboard + Agent |
| Ollama + 8B model (when active) | ~8GB | Phi-3-mini or Llama 3.1 8B |
| Safety margin | ~1.5GB | For spikes and overhead |
| **Total (active)** | **~10.5GB** | Comfortable within 12GB |

### Model Constraints
- **Phi-3-mini (3.8B):** ~4GB VRAM → ✅ Perfect (5.5GB headroom)
- **Llama 3.1 8B:** ~8GB VRAM → ✅ Works (1.5GB headroom)
- **13B+ models:** ~12GB+ VRAM → ❌ Too risky (OOM territory)

### Operation
- **Manual start/stop** via Proxmox UI when working on projects
- **Clean shutdown** (10-30 seconds) for data integrity
- **Systemd dependencies** with health checks for startup order:
  1. WireGuard (network)
  2. Ollama (LLM service) - with health check
  3. Node.js services (MCP, Dashboard, Agent)

### GPU Passthrough
- **Approach:** Device passthrough (pass `/dev/kfd` and `/dev/dri` to VM)
- **GPU:** AMD Radeon 680M (RDNA2, integrated in Ryzen 7 PRO 6850U)
- **Fallback:** If passthrough fails, run Ollama on Proxmox host and expose API to VM

### Backup Strategy
- **Method:** Proxmox snapshots
- **Enable:** qemu-guest-agent for filesystem-level snapshots
- **Exclude:** Ollama models from snapshots (large, re-downloadable)
- **Schedule:** Daily (7 days), Weekly (4 weeks), Monthly (6 months)

### Network Architecture
```
WireGuard (wg0 interface, 10.0.0.10)
    ↓
Caddy (listens on wg0 interface, port 443)
    ↓
Services (bind to 127.0.0.1 only)
```

### Monitoring
- **Method:** systemd limits + simple health check script (cron every 5 min)
- **Checks:** RAM usage > 90%, Ollama responsiveness, Node.js service status
- **Overhead:** <1MB

## Prerequisites

### 🔴 CRITICAL: Fix MCP Connection Issues First
**Status:** Unresolved (HIGH PRIORITY)  
**Timeline:** Week 1-3 for investigation/fix  
**Impact:** Blocking reliable use of Sidekick from opencode

**Symptoms:**
- "Server not initialized" errors
- Intermittent tool call failures
- Session management problems

**Success Criteria:**
- Zero errors over 24-hour period
- 100+ consecutive successful tool calls
- Clear error messages when failures occur

See `CONTEXT.md` for detailed investigation plan and root cause hypotheses.

### Technical Prerequisites
1. **Cloudflare API token** - Token with DNS edit permissions for `digitaltrainwreck.com`
2. **Let's Encrypt email** - Email for Caddy's Let's Encrypt account
3. **WireGuard config** - Router's public key and endpoint IP
4. **Split DNS** - A records on local DNS server for subdomains

## Migration Phases

### Phase 0: Fix MCP Connection Issues (Week 1-3) 🔴
**MUST complete before any migration work**
- Add detailed logging to track session lifecycle
- Capture error messages with timestamps
- Track frequency and patterns
- Identify root cause
- Implement fix
- Test thoroughly, verify success criteria

### Phase 1: Test GPU Passthrough (Week 4)
- Test AMD Radeon 680M passthrough to VM
- Verify device passthrough approach works
- Test fallback plan (Ollama on Proxmox host) if needed

### Phase 2: Create VM (Week 4)
- Create VM with 12GB RAM, 8 cores, 100GB disk
- Install Ubuntu 24.04
- Configure SSH key authentication
- Create `sidekick` user with restricted sudo

### Phase 3: Set Up WireGuard Client (Week 4)
- Generate client keys
- Configure WireGuard interface (wg0)
- Test connectivity to router

### Phase 4: Install Node.js and Deploy Services (Week 4)
- Install Node.js 22.x
- Clone repository
- Install dependencies
- Configure `.env` file
- Set up systemd services with proper dependencies

### Phase 5: Install Ollama and Configure GPU (Week 4)
- Install Ollama (native, not Docker)
- Configure GPU passthrough
- Set up on-demand start/stop mechanism
- Pull initial models (phi3:mini)

### Phase 6: Set Up Caddy Reverse Proxy (Week 4)
- Install Caddy with Cloudflare DNS plugin
- Configure Caddyfile for subdomains
- Set up Let's Encrypt certificates
- Test HTTPS connectivity

### Phase 7: Test All Services (Week 4)
- Verify all services are running
- Test MCP connectivity from opencode
- Test dashboard access
- Test agent bridge
- Test Ollama with GPU acceleration

### Phase 8: Migrate Data (Week 4)
- Export KV store from VPS
- Export conversation history
- Export logs
- Import to new VM
- Verify data integrity

### Phase 9: Update Local Configuration (Week 4)
- Update `opencode.json` to point to new VM
- Update `AGENTS.md` with new IP/architecture
- Test end-to-end with opencode

### Phase 10: Decommission VPS (Week 5)
- Run new VM in parallel for 1 week
- Monitor for issues
- Decommission VPS after stable operation confirmed

## Risks & Mitigations

### Risk 1: GPU Passthrough (Medium confidence)
**Mitigation:** Have fallback plan ready (run Ollama on Proxmox host)  
**Testing:** Test GPU passthrough early in migration

### Risk 2: RAM for Larger Models
**Mitigation:** Start with 12GB, monitor actual usage  
**Note:** Can upgrade to 16GB later if needed (Proxmox makes this easy)

### Risk 3: Snapshot Consistency
**Mitigation:** Enable qemu-guest-agent, add pre-snapshot hook for KV store

### Risk 4: MCP Connection Issues
**Mitigation:** Fix before migration (see Phase 0)  
**Note:** Migrating with broken MCP = migrating a broken system

## Rollback Plan

- Keep VPS running for 1 week after migration
- If issues arise, revert `opencode.json` to VPS IP
- VPS serves as failover

## Estimated Time

- **Phase 0 (MCP fix):** 1-3 weeks (depends on root cause)
- **Phases 1-10 (migration):** 1 week (after MCP issues resolved)
- **Total:** 2-4 weeks

## Security Decisions

- **Dashboard password:** Generate new 24+ char strong password
- **API key:** Generate new key (more secure than reusing)
- **Auth:** Bearer token (MCP), HTTP Basic Auth (Dashboard), localhost-only (Agent)
- **Network:** All services bind to 127.0.0.1, Caddy handles external access via WireGuard

## Troubleshooting

### GPU Issues
- Check `rocm-smi` for GPU status
- Verify device passthrough configuration
- Check Ollama logs: `journalctl -u ollama -f`
- Fallback to CPU if GPU doesn't work (still faster with 8 cores)

### Caddy Issues
- Check Caddy logs: `journalctl -u caddy -f`
- Verify Cloudflare API token has correct permissions
- Check DNS resolution: `nslookup mcp.home.digitaltrainwreck.com`

### WireGuard Issues
- Check connection: `wg show`
- Verify router's WireGuard config has client's public key
- Test connectivity: `ping 10.0.0.1` (router)

### MCP Connection Issues
- See `CONTEXT.md` for detailed troubleshooting
- Check session logs
- Verify network connectivity
- Test with different MCP clients

## Notes

- Current VPS: 149.28.229.13
- New VM IP: 10.0.0.10 (WireGuard)
- Domain: home.digitaltrainwreck.com (split DNS)
- GPU: AMD Radeon 680M (RDNA2, 12 cores)
- Node.js: 22.x (LTS)
- Ubuntu: 24.04 LTS
- Migration plan stored in Sidekick's KV store under `migration_plan_proxmox` key
- All services (MCP, Dashboard, Agent) stay together in one VM
- Ollama runs natively (not in Docker) for simpler AMD GPU management
- On-demand Ollama is the game-changer that makes 12GB VM work
