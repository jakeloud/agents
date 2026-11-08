import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create()

try {
    const response = await agent.send('hi')
    console.log(response.text)
    console.log(response.usage)
} finally {
    await agent.delete()
}
