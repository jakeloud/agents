import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create()

try {
    const first = await agent.send('Write a small Fibonacci program in js and run it.')
    console.log(first.text)

    const next = await agent.send('Make it print the first 20 numbers and run it again.')
    console.log(next.text)
    console.log(await agent.get())
    console.log(await agents.list())
} finally {
    await agent.delete()
}
