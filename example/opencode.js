import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create({ harness: 'opencode' })

try {
    const response = await agent.send('hi', { model: 'gpt-6-luna' })
    console.log(response.text)
} finally {
    await agent.delete()
}
