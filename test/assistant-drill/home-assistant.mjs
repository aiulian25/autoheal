// A stand-in for Home Assistant inside the drill's engine: its socket as Autoheal reads it, a webhook that keeps what
// it is sent, and a way for the drill to set a Text helper, as an automation would. Run with `ws` copied beside it.
import { createServer } from "node:http";
import { WebSocketServer } from "/tmp/ws/wrapper.mjs";

const [port, token] = process.argv.slice(2);
const VERSION = "2026.11.0";
const states = new Map();
const sent = [];
// Each socket's subscription to state changes, by the id it subscribed with.
const subscribed = new Map();

const bodyOf = (request) =>
  new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

function setState(entityId, state) {
  const now = new Date().toISOString();
  const oldState = states.get(entityId) ?? null;
  const newState = { entity_id: entityId, state, attributes: {}, last_changed: now, last_updated: now };
  states.set(entityId, newState);
  const data = { entity_id: entityId, old_state: oldState, new_state: newState };
  for (const [socket, id] of subscribed) {
    socket.send(JSON.stringify({ id, type: "event", event: { event_type: "state_changed", data } }));
  }
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  const { pathname } = new URL(request.url, "http://home");
  if (request.method === "POST" && pathname.startsWith("/api/webhook/")) {
    sent.push(JSON.parse(body));
    return response.writeHead(200).end();
  }
  if (pathname === "/drill/sent") return response.writeHead(200).end(JSON.stringify(sent));
  if (request.method === "POST" && pathname === "/drill/state") {
    const { entity_id: entityId, state } = JSON.parse(body);
    setState(entityId, state);
    return response.writeHead(204).end();
  }
  response.writeHead(404).end();
});

new WebSocketServer({ server, path: "/api/websocket" }).on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "auth_required", ha_version: VERSION }));
  socket.on("close", () => subscribed.delete(socket));
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "auth") {
      const answer =
        message.access_token === token ? { type: "auth_ok", ha_version: VERSION } : { type: "auth_invalid" };
      return socket.send(JSON.stringify(answer));
    }
    if (message.type === "subscribe_events" && message.event_type === "state_changed")
      subscribed.set(socket, message.id);
    const result = message.type === "get_states" ? [...states.values()] : [];
    socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result }));
  });
});

server.listen(Number(port), "127.0.0.1");
