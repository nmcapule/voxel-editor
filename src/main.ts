import { mountApplication } from './app/application'

const app = await mountApplication(document.querySelector<HTMLElement>('#app')!)
import.meta.hot?.dispose(async () => { await app.dispose() })
