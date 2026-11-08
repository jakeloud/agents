import { t } from 'elysia'
import type { AgentEvent, Content, Json, Status, TokenUsage, ToolEvent } from '../sdk/index'

const count = (description: string) => t.Nullable(t.Integer({ minimum: 0 }), { description })
const usageFields = {
    inputTokens: count('Total input tokens, including cached reads and writes. Null when not reported.'),
    outputTokens: count('Total generated tokens, including reasoning. Null when not reported.'),
    cachedInputTokens: count('Input tokens read from cache. Null when not reported.'),
    cacheWriteInputTokens: count('Input tokens written to cache. Null when not reported.'),
    reasoningOutputTokens: count('Reasoning tokens, included in outputTokens. Null when not reported.')
}
const status = t.Union(['running', 'completed', 'failed', 'interrupted'].map(value => t.Literal(value)))
const content = t.Union([
    t.Object({ type: t.Literal('text'), text: t.String({ description: 'Text output.' }) }, { additionalProperties: false }),
    t.Object({ type: t.Literal('image'), mimeType: t.String({ description: 'Image MIME type.' }), data: t.String({ description: 'Base64 image bytes.' }) }, { additionalProperties: false }),
    t.Object({ type: t.Literal('json'), value: t.Ref('JsonValue', { description: 'Structured tool result.' }) }, { additionalProperties: false })
])
const variants = {
    MessageEvent: t.Object({ type: t.Literal('message'), text: t.String({ description: 'Completed assistant message.' }) }, { additionalProperties: false }),
    ReasoningEvent: t.Object({ type: t.Literal('reasoning'), text: t.String({ description: 'Reasoning summary provided during the turn.' }) }, { additionalProperties: false }),
    ToolEvent: t.Object({
        type: t.Literal('tool'),
        id: t.String({ description: 'Tool call identifier. Later snapshots with this ID replace earlier ones within this turn.' }),
        name: t.String({ description: 'Tool name, such as shell, read_file, write_file, edit_file, edit_files, search_files, find_files, list_files or search_web. Integrations may define other tool names.' }),
        status: t.Union([t.Literal('running'), t.Literal('completed'), t.Literal('failed')], { description: 'Current tool execution status.' }),
        input: t.Ref('JsonValue', { description: 'Tool arguments as JSON. Shell calls use {command}; file operations use paths and file contents; integrations define their own arguments.' }),
        output: t.Array(content, { description: 'Latest complete tool output snapshot. Replace the previous output; do not append snapshots.' }),
        exitCode: t.Nullable(t.Integer(), { description: 'Process exit code when known; otherwise null.' }),
        error: t.Nullable(t.String(), { description: 'Tool failure detail, or null.' })
    }, { additionalProperties: false }),
    PlanEvent: t.Object({ type: t.Literal('plan'), steps: t.Array(t.Object({ text: t.String({ description: 'Planned action.' }), completed: t.Boolean({ description: 'Whether the action is complete.' }) }, { additionalProperties: false }), { description: 'Current plan. Replaces the previous plan.' }) }, { additionalProperties: false }),
    UsageEvent: t.Object({ type: t.Literal('usage'), ...usageFields }, { additionalProperties: false, description: 'Running token totals for this API turn. Replace previous totals; do not sum usage events.' }),
    ErrorEvent: t.Object({ type: t.Literal('error'), message: t.String({ description: 'Error detail. The final status event determines whether the turn ultimately failed.' }) }, { additionalProperties: false }),
    StatusEvent: t.Object({ type: t.Literal('status'), status: { ...status, description: 'API turn lifecycle state.' } }, { additionalProperties: false })
}
export const eventModels = {
    JsonValue: t.Unsafe<Json>(t.Union([t.Null(), t.Boolean(), t.Number(), t.String(), t.Array(t.Ref('JsonValue')), t.Record(t.String(), t.Ref('JsonValue'))], { description: 'A JSON value: null, boolean, number, string, an array of JSON values, or an object of JSON values.' })),
    ...variants,
    Event: t.Union(Object.keys(variants).map(name => t.Ref(name)), { description: 'SDK event. The type field selects the documented shape.', discriminator: { propertyName: 'type' } }),
    TokenUsage: t.Object(usageFields, { additionalProperties: false, description: 'Token totals for one API turn. Null means a counter is unavailable, not zero.' })
}

const text = (blocks: any[]) => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
const contentOf = (blocks: any[] = []): Content[] => blocks.flatMap((block): Content[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') return [{ type: 'image', mimeType: block.mimeType ?? block.mime_type, data: block.data }]
    if (block.type === 'resource' && typeof block.resource?.text === 'string') return [{ type: 'text', text: block.resource.text }]
    return []
})
const toolNames: Record<string, string> = { bash: 'shell', read: 'read_file', write: 'write_file', edit: 'edit_file', grep: 'search_files', find: 'find_files', ls: 'list_files' }

export class Run {
    events: AgentEvent[] = [{ type: 'status', status: 'running' }]
    usage: TokenUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }
    sessionId?: string
    text = ''
    error?: string
    completed = false
    tools = new Map<string, ToolEvent>()

    constructor(readonly harness: 'codex' | 'pi') {}

    tokens(values: TokenUsage) {
        for (const key of Object.keys(values) as (keyof TokenUsage)[]) {
            if (values[key] !== null) this.usage[key] = (this.usage[key] ?? 0) + values[key]!
        }
        this.events.push({ type: 'usage', ...this.usage })
    }

    tool(id: string, name: string, status: ToolEvent['status'], input: Json, output: Content[], exitCode: number | null = null, error: string | null = null) {
        const tool: ToolEvent = { type: 'tool', id, name, status, input, output, exitCode, error }
        this.tools.set(id, tool)
        this.events.push(tool)
    }

    accept(event: any) {
        if (!event || typeof event.type !== 'string') return
        if (this.harness === 'pi') this.pi(event)
        else this.codex(event)
    }

    codex(event: any) {
        if (event.type === 'thread.started') this.sessionId = event.thread_id
        if (event.type === 'turn.failed' || event.type === 'error') this.error = event.error?.message ?? event.message ?? 'Execution failed'
        if (event.type === 'turn.completed') {
            this.completed = true
            const u = event.usage ?? {}
            this.tokens({ inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, cachedInputTokens: u.cached_input_tokens ?? null, cacheWriteInputTokens: u.cache_write_input_tokens ?? null, reasoningOutputTokens: u.reasoning_output_tokens ?? null })
        }
        const item = event.item
        if (!item || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) return
        const done = event.type === 'item.completed'
        const status = done ? item.status === 'failed' ? 'failed' : 'completed' : 'running'
        if (done && item.type === 'agent_message') {
            this.text = item.text
            this.events.push({ type: 'message', text: item.text })
        }
        if (done && item.type === 'reasoning') this.events.push({ type: 'reasoning', text: item.text })
        if (item.type === 'todo_list') this.events.push({ type: 'plan', steps: item.items.map((step: any) => ({ text: step.text, completed: step.completed })) })
        if (item.type === 'error') this.events.push({ type: 'error', message: item.message })
        if (item.type === 'command_execution') {
            this.tool(item.id, 'shell', status, { command: item.command }, [{ type: 'text', text: item.aggregated_output ?? '' }], item.exit_code ?? null,
                status === 'failed' ? 'Command failed' : null)
        }
        if (item.type === 'file_change') {
            const operations: Record<string, string> = { add: 'create', update: 'update', delete: 'delete' }
            const changes = item.changes.map((change: any) => ({ path: change.path, operation: operations[change.kind] ?? 'update' }))
            this.tool(item.id, 'edit_files', status, { changes }, [], null, status === 'failed' ? 'File update failed' : null)
        }
        if (item.type === 'web_search') this.tool(item.id, 'search_web', status, { query: item.query }, [])
        if (item.type === 'mcp_tool_call') {
            const output = contentOf(item.result?.content)
            if (item.result?.structured_content != null) output.push({ type: 'json', value: item.result.structured_content })
            this.tool(item.id, `${item.server}.${item.tool}`, status, item.arguments ?? null, output, null, item.error?.message ?? null)
        }
    }

    pi(event: any) {
        if (event.type === 'session') this.sessionId = event.id
        if (event.type === 'message_end' && event.message.role === 'assistant') {
            const message = event.message
            this.text = text(message.content)
            if (this.text) this.events.push({ type: 'message', text: this.text })
            for (const block of message.content) {
                if (block.type === 'thinking' && block.thinking) this.events.push({ type: 'reasoning', text: block.thinking })
            }
            this.error = ['error', 'aborted', 'length'].includes(message.stopReason) ? message.errorMessage || `Response stopped: ${message.stopReason}` : undefined
            const u = message.usage
            if (u) this.tokens({ inputTokens: typeof u.input === 'number' ? u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : null, outputTokens: u.output ?? null, cachedInputTokens: u.cacheRead ?? null, cacheWriteInputTokens: u.cacheWrite ?? null, reasoningOutputTokens: null })
        }
        if (event.type.startsWith('tool_execution_')) {
            const previous = this.tools.get(event.toolCallId)
            const result = event.result ?? event.partialResult
            const output = result ? contentOf(result.content) : previous?.output ?? []
            const failed = event.isError === true
            this.tool(event.toolCallId, toolNames[event.toolName] ?? event.toolName ?? previous?.name ?? 'tool',
                event.type === 'tool_execution_end' ? failed ? 'failed' : 'completed' : 'running',
                event.args ?? previous?.input ?? {}, output, result?.details?.exitCode ?? null, failed ? text(output) || 'Tool failed' : null)
        }
        if (event.type === 'auto_retry_end' && !event.success) this.error = event.finalError || 'Retries exhausted'
        if (event.type === 'agent_settled') {
            this.completed = true
            if (event.aborted) this.error = 'Execution aborted'
        }
    }

    finish(status: Status, error?: string) {
        if (error) this.events.push({ type: 'error', message: error })
        if (status !== 'running') this.events.push({ type: 'status', status })
    }
}
