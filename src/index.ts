import { Elysia } from 'elysia'
import { openapi } from '@elysia/openapi'

new Elysia()
    .use(openapi())
    .get('/', 'Hello Elysia')
    .get('/user/:id', ({ params: { id } }) => id)
    .post('/form', ({ body }) => body)
    .listen(3000, ({ hostname, port }) => {
        console.log(`Elysia is running at ${hostname}:${port}`)
    })
