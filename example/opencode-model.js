import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create({ harness: 'opencode', auth: 'opencode' })

try {
    const response = await agent.send('hi')
    console.log(response.text)
    console.log(response.model)
} finally {
    await agent.delete()
}
