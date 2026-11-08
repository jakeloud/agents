# agents

One Docker container, one Codex thread. Bun + Elysia. A small HTTP server and a fetch-based JavaScript SDK.

On the server machine, install Bun and Docker and put a file-backed Codex login at `~/.codex/auth.json`. The `default` auth profile means the server user's `~/.codex` directory; omitting `auth` selects it too. The server copies `auth.json` and, if present, `config.toml` into each container. Named auth profiles are paths in `auths` at the top of `src/index.ts`; add more there. Credentials stored only in an OS keychain need a file-backed login first.

```sh
bun install
bun start
```

In another terminal:

```sh
bun example/simple.js
```

The API binds to `127.0.0.1:3000`. For a remote server, use an SSH tunnel:

```sh
ssh -N -L 3000:127.0.0.1:3000 user@server
```

```js
import { Agents } from './sdk/index.js'

const agents = new Agents()
const env = await agents.create({ harness: 'codex', auth: 'default' })
const result = await env.send('Create a hello world program and run it.', { model: 'gpt-6.1-sol' })
console.log(result.text)
console.log(await env.get())
console.log(await agents.list())
await env.delete()
```

`agents.environment(id)` reconnects a client to an existing environment. Pass a URL to `new Agents(url)` to change the API address. Select a model on every `send`; subsequent messages resume the same Codex session.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/environments` | `{ harness?: "codex", auth?: "default", image?: "node:24-bookworm-slim" }` → environment (201) |
| GET | `/environments` | Environment summaries with thread IDs |
| GET | `/environments/:id` | Environment, Docker state, thread ID and turns |
| POST | `/environments/:id/messages` | `{ message, model }` → completed turn with `text` and raw Codex `events` |
| DELETE | `/environments/:id` | Remove container and stored state (204) |

Creation starts the selected base image and installs `@openai/codex` inside it, then clears npm's cache. The default is `node:24-bookworm-slim`, with only Git and CA certificates added and apt's package lists removed. Custom images need Linux, Node/npm, `sleep`, normal shell utilities, and CA certificates; execution uses root with `/workspace` as its working directory. The copied Codex config must work inside the container; host paths are not rewritten. No host workspace or Docker socket is mounted, and no container ports are published. Codex runs with approvals and its inner sandbox disabled inside the container.

Messages wait for completion. Poll `env.get()` from another caller for events during a turn. A busy environment rejects another send or deletion with 409. Independent environments can run in parallel. Errors return `{ error }`; the SDK throws an error with an HTTP `status`. Failed turns remain in thread history and can be retried.

State lives in `environments.json` in the server's working directory; workspaces and Codex sessions live in the containers. Idle environments survive server restarts. If the server stops during work, that environment is marked `interrupted` on restart and must be deleted and recreated. Deleting an environment removes its workspace, credentials, and thread. The example deletes its environment when finished.

This prototype uses [Codex's JSONL execution and session resumption](https://learn.chatgpt.com/docs/non-interactive-mode).
