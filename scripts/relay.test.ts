import { expect, test } from "bun:test";
import {
  connectionInfo,
  createRelay,
  generateCapabilityToken,
  parseCliArgs,
  websocketUrl,
} from "./relay.ts";

interface TestClient {
  messages: unknown[];
  socket: WebSocket;
}

async function connect(url: string): Promise<TestClient> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => messages.push(event.data));

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  return { messages, socket };
}

async function nextMessage(client: TestClient): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (client.messages.length > 0) return client.messages.shift();
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for WebSocket message");
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for close")), 2_000);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

test("builds tokens, CLI options, and browser connection details", () => {
  const first = generateCapabilityToken();
  const second = generateCapabilityToken();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(second).not.toBe(first);

  expect(
    parseCliArgs(["--port=0", "--app", "https://studio.example/work", "--token", "fixed"]),
  ).toEqual({ port: 0, app: "https://studio.example/work", token: "fixed", help: false });
  expect(() => parseCliArgs(["--port", "70000"])).toThrow();
  expect(() => parseCliArgs(["--unknown", "value"])).toThrow();

  const info = connectionInfo(4321, "secret", "https://studio.example/work");
  expect(new URLSearchParams(new URL(info.browserUrl).hash.slice(1)).get("relay")).toBe(
    info.appWebSocketUrl,
  );
  expect(info.agentWebSocketUrl).toBe("ws://127.0.0.1:4321/?role=agent&token=secret");
});

test("pairs one app and agent, relays messages, and enforces limits", async () => {
  const relay = createRelay({ port: 0, token: "test-token", maxPayloadBytes: 1024 });
  const port = relay.server.port;
  expect(port).toBeNumber();
  if (port === undefined) throw new Error("Relay did not bind a port");

  let app: TestClient | undefined;
  let agent: TestClient | undefined;
  try {
    app = await connect(websocketUrl(port, "app", relay.token));
    expect(JSON.parse(String(await nextMessage(app)))).toEqual({
      type: "peer",
      role: "agent",
      connected: false,
    });

    await expect(connect(websocketUrl(port, "agent", "wrong-token"))).rejects.toThrow(
      "WebSocket connection failed",
    );
    await expect(connect(websocketUrl(port, "app", relay.token))).rejects.toThrow(
      "WebSocket connection failed",
    );

    agent = await connect(websocketUrl(port, "agent", relay.token));
    expect(JSON.parse(String(await nextMessage(agent)))).toEqual({
      type: "peer",
      role: "app",
      connected: true,
    });
    expect(JSON.parse(String(await nextMessage(app)))).toEqual({
      type: "peer",
      role: "agent",
      connected: true,
    });

    app.socket.send("from app");
    expect(await nextMessage(agent)).toBe("from app");

    agent.socket.send(new Uint8Array([1, 2, 3]));
    expect(Array.from(new Uint8Array((await nextMessage(app)) as ArrayBuffer))).toEqual([1, 2, 3]);

    const agentClosed = closed(agent.socket);
    agent.socket.close();
    await agentClosed;
    agent = undefined;
    expect(JSON.parse(String(await nextMessage(app)))).toEqual({
      type: "peer",
      role: "agent",
      connected: false,
    });

    const appClosed = closed(app.socket);
    app.socket.send("x".repeat(1025));
    expect([1006, 1009]).toContain((await appClosed).code);
    app = undefined;
  } finally {
    app?.socket.close();
    agent?.socket.close();
    await relay.server.stop(true);
  }
});
