import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create({ harness: 'pi' })

try {
    const result = await agent.send('Write a small Fibonacci program and run it.', { model: 'gpt-6-luna' })
    console.log(result.text)
} finally {
    await agent.delete()
}
