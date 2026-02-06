/**
 * CloudForge Agent WebSocket Manager
 * Handles connection to CloudForge server
 */

import { io, Socket } from 'socket.io-client'
import * as os from 'os'
import chalk from 'chalk'
import { AgentConfig, getSystemInfo, VERSION } from './config.js'
import type { TerminalManager } from './terminal.js'
import type { FileManager } from './files.js'
import type { GitManager } from './git.js'

export class WebSocketManager {
  private socket: Socket | null = null
  private config: AgentConfig
  private terminalManager: TerminalManager
  private fileManager: FileManager
  private gitManager: GitManager
  private reconnectAttempts = 0
  private heartbeatTimer: NodeJS.Timeout | null = null
  private isConnected = false

  constructor(config: AgentConfig, terminalManager: TerminalManager, fileManager: FileManager, gitManager: GitManager) {
    this.config = config
    this.terminalManager = terminalManager
    this.fileManager = fileManager
    this.gitManager = gitManager
  }

  /**
   * Connect to CloudForge server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketUrl = `${this.config.serverUrl}/agent`

      this.socket = io(socketUrl, {
        auth: {
          token: this.config.token,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: this.config.reconnectDelay,
        reconnectionDelayMax: this.config.maxReconnectDelay,
        timeout: 60000,
      })

      // Connection events
      this.socket.on('connect', () => {
        this.isConnected = true
        this.reconnectAttempts = 0
        console.log(chalk.green('Connected to CloudForge!'))

        // Send system info
        this.sendSystemInfo()

        // Start heartbeat
        this.startHeartbeat()

        resolve()
      })

      this.socket.on('connect_error', (err) => {
        if (this.reconnectAttempts === 0) {
          console.error(chalk.red('Connection failed:'), err.message)
        }
        this.reconnectAttempts++

        if (this.reconnectAttempts >= 5 && !this.isConnected) {
          reject(new Error(`Failed to connect after ${this.reconnectAttempts} attempts: ${err.message}`))
        }
      })

      this.socket.on('disconnect', (reason) => {
        this.isConnected = false
        this.stopHeartbeat()
        console.log(chalk.yellow('Disconnected:'), reason)

        // Socket.IO auto-reconnects for transport-level disconnects only.
        // For namespace-level disconnects (server or client initiated),
        // we must manually reconnect.
        // Note: "io client disconnect" = client called disconnect (server sees "client namespace disconnect")
        //       "io server disconnect" = server called disconnect (server sees "server namespace disconnect")
        if (reason === 'io server disconnect' || reason === 'io client disconnect') {
          const delay = reason === 'io client disconnect' ? 2000 : 1000
          console.log(chalk.yellow(`Reconnecting in ${delay}ms...`))
          setTimeout(() => {
            if (!this.isConnected && this.socket) {
              this.socket.connect()
            }
          }, delay)
        }
      })

      this.socket.on('reconnect', (attemptNumber) => {
        console.log(chalk.green(`Reconnected after ${attemptNumber} attempts`))
        this.sendSystemInfo()
        this.startHeartbeat()
      })

      this.socket.on('reconnect_attempt', (attemptNumber) => {
        if (this.config.debug) {
          console.log(chalk.gray(`Reconnect attempt ${attemptNumber}...`))
        }
      })

      this.socket.on('error', (err) => {
        console.error(chalk.red('Socket error:'), err)
      })

      // Terminal events from server
      this.setupTerminalHandlers()

      // File events from server
      this.setupFileHandlers()

      // Git events from server
      this.setupGitHandlers()

      // Auth events from server
      this.setupAuthHandlers()
    })
  }

  /**
   * Setup terminal event handlers
   */
  private setupTerminalHandlers(): void {
    if (!this.socket) return

    // Spawn terminal request
    this.socket.on('terminal:spawn', (msg: {
      sessionId: string
      shell?: string
      cols?: number
      rows?: number
      cwd?: string
      idleTimeoutMs?: number
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Terminal spawn request: ${msg.sessionId}`))
      }

      // Resolve cwd: use provided cwd, or fall back to homeDir
      let cwd = this.config.homeDir
      if (msg.cwd) {
        let expanded = msg.cwd
        if (expanded === '~' || expanded.startsWith('~/')) {
          expanded = expanded.replace('~', os.homedir())
        }
        cwd = expanded
      }

      try {
        const session = this.terminalManager.spawn(
          msg.sessionId,
          msg.shell || this.config.shell,
          msg.cols || 80,
          msg.rows || 24,
          cwd,
          msg.idleTimeoutMs
        )

        // Forward output to server
        session.onData((data) => {
          this.socket?.emit('terminal:output', {
            type: 'terminal:output',
            sessionId: msg.sessionId,
            data,
          })
        })

        // Forward exit to server
        session.onExit((exitCode) => {
          this.socket?.emit('terminal:closed', {
            type: 'terminal:closed',
            sessionId: msg.sessionId,
            exitCode,
          })
          this.terminalManager.remove(msg.sessionId)
        })

      } catch (err) {
        console.error(chalk.red('Terminal spawn error:'), err)
        this.socket?.emit('terminal:error', {
          type: 'terminal:error',
          sessionId: msg.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Terminal input from server
    this.socket.on('terminal:input', (msg: {
      sessionId: string
      data: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Terminal input: sessionId=${msg.sessionId}, data length=${msg.data.length}`))
      }
      const session = this.terminalManager.get(msg.sessionId)
      if (session) {
        session.write(msg.data)
      } else {
        console.warn(chalk.yellow(`No terminal session found for: ${msg.sessionId}`))
        console.warn(chalk.yellow(`Available sessions: ${this.terminalManager.sessionIds.join(', ')}`))
      }
    })

    // Terminal resize from server
    this.socket.on('terminal:resize', (msg: {
      sessionId: string
      cols: number
      rows: number
    }) => {
      const session = this.terminalManager.get(msg.sessionId)
      if (session) {
        session.resize(msg.cols, msg.rows)
      }
    })

    // Terminal kill from server
    this.socket.on('terminal:kill', (msg: {
      sessionId: string
    }) => {
      this.terminalManager.kill(msg.sessionId)
    })

    // Get terminal cwd
    this.socket.on('terminal:getcwd', async (msg: {
      sessionId: string
    }) => {
      const cwd = await this.terminalManager.getCwd(msg.sessionId)
      if (cwd) {
        this.socket?.emit('terminal:cwd', {
          type: 'terminal:cwd',
          sessionId: msg.sessionId,
          cwd,
        })
      }
    })

    // Detach terminal session (keep PTY alive)
    this.socket.on('terminal:detach', (msg: {
      sessionId: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Terminal detach request: ${msg.sessionId}`))
      }
      this.terminalManager.detach(msg.sessionId)
    })

    // List existing sessions
    this.socket.on('terminal:list-sessions', () => {
      if (this.config.debug) {
        console.log(chalk.gray('Terminal list-sessions request'))
      }
      const sessions = this.terminalManager.listSessions()
      this.socket?.emit('terminal:sessions-list', {
        type: 'terminal:sessions-list',
        sessions,
      })
    })

    // Reattach to existing session
    this.socket.on('terminal:reattach', (msg: {
      sessionId: string
      cols?: number
      rows?: number
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Terminal reattach request: ${msg.sessionId}`))
      }

      const result = this.terminalManager.reattach(msg.sessionId)
      if (!result) {
        this.socket?.emit('terminal:error', {
          type: 'terminal:error',
          sessionId: msg.sessionId,
          error: 'Session not found',
        })
        return
      }

      // Send scrollback buffer
      this.socket?.emit('terminal:scrollback', {
        type: 'terminal:scrollback',
        sessionId: msg.sessionId,
        data: result.scrollback,
      })

      // Re-register output forwarding (clear old callbacks first to prevent double echo)
      const session = this.terminalManager.get(msg.sessionId)
      if (session) {
        session.clearDataCallbacks()
        session.onData((data) => {
          this.socket?.emit('terminal:output', {
            type: 'terminal:output',
            sessionId: msg.sessionId,
            data,
          })
        })

        // Resize if dimensions changed
        if (msg.cols && msg.rows) {
          session.resize(msg.cols, msg.rows)
        }
      }
    })
  }

  /**
   * Setup file event handlers
   */
  private setupFileHandlers(): void {
    if (!this.socket) return

    // List directory
    this.socket.on('files:list', async (msg: {
      requestId: string
      path: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Files list request: ${msg.path}`))
      }

      try {
        const entries = await this.fileManager.list(msg.path)
        this.socket?.emit('files:list:response', {
          type: 'files:list:response',
          requestId: msg.requestId,
          path: msg.path,
          entries,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('Files list error:'), err)
        this.socket?.emit('files:list:response', {
          type: 'files:list:response',
          requestId: msg.requestId,
          path: msg.path,
          entries: [],
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Read file
    this.socket.on('file:read', async (msg: {
      requestId: string
      path: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`File read request: ${msg.path}`))
      }

      try {
        const result = await this.fileManager.read(msg.path)
        this.socket?.emit('file:read:response', {
          type: 'file:read:response',
          requestId: msg.requestId,
          ...result,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('File read error:'), err)
        this.socket?.emit('file:read:response', {
          type: 'file:read:response',
          requestId: msg.requestId,
          path: msg.path,
          content: '',
          encoding: 'utf8',
          size: 0,
          isBinary: false,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Write file
    this.socket.on('file:write', async (msg: {
      requestId: string
      path: string
      content: string
      encoding?: 'utf8' | 'base64'
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`File write request: ${msg.path}`))
      }

      try {
        const result = await this.fileManager.write(msg.path, msg.content, msg.encoding || 'utf8')
        this.socket?.emit('file:write:response', {
          type: 'file:write:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('File write error:'), err)
        this.socket?.emit('file:write:response', {
          type: 'file:write:response',
          requestId: msg.requestId,
          path: msg.path,
          success: false,
          bytesWritten: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Delete file/directory
    this.socket.on('file:delete', async (msg: {
      requestId: string
      path: string
      recursive?: boolean
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`File delete request: ${msg.path}`))
      }

      try {
        const result = await this.fileManager.delete(msg.path, msg.recursive)
        this.socket?.emit('file:delete:response', {
          type: 'file:delete:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('File delete error:'), err)
        this.socket?.emit('file:delete:response', {
          type: 'file:delete:response',
          requestId: msg.requestId,
          path: msg.path,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Create directory
    this.socket.on('file:mkdir', async (msg: {
      requestId: string
      path: string
      recursive?: boolean
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Mkdir request: ${msg.path}`))
      }

      try {
        const result = await this.fileManager.mkdir(msg.path, msg.recursive)
        this.socket?.emit('file:mkdir:response', {
          type: 'file:mkdir:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Mkdir error:'), err)
        this.socket?.emit('file:mkdir:response', {
          type: 'file:mkdir:response',
          requestId: msg.requestId,
          path: msg.path,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Rename/move file
    this.socket.on('file:rename', async (msg: {
      requestId: string
      fromPath: string
      toPath: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Rename request: ${msg.fromPath} -> ${msg.toPath}`))
      }

      try {
        const result = await this.fileManager.rename(msg.fromPath, msg.toPath)
        this.socket?.emit('file:rename:response', {
          type: 'file:rename:response',
          requestId: msg.requestId,
          fromPath: msg.fromPath,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Rename error:'), err)
        this.socket?.emit('file:rename:response', {
          type: 'file:rename:response',
          requestId: msg.requestId,
          fromPath: msg.fromPath,
          path: msg.toPath,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Stat file/directory
    this.socket.on('file:stat', async (msg: {
      requestId: string
      path: string
    }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Stat request: ${msg.path}`))
      }

      try {
        const entry = await this.fileManager.stat(msg.path)
        this.socket?.emit('file:stat:response', {
          type: 'file:stat:response',
          requestId: msg.requestId,
          path: msg.path,
          entry,
          success: entry !== null,
          error: entry === null ? 'File not found' : undefined,
        })
      } catch (err) {
        console.error(chalk.red('Stat error:'), err)
        this.socket?.emit('file:stat:response', {
          type: 'file:stat:response',
          requestId: msg.requestId,
          path: msg.path,
          entry: null,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Resolve git cwd - handles ~ expansion and field name compatibility
   */
  private resolveGitCwd(msg: { cwd?: string; path?: string }): string {
    let cwd = msg.cwd || msg.path || os.homedir()
    if (cwd === '~' || cwd.startsWith('~/')) {
      cwd = cwd.replace('~', os.homedir())
    }
    return cwd
  }

  /**
   * Setup Git event handlers
   */
  private setupGitHandlers(): void {
    if (!this.socket) return

    // Git status
    this.socket.on('git:status', async (msg: {
      requestId: string
      cwd?: string
      path?: string
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git status request: ${cwd}`))
      }

      try {
        const status = await this.gitManager.status(cwd)
        this.socket?.emit('git:status:response', {
          type: 'git:status:response',
          requestId: msg.requestId,
          status,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('Git status error:'), err)
        this.socket?.emit('git:status:response', {
          type: 'git:status:response',
          requestId: msg.requestId,
          status: null,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git add (stage files)
    this.socket.on('git:add', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      files: string[]
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git add request: ${msg.files.join(', ')}`))
      }

      try {
        const result = await this.gitManager.add(cwd, msg.files)
        this.socket?.emit('git:add:response', {
          type: 'git:add:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git add error:'), err)
        this.socket?.emit('git:add:response', {
          type: 'git:add:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git reset (unstage files)
    this.socket.on('git:reset', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      files: string[]
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git reset request: ${msg.files.join(', ')}`))
      }

      try {
        const result = await this.gitManager.reset(cwd, msg.files)
        this.socket?.emit('git:reset:response', {
          type: 'git:reset:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git reset error:'), err)
        this.socket?.emit('git:reset:response', {
          type: 'git:reset:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git commit
    this.socket.on('git:commit', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      message: string
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git commit request: ${msg.message}`))
      }

      try {
        const result = await this.gitManager.commit(cwd, msg.message)
        this.socket?.emit('git:commit:response', {
          type: 'git:commit:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git commit error:'), err)
        this.socket?.emit('git:commit:response', {
          type: 'git:commit:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git pull
    this.socket.on('git:pull', async (msg: {
      requestId: string
      cwd?: string
      path?: string
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray('Git pull request'))
      }

      try {
        const result = await this.gitManager.pull(cwd)
        this.socket?.emit('git:pull:response', {
          type: 'git:pull:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git pull error:'), err)
        this.socket?.emit('git:pull:response', {
          type: 'git:pull:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git push
    this.socket.on('git:push', async (msg: {
      requestId: string
      cwd?: string
      path?: string
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray('Git push request'))
      }

      try {
        const result = await this.gitManager.push(cwd)
        this.socket?.emit('git:push:response', {
          type: 'git:push:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git push error:'), err)
        this.socket?.emit('git:push:response', {
          type: 'git:push:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git diff
    this.socket.on('git:diff', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      file?: string
      staged?: boolean
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git diff request: ${msg.file || 'all'}`))
      }

      try {
        const diff = await this.gitManager.diff(cwd, msg.file, msg.staged)
        this.socket?.emit('git:diff:response', {
          type: 'git:diff:response',
          requestId: msg.requestId,
          diff,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('Git diff error:'), err)
        this.socket?.emit('git:diff:response', {
          type: 'git:diff:response',
          requestId: msg.requestId,
          diff: null,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git log
    this.socket.on('git:log', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      limit?: number
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git log request: limit=${msg.limit || 20}`))
      }

      try {
        const logs = await this.gitManager.log(cwd, msg.limit)
        this.socket?.emit('git:log:response', {
          type: 'git:log:response',
          requestId: msg.requestId,
          logs,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('Git log error:'), err)
        this.socket?.emit('git:log:response', {
          type: 'git:log:response',
          requestId: msg.requestId,
          logs: [],
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git branches
    this.socket.on('git:branches', async (msg: {
      requestId: string
      cwd?: string
      path?: string
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray('Git branches request'))
      }

      try {
        const result = await this.gitManager.branches(cwd)
        this.socket?.emit('git:branches:response', {
          type: 'git:branches:response',
          requestId: msg.requestId,
          ...result,
          success: true,
        })
      } catch (err) {
        console.error(chalk.red('Git branches error:'), err)
        this.socket?.emit('git:branches:response', {
          type: 'git:branches:response',
          requestId: msg.requestId,
          current: '',
          branches: [],
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Git checkout (discard changes)
    this.socket.on('git:checkout', async (msg: {
      requestId: string
      cwd?: string
      path?: string
      files: string[]
    }) => {
      const cwd = this.resolveGitCwd(msg)
      if (this.config.debug) {
        console.log(chalk.gray(`Git checkout request: ${msg.files.join(', ')}`))
      }

      try {
        const result = await this.gitManager.checkout(cwd, msg.files)
        this.socket?.emit('git:checkout:response', {
          type: 'git:checkout:response',
          requestId: msg.requestId,
          ...result,
        })
      } catch (err) {
        console.error(chalk.red('Git checkout error:'), err)
        this.socket?.emit('git:checkout:response', {
          type: 'git:checkout:response',
          requestId: msg.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Setup auth deployment handlers
   */
  private setupAuthHandlers(): void {
    if (!this.socket) return

    // Deploy auth (write env file)
    this.socket.on('auth:deploy', async (msg: {
      provider: string
      envVarName: string
      envVarValue: string
    }) => {
      console.log(chalk.cyan(`Auth deploy request: ${msg.provider}`))

      try {
        const homeDir = os.homedir()
        const envDir = `${homeDir}/.cloudforge/env`
        const envFile = `${envDir}/${msg.provider}.env`
        const content = `export ${msg.envVarName}="${msg.envVarValue}"\n`

        // Create directory
        const fs = await import('fs/promises')
        await fs.mkdir(envDir, { recursive: true })

        // Write env file
        await fs.writeFile(envFile, content, { mode: 0o600 })

        // Add source line to shell profiles if not present
        const sourceLine = `[ -f "${envFile}" ] && source "${envFile}"`
        const profiles = ['.bashrc', '.zshrc', '.profile']
        for (const profile of profiles) {
          const profilePath = `${homeDir}/${profile}`
          try {
            const existing = await fs.readFile(profilePath, 'utf8')
            if (!existing.includes(envFile)) {
              await fs.appendFile(profilePath, `\n# CloudForge AI Auth (${msg.provider})\n${sourceLine}\n`)
            }
          } catch {
            // Profile doesn't exist, skip
          }
        }

        console.log(chalk.green(`Auth deployed: ${msg.provider} → ${envFile}`))
        this.socket?.emit('auth:deploy:response', {
          success: true,
          provider: msg.provider,
        })
      } catch (err) {
        console.error(chalk.red('Auth deploy error:'), err)
        this.socket?.emit('auth:deploy:response', {
          success: false,
          provider: msg.provider,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Check auth status
    this.socket.on('auth:status', async (msg: { providers: string[] }) => {
      const homeDir = os.homedir()
      const deployed: Record<string, boolean> = {}

      const fs = await import('fs/promises')
      for (const provider of msg.providers) {
        const envFile = `${homeDir}/.cloudforge/env/${provider}.env`
        try {
          await fs.access(envFile)
          deployed[provider] = true
        } catch {
          deployed[provider] = false
        }
      }

      this.socket?.emit('auth:status:response', {
        success: true,
        deployed,
      })
    })
  }

  /**
   * Send system info to server
   */
  private sendSystemInfo(): void {
    const systemInfo = getSystemInfo()

    this.socket?.emit('system:info', {
      type: 'system:info',
      os: systemInfo.os,
      hostname: systemInfo.hostname,
      version: VERSION,
      shell: systemInfo.shell,
      homeDir: systemInfo.homeDir,
    })
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return

      const systemInfo = getSystemInfo()

      this.socket?.emit('heartbeat', {
        type: 'heartbeat',
        timestamp: Date.now(),
        os: systemInfo.os,
        hostname: systemInfo.hostname,
        version: VERSION,
        uptime: process.uptime(),
      })

      if (this.config.debug) {
        console.log(chalk.gray('Heartbeat sent'))
      }
    }, this.config.heartbeatInterval)
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.stopHeartbeat()
    this.socket?.disconnect()
    this.socket = null
    this.isConnected = false
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected
  }
}
