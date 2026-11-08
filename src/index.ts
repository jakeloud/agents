import { Elysia, t } from 'elysia'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'

const auths: Record<string, string> = { default: join(homedir(), '.codex') }
const image = 'node:24-bookworm'
const file = 'environments.json'

type Turn = {
    message: string, model: string, status: string, text: string, events: any[], error?: string
}
type Environment = {
    id: string, harness: string, image: string, auth: string, status: string,
    thread: { id: string | null, turns: Turn[] }, error?: string
}

const environments: Record<string, Environment> = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')) : {}
const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(environments))
    renameSync(`${file}.tmp`, file)
}
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }) }
const get = (id: string) => Object.hasOwn(environments, id) ? environments[id]! : fail(404, 'Environment not found')
const idle = (env: Environment) => {
    if (['creating', 'running', 'deleting'].includes(env.status)) fail(409, 'Environment is busy')
}

for (const env of Object.values(environments)) {
    if (!['creating', 'running', 'deleting'].includes(env.status)) continue
    env.status = 'interrupted'
    env.error = 'Server stopped during work; delete and recreate this environment'
    const turn = env.thread.turns.at(-1)
    if (turn?.status === 'running') Object.assign(turn, { status: 'interrupted', error: env.error })
}
save()

async function docker(...args: string[]) {
    const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
    ])
    if (code) fail(502, err.trim() || `Docker exited with ${code}`)
    return out.trim()
}

async function remove(id: string) {
    try {
        await docker('rm', '-fv', id)
    } catch (error) {
        if (!/No such (container|object)/i.test(String(error))) throw error
    }
    delete environments[id]
    save()
}

async function create(options: { harness?: 'codex', auth?: string, image?: string }) {
    const auth = options.auth ?? 'default'
    const source = Object.hasOwn(auths, auth) ? auths[auth]! : fail(400, 'Unknown auth profile')
    if (!existsSync(join(source, 'auth.json'))) fail(400, `Auth profile ${auth} needs auth.json`)
    const env: Environment = {
        id: `agent-${crypto.randomUUID()}`, harness: 'codex', auth,
        image: options.image ?? image, status: 'creating', thread: { id: null, turns: [] }
    }
    environments[env.id] = env
    save()
    try {
        await docker('run', '-d', '--init', '--name', env.id, '--user', '0',
            '--workdir', '/workspace', '--env', 'HOME=/root', '--env', 'CODEX_HOME=/root/.codex',
            '--entrypoint', 'sleep', env.image, 'infinity')
        await docker('exec', env.id, 'mkdir', '-p', '/root/.codex')
        await docker('exec', env.id, 'npm', 'install', '--global', '@openai/codex')
        for (const name of ['auth.json', 'config.toml']) {
            if (name === 'auth.json' || existsSync(join(source, name))) {
                await docker('cp', join(source, name), `${env.id}:/root/.codex/${name}`)
            }
        }
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

async function send(id: string, message: string, model: string) {
    const env = get(id)
    if (env.status !== 'ready') fail(409, `Environment is ${env.status}`)
    const turn: Turn = { message, model, status: 'running', text: '', events: [] }
    env.thread.turns.push(turn)
    env.status = 'running'
    save()
    let exited = true
    try {
        const args = env.thread.id ? ['resume', env.thread.id] : []
        const proc = Bun.spawn(['docker', 'exec', '-i', env.id, 'codex', 'exec', ...args,
            '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', model, '-'],
            { stdin: new Blob([message]), stdout: 'pipe', stderr: 'pipe' })
        exited = false
        const stderr = new Response(proc.stderr).text()
        for await (const line of createInterface({ input: Readable.fromWeb(proc.stdout as any) })) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            turn.events.push(event)
            if (event.type === 'thread.started') env.thread.id = event.thread_id
            if (event.type === 'item.completed' && event.item.type === 'agent_message') turn.text = event.item.text
            if (event.type === 'turn.failed') turn.error = event.error?.message ?? 'Codex turn failed'
            save()
        }
        const [code, err] = await Promise.all([proc.exited, stderr])
        exited = true
        if (code || turn.error || !turn.events.some(event => event.type === 'turn.completed')) {
            fail(502, turn.error || err.trim() || 'Codex exited without completing the turn')
        }
        turn.status = 'completed'
        return turn
    } catch (error) {
        turn.status = 'failed'
        turn.error = String(error)
        throw error
    } finally {
        env.status = exited ? 'ready' : 'interrupted'
        save()
    }
}

new Elysia()
    .onError(({ error, set }) => {
        set.status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500
        return { error: error instanceof Error ? error.message : String(error) }
    })
    .post('/environments', {
        body: t.Object({
            harness: t.Optional(t.Literal('codex')),
            auth: t.Optional(t.String({ minLength: 1 })),
            image: t.Optional(t.String({ minLength: 1 }))
        })
    }, async ({ body, set }) => {
        const env = await create(body)
        set.status = 201
        return env
    })
    .get('/environments', () => Object.values(environments).map(({ thread, ...env }) => ({ ...env, threadId: thread.id })))
    .get('/environments/:id', async ({ params: { id } }) => ({
        ...get(id), container: JSON.parse(await docker('inspect', '--format', '{{json .State}}', id))
    }))
    .post('/environments/:id/messages', {
        body: t.Object({ message: t.String({ minLength: 1 }), model: t.String({ minLength: 1 }) })
    }, ({ params: { id }, body }) => send(id, body.message, body.model))
    .delete('/environments/:id', async ({ params: { id }, set }) => {
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
    .listen({ hostname: '127.0.0.1', port: 3000, idleTimeout: 0 })

console.log('Agents: http://127.0.0.1:3000')
