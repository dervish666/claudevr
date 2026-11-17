// What the mod keeps in $.state, so a hot reload of the hooks module keeps
// the session's picture and the ids it has already submitted.

export type ClaudevrAsking = { text: string; options: string[] }

// One tool call of the main loop in flight. `permission` is set while the
// person is being asked to allow it.
export type ClaudevrCall = { id: string; action: string; asking: ClaudevrAsking | null; permission: boolean }

export type ClaudevrMessage = { role: 'you' | 'session'; text: string; at: number }

export type ClaudevrAgent = {
  id: string
  type: string
  description: string
  model: string | null
  state: 'running' | 'done' | 'failed'
  startedAt: number | null
  endedAt: number | null
  now: string | null
}

export type ClaudevrLive = {
  busy: boolean
  failed: boolean
  calls: ClaudevrCall[]
  lastLine: string | null
  activeAt: number
  messages: ClaudevrMessage[]
  agents: ClaudevrAgent[]
}

declare module 'claude-code' {
  interface PluginState {
    claudevr: {
      live: Shaped<ClaudevrLive>
      sent: Shaped<string[]>
    }
  }
}
