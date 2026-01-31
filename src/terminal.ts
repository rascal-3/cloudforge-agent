/**
 * CloudForge Agent Terminal Manager
 * Manages PTY terminal sessions
 */

import pty, { type IPty } from 'node-pty'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'
import type { AgentConfig } from './config.js'

const execAsync = promisify(exec)

export interface TerminalSession {
  pty: IPty
  sessionId: string
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (exitCode: number) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private config: AgentConfig

  constructor(config: AgentConfig) {
    this.config = config
  }

  /**
   * Spawn a new terminal session
   */
  spawn(sessionId: string, shell: string, cols: number, rows: number, cwd?: string): TerminalSession {
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

    // Handle data from PTY
    ptyProcess.onData((data) => {
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
        ptyProcess.resize(cols, rows)
      },
      kill: () => {
        if (this.config.debug) {
          console.log(chalk.gray(`Terminal kill: ${sessionId}`))
        }
        ptyProcess.kill()
      },
    }

    this.sessions.set(sessionId, session)
    return session
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
