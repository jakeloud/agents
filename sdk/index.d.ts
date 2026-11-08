export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Harness = 'codex' | 'pi' | 'opencode'
export type Status = 'running' | 'completed' | 'failed' | 'interrupted'
export type Content = { type: 'text', text: string } | { type: 'image', mimeType: string, data: string } | { type: 'json', value: Json }
export type TokenUsage = {
    inputTokens: number | null
    outputTokens: number | null
    cachedInputTokens: number | null
    cacheWriteInputTokens: number | null
    reasoningOutputTokens: number | null
}
export type ToolEvent = {
    type: 'tool'
    id: string
    name: string
    status: 'running' | 'completed' | 'failed'
    input: Json
    output: Content[]
    exitCode: number | null
    error: string | null
}
export type AgentEvent =
    | { type: 'message', text: string }
    | { type: 'reasoning', text: string }
    | ToolEvent
    | { type: 'plan', steps: { text: string, completed: boolean }[] }
    | ({ type: 'usage' } & TokenUsage)
    | { type: 'error', message: string }
    | { type: 'status', status: Status }
export type Turn = {
    message: string
    model: string | null
    effort: string | null
    status: Status
    text: string
    events: AgentEvent[]
    usage: TokenUsage
    error?: string
}
export type Environment = {
    id: string
    harness: Harness
    auth: string
    image: string
    status: 'creating' | 'ready' | 'running' | 'failed' | 'deleting' | 'interrupted'
    thread: { id: string | null, turns: Turn[] }
    error?: string
}
export type EnvironmentSummary = Omit<Environment, 'thread'> & { threadId: string | null }
export type ContainerState = {
    status: string, running: boolean, exitCode: number, error: string | null,
    startedAt: string | null, finishedAt: string | null
}
export type EnvironmentState = Environment & { container: ContainerState }
export type EnvironmentHandle = {
    id: string
    get(): Promise<EnvironmentState>
    send(message: string, options?: { model?: string }): Promise<Turn>
    delete(): Promise<void>
}
export class Agents {
    constructor(url?: string)
    create(options?: { harness?: Harness, auth?: string, image?: string }): Promise<EnvironmentHandle>
    environment(id: string): EnvironmentHandle
    list(): Promise<EnvironmentSummary[]>
    private request
}
