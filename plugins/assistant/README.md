# Canvas Assistant

An optional development plugin that lets an OpenCode agent inspect and edit the
live voxel canvas. It does not give the agent shell, filesystem, browser, or
other MCP tools. No permanent OpenCode configuration is installed.

## Start

Authenticate your chosen provider in OpenCode first, then run:

```sh
bun install
bun run dev:assistant
```

The launcher starts an authenticated loopback OpenCode instance, a loopback
canvas bridge, and Vite. It inherits your configured OpenCode model and provider
authentication. It checks that the canvas tool is registered before starting Vite.
Use `bun run dev:assistant --port 5180` if another dev server owns the default port.

Open the project menu, choose **Enable assistant**, and enter the **connection
key** printed in the terminal. This is a temporary canvas capability, not your
model API key. It stays in tab session storage, never local storage or the build.
An optional `#assistant=<connection-key>` launch fragment also works and is
removed from the address bar immediately. Treat either form as a secret.

The UI supports prompts, follow-ups, streamed model text/reasoning supplied by
OpenCode, tool progress, Stop, and New conversation. Close collapses the panel
while work continues; Disable stops it and removes the panel. Re-enable through
the project menu. A disconnected socket ends its run; reconnect creates a fresh
conversation without replaying requests. Earlier transcript entries are local
display only. One authenticated canvas can connect at a time.

Prompts, state, tool results, and requested viewport captures go to the model
provider configured in OpenCode. Model reasoning availability depends on that
provider. The activity feed does not manufacture a thinking transcript.

## exe.dev

All browser traffic uses `/__assistant/socket` on the **same origin as the app**.
HTTPS pages use WSS. Vite proxies only that exact path to the loopback bridge;
the OpenCode API and internal tool endpoint are not proxied. No browser-side
localhost URL, provider credential, or extra public service port is needed.

Use the existing exe.dev proxy with its target port set to this Vite instance.
Keep private exe.dev access enabled. The bridge additionally checks the WebSocket
Origin against Host (using exe.dev's forwarded public Host when present), requires
the connection key before any model operation, and uses a separate server-only
credential for tool callbacks. When checking
from inside the VM, its `/etc/hosts` entry may resolve its public hostname back
to the VM rather than the external HTTPS proxy.

## Editing And Stop

Every tool proposal is parsed on both sides and edits use the existing serial
application queue with a revision guard. The model must refresh state after a
conflict. UI/renderer changes remain usable and appear to external scripting
clients; assistant commands are attributed to `assistant`.

Voxel batches use normal Undo. There is no whole-run rollback: it could undo
intervening manual work, and not every layer/material/settings operation is
undoable. Completed edits retain normal autosave behavior.

Replacing the document, resizing, and deleting a layer always require local
approval of the exact command and revision. Model-supplied approval flags are
discarded. Declining approval stops the run. Approval expires after 60 seconds.
Stop aborts the local run immediately, invalidates waiting command signals, and
aborts OpenCode. It cannot retract a command already applied to the document.

Runs are limited to 40 model steps, 128 canvas commands, and 10 minutes. Explicit
voxel/cell batches are limited to 4096; fill bounding volumes to 32768. Viewport
capture settles meshing, not progressive-render convergence. Heartbeats detect
lost connections; pending canvas calls time out rather than replaying.

## Remove Or Disable

`bun run dev` and `bun run build` leave the feature off. No assistant code or
styles are loaded into the ordinary build, and no assistant service is started.
The feature has two integration points:

- The gated `mountAssistant` call in `src/main.ts` supplies DOM roots, execution,
  and a command subscription. Its disposer removes owned UI, styles, and listeners.
- The `VOXEL_ASSISTANT_PORT` define and exact WebSocket proxy in `vite.config.ts`.

For complete removal, remove those blocks, `plugins/assistant/`, the
`dev:assistant` script, the assistant TypeScript include, and the two
`@opencode-ai/*` dev dependencies. The shared queue's optional AbortSignal support
and command-source attribution can remain; neither starts the feature.

The standalone scripting relay is unchanged and not required by the assistant.

## Checks

```sh
bun test
bun test plugins/assistant/server.test.ts scripts/relay.test.ts
bun run build
bunx impeccable detect plugins/assistant/client.ts plugins/assistant/style.css src/main.ts
```

The main app uses Vite's experimental bundled-dev mode, so run the browser
fixture on a standard Vite test server:

```sh
bun -e 'const {createServer}=await import("vite"); const s=await createServer({configFile:false,server:{host:"127.0.0.1",port:5181,strictPort:true}}); await s.listen(); s.printUrls()'
```

Open `http://127.0.0.1:5181/plugins/assistant/check.html` for the browser lifecycle
check, `runAssistantChecks()` from `client.browser-test.ts`.
It uses a fake WebSocket and checks approval, cancellation, stream bounds,
keyboard isolation, disconnect/reconnect, and disposal without a provider call.
