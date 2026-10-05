import { createApp } from './server.ts';

const port = Number(process.env.PORT ?? 4310);
const server = createApp();
server.listen(port, '127.0.0.1', () => console.log(`demo-app listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
