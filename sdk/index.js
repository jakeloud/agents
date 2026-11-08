export class Agents {
    constructor(url = 'http://127.0.0.1:3000') {
        this.url = url.replace(/\/$/, '')
    }

    async request(method, path, body) {
        const response = await fetch(`${this.url}${path}`, {
            method,
            headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        if (response.status === 204) return
        const data = await response.json()
        if (!response.ok) throw Object.assign(new Error(data.error ?? response.statusText), { status: response.status })
        return data
    }

    environment(id) {
        const path = `/environments/${encodeURIComponent(id)}`
        return {
            id,
            get: () => this.request('GET', path),
            send: (message, { model }) => this.request('POST', `${path}/messages`, { message, model }),
            delete: () => this.request('DELETE', path)
        }
    }

    async create(options = {}) {
        const { id } = await this.request('POST', '/environments', options)
        return this.environment(id)
    }

    list() {
        return this.request('GET', '/environments')
    }
}
