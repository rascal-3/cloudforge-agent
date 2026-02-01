/**
 * CloudForge Agent Terminal Manager
 * Manages PTY terminal sessions with scrollback buffer and detach/reattach support
 */

import pty, { type IPty } from 'node-pty'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'
import type { AgentConfig } from './config.js'

const execAsync = promisify(exec)

/**
 * Ring buffer for terminal scrollback
 */
export class ScrollbackBuffer {
  private buffer: string[] = []
  private totalSize = 0
  private maxSize: number

  constructor(maxSize = 100 * 1024) { // 100KB default
    this.maxSize = maxSize
  }

  write(data: string): void {
    this.buffer.push(data)
    this.totalSize += data.length

    // Trim from front if over limit
    while (this.totalSize > this.maxSize && this.buffer.length > 1) {
      const removed = this.buffer.shift()!
      this.totalSize -= removed.length
    }
  }

  getContents(): string {
    return this.buffer.join('')
  }

  clear(): void {
    this.buffer = []
    this.totalSize = 0
  }
}

export type SessionState = 'attached' | 'detached'

export interface SessionInfo {
  sessionId: string
  state: SessionState
  shell: string
  cols: number
  rows: number
  createdAt: number
  detachedAt: number | null
}

export interface TerminalSession {
  pty: IPty
  sessionId: string
  state: SessionState
  scrollback: ScrollbackBuffer
  createdAt: number
  detachedAt: number | null
  shell: string
  cols: number
  rows: number
  idleTimeoutMs: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (exitCode: number) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  clearDataCallbacks: () => void
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private config: AgentConfig
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: AgentConfig) {
    this.config = config
    // Check for idle detached sessions every 60s
    this.idleCheckInterval = setInterval(() => this.cleanupIdleSessions(), 60_000)
  }

  /**
   * Spawn a new terminal session
   */
  spawn(sessionId: string, shell: string, cols: number, rows: number, cwd?: string, idleTimeoutMs?: number): TerminalSession {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`)
    }

    if (this.config.debug) {
      console.log(chalk.gray(`Spawning terminal: ${sessionId}, shell=${shell}, ${cols}x${rows}`))
    }

    // Spawn PTY process
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || this.config.homeDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    })

    // Event callbacks
    const dataCallbacks: ((data: string) => void)[] = []
    const exitCallbacks: ((exitCode: number) => void)[] = []
    const scrollback = new ScrollbackBuffer()

    // Handle data from PTY
    ptyProcess.onData((data) => {
      // Always write to scrollback regardless of attached state
      scrollback.write(data)
      for (const callback of dataCallbacks) {
        callback(data)
      }
    })

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      if (this.config.debug) {
        console.log(chalk.gray(`Terminal exited: ${sessionId}, code=${exitCode}`))
      }
      for (const callback of exitCallbacks) {
        callback(exitCode)
      }
    })

    // Create session object
    const session: TerminalSession = {
      pty: ptyProcess,
      sessionId,
      state: 'attached',
      scrollback,
      createdAt: Date.now(),
      detachedAt: null,
      shell,
      cols,
      rows,
      idleTimeoutMs: idleTimeoutMs || 0,
      onData: (callback) => {
        dataCallbacks.push(callback)
      },
      onExit: (callback) => {
        exitCallbacks.push(callback)
      },
      write: (data) => {
        ptyProcess.write(data)
      },
      resize: (cols, rows) => {
        if (this.config.debug) {
          console.log(chalk.gray(`Terminal resize: ${sessionId}, ${cols}x${rows}`))
        }
        session.cols = cols
        session.rows = rows
        ptyProcess.resize(cols, rows)
      },
      kill: () => {
        if (this.config.debug) {
          console.log(chalk.gray(`Terminal kill: ${sessionId}`))
        }
        ptyProcess.kill()
      },
      clearDataCallbacks: () => {
        dataCallbacks.length = 0
      },
    }

    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * Detach a session (keep PTY alive, stop forwarding output)
   */
  detach(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    if (this.config.debug) {
      console.log(chalk.gray(`Terminal detach: ${sessionId}`))
    }

    session.state = 'detached'
    session.detachedAt = Date.now()
    session.clearDataCallbacks()
    return true
  }

  /**
   * Reattach to a detached session. Returns scrollback contents.
   */
  reattach(sessionId: string): { scrollback: string } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    if (this.config.debug) {
      console.log(chalk.gray(`Terminal reattach: ${sessionId}`))
    }

    session.state = 'attached'
    session.detachedAt = null
    return { scrollback: session.scrollback.getContents() }
  }

  /**
   * List all sessions with their info
   */
  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = []
    for (const session of this.sessions.values()) {
      result.push({
        sessionId: session.sessionId,
        state: session.state,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
        detachedAt: session.detachedAt,
      })
    }
    return result
  }

  /**
   * Cleanup idle detached sessions
   */
  private cleanupIdleSessions(): void {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      if (
        session.state === 'detached' &&
        session.idleTimeoutMs > 0 &&
        session.detachedAt &&
        now - session.detachedAt > session.idleTimeoutMs
      ) {
        if (this.config.debug) {
          console.log(chalk.gray(`Idle timeout, killing: ${sessionId}`))
        }
        session.kill()
        this.sessions.delete(sessionId)
      }
    }
  }

  /**
   * Get a terminal session by ID
   */
  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Check if a session exists
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Remove a terminal session
   */
  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /**
   * Kill and remove a terminal session
   */
  kill(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.kill()
      this.sessions.delete(sessionId)
      return true
    }
    return false
  }

  /**
   * Kill all terminal sessions
   */
  killAll(): void {
    for (const [sessionId, session] of this.sessions) {
      if (this.config.debug) {
        console.log(chalk.gray(`Killing terminal: ${sessionId}`))
      }
      session.kill()
    }
    this.sessions.clear()
  }

  /**
   * Destroy the manager (cleanup interval)
   */
  destroy(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
      this.idleCheckInterval = null
    }
    this.killAll()
  }

  /**
   * Get the number of active sessions
   */
  get count(): number {
    return this.sessions.size
  }

  /**
   * Get all session IDs
   */
  get sessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  /**
   * Get the current working directory of a terminal session.
   * Uses /proc on Linux, lsof on macOS with child process tree traversal.
   */
  async getCwd(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const pid = session.pty.pid
    try {
      // Linux: read /proc/<pid>/cwd symlink (check child processes first)
      try {
        // Get the foreground child process (the actual shell, not pty wrapper)
        const childCwd = await this.getChildCwd(pid)
        if (childCwd && childCwd !== '/') return childCwd

        return fs.readlinkSync(`/proc/${pid}/cwd`)
      } catch {
        // Not Linux or /proc not available
      }

      // macOS: find the shell's child process and get its cwd
      try {
        // Get child processes of the pty process
        const { stdout: children } = await execAsync(
          `pgrep -P ${pid} 2>/dev/null || echo ${pid}`,
          { encoding: 'utf8', timeout: 3000 }
        )
        const childPids = children.trim().split('\n').filter(Boolean)
        // Use the last child (deepest in process tree)
        const targetPid = childPids[childPids.length - 1] || String(pid)

        const { stdout } = await execAsync(
          `lsof -a -d cwd -p ${targetPid} -Fn 2>/dev/null`,
          { encoding: 'utf8', timeout: 3000 }
        )
        // Parse: lines starting with 'n' after 'fcwd' line contain the path
        const lines = stdout.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === 'fcwd' && i + 1 < lines.length && lines[i + 1].startsWith('n')) {
            const cwd = lines[i + 1].substring(1)
            if (cwd && cwd !== '/') return cwd
          }
        }
      } catch {
        // lsof not available or failed
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get cwd from a child process (Linux /proc)
   */
  private async getChildCwd(parentPid: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `pgrep -P ${parentPid} 2>/dev/null`,
        { encoding: 'utf8', timeout: 2000 }
      )
      const childPids = stdout.trim().split('\n').filter(Boolean)
      if (childPids.length > 0) {
        const lastChild = childPids[childPids.length - 1]
        return fs.readlinkSync(`/proc/${lastChild}/cwd`)
      }
    } catch {
      // No children or /proc not available
    }
    return null
  }
}
