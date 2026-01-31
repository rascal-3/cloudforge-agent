/**
 * CloudForge Agent Git Manager
 * Manages Git operations via CLI
 */

import { exec, execSync } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'
import type { AgentConfig } from './config.js'

const execAsync = promisify(exec)

export interface GitStatus {
  branch: string
  isRepo: boolean
  modified: string[]
  staged: string[]
  untracked: string[]
  ahead: number
  behind: number
}

export interface GitLog {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

export interface GitDiff {
  file?: string
  diff: string
}

export interface GitResult {
  success: boolean
  message?: string
  error?: string
}

export interface GitCommitResult extends GitResult {
  hash?: string
}

export class GitManager {
  private config: AgentConfig

  constructor(config: AgentConfig) {
    this.config = config
  }

  /**
   * Check if git is available
   */
  private async isGitAvailable(): Promise<boolean> {
    try {
      await execAsync('git --version')
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if path is inside a git repository
   */
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd })
      return true
    } catch {
      return false
    }
  }

  /**
   * Get git status
   */
  async status(cwd: string): Promise<GitStatus> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git status: ${cwd}`))
    }

    const isRepo = await this.isGitRepo(cwd)
    if (!isRepo) {
      return {
        branch: '',
        isRepo: false,
        modified: [],
        staged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
      }
    }

    try {
      // Get branch name
      const { stdout: branchOut } = await execAsync(
        'git branch --show-current',
        { cwd }
      )
      const branch = branchOut.trim()

      // Get status with porcelain format
      const { stdout: statusOut } = await execAsync(
        'git status --porcelain -u',
        { cwd }
      )

      const modified: string[] = []
      const staged: string[] = []
      const untracked: string[] = []

      statusOut.split('\n').filter(Boolean).forEach(line => {
        const indexStatus = line[0]
        const workingStatus = line[1]
        const file = line.slice(3)

        // Staged changes (index status)
        if (indexStatus !== ' ' && indexStatus !== '?') {
          staged.push(file)
        }

        // Modified in working tree
        if (workingStatus === 'M' || workingStatus === 'D') {
          modified.push(file)
        }

        // Untracked files
        if (indexStatus === '?' && workingStatus === '?') {
          untracked.push(file)
        }
      })

      // Get ahead/behind count
      let ahead = 0
      let behind = 0
      try {
        const { stdout: trackingOut } = await execAsync(
          'git rev-list --left-right --count HEAD...@{upstream}',
          { cwd }
        )
        const [aheadStr, behindStr] = trackingOut.trim().split('\t')
        ahead = parseInt(aheadStr, 10) || 0
        behind = parseInt(behindStr, 10) || 0
      } catch {
        // No upstream tracking, ignore
      }

      return {
        branch,
        isRepo: true,
        modified,
        staged,
        untracked,
        ahead,
        behind,
      }
    } catch (err) {
      console.error(chalk.red('Git status error:'), err)
      throw err
    }
  }

  /**
   * Stage files
   */
  async add(cwd: string, files: string[]): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git add: ${files.join(', ')}`))
    }

    try {
      const fileArgs = files.map(f => `"${f}"`).join(' ')
      await execAsync(`git add ${fileArgs}`, { cwd })
      return { success: true, message: `Staged ${files.length} file(s)` }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Unstage files
   */
  async reset(cwd: string, files: string[]): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git reset: ${files.join(', ')}`))
    }

    try {
      const fileArgs = files.map(f => `"${f}"`).join(' ')
      await execAsync(`git reset HEAD ${fileArgs}`, { cwd })
      return { success: true, message: `Unstaged ${files.length} file(s)` }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Commit staged changes
   */
  async commit(cwd: string, message: string): Promise<GitCommitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git commit: ${message}`))
    }

    try {
      // Use -m with properly escaped message
      const escapedMessage = message.replace(/"/g, '\\"')
      await execAsync(`git commit -m "${escapedMessage}"`, { cwd })

      // Get the commit hash
      const { stdout: hashOut } = await execAsync(
        'git rev-parse --short HEAD',
        { cwd }
      )
      const hash = hashOut.trim()

      return { success: true, hash, message: `Committed: ${hash}` }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Pull from remote
   */
  async pull(cwd: string): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray('Git pull'))
    }

    try {
      const { stdout } = await execAsync('git pull', { cwd })
      return { success: true, message: stdout.trim() || 'Already up to date' }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Push to remote
   */
  async push(cwd: string): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray('Git push'))
    }

    try {
      const { stdout } = await execAsync('git push', { cwd })
      return { success: true, message: stdout.trim() || 'Push successful' }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Get diff
   */
  async diff(cwd: string, file?: string, staged: boolean = false): Promise<GitDiff> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git diff: ${file || 'all'}, staged=${staged}`))
    }

    try {
      const stagedFlag = staged ? '--cached' : ''
      const fileArg = file ? `"${file}"` : ''
      const { stdout } = await execAsync(
        `git diff ${stagedFlag} ${fileArg}`.trim(),
        { cwd, maxBuffer: 5 * 1024 * 1024 } // 5MB buffer for large diffs
      )
      return { file, diff: stdout }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      throw new Error(error.stderr || error.message)
    }
  }

  /**
   * Get commit log
   */
  async log(cwd: string, limit: number = 20): Promise<GitLog[]> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git log: limit=${limit}`))
    }

    try {
      // Use a custom format for easy parsing
      const format = '%H|%h|%an|%aI|%s'
      const { stdout } = await execAsync(
        `git log -n ${limit} --format="${format}"`,
        { cwd }
      )

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, author, date, message] = line.split('|')
        return { hash, shortHash, author, date, message }
      })
    } catch (err) {
      const error = err as Error & { stderr?: string }
      throw new Error(error.stderr || error.message)
    }
  }

  /**
   * Discard changes in working directory
   */
  async checkout(cwd: string, files: string[]): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git checkout: ${files.join(', ')}`))
    }

    try {
      const fileArgs = files.map(f => `"${f}"`).join(' ')
      await execAsync(`git checkout -- ${fileArgs}`, { cwd })
      return { success: true, message: `Discarded changes in ${files.length} file(s)` }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Get list of branches
   */
  async branches(cwd: string): Promise<{ current: string; branches: string[] }> {
    if (this.config.debug) {
      console.log(chalk.gray('Git branches'))
    }

    try {
      const { stdout } = await execAsync('git branch', { cwd })
      const lines = stdout.trim().split('\n').filter(Boolean)

      let current = ''
      const branches: string[] = []

      lines.forEach(line => {
        const isCurrent = line.startsWith('*')
        const name = line.replace(/^\*?\s+/, '').trim()
        branches.push(name)
        if (isCurrent) {
          current = name
        }
      })

      return { current, branches }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      throw new Error(error.stderr || error.message)
    }
  }

  /**
   * Switch branch
   */
  async switchBranch(cwd: string, branch: string): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git switch: ${branch}`))
    }

    try {
      await execAsync(`git checkout "${branch}"`, { cwd })
      return { success: true, message: `Switched to branch '${branch}'` }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }

  /**
   * Create new branch
   */
  async createBranch(cwd: string, branch: string, checkout: boolean = true): Promise<GitResult> {
    if (this.config.debug) {
      console.log(chalk.gray(`Git create branch: ${branch}`))
    }

    try {
      if (checkout) {
        await execAsync(`git checkout -b "${branch}"`, { cwd })
        return { success: true, message: `Created and switched to branch '${branch}'` }
      } else {
        await execAsync(`git branch "${branch}"`, { cwd })
        return { success: true, message: `Created branch '${branch}'` }
      }
    } catch (err) {
      const error = err as Error & { stderr?: string }
      return { success: false, error: error.stderr || error.message }
    }
  }
}
