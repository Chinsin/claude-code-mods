export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'blocked'

export type Step = {
  id: string
  title: string
  detail?: string
  /** The model's note on the step's outcome (why it is blocked, what it found). */
  note?: string
  status: StepStatus
  children: Step[]
  /** When the status last changed, so a step just finished animates once. */
  changedAt?: number
}

export type Plan = {
  goal: string
  steps: Step[]
  updatedAt: number
  /** When this plan's work began: its first publish, kept across revisions. */
  startedAt?: number
  /** When every step settled (done or skipped); cleared if one reopens. */
  finishedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-flow': {
      plan: Plan | null
      /** The guide has ridden a prompt of this conversation already. */
      guided: boolean
      /** Steps quoted where the prompt box could not take the quote; the next prompt carries them. */
      quoted: string[]
    }
  }
}
