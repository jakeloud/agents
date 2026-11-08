import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { auths } from './auth'
import type { Harness } from '../sdk/index'

export function configuration(harness: Harness) {
    const files: [string, string][] = []
    const env: string[] = []
    const add = (source: string, target: string, names: string[]) => {
        for (const name of names) if (existsSync(join(source, name))) files.push([join(source, name), join(target, name)])
    }
    if (harness === 'codex') {
        const source = dirname(auths.codex!.file)
        add(source, '/root/.codex', existsSync(source) ? readdirSync(source).filter(name => name === 'config.toml' || name.endsWith('.config.toml')) : [])
    } else if (harness === 'pi') {
        add(dirname(auths.pi!.file), '/root/.pi/agent', ['settings.json', 'models.json'])
    } else {
        const names = ['config.json', 'opencode.json', 'opencode.jsonc', 'agent', 'agents']
        add(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'), '/root/.config/opencode', names)
        add(join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'opencode'), '/root/.local/state/opencode', ['model.json'])
        if (process.env.OPENCODE_CONFIG_DIR) {
            add(process.env.OPENCODE_CONFIG_DIR, '/root/.opencode-config', names)
            env.push('OPENCODE_CONFIG_DIR=/root/.opencode-config')
        }
        if (process.env.OPENCODE_CONFIG && existsSync(process.env.OPENCODE_CONFIG)) {
            files.push([process.env.OPENCODE_CONFIG, '/root/.opencode-config.jsonc'])
            env.push('OPENCODE_CONFIG=/root/.opencode-config.jsonc')
        }
    }
    return { files, env }
}

export const sessionMetadata = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [harness, id] = process.argv.slice(1);
const root = harness === 'codex' ? '/root/.codex/sessions' : '/root/.pi/agent/sessions';
const file = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(name => name.endsWith(id + '.jsonl')).sort().at(-1) : null;
let model = null, effort = null;
if (file) for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'turn_context') { model = entry.payload.model; effort = entry.payload.effort ?? entry.payload.reasoning_effort ?? null; }
    if (entry.type === 'model_change') model = entry.modelId;
    if (entry.type === 'thinking_level_change') effort = entry.thinkingLevel;
    if (entry.type === 'message' && entry.message.role === 'assistant') model = entry.message.model;
}
console.log(JSON.stringify({ model, effort }));
`
