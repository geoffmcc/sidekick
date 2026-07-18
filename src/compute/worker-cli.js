// Worker CLI parsing and presentation (Phase 5).
//
// Pure, side-effect-free helpers for the `sidekick-compute-worker` binary:
// argument parsing (command + flags -> env assignments), help text, and status
// formatting. Kept free of any worker-agent/network dependency so it is trivially
// testable and safe to require before the agent's config consts are evaluated.
//
// The agent applies parseArgv().env to process.env BEFORE reading its config
// consts, preserving the CLI > env > file > defaults precedence.

const COMMANDS = ["run", "enroll", "status", "doctor", "rotate-credential", "version"];

// Flag -> environment variable it assigns.
const FLAG_MAP = {
  "--server": "SIDEKICK_SERVER_URL",
  "--token": "SIDEKICK_ENROLL_TOKEN",
  "--name": "SIDEKICK_NODE_NAME",
  "--node-id": "SIDEKICK_NODE_ID",
  "--config": "SIDEKICK_WORKER_CONFIG",
  "--config-file": "SIDEKICK_WORKER_CONFIG_FILE",
  "--concurrency": "SIDEKICK_WORKER_CONCURRENCY",
};

const HELP = `Usage: sidekick-compute-worker <command> [options]

Commands:
  run                Load config + credential, connect, and process jobs (default)
  enroll             Exchange an enrollment token, write the credential, and exit
  status             Print local worker status (no secrets) and exit
  doctor             Run read-only diagnostics and exit
  rotate-credential  Rotate the worker credential via the server and exit
  version            Print the worker version and exit

Options:
  --server <url>       Sidekick server URL, e.g. http://10.47.20.20:4097
  --token <token>      One-time enrollment token (enroll)
  --name <name>        Worker display name
  --node-id <id>       Stable node ID for this machine
  --config <path>      Credential file path
  --config-file <path> Worker settings config file (JSON)
  --concurrency <n>    Maximum concurrent jobs, 1-16
  --service [type]     Enroll only; do not start the claim loop (installer use)
  -h, --help           Show this help and exit`;

// Parse argv (already sliced past node + script). Returns:
//   { command, env: {NAME:value}, service: bool, help: bool, error: string|null }
// Never mutates process.env or exits — the caller decides what to do.
function parseArgv(argv) {
  const args = (argv || []).slice();
  if (args.includes("--help") || args.includes("-h")) {
    return { command: null, env: {}, service: false, help: true, error: null };
  }
  let command = "run";
  if (args.length && !args[0].startsWith("-")) command = args.shift();
  if (!COMMANDS.includes(command)) {
    return { command, env: {}, service: false, help: false, error: `Unknown worker command: ${command}` };
  }
  const env = {};
  let service = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--service") {
      service = true;
      // Optional service-type value (e.g. "--service windows"); consume if present.
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    const envName = FLAG_MAP[arg];
    if (!envName) return { command, env, service, help: false, error: `Unknown option: ${arg}` };
    const value = args[++i];
    if (value === undefined) return { command, env, service, help: false, error: `Missing value for ${arg}` };
    env[envName] = value;
  }
  return { command, env, service, help: false, error: null };
}

// Render a status object as human-readable text. `info` MUST NOT contain the
// credential secret; this function only reads known non-secret fields.
function formatStatus(info) {
  const lines = [
    "Sidekick Compute Worker — status",
    `  Server URL:      ${info.serverUrl}`,
    `  Node ID:         ${info.nodeId}`,
    `  Display name:    ${info.displayName}`,
    `  Config file:     ${info.configFilePath}`,
    `  Credential file: ${info.credentialPath}`,
    `  Enrolled:        ${info.enrolled ? "yes" : "no"}`,
  ];
  if (info.enrolled) {
    lines.push(`  Worker ID:       ${info.workerId}`);
    if (info.enrolledAt) lines.push(`  Enrolled at:     ${info.enrolledAt}`);
  }
  if (info.concurrency !== undefined) lines.push(`  Concurrency:     ${info.concurrency}`);
  return lines.join("\n");
}

module.exports = { COMMANDS, FLAG_MAP, HELP, parseArgv, formatStatus };
