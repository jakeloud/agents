import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Harness } from '../sdk/index'

const home = homedir()
export const auths: Record<string, { harness: Harness, file: string }> = {
    codex: { harness: 'codex', file: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json') },
    pi: { harness: 'pi', file: join(process.env.PI_CODING_AGENT_DIR ?? join(home, '.pi/agent'), 'auth.json') },
    opencode: { harness: 'opencode', file: join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'opencode/auth.json') }
}
const destinations = { codex: '/root/.codex/auth.json', pi: '/root/.pi/agent/auth.json', opencode: '/root/.local/share/opencode/auth.json' }
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }) }
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const claims = (token: string) => {
    try {
        const value = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
    catch { return {} }
}
const apiKey = (value: any) => ['api', 'api_key'].includes(value?.type) && string(value.key) && !value.key.startsWith('!')
const oauth = (value: any) => value?.type === 'oauth' && string(value.access) && string(value.refresh) && Number.isInteger(value.expires) && value.expires >= 0
const shared = new Set(['openai', 'anthropic', 'google', 'xai', 'mistral', 'groq', 'cerebras', 'deepseek', 'openrouter', 'nvidia'])

function decode(harness: Harness, data: any): Record<string, any> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    if (harness !== 'codex') return Object.fromEntries(Object.entries(data)
        .filter(([, value]: [string, any]) => apiKey(value) || oauth(value) || harness === 'opencode' && value?.type === 'wellknown' && string(value.key) && string(value.token)).map(([provider, value]: [string, any]) => [
            provider === 'openai' && value.type === 'oauth' ? 'openai-codex' : provider,
            apiKey(value) ? { ...value, type: 'api_key' } : value
        ]))
    if (data.auth_mode !== 'chatgpt' && string(data.OPENAI_API_KEY)) return { openai: { type: 'api_key', key: data.OPENAI_API_KEY } }
    const tokens = data.tokens
    if (!string(tokens?.access_token) || !string(tokens.refresh_token)) return {}
    const payload = claims(tokens.access_token)
    const value = { type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token,
        expires: payload.exp * 1000, accountId: tokens.account_id ?? payload['https://api.openai.com/auth']?.chatgpt_account_id,
        idToken: tokens.id_token }
    return oauth(value) && string(value.accountId) ? { 'openai-codex': value } : {}
}

function encode(target: Harness, source: Harness, data: any, credentials: Record<string, any>) {
    const entries = Object.entries(credentials).filter(([provider, value]) => target === source || apiKey(value) && shared.has(provider) || provider === 'openai-codex')
    if (target === 'codex') {
        const token = credentials['openai-codex']
        const key = credentials.openai
        if (target === source && entries.length) return data
        if (oauth(token) && Number.isFinite(claims(token.access).exp) && string(token.accountId ?? claims(token.access)['https://api.openai.com/auth']?.chatgpt_account_id)) {
            return { auth_mode: 'chatgpt', tokens: { access_token: token.access, refresh_token: token.refresh,
                id_token: string(token.idToken) ? token.idToken : token.access, account_id: token.accountId ?? claims(token.access)['https://api.openai.com/auth'].chatgpt_account_id } }
        }
        if (apiKey(key)) return { auth_mode: 'apikey', OPENAI_API_KEY: key.key }
        return
    }
    if (!entries.length) return
    return Object.fromEntries(entries.sort(([a], [b]) => Number(a === 'openai-codex') - Number(b === 'openai-codex')).map(([provider, value]) => target === 'pi'
        ? [provider, value]
        : [provider === 'openai-codex' ? 'openai' : provider, apiKey(value) ? { ...value, type: 'api' } : value]))
}

export function resolveAuth(harness: Harness, profile = 'default') {
    const names = profile === 'default'
        ? [harness, ...Object.keys(auths).filter(name => name !== harness)] : [profile]
    if (profile !== 'default' && !Object.hasOwn(auths, profile)) fail(`Unknown auth profile: ${profile}`)
    for (const name of names) {
        const source = auths[name]!
        let data: any
        try { data = JSON.parse(readFileSync(source.file, 'utf8')) } catch { continue }
        const credentials = decode(source.harness, data)
        const converted = encode(harness, source.harness, data, credentials)
        if (!converted) continue
        const providers = Object.keys(converted)
        return { name, data: converted, destination: destinations[harness],
            provider: providers.includes('openai') ? 'openai' : providers[0] }
    }
    return fail(profile === 'default' ? `No compatible credentials found for ${harness}. Checked its own auth file, then other harness auth files.` : `Auth profile ${profile} has no compatible credentials for ${harness}`)
}
