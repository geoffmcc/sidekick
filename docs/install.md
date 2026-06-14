# Installation and Deployment

Sidekick should be installed and deployed using the included deployment scripts.

The deploy scripts are the primary install path. Manual `npm install` commands are for local development only.

## Server Path

The expected install path on the remote server is:

```bash
/home/sidekick/sidekick
```

Use this path consistently in documentation, scripts, troubleshooting notes, and examples.

## Remote Placeholder

Use this placeholder everywhere in docs:

```text
YOUR_REMOTE_IP
```

Do not mix this with `YOUR_VPS_IP`, `SERVER_IP`, or other placeholder names.

## Windows / PowerShell Deploy

From the local repo folder:

```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP"
```

Example with an initial bootstrap user, if supported by the script:

```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"
```

## Linux / macOS / Bash Deploy

From the local repo folder:

```bash
./deploy.sh YOUR_REMOTE_IP
```

If the script supports an initial bootstrap user, document the exact syntax used by the script. Do not invent flags that the Bash script does not support.

## What the Deploy Scripts Should Handle

The deployment scripts are intended to handle the normal server setup flow:

- Connect to the remote machine over SSH
- Prepare the `/home/sidekick/sidekick` install path
- Install required system packages
- Install Node.js dependencies
- Configure environment/service files as needed
- Install and enable systemd services
- Start or restart Sidekick

## After Deployment

Open the dashboard:

```text
http://YOUR_REMOTE_IP:4098/
```

Check the service:

```bash
sudo systemctl status sidekick
```

View logs:

```bash
sudo journalctl -u sidekick -f
```

## Manual Development Setup

Use this only for local development or troubleshooting:

```bash
npm install
npm start
```

Production/server installs should use the deployment scripts instead.
