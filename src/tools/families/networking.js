"use strict";

// Networking tool family: Cloudflare tunnels, WireGuard, and Nginx.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins and the
// shared command-validation helpers — never on tools-legacy.js. All three tools
// are `high` risk (they shell out to privileged network/proxy commands); that
// classification is preserved from src/tools/metadata.js and gated by the
// dispatcher's policy/approval pipeline. Argument values that reach a shell are
// validated through core/command-validation before use.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { z } = require("zod");
const { validIdentifier, validPort, validDomainName, validAllowedIps, validWireGuardEndpoint, validWireGuardPublicKey } = require("../../core/command-validation");

async function sidekick_tunnel({ action, url, port, name }) {
  try {
    if (action === "start") {
      if (!port) {
        return { content: [{ type: "text", text: "Error: port required" }], isError: true };
      }
      const tunnelName = name ? validIdentifier(name, "tunnel name") : `tunnel-${Date.now()}`;
      const localPort = validPort(port);
      const logPath = path.join("/tmp", `${tunnelName}.log`);
      const logFd = fs.openSync(logPath, "a");
      const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${localPort}`, "--name", tunnelName], {
        detached: true,
        stdio: ["ignore", logFd, logFd]
      });
      child.unref();
      fs.closeSync(logFd);
      // Wait a moment for tunnel to establish
      await new Promise(resolve => setTimeout(resolve, 3000));
      // Try to get the tunnel URL from logs
      try {
        const logContent = fs.readFileSync(logPath, 'utf8');
        const urlMatch = logContent.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        const tunnelUrl = urlMatch ? urlMatch[0] : null;
        return { content: [{ type: "text", text: JSON.stringify({
          name: tunnelName,
          port: localPort,
          url: tunnelUrl,
          status: "started",
          log: logPath
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({
          name: tunnelName,
          port: localPort,
          status: "started",
          note: "Tunnel started but URL not yet available. Check logs at " + logPath
        }, null, 2) }] };
      }
    }

    if (action === "stop") {
      if (!name) {
        return { content: [{ type: "text", text: "Error: tunnel name required" }], isError: true };
      }
      const tunnelName = validIdentifier(name, "tunnel name");
      try {
        execFileSync("pkill", ["-f", `cloudflared tunnel.*--name ${tunnelName}`], { timeout: 5000 });
        return { content: [{ type: "text", text: `Stopped tunnel: ${tunnelName}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Tunnel not found or already stopped: ${tunnelName}` }] };
      }
    }

    if (action === "list") {
      try {
        const result = execFileSync("ps", ["aux"], { timeout: 5000, encoding: "utf-8" });
        const tunnels = result.split('\n').filter(line => line.trim()).map(line => {
          const nameMatch = line.match(/--name\s+(\S+)/);
          const portMatch = line.match(/--url\s+http:\/\/localhost:(\d+)/);
          return {
            name: nameMatch ? nameMatch[1] : "unknown",
            port: portMatch ? portMatch[1] : "unknown",
            pid: line.split(/\s+/)[1]
          };
        }).filter(tunnel => tunnel.name !== "unknown" || tunnel.port !== "unknown");
        return { content: [{ type: "text", text: JSON.stringify(tunnels, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "No active tunnels" }] };
      }
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: start, stop, list" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_wireguard({ action, interface_name, peer_name, public_key, endpoint, allowed_ips }) {
  try {
    if (action === "status") {
      const result = execFileSync("sudo", ["wg", "show", "all"], { timeout: 5000, encoding: "utf-8" });
      if (!result.trim()) {
        return { content: [{ type: "text", text: "No WireGuard interfaces found" }] };
      }
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_peers") {
      if (!interface_name) {
        return { content: [{ type: "text", text: "Error: interface_name required" }], isError: true };
      }
      const iface = validIdentifier(interface_name, "interface name", 32);
      const result = execFileSync("sudo", ["wg", "show", iface, "peers"], { timeout: 5000, encoding: "utf-8" });
      const peers = result.trim().split('\n').filter(line => line && !line.startsWith('Warning')).map(line => {
        const parts = line.split('\t');
        return {
          public_key: parts[0],
          endpoint: parts[1] || 'none',
          allowed_ips: parts[2] || 'none',
          latest_handshake: parts[3] || 'never',
          transfer_rx: parts[4] || '0',
          transfer_tx: parts[5] || '0'
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }] };
    }

    if (action === "add_peer") {
      if (!interface_name || !peer_name || !public_key) {
        return { content: [{ type: "text", text: "Error: interface_name, peer_name, and public_key required" }], isError: true };
      }
      const iface = validIdentifier(interface_name, "interface name", 32);
      const peerName = validIdentifier(peer_name, "peer name");
      const key = validWireGuardPublicKey(public_key);
      const ips = validAllowedIps(allowed_ips);
      const peerEndpoint = validWireGuardEndpoint(endpoint);
      const args = ["wg", "set", iface, "peer", key, "allowed-ips", ips];
      if (peerEndpoint) args.push("endpoint", peerEndpoint);
      execFileSync("sudo", args, { timeout: 5000 });
      return { content: [{ type: "text", text: `Added peer ${peerName} to ${iface}` }] };
    }

    if (action === "remove_peer") {
      if (!interface_name || !public_key) {
        return { content: [{ type: "text", text: "Error: interface_name and public_key required" }], isError: true };
      }
      const iface = validIdentifier(interface_name, "interface name", 32);
      const key = validWireGuardPublicKey(public_key);
      execFileSync("sudo", ["wg", "set", iface, "peer", key, "remove"], { timeout: 5000 });
      return { content: [{ type: "text", text: `Removed peer from ${iface}` }] };
    }

    if (action === "generate_keypair") {
      const privateKey = execFileSync("wg", ["genkey"], { timeout: 5000, encoding: "utf-8" }).trim();
      const publicKey = execFileSync("wg", ["pubkey"], { input: privateKey + "\n", timeout: 5000, encoding: "utf-8" }).trim();
      return { content: [{ type: "text", text: JSON.stringify({ private_key: privateKey, public_key: publicKey }, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: status, list_peers, add_peer, remove_peer, generate_keypair" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_nginx({ action, site_name, domain, upstream_port, ssl_email }) {
  try {
    if (action === "status") {
      const result = execFileSync("sudo", ["systemctl", "status", "nginx", "--no-pager"], { timeout: 5000, encoding: "utf-8" });
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_sites") {
      const sites = fs.readdirSync("/etc/nginx/sites-enabled").filter(s => s && s !== "default");
      return { content: [{ type: "text", text: JSON.stringify(sites, null, 2) }] };
    }

    if (action === "add_site") {
      if (!site_name || !domain || !upstream_port) {
        return { content: [{ type: "text", text: "Error: site_name, domain, and upstream_port required" }], isError: true };
      }
      const siteName = validIdentifier(site_name, "site name");
      const domainName = validDomainName(domain);
      const proxyPort = validPort(upstream_port, "upstream port");

      const config = `server {
    listen 80;
    server_name ${domainName};

    location / {
        proxy_pass http://127.0.0.1:${proxyPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}`;

      const tmpPath = path.join("/tmp", siteName);
      const availablePath = `/etc/nginx/sites-available/${siteName}`;
      const enabledPath = `/etc/nginx/sites-enabled/${siteName}`;
      fs.writeFileSync(tmpPath, config);
      execFileSync("sudo", ["install", "-m", "0644", tmpPath, availablePath], { timeout: 5000 });
      execFileSync("sudo", ["ln", "-sf", availablePath, enabledPath], { timeout: 5000 });

      // Test config
      try {
        execFileSync("sudo", ["nginx", "-t"], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
        execFileSync("sudo", ["systemctl", "reload", "nginx"], { timeout: 5000 });
        return { content: [{ type: "text", text: `Added site ${siteName} for ${domainName} -> port ${proxyPort}` }] };
      } catch (e) {
        execFileSync("sudo", ["rm", "-f", enabledPath, availablePath], { timeout: 5000 });
        const detail = (e.stderr || e.stdout || e.message || "").toString();
        return { content: [{ type: "text", text: `Error: Invalid nginx config: ${detail}` }], isError: true };
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }

    if (action === "remove_site") {
      if (!site_name) {
        return { content: [{ type: "text", text: "Error: site_name required" }], isError: true };
      }
      const siteName = validIdentifier(site_name, "site name");
      execFileSync("sudo", ["rm", "-f", `/etc/nginx/sites-enabled/${siteName}`, `/etc/nginx/sites-available/${siteName}`], { timeout: 5000 });
      execFileSync("sudo", ["systemctl", "reload", "nginx"], { timeout: 5000 });
      return { content: [{ type: "text", text: `Removed site ${siteName}` }] };
    }

    if (action === "test_config") {
      try {
        execFileSync("sudo", ["nginx", "-t"], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
        return { content: [{ type: "text", text: "nginx config test passed" }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e.stderr || e.stdout || e.message).toString() }], isError: true };
      }
    }

    if (action === "reload") {
      execFileSync("sudo", ["systemctl", "reload", "nginx"], { timeout: 5000 });
      return { content: [{ type: "text", text: "Nginx reloaded" }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: status, list_sites, add_site, remove_site, test_config, reload" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "tunnel",
    description: "Manage Cloudflare tunnels: start, stop, list",
    schema: z.object({
      action: z.enum(["start", "stop", "list"]).describe("Tunnel action"),
      port: z.number().optional().describe("Local port to expose (required for start)"),
      name: z.string().optional().describe("Tunnel name (optional)"),
    }),
    args: { action: "string (start|stop|list)", port: "number (local port to expose)", name: "string (optional, tunnel name)" },
    risk: "high",
    category: "Networking",
    source: "builtin",
    family: "networking",
    handler: sidekick_tunnel,
  }),
  Object.freeze({
    name: "wireguard",
    description: "Manage WireGuard VPN: status, list_peers, add_peer, remove_peer, generate_keypair",
    schema: z.object({
      action: z.enum(["status", "list_peers", "add_peer", "remove_peer", "generate_keypair"]).describe("WireGuard action"),
      interface_name: z.string().optional().describe("WireGuard interface (e.g. wg0)"),
      peer_name: z.string().optional().describe("Peer name (for add_peer)"),
      public_key: z.string().optional().describe("Peer public key"),
      endpoint: z.string().optional().describe("Peer endpoint IP:port"),
      allowed_ips: z.string().optional().describe("Allowed IPs (default 10.0.0.0/24)"),
    }),
    args: { action: "string (status|list_peers|add_peer|remove_peer|generate_keypair)", interface_name: "string (WireGuard interface, e.g. wg0)", peer_name: "string (peer name for add_peer)", public_key: "string (peer public key)", endpoint: "string (optional, peer endpoint IP:port)", allowed_ips: "string (optional, allowed IPs, default 10.0.0.0/24)" },
    risk: "high",
    category: "Networking",
    source: "builtin",
    family: "networking",
    handler: sidekick_wireguard,
  }),
  Object.freeze({
    name: "nginx",
    description: "Manage Nginx reverse proxy: status, list_sites, add_site, remove_site, test_config, reload",
    schema: z.object({
      action: z.enum(["status", "list_sites", "add_site", "remove_site", "test_config", "reload"]).describe("Nginx action"),
      site_name: z.string().optional().describe("Site config name"),
      domain: z.string().optional().describe("Domain name (for add_site)"),
      upstream_port: z.number().optional().describe("Local port to proxy to"),
      ssl_email: z.string().optional().describe("Email for Let's Encrypt"),
    }),
    args: { action: "string (status|list_sites|add_site|remove_site|test_config|reload)", site_name: "string (site config name)", domain: "string (domain name for add_site)", upstream_port: "number (local port to proxy to)", ssl_email: "string (optional, email for Let's Encrypt)" },
    risk: "high",
    category: "Networking",
    source: "builtin",
    family: "networking",
    handler: sidekick_nginx,
  }),
]);

module.exports = { descriptors, sidekick_tunnel, sidekick_wireguard, sidekick_nginx };
