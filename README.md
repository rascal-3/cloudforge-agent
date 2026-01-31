# CloudForge Agent

Lightweight agent that connects your server to [CloudForge](https://cloud-forge.me) — remote AI coding from anywhere.

CloudForge Agent runs on your server and establishes an outbound WebSocket connection to CloudForge. Your code stays on your server; CloudForge only relays terminal I/O, file operations, and Git commands.

## Features

- **Terminal sessions** via node-pty (full PTY support)
- **File operations** — browse, read, write files remotely
- **Git integration** — status, add, commit, push, pull, diff, branch management
- **Outbound-only connection** — no firewall or port forwarding needed
- **Auto-reconnection** with exponential backoff
- **Heartbeat** with system info reporting

## Requirements

- Node.js >= 18
- A CloudForge account and server token (get one at [cloud-forge.me](https://cloud-forge.me))

## Installation

### npx (quickest)

```bash
npx cloudforge-agent --token YOUR_TOKEN
```

### npm global install

```bash
npm install -g cloudforge-agent
cloudforge-agent --token YOUR_TOKEN
```

### From source

```bash
git clone https://github.com/rascal-3/cloudforge-agent.git
cd cloudforge-agent
npm install
npm run build
npm start -- --token YOUR_TOKEN
```

### Docker

```bash
docker run -d \
  --name cloudforge-agent \
  --restart unless-stopped \
  -v /path/to/projects:/home/user \
  cloudforge/agent:latest \
  --token YOUR_TOKEN
```

## Usage

```bash
cloudforge-agent --token YOUR_TOKEN [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--token` | Server authentication token (required) | — |
| `--server` | CloudForge server URL | `https://cloud-forge.me` |
| `--home` | Home directory for terminal sessions | `~` |
| `--debug` | Enable debug logging | `false` |

### Environment variables

You can also configure via environment variables or a `.env` file:

```bash
CLOUDFORGE_TOKEN=your_token
CLOUDFORGE_SERVER=https://cloud-forge.me
CLOUDFORGE_HOME=/home/user
CLOUDFORGE_DEBUG=true
```

## How it works

```
┌─────────────────────┐          ┌─────────────────────┐
│   Your Browser      │          │   Your Server        │
│   (CloudForge UI)   │          │                      │
│                     │          │   CloudForge Agent   │
│   Terminal ─────────┤          ├──── node-pty         │
│   File Tree ────────┤  WebSocket│──── File I/O        │
│   Git Panel ────────┤◄────────►├──── Git CLI          │
│   Code Editor ──────┤          │                      │
└─────────────────────┘          └─────────────────────┘
                    ▲                    │
                    │   CloudForge SaaS  │
                    └── relay only ──────┘
```

- Agent connects **outbound** to CloudForge (no inbound ports needed)
- All code stays on your server
- CloudForge relays commands between your browser and the agent

## Supported AI Coding Tools

CloudForge works with any CLI tool running in the terminal:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://github.com/openai/codex) (OpenAI)
- [Gemini CLI](https://github.com/google/gemini-cli) (Google)
- [Aider](https://aider.chat/)
- Any other terminal-based tool

## Development

```bash
npm install
npm run dev      # watch mode with tsx
npm run build    # compile TypeScript
npm run typecheck
```

## License

[MIT](LICENSE)
