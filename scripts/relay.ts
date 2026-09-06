import type { Server, ServerWebSocket } from "bun";

export type RelayRole = "app" | "agent";

export const RELAY_HOST = "127.0.0.1";
export const DEFAULT_PORT = 43110;
export const DEFAULT_APP_URL = "http://127.0.0.1:5173/";
export const MAX_PAYLOAD_BYTES = 97 * 1024 * 1024;
export const MAX_BACKPRESSURE_BYTES = 128 * 1024 * 1024;

interface RelaySocketData {
  role: RelayRole;
}

export interface RelayOptions {
  port?: number;
  token?: string;
  maxPayloadBytes?: number;
}

export interface CliOptions extends RelayOptions {
  app: string;
  help: boolean;
}

const textEncoder = new TextEncoder();

export function generateCapabilityToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function tokensMatch(candidate: string | null, expected: string): boolean {
  if (candidate === null) return false;
  const candidateBytes = textEncoder.encode(candidate);
  const expectedBytes = textEncoder.encode(expected);
  return (
    candidateBytes.byteLength === expectedBytes.byteLength &&
    crypto.timingSafeEqual(candidateBytes, expectedBytes)
  );
}

export function peerStatusMessage(role: RelayRole, connected: boolean): string {
  return JSON.stringify({ type: "peer", role, connected });
}

export function websocketUrl(port: number, role: RelayRole, token: string): string {
  const url = new URL(`ws://${RELAY_HOST}:${port}/`);
  url.searchParams.set("role", role);
  url.searchParams.set("token", token);
  return url.href;
}

export function connectionInfo(port: number, token: string, app: string = DEFAULT_APP_URL) {
  const appWebSocketUrl = websocketUrl(port, "app", token);
  const browserFragment = `#${new URLSearchParams({ relay: appWebSocketUrl })}`;
  const browserUrl = new URL(app);
  if (browserUrl.protocol !== "http:" && browserUrl.protocol !== "https:") {
    throw new Error("--app must be an http(s) URL");
  }
  browserUrl.hash = browserFragment;

  return {
    appWebSocketUrl,
    agentWebSocketUrl: websocketUrl(port, "agent", token),
    browserFragment,
    browserUrl: browserUrl.href,
  };
}

export function createRelay(options: RelayOptions = {}): {
  server: Server<RelaySocketData>;
  token: string;
} {
  const token = options.token ?? generateCapabilityToken();
  if (!token || token.length > 512) throw new Error("Token must be 1-512 characters");
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;

  const peers: Record<RelayRole, ServerWebSocket<RelaySocketData> | undefined> = {
    app: undefined,
    agent: undefined,
  };
  const pending = new Set<RelayRole>();
  const otherRole = (role: RelayRole): RelayRole => (role === "app" ? "agent" : "app");

  const server = Bun.serve<RelaySocketData>({
    hostname: RELAY_HOST,
    port: options.port ?? DEFAULT_PORT,
    development: false,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });

      const suppliedTokens = url.searchParams.getAll("token");
      if (suppliedTokens.length !== 1 || !tokensMatch(suppliedTokens[0]!, token)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const roles = url.searchParams.getAll("role");
      const role = roles[0];
      if (roles.length !== 1 || (role !== "app" && role !== "agent")) {
        return new Response("role must be app or agent", { status: 400 });
      }
      if (peers[role] || pending.has(role)) {
        return new Response(`${role} is already connected`, { status: 409 });
      }

      pending.add(role);
      if (bunServer.upgrade(request, { data: { role } })) return;
      pending.delete(role);
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      data: {} as RelaySocketData,
      maxPayloadLength: maxPayloadBytes,
      backpressureLimit: options.maxPayloadBytes ? Math.max(64 * 1024, maxPayloadBytes * 4) : MAX_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open(socket) {
        const { role } = socket.data;
        pending.delete(role);
        if (peers[role]) {
          socket.close(1008, `${role} is already connected`);
          return;
        }

        peers[role] = socket;
        const peerRole = otherRole(role);
        const peer = peers[peerRole];
        socket.send(peerStatusMessage(peerRole, peer !== undefined));
        if (peer) peer.send(peerStatusMessage(role, true));
      },
      message(socket, message) {
        const size =
          typeof message === "string" ? textEncoder.encode(message).byteLength : message.byteLength;
        if (size > maxPayloadBytes) {
          socket.close(1009, "Payload too large");
          return;
        }

        const peer = peers[otherRole(socket.data.role)];
        if (!peer) return;

        // Bun queues -1 under the configured limit and closes at the limit; 0 was dropped.
        if (peer.send(message) === 0) peer.close(1013, "Unable to receive message");
      },
      close(socket) {
        const { role } = socket.data;
        if (peers[role] !== socket) return;
        peers[role] = undefined;
        peers[otherRole(role)]?.send(peerStatusMessage(role, false));
      },
    },
  });

  return { server, token };
}

function optionValue(args: string[], index: number, inline: string | undefined): string {
  const value = inline ?? args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${args[index]}`);
  return value;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { app: DEFAULT_APP_URL, help: false };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);

    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }

    const value = optionValue(args, index, inline);
    if (inline === undefined) index++;

    if (flag === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port must be an integer from 0 to 65535");
      }
      options.port = port;
    } else if (flag === "--app") {
      connectionInfo(options.port ?? DEFAULT_PORT, options.token ?? "token", value);
      options.app = value;
    } else if (flag === "--token") {
      if (!value || value.length > 512) throw new Error("--token must be 1-512 characters");
      options.token = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

export function main(args: string[] = Bun.argv.slice(2)): void {
  const options = parseCliArgs(args);
  if (options.help) {
    console.log("Usage: bun scripts/relay.ts [--port PORT] [--app URL] [--token TOKEN]");
    return;
  }

  const relay = createRelay(options);
  const port = relay.server.port ?? options.port ?? DEFAULT_PORT;
  const info = connectionInfo(port, relay.token, options.app);
  console.log(`Relay listening: ws://${RELAY_HOST}:${port}/`);
  console.log(`Browser launch URL: ${info.browserUrl}`);
  console.log(`Browser launch fragment: ${info.browserFragment}`);
  console.log(`Agent WebSocket URL: ${info.agentWebSocketUrl}`);
}

if (import.meta.main) main();
