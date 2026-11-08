import { t } from 'elysia'
import { openapi } from '@elysia/openapi'
import { eventModels } from './events'

const id = t.String({ description: 'Environment container name returned by create or list.', examples: ['agent-123e4567-e89b-42d3-a456-426614174000'] })
const threadId = t.Nullable(t.String(), { description: 'Thread identifier. Null until the first message starts the conversation.' })
const harness = t.Union([t.Literal('codex'), t.Literal('pi'), t.Literal('opencode')], { description: 'Agent CLI to run. OpenCode uses the file-based v1.19.5 CLI.' })
const auth = t.String({ minLength: 1, description: '"default" prefers the harness’s own credentials, then compatible sources in codex, pi, opencode order. OpenCode reads active v2 SQLite credentials or legacy auth.json; OPENCODE_DB overrides the database path. Missing, invalid and incompatible sources are skipped. An explicit profile name pins the source without fallback. Profiles and native paths are defined in src/auth.ts. Responses report the selected source; errors identify checked paths and failures without credentials.', examples: ['default', 'codex', 'pi', 'opencode'] })
const image = t.String({ minLength: 1, description: 'Docker base image. Custom images need Linux, Node/npm, sleep, shell utilities and CA certificates.', examples: ['node:24-bookworm-slim'] })
const message = t.String({ minLength: 1, description: 'User message sent to the environment’s conversation.', examples: ['Write a small Fibonacci program and run it.'] })
const model = t.String({ minLength: 1, description: 'Optional model override for this message. Omit to use the harness’s native configuration and session defaults, including configured effort. Changing the model keeps the same conversation.', examples: ['gpt-6-luna'] })
const params = t.Object({ id })

const turn = t.Object({
    message,
    model: t.Nullable(t.String(), { description: 'Actual model selected for this turn. Null until reported by the harness or its session.' }),
    effort: t.Nullable(t.String(), { description: 'Selected reasoning effort or variant reported by the session. Null when unavailable.' }),
    status: t.String({ enum: ['running', 'completed', 'failed', 'interrupted'], description: 'running: harness executing; completed: successful terminal event and process exit; failed: invocation or model failure; interrupted: server stopped during execution.' }),
    text: t.String({ description: 'Latest completed assistant message as plain text. Empty before a message completes.' }),
    events: t.Array(t.Ref('Event'), { description: 'SDK events in arrival order. Switch on type to read the corresponding documented fields. Tool snapshots replace earlier snapshots with the same id; usage and plan events replace previous totals and plans. Poll get to see progress.' }),
    usage: { ...eventModels.TokenUsage, description: 'Token totals for this turn, including all its model requests. Unavailable counters are null.' },
    error: t.Optional(t.String({ description: 'Failure or interruption detail. Absent on successful turns.' }))
}, {
    additionalProperties: false,
    description: 'One user message and the work performed in response. Send returns a completed turn; get also exposes running and failed turns.',
    examples: [{ message: 'Say hello.', model: 'gpt-6-luna', effort: null, status: 'completed', text: 'Hello!', usage: { inputTokens: 100, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: null, reasoningOutputTokens: null }, events: [{ type: 'status', status: 'running' }, { type: 'message', text: 'Hello!' }, { type: 'status', status: 'completed' }] }]
})

const environmentFields = {
    id,
    harness,
    auth,
    image,
    status: t.String({ enum: ['creating', 'ready', 'running', 'failed', 'deleting', 'interrupted'], description: 'creating: provisioning; ready: accepts messages; running: processing a message; failed: provisioning failed and cleanup needs retry; deleting: removal in progress; interrupted: server stopped during work, delete and recreate.' }),
    error: t.Optional(t.String({ description: 'Environment provisioning or interruption detail. Message failures are recorded on the corresponding turn instead.' }))
}
const environment = t.Object({
    ...environmentFields,
    thread: t.Object({
        id: threadId,
        turns: t.Array(turn, { description: 'Messages submitted through this API, in chronological order, including their responses and events.' })
    }, { additionalProperties: false, description: 'One persistent conversation per environment.' })
}, { description: 'Environment metadata and complete API-managed thread history.' })

const container = t.Object({
    status: t.String({ description: 'Container runtime state: created, running, paused, restarting, removing, exited or dead.' }),
    running: t.Boolean({ description: 'Whether the container process is running.' }),
    exitCode: t.Integer({ description: 'Exit code of the container’s main process.' }),
    error: t.Nullable(t.String(), { description: 'Container runtime failure, or null.' }),
    startedAt: t.Nullable(t.String(), { description: 'Container start timestamp in RFC 3339 format, or null if it has not started.' }),
    finishedAt: t.Nullable(t.String(), { description: 'Container stop timestamp in RFC 3339 format, or null if it has not stopped.' })
}, { additionalProperties: false, description: 'Current container runtime state.' })

const createBody = t.Object({
    harness: t.Optional({ ...harness, default: 'codex' }),
    auth: t.Optional({ ...auth, default: 'default' }),
    image: t.Optional({ ...image, default: 'node:24-bookworm-slim' })
}, {
    description: 'All fields are optional. Send {} to create Codex with automatic auth selection and the slim base image.',
    examples: [{ harness: 'codex', auth: 'default', image: 'node:24-bookworm-slim' }, { harness: 'pi' }, { harness: 'opencode' }]
})

export const models = {
    ...eventModels,
    CreateEnvironment: createBody,
    SendMessage: t.Object({ message, model: t.Optional(model) }, { description: 'Send a user message using native model and effort defaults, with an optional model override.' }),
    Turn: turn,
    Environment: environment,
    Environments: t.Array(t.Object({
        ...environmentFields,
        threadId
    }, { description: 'Environment summary. Conversation history and container state are available through get.' }), { description: 'All environments managed by this server, including busy and interrupted environments. Empty array when none exist.' }),
    EnvironmentState: t.Object({ ...environment.properties, container }, { description: 'Environment metadata, current thread history and actual Docker runtime state.' }),
    Error: t.Object({ error: t.String({ description: 'Human-readable error detail. The HTTP status identifies the error category.', examples: ['Environment not found'] }) }, { description: 'API error response.' })
}

const json = (name: string, description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
})
const errors = {
    400: json('Error', 'Malformed JSON, unknown auth profile or missing/incomplete credentials.'),
    404: json('Error', 'No environment with this ID is managed by the server.'),
    409: json('Error', 'Environment is busy or is not ready to accept a message. Interrupted environments must be deleted and recreated.'),
    422: json('Error', 'Request body or path parameters failed schema validation.'),
    500: json('Error', 'Unexpected server error, such as a filesystem failure or missing Docker executable.'),
    502: json('Error', 'Docker command, harness installation or model execution failed. Inspect the environment’s last turn for a failed message’s events and error.')
}

export const routes = {
    create: {
        body: createBody,
        detail: {
            operationId: 'createEnvironment', summary: 'Create an environment',
            description: 'Creates a container, installs the selected agent and copies the chosen credentials and the harness’s local configuration. Configuration comes from the selected harness independently of the auth source and is captured at creation. Waits until the environment is ready. The first message starts its conversation; thread.id is initially null.',
            responses: { 201: json('Environment', 'Environment provisioned and ready for its first message.'), 400: errors[400], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    },
    list: {
        detail: {
            operationId: 'listEnvironments', summary: 'List environments',
            description: 'Lists the server’s persisted environment records without invoking Docker. No pagination or filters. Status is the manager’s state; use get for actual Docker state and complete thread history.',
            responses: { 200: json('Environments', 'Environment summaries; an empty array if none exist.'), 500: errors[500] }
        }
    },
    get: {
        params,
        detail: {
            operationId: 'getEnvironment', summary: 'Get environment and thread state',
            description: 'Returns the environment, conversation and container state. Poll during send to read progress events. Use the environment ID in API paths.',
            responses: { 200: json('EnvironmentState', 'Current environment and thread state.'), 404: errors[404], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    },
    send: {
        params, body: models.SendMessage,
        detail: {
            operationId: 'sendMessage', summary: 'Send a message',
            description: 'Creates or resumes the environment’s single thread. Omit model to use native configuration and session defaults; provide model to override it for this message. Configured effort is preserved. Waits for the harness to exit; this response is not a stream. Successful calls return the completed turn and selected model. Failures return an error and remain visible in get. Only one message may run per environment. Different environments can run concurrently.',
            responses: { 200: json('Turn', 'Completed turn with assistant text, SDK events and token totals.'), 400: errors[400], 404: errors[404], 409: errors[409], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    },
    delete: {
        params,
        detail: {
            operationId: 'deleteEnvironment', summary: 'Delete an environment',
            description: 'Removes the container, workspace, credentials and conversation, then removes the server’s record. Rejects creating, running and deleting environments with 409. Can clean up interrupted or failed environments. A container already missing from Docker still has its record removed.',
            responses: { 204: { description: 'Environment deleted. No response body.' }, 404: errors[404], 409: errors[409], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    }
}

export const docs = openapi({
    documentation: {
        info: { title: 'Agents API', version: '0.2.0', description: 'Create an environment, save its id, then send messages. Model and effort default to the harness’s native configuration. Every message returns the same SDK event types: message, reasoning, tool, plan, usage, error and status.' },
        servers: [{ url: 'http://127.0.0.1:8910', description: 'Local server, or remote server reached through an SSH tunnel.' }]
    }
})
