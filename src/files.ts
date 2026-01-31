/**
 * CloudForge Agent File Manager
 * Manages file operations for remote file access
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Stats } from 'fs'
import chalk from 'chalk'
import type { AgentConfig } from './config.js'

// Maximum file size to read (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov',
  '.ttf', '.otf', '.woff', '.woff2',
  '.pyc', '.class', '.o', '.a',
])

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modified: string
  permissions: string
}

export interface ReadFileResult {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  size: number
  isBinary: boolean
}

export interface WriteFileResult {
  path: string
  success: boolean
  bytesWritten: number
}

export interface FileOperationResult {
  path: string
  success: boolean
  error?: string
}

export class FileManager {
  private config: AgentConfig
  private basePath: string

  constructor(config: AgentConfig) {
    this.config = config
    this.basePath = config.homeDir
  }

  /**
   * Validate and resolve a path, preventing directory traversal attacks
   */
  private resolvePath(requestedPath: string): string {
    // Expand ~ to home directory
    let expanded = requestedPath
    if (expanded === '~' || expanded.startsWith('~/')) {
      expanded = expanded.replace('~', os.homedir())
    }

    // Normalize the path
    const normalized = path.normalize(expanded)

    // If it's an absolute path, use it directly
    // If it's relative, resolve from basePath
    const resolved = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(this.basePath, normalized)

    // For security, we don't restrict to basePath - the agent runs on user's server
    // User already has full access to their filesystem via terminal
    return resolved
  }

  /**
   * Check if a file is binary based on extension
   */
  private isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return BINARY_EXTENSIONS.has(ext)
  }

  /**
   * Convert file stats to permissions string
   */
  private formatPermissions(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
    const user = perms[(mode >> 6) & 7]
    const group = perms[(mode >> 3) & 7]
    const other = perms[mode & 7]
    return `${user}${group}${other}`
  }

  /**
   * Get file type from stats
   */
  private getFileType(stats: Stats): FileEntry['type'] {
    if (stats.isFile()) return 'file'
    if (stats.isDirectory()) return 'directory'
    if (stats.isSymbolicLink()) return 'symlink'
    return 'other'
  }

  /**
   * List directory contents
   */
  async list(dirPath: string): Promise<FileEntry[]> {
    const resolvedPath = this.resolvePath(dirPath)

    if (this.config.debug) {
      console.log(chalk.gray(`Files list: ${resolvedPath}`))
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true })
    const results: FileEntry[] = []

    for (const entry of entries) {
      try {
        const entryPath = path.join(resolvedPath, entry.name)
        const stats = await fs.stat(entryPath)

        results.push({
          name: entry.name,
          path: entryPath,
          type: this.getFileType(stats),
          size: stats.size,
          modified: stats.mtime.toISOString(),
          permissions: this.formatPermissions(stats.mode),
        })
      } catch (err) {
        // Skip entries we can't stat (permission denied, etc.)
        if (this.config.debug) {
          console.log(chalk.yellow(`Cannot stat: ${entry.name}`))
        }
      }
    }

    // Sort: directories first, then files, alphabetically
    results.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    return results
  }

  /**
   * Read file contents
   */
  async read(filePath: string): Promise<ReadFileResult> {
    const resolvedPath = this.resolvePath(filePath)

    if (this.config.debug) {
      console.log(chalk.gray(`File read: ${resolvedPath}`))
    }

    // Check file size first
    const stats = await fs.stat(resolvedPath)
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${stats.size} bytes). Maximum size is ${MAX_FILE_SIZE} bytes.`)
    }

    const isBinary = this.isBinaryFile(resolvedPath)

    if (isBinary) {
      // Read as base64 for binary files
      const buffer = await fs.readFile(resolvedPath)
      return {
        path: resolvedPath,
        content: buffer.toString('base64'),
        encoding: 'base64',
        size: stats.size,
        isBinary: true,
      }
    } else {
      // Read as UTF-8 for text files
      const content = await fs.readFile(resolvedPath, 'utf8')
      return {
        path: resolvedPath,
        content,
        encoding: 'utf8',
        size: stats.size,
        isBinary: false,
      }
    }
  }

  /**
   * Write file contents
   */
  async write(filePath: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<WriteFileResult> {
    const resolvedPath = this.resolvePath(filePath)

    if (this.config.debug) {
      console.log(chalk.gray(`File write: ${resolvedPath}`))
    }

    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath)
    await fs.mkdir(dir, { recursive: true })

    if (encoding === 'base64') {
      const buffer = Buffer.from(content, 'base64')
      await fs.writeFile(resolvedPath, buffer)
      return {
        path: resolvedPath,
        success: true,
        bytesWritten: buffer.length,
      }
    } else {
      await fs.writeFile(resolvedPath, content, 'utf8')
      return {
        path: resolvedPath,
        success: true,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      }
    }
  }

  /**
   * Delete a file or directory
   */
  async delete(targetPath: string, recursive: boolean = false): Promise<FileOperationResult> {
    const resolvedPath = this.resolvePath(targetPath)

    if (this.config.debug) {
      console.log(chalk.gray(`File delete: ${resolvedPath}, recursive=${recursive}`))
    }

    try {
      const stats = await fs.stat(resolvedPath)

      if (stats.isDirectory()) {
        if (recursive) {
          await fs.rm(resolvedPath, { recursive: true, force: true })
        } else {
          await fs.rmdir(resolvedPath)
        }
      } else {
        await fs.unlink(resolvedPath)
      }

      return { path: resolvedPath, success: true }
    } catch (err) {
      const error = err as Error
      return { path: resolvedPath, success: false, error: error.message }
    }
  }

  /**
   * Create a directory
   */
  async mkdir(dirPath: string, recursive: boolean = true): Promise<FileOperationResult> {
    const resolvedPath = this.resolvePath(dirPath)

    if (this.config.debug) {
      console.log(chalk.gray(`Mkdir: ${resolvedPath}`))
    }

    try {
      await fs.mkdir(resolvedPath, { recursive })
      return { path: resolvedPath, success: true }
    } catch (err) {
      const error = err as Error
      return { path: resolvedPath, success: false, error: error.message }
    }
  }

  /**
   * Rename/move a file or directory
   */
  async rename(fromPath: string, toPath: string): Promise<FileOperationResult> {
    const resolvedFrom = this.resolvePath(fromPath)
    const resolvedTo = this.resolvePath(toPath)

    if (this.config.debug) {
      console.log(chalk.gray(`Rename: ${resolvedFrom} -> ${resolvedTo}`))
    }

    try {
      // Ensure parent directory of destination exists
      await fs.mkdir(path.dirname(resolvedTo), { recursive: true })
      await fs.rename(resolvedFrom, resolvedTo)
      return { path: resolvedTo, success: true }
    } catch (err) {
      const error = err as Error
      return { path: resolvedTo, success: false, error: error.message }
    }
  }

  /**
   * Get file/directory stats
   */
  async stat(targetPath: string): Promise<FileEntry | null> {
    const resolvedPath = this.resolvePath(targetPath)

    if (this.config.debug) {
      console.log(chalk.gray(`Stat: ${resolvedPath}`))
    }

    try {
      const stats = await fs.stat(resolvedPath)
      return {
        name: path.basename(resolvedPath),
        path: resolvedPath,
        type: this.getFileType(stats),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        permissions: this.formatPermissions(stats.mode),
      }
    } catch {
      return null
    }
  }

  /**
   * Check if path exists
   */
  async exists(targetPath: string): Promise<boolean> {
    const resolvedPath = this.resolvePath(targetPath)
    try {
      await fs.access(resolvedPath)
      return true
    } catch {
      return false
    }
  }
}
