import { t } from 'elysia'
import { openapi } from '@elysia/openapi'

const id = t.String({ description: 'Environment container name returned by create or list.', examples: ['agent-123e4567-e89b-42d3-a456-426614174000'] })
const threadId = t.Nullable(t.String(), { description: 'Native Codex or Pi session ID. Null until the first message starts a session.' })
const harness = t.Union([t.Literal('codex'), t.Literal('pi')], { description: 'Agent CLI installed and executed in this environment.' })
const auth = t.String({ minLength: 1, description: 'Named server-side Codex credential profile. "default" selects the server user’s ~/.codex. Credentials are copied into the container.', examples: ['default'] })
const image = t.String({ minLength: 1, description: 'Docker base image. Custom images need Linux, Node/npm, sleep, shell utilities and CA certificates.', examples: ['node:24-bookworm-slim'] })
const message = t.String({ minLength: 1, description: 'User message sent to the environment’s existing thread. The first message creates the native session.', examples: ['Write a small Fibonacci program and run it.'] })
const model = t.String({ minLength: 1, description: 'Model ID for this message. Required on every send; changing it keeps the same thread. Pi requires a model supported by the provider derived from the auth profile.', examples: ['gpt-6-luna'] })
const params = t.Object({ id })

const event = t.Object({
    type: t.String({ description: 'Native event discriminator, such as thread.started, item.completed, turn.completed, session, message_end or agent_settled.' })
}, {
    additionalProperties: true,
    description: 'Unmodified JSONL event. Additional fields belong to the selected harness and vary by event type and CLI version. Codex: https://learn.chatgpt.com/docs/non-interactive-mode. Pi: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md. No fixed schema is imposed on native tool results or event payloads.',
    examples: [{ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }, { type: 'agent_settled', aborted: false }]
})

const turn = t.Object({
    message,
    model,
    status: t.String({ enum: ['running', 'completed', 'failed', 'interrupted'], description: 'running: harness executing; completed: successful terminal event and process exit; failed: invocation or model failure; interrupted: server stopped during execution.' }),
    text: t.String({ description: 'Latest completed assistant message as plain text. Empty before an assistant message completes; partial streaming output is available in events.' }),
    events: t.Array(event, { description: 'Native harness events in arrival order, including tool activity and token usage when emitted. Poll get while a message is running to see new events.' }),
    error: t.Optional(t.String({ description: 'Failure or interruption detail. Absent on successful turns.' }))
}, {
    description: 'One API message and its harness execution. A successful send returns a completed turn; get also exposes running and failed turns.',
    examples: [{ message: 'Say hello.', model: 'gpt-6-luna', status: 'completed', text: 'Hello!', events: [{ type: 'agent_settled', aborted: false }] }]
})

const environmentFields = {
    id,
    harness,
    auth,
    image,
    status: t.String({ enum: ['creating', 'ready', 'running', 'failed', 'deleting', 'interrupted'], description: 'creating: provisioning; ready: accepts messages; running: processing a message; failed: provisioning failed and cleanup needs retry; deleting: removal in progress; interrupted: server stopped during work, delete and recreate.' }),
    provider: t.Optional(t.String({ enum: ['openai', 'openai-codex'], description: 'Pi only. openai uses the Codex profile’s saved API key; openai-codex uses its ChatGPT OAuth tokens. Omitted for the Codex harness.' })),
    error: t.Optional(t.String({ description: 'Environment provisioning or interruption detail. Message failures are recorded on the corresponding turn instead.' }))
}
const environment = t.Object({
    ...environmentFields,
    thread: t.Object({
        id: threadId,
        turns: t.Array(turn, { description: 'Messages submitted through this API, in chronological order, including their responses and events.' })
    }, { description: 'One persistent harness session per environment. Credentials, workspace and native session files live inside the container.' })
}, { description: 'Environment metadata and complete API-managed thread history.' })

const container = t.Object({
    Status: t.String({ description: 'Docker runtime status, for example created, running, paused, restarting, removing, exited or dead. Separate from the manager’s environment status.' }),
    Running: t.Boolean({ description: 'Whether the container process is running.' }),
    Paused: t.Boolean({ description: 'Whether Docker has paused the container.' }),
    Restarting: t.Boolean({ description: 'Whether Docker is restarting the container.' }),
    OOMKilled: t.Boolean({ description: 'Whether the last container process was killed for exceeding its memory limit.' }),
    Dead: t.Boolean({ description: 'Whether Docker considers the container dead.' }),
    Pid: t.Integer({ description: 'Host PID of the container’s main process; normally zero when stopped.' }),
    ExitCode: t.Integer({ description: 'Exit code of the container’s main process. This is not the Codex or Pi invocation’s exit code.' }),
    Error: t.String({ description: 'Docker runtime error message, or an empty string.' }),
    StartedAt: t.String({ description: 'Docker start timestamp in RFC 3339 format; a zero timestamp means it has not started.' }),
    FinishedAt: t.String({ description: 'Docker stop timestamp in RFC 3339 format; a zero timestamp means it has not stopped.' }),
    Health: t.Optional(t.Nullable(t.Object({
        Status: t.String({ description: 'Healthcheck state: starting, healthy or unhealthy.' }),
        FailingStreak: t.Integer({ description: 'Number of consecutive failed healthchecks.' }),
        Log: t.Nullable(t.Array(t.Object({
            Start: t.String({ description: 'Healthcheck start timestamp.' }),
            End: t.String({ description: 'Healthcheck end timestamp.' }),
            ExitCode: t.Integer({ description: 'Healthcheck command exit code.' }),
            Output: t.String({ description: 'Captured healthcheck output.' })
        })), { description: 'Recent healthcheck executions, or null when none are recorded.' })
    }, { description: 'Present when the selected image defines a Docker healthcheck.' })))
}, { additionalProperties: true, description: 'Docker inspect .State, preserving Docker’s field names and any additional fields supplied by the installed engine.' })

const createBody = t.Object({
    harness: t.Optional({ ...harness, default: 'codex' }),
    auth: t.Optional({ ...auth, default: 'default' }),
    image: t.Optional({ ...image, default: 'node:24-bookworm-slim' })
}, {
    description: 'All fields are optional. Send {} to create Codex with the default auth profile and slim base image.',
    examples: [{ harness: 'codex', auth: 'default', image: 'node:24-bookworm-slim' }, { harness: 'pi', auth: 'default' }]
})

export const models = {
    CreateEnvironment: createBody,
    SendMessage: t.Object({ message, model }, { description: 'Send a user message and explicitly select its model.' }),
    NativeEvent: event,
    Turn: turn,
    Environment: environment,
    Environments: t.Array(t.Object({
        ...environmentFields,
        threadId
    }, { description: 'Environment summary. Thread history and Docker inspect state are available through get.' }), { description: 'All environments managed by this server, including busy and interrupted environments. Empty array when none exist.' }),
    EnvironmentState: t.Object({ ...environment.properties, container }, { description: 'Environment metadata, current thread history and actual Docker runtime state.' }),
    Error: t.Object({ error: t.String({ description: 'Human-readable error detail. The HTTP status identifies the error category.', examples: ['Environment not found'] }) }, { description: 'API error response.' })
}

const json = (name: string, description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
})
const errors = {
    400: json('Error', 'Malformed JSON, unknown auth profile, missing auth.json or unsupported/incomplete Pi credentials.'),
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
            description: 'Starts an isolated Docker container, installs the selected harness and copies the selected Codex credentials. Pi converts those credentials into its own auth format. Waits for provisioning to finish. The native thread starts on the first message; thread.id is initially null. There is no HTTP auth layer; the API binds to loopback.',
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
            description: 'Returns the persisted thread record plus Docker inspect state. Poll during send to inspect native events and completed assistant messages. Thread and turn IDs belong to the selected harness; use the environment ID in API paths.',
            responses: { 200: json('EnvironmentState', 'Current environment and thread state.'), 404: errors[404], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    },
    send: {
        params, body: models.SendMessage,
        detail: {
            operationId: 'sendMessage', summary: 'Send a message and select its model',
            description: 'Creates or resumes the environment’s single thread and runs one message using the requested model. Waits for the harness to exit; this response is not a stream. Successful calls return the completed turn. Failures return an error and remain visible in get. Only one message may run per environment. Different environments can run concurrently.',
            responses: { 200: json('Turn', 'Successfully completed turn with assistant text and native events.'), 400: errors[400], 404: errors[404], 409: errors[409], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    },
    delete: {
        params,
        detail: {
            operationId: 'deleteEnvironment', summary: 'Delete an environment',
            description: 'Forcibly removes the Docker container and its anonymous volumes, workspace, credentials and native sessions, then removes the server’s record. Rejects creating, running and deleting environments with 409. Can clean up interrupted or failed environments. A container already missing from Docker still has its record removed.',
            responses: { 204: { description: 'Environment deleted. No response body.' }, 404: errors[404], 409: errors[409], 422: errors[422], 500: errors[500], 502: errors[502] }
        }
    }
}

export const docs = openapi({
    documentation: {
        info: { title: 'Agents API', version: '0.1.0', description: 'One Docker environment and persistent thread per agent. Supports Codex and Pi, using named Codex auth profiles. Start with POST /environments, save its id, then send messages. Every message chooses a model. Defaults and all managed response fields are described below; native harness events and Docker extensions retain their upstream schemas.' },
        servers: [{ url: 'http://127.0.0.1:3000', description: 'Local server, or remote server reached through an SSH tunnel.' }]
    }
})
