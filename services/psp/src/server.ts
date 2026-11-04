import { startServer } from '@ticketflow/common'
import { buildApp, loadConfig } from './app'

const config = loadConfig()
const app = await buildApp(config)
await startServer(app, config.PORT)
