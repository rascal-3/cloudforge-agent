#!/usr/bin/env node
/**
 * CloudForge Agent
 * Connects your server to CloudForge for remote terminal access
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { createRequire } from 'module'
import { chmodSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { createConfig, VERSION, getSystemInfo } from './config.js'
import { WebSocketManager } from './websocket.js'
import { TerminalManager } from './terminal.js'
import { FileManager } from './files.js'
import { GitManager } from './git.js'

/**
 * Fix node-pty spawn-helper permissions.
 * When installed via npx, the spawn-helper binary may lack execute permission.
 */
function fixNodePtyPermissions(): void {
  try {
    const require = createRequire(import.meta.url)
    const ptyPath = dirname(require.resolve('node-pty'))
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
    const arch = process.arch
    if (!platform) return
    const helperPath = join(ptyPath, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
    const stat = statSync(helperPath, { throwIfNoEntry: false })
    if (stat && !(stat.mode & 0o111)) {
      chmodSync(helperPath, stat.mode | 0o755)
    }
  } catch {
    // Ignore - will fail naturally when spawning terminal if still broken
  }
}

fixNodePtyPermissions()

const program = new Command()

program
  .name('cloudforge-agent')
  .description('CloudForge Agent - Connect your server to CloudForge')
  .version(VERSION)
  .option('-t, --token <token>', 'Agent token from CloudForge dashboard')
  .option('-s, --server <url>', 'CloudForge server URL (default: https://cloud-forge.me)')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options) => {
    console.log(chalk.cyan(`
   _____ _                 _ _____
  / ____| |               | |  ___|
 | |    | | ___  _   _  __| | |_ ___  _ __ __ _  ___
 | |    | |/ _ \\| | | |/ _\` |  _/ _ \\| '__/ _\` |/ _ \\
 | |____| | (_) | |_| | (_| | || (_) | | | (_| |  __/
  \\_____|_|\\___/ \\__,_|\\__,_\\_| \\___/|_|  \\__, |\\___|
                                           __/ |
                                          |___/
    `))
    console.log(chalk.gray(`  Agent v${VERSION}`))
    console.log()

    try {
      // Create configuration
      const config = createConfig({
        token: options.token,
        serverUrl: options.server,
        debug: options.debug,
      })

      if (config.debug) {
        console.log(chalk.gray('Debug mode enabled'))
        console.log(chalk.gray(`Server URL: ${config.serverUrl}`))
      }

      // Get system info
      const systemInfo = getSystemInfo()
      console.log(chalk.gray(`System: ${systemInfo.os}`))
      console.log(chalk.gray(`Hostname: ${systemInfo.hostname}`))
      console.log(chalk.gray(`Shell: ${systemInfo.shell}`))
      console.log()

      // Create terminal manager
      const terminalManager = new TerminalManager(config)

      // Create file manager
      const fileManager = new FileManager(config)

      // Create git manager
      const gitManager = new GitManager(config)

      // Create and connect WebSocket manager
      const wsManager = new WebSocketManager(config, terminalManager, fileManager, gitManager)

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log()
        console.log(chalk.yellow('Shutting down agent...'))
        terminalManager.killAll()
        wsManager.disconnect()
        console.log(chalk.green('Agent stopped.'))
        process.exit(0)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Connect to CloudForge
      console.log(chalk.yellow('Connecting to CloudForge...'))
      await wsManager.connect()

    } catch (err) {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

program.parse()
