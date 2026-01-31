/**
 * CloudForge Agent Configuration
 */

import { config as dotenvConfig } from 'dotenv'
import os from 'os'

// Load .env file if exists
dotenvConfig()

export interface AgentConfig {
  token: string
  serverUrl: string
  heartbeatInterval: number
  reconnectDelay: number
  maxReconnectDelay: number
  shell: string
  homeDir: string
  debug: boolean
}

const DEFAULT_SERVER_URL = 'https://cloud-forge.me'
const DEFAULT_HEARTBEAT_INTERVAL = 30000 // 30 seconds
const DEFAULT_RECONNECT_DELAY = 1000 // 1 second
const MAX_RECONNECT_DELAY = 30000 // 30 seconds

/**
 * Get the default shell for the current platform
 */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * Create agent configuration from environment and CLI options
 */
export function createConfig(options: {
  token?: string
  serverUrl?: string
  debug?: boolean
}): AgentConfig {
  const token = options.token || process.env.CLOUDFORGE_TOKEN

  if (!token) {
    throw new Error('Agent token is required. Use --token flag or set CLOUDFORGE_TOKEN environment variable.')
  }

  // Validate token format (cf_ prefix + 32 hex chars)
  if (!/^cf_[a-f0-9]{32}$/.test(token)) {
    throw new Error('Invalid token format. Token should start with "cf_" followed by 32 hex characters.')
  }

  return {
    token,
    serverUrl: options.serverUrl || process.env.CLOUDFORGE_SERVER_URL || DEFAULT_SERVER_URL,
    heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL,
    reconnectDelay: DEFAULT_RECONNECT_DELAY,
    maxReconnectDelay: MAX_RECONNECT_DELAY,
    shell: getDefaultShell(),
    homeDir: os.homedir(),
    debug: options.debug || process.env.CLOUDFORGE_DEBUG === 'true',
  }
}

/**
 * Get system information for heartbeat
 */
export function getSystemInfo(): {
  os: string
  hostname: string
  platform: string
  arch: string
  nodeVersion: string
  homeDir: string
  shell: string
} {
  return {
    os: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    homeDir: os.homedir(),
    shell: getDefaultShell(),
  }
}

export const VERSION = '0.1.0'
