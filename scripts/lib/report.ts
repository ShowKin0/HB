export type Level = 'error' | 'warn' | 'info'

export interface Issue {
  level: Level
  message: string
  file?: string
  line?: number
}

const MARK: Record<Level, string> = { error: '✗', warn: '!', info: '·' }

export class Reporter {
  private readonly issues: Issue[] = []

  add(level: Level, message: string, where: { file?: string; line?: number } = {}): void {
    this.issues.push({ level, message, ...where })
  }

  error(message: string, where?: { file?: string; line?: number }): void {
    this.add('error', message, where)
  }

  warn(message: string, where?: { file?: string; line?: number }): void {
    this.add('warn', message, where)
  }

  info(message: string, where?: { file?: string; line?: number }): void {
    this.add('info', message, where)
  }

  get counts(): { error: number; warn: number; info: number } {
    return {
      error: this.issues.filter((i) => i.level === 'error').length,
      warn: this.issues.filter((i) => i.level === 'warn').length,
      info: this.issues.filter((i) => i.level === 'info').length,
    }
  }

  /** 按文件分组打印，中文内容在 Windows 终端下也能正常显示。 */
  flush(title: string): number {
    const { error, warn, info } = this.counts
    const groups = new Map<string, Issue[]>()
    for (const issue of this.issues) {
      const key = issue.file ?? ''
      const bucket = groups.get(key)
      if (bucket) bucket.push(issue)
      else groups.set(key, [issue])
    }

    const lines: string[] = [`\n${title}`]
    for (const [file, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (file) lines.push(`  ${file}`)
      for (const issue of list) {
        const loc = issue.line ? `:${issue.line}` : ''
        lines.push(`    ${MARK[issue.level]}${loc} ${issue.message}`)
      }
    }
    lines.push(`  ${error} error, ${warn} warning, ${info} info\n`)
    process.stdout.write(lines.join('\n'))
    return error
  }
}
