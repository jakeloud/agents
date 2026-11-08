import { Elysia } from 'elysia'
import { docs, models, routes } from './api'
import { Run } from './events'
import { resolveAuth } from './auth'
import { configuration, sessionMetadata } from './config'
import type { Environment as PublicEnvironment, Harness, Turn } from '../sdk/index'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const image = 'node:24-bookworm-slim'
const file = 'environments.json'
const packages = { codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent', opencode: 'opencode-ai@1.19.5' }

type Environment = PublicEnvironment & { provider?: string }

const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 2, environments: {} }
const environments: Record<string, Environment> = stored.version === 2 ? stored.environments : stored
const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, environments }))
    renameSync(`${file}.tmp`, file)
}
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }) }
const get = (id: string) => Object.hasOwn(environments, id) ? environments[id]! : fail(404, 'Environment not found')
const publicEnvironment = ({ provider, ...env }: Environment): PublicEnvironment => env
const idle = (env: Environment) => {
    if (['creating', 'running', 'deleting'].includes(env.status)) fail(409, 'Environment is busy')
}

for (const env of Object.values(environments)) {
    for (const turn of env.thread.turns) turn.effort ??= null
    if (stored.version !== 2) for (const turn of env.thread.turns) {
        const run = new Run(env.harness)
        for (const event of turn.events) run.accept(event)
        run.finish(turn.status, turn.error)
        turn.events = run.events
        turn.usage = run.usage
    }
    if (!['creating', 'running', 'deleting'].includes(env.status)) continue
    env.status = 'interrupted'
    env.error = 'Server stopped during work; delete and recreate this environment'
    const turn = env.thread.turns.at(-1)
    if (turn?.status === 'running') {
        Object.assign(turn, { status: 'interrupted', error: env.error })
        turn.events.push({ type: 'error', message: env.error }, { type: 'status', status: 'interrupted' })
    }
}
save()

async function docker(args: string[], input?: Blob) {
    const proc = Bun.spawn(['docker', ...args], { stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
    ])
    if (code) fail(502, err.trim() || `Docker exited with ${code}`)
    return out.trim()
}

async function remove(id: string) {
    try {
        await docker(['rm', '-fv', id])
    } catch (error) {
        if (!/No such (container|object)/i.test(String(error))) throw error
    }
    delete environments[id]
    save()
}

async function* events(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end)
            buffer = buffer.slice(end + 1)
            if (line.trim()) yield JSON.parse(line)
        }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield JSON.parse(buffer)
}

async function create(options: { harness?: Harness, auth?: string, image?: string }) {
    const harness = options.harness ?? 'codex'
    const auth = resolveAuth(harness, options.auth)
    const config = configuration(harness)
    const env: Environment = {
        id: `agent-${crypto.randomUUID()}`, harness, auth: auth.name, provider: auth.provider,
        image: options.image ?? image, status: 'creating', thread: { id: null, turns: [] }
    }
    environments[env.id] = env
    save()
    try {
        await docker(['run', '-d', '--init', '--name', env.id, '--user', '0',
            '--workdir', '/workspace', '--env', 'HOME=/root', '--env', 'CODEX_HOME=/root/.codex',
            '--env', 'PI_CODING_AGENT_DIR=/root/.pi/agent',
            '--env', 'XDG_DATA_HOME=/root/.local/share',
            '--env', 'XDG_CONFIG_HOME=/root/.config', '--env', 'XDG_STATE_HOME=/root/.local/state',
            ...config.env.flatMap(value => ['--env', value]),
            '--entrypoint', 'sleep', env.image, 'infinity'])
        await docker(['exec', env.id, 'mkdir', '-p', '/root/.codex', '/root/.pi/agent', '/root/.local/share/opencode',
            ...config.files.map(([, target]) => dirname(target))])
        if (env.image === image) await docker(['exec', env.id, 'sh', '-c',
            'apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*'])
        await docker(['exec', env.id, 'sh', '-c', `npm install --global ${packages[harness]} && npm cache clean --force`])
        await docker(['exec', '-i', env.id, 'node', '-e',
            'require("node:fs").writeFileSync(process.argv[1], require("node:fs").readFileSync(0), { mode: 0o600 })', auth.destination],
            new Blob([JSON.stringify(auth.data)]))
        for (const [source, target] of config.files) await docker(['cp', source, `${env.id}:${target}`])
        env.status = 'ready'
        save()
        return env
    } catch (error) {
        env.status = 'failed'
        env.error = String(error)
        save()
        try { await remove(env.id) } catch {}
        throw error
    }
}

async function send(id: string, message: string, model?: string) {
    const env = get(id)
    if (env.status !== 'ready') fail(409, `Environment is ${env.status}`)
    const run = new Run(env.harness)
    const turn: Turn = { message, model: null, effort: null, status: 'running', text: '', events: run.events, usage: run.usage }
    env.thread.turns.push(turn)
    env.status = 'running'
    save()
    let exited = true
    try {
        const args = {
            pi: ['pi', '--mode', 'json', '--session-id', env.id, ...(model ? ['--model', model] : [])],
            codex: ['codex', 'exec', ...(env.thread.id ? ['resume', env.thread.id] : []),
                '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'cli_auth_credentials_store="file"', ...(model ? ['--model', model] : []), '-'],
            opencode: ['opencode', 'run', '--format', 'json', '--thinking', '--auto',
                ...(model ? ['--model', model.includes('/') ? model : `${env.provider ?? 'openai'}/${model}`] : []),
                ...(env.thread.id ? ['--session', env.thread.id] : [])]
        }[env.harness]
        const proc = Bun.spawn(['docker', 'exec', '-i', env.id, ...args],
            { stdin: new Blob([message]), stdout: 'pipe', stderr: 'pipe' })
        exited = false
        const stderr = new Response(proc.stderr).text()
        for await (const event of events(proc.stdout)) {
            run.accept(event)
            if (run.sessionId) env.thread.id = run.sessionId
            turn.text = run.text
            turn.model = run.model
            turn.effort = run.effort
            save()
        }
        const [code, err] = await Promise.all([proc.exited, stderr])
        exited = true
        if (code || run.error || !run.completed) {
            fail(502, run.error || err.trim() || 'Agent exited without completing the turn')
        }
        if (run.sessionId) {
            if (env.harness === 'opencode') {
                const session = JSON.parse(await docker(['exec', env.id, 'opencode', 'export', run.sessionId]))
                const info = session.messages.findLast((entry: any) => entry.info.role === 'assistant')?.info
                turn.model = info?.modelID ?? null
                turn.effort = info?.variant ?? null
            } else {
                const selected = JSON.parse(await docker(['exec', env.id, 'node', '-e', sessionMetadata, env.harness, run.sessionId]))
                turn.model = selected.model ?? run.model
                turn.effort = selected.effort ?? run.effort
            }
        }
        turn.status = 'completed'
        return turn
    } catch (error) {
        turn.status = exited ? 'failed' : 'interrupted'
        turn.error = error instanceof Error ? error.message : String(error)
        throw error
    } finally {
        run.finish(turn.status, turn.error)
        env.status = exited ? 'ready' : 'interrupted'
        save()
    }
}

new Elysia()
    .model(models)
    .use(docs)
    .onError(({ error, set }) => {
        set.status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500
        return { error: error instanceof Error ? error.message : String(error) }
    })
    .post('/environments', routes.create, async ({ body, set }) => {
        const env = await create(body)
        set.status = 201
        return publicEnvironment(env)
    })
    .get('/environments', routes.list, () => Object.values(environments).map(({ provider, thread, ...env }) => ({ ...env, threadId: thread.id })))
    .get('/environments/:id', routes.get, async ({ params: { id } }) => {
        const env = get(id)
        const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', id]))
        return { ...publicEnvironment(env), container: {
            status: state.Status, running: state.Running, exitCode: state.ExitCode, error: state.Error || null,
            startedAt: !state.StartedAt || state.StartedAt.startsWith('0001-') ? null : state.StartedAt,
            finishedAt: !state.FinishedAt || state.FinishedAt.startsWith('0001-') ? null : state.FinishedAt
        } }
    })
    .post('/environments/:id/messages', routes.send, ({ params: { id }, body }) => send(id, body.message, body.model))
    .delete('/environments/:id', routes.delete, async ({ params: { id }, set }) => {
        const env = get(id)
        idle(env)
        const previous = env.status
        env.status = 'deleting'
        save()
        try {
            await remove(id)
            set.status = 204
        } catch (error) {
            env.status = previous
            save()
            throw error
        }
    })
    .listen({ hostname: '127.0.0.1', port: 8910, idleTimeout: 0 })

console.log('Agents: http://127.0.0.1:8910')
console.log('API docs: http://127.0.0.1:8910/openapi')
