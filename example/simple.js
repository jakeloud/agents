import { Agents } from '../sdk/index.js'

const agents = new Agents()
const agent = await agents.create({ harness: 'codex' })

try {
    const first = await agent.send('Write a small Fibonacci program in js and run it.', {
        model: 'gpt-6-luna'
    })
    console.log(first.text)

    const next = await agent.send('Make it print the first 20 numbers and run it again.', { model: 'gpt-6-luna' })
    console.log(next.text)
    console.log(await agent.get())
    console.log(await agents.list())
} finally {
    await agent.delete()
}
