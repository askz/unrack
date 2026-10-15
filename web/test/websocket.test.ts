import { test } from "node:test";
import assert from "node:assert/strict";
import { WsLink, type WsSocket } from "../src/transport/websocket.ts";
import { RequestChannel } from "../src/transport/channel.ts";
import { EspApiError, bridgeUrl, describeError, passwordProblem } from "../src/esp/api.ts";
import { getStatusFrame } from "../src/protocol/control.ts";
import { MockDsp } from "../src/transport/mock.ts";

class FakeSocket implements WsSocket {
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", {});
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  text(message: object): void { this.fire("message", { data: JSON.stringify(message) }); }
  binary(report: Uint8Array): void {
    this.readyState = 1;
    this.fire("message", { data: report.buffer.slice(report.byteOffset, report.byteOffset + report.byteLength) });
  }
}

function setup() {
  const socket = new FakeSocket();
  const link = new WsLink("ws://dsp/ws", () => socket);
  return { socket, link };
}

test("open resolves on a hello with the DSP attached", async () => {
  const { socket, link } = setup();
  const opening = link.open();
  socket.readyState = 1;
  socket.text({ type: "hello", usb: true, fw: "0.1.0" });
  await opening;
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(link.bridgeFirmware, "0.1.0");
});

test("open rejects when the ESP has no DSP attached", async () => {
  const { socket, link } = setup();
  const opening = link.open();
  socket.text({ type: "hello", usb: false });
  await assert.rejects(opening, /not connected to the ESP32/);
  assert.equal(socket.closed, true);
});

test("open rejects when the server refuses the handshake", async () => {
  const { socket, link } = setup();
  const opening = link.open();
  socket.fire("close", {});
  await assert.rejects(opening, /log in first/);
});

test("binary messages are delivered as reports and writes go out as binary", async () => {
  const { socket, link } = setup();
  const reports: Uint8Array[] = [];
  link.onReport((report) => reports.push(report));
  const opening = link.open();
  socket.readyState = 1;
  socket.text({ type: "hello", usb: true });
  await opening;

  const inbound = new Uint8Array(64).fill(7);
  socket.binary(inbound);
  socket.binary(new Uint8Array(10)); // wrong size: ignored
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], inbound);

  const outbound = new Uint8Array(64).fill(3);
  await link.write(outbound);
  assert.deepEqual(socket.sent[0], outbound);
});

test("write fails when the socket is not open", async () => {
  const { link } = setup();
  await assert.rejects(link.write(new Uint8Array(64)), /not connected/);
});

test("takeover, unplug and socket loss each end the link once with a reason", async () => {
  for (const [event, expected] of [
    [{ type: "evicted" }, /Another browser/],
    [{ type: "usb", connected: false }, /unplugged/],
  ] as const) {
    const { socket, link } = setup();
    const reasons: (string | undefined)[] = [];
    link.onDisconnect((reason) => reasons.push(reason));
    const opening = link.open();
    socket.readyState = 1;
    socket.text({ type: "hello", usb: true });
    await opening;
    socket.text(event);
    socket.fire("close", {});
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, expected);
  }

  const { socket, link } = setup();
  const reasons: (string | undefined)[] = [];
  link.onDisconnect((reason) => reasons.push(reason));
  const opening = link.open();
  socket.readyState = 1;
  socket.text({ type: "hello", usb: true });
  await opening;
  socket.fire("close", {});
  assert.match(reasons[0]!, /closed/);
});

test("closing on purpose does not report a disconnect", async () => {
  const { socket, link } = setup();
  const reasons: (string | undefined)[] = [];
  link.onDisconnect((reason) => reasons.push(reason));
  const opening = link.open();
  socket.readyState = 1;
  socket.text({ type: "hello", usb: true });
  await opening;
  await link.close();
  assert.equal(reasons.length, 0);
});

test("the request channel adds the link's network slack to every reply timeout", async () => {
  const mock = new MockDsp();
  await mock.open();
  mock.unresponsive = true;
  const link = Object.assign(Object.create(mock) as MockDsp, { timeoutSlackMs: 120 });
  const channel = new RequestChannel(link);
  const frame = getStatusFrame();
  const started = performance.now();
  await assert.rejects(channel.request(frame, { timeoutMs: 40, attempts: 1 }), /no reply within 160 ms/);
  assert.ok(performance.now() - started >= 150);
  channel.close();
});

test("bridgeUrl follows the page protocol", () => {
  assert.equal(bridgeUrl({ protocol: "http:", host: "192.168.4.1" }), "ws://192.168.4.1/ws");
  assert.equal(bridgeUrl({ protocol: "https:", host: "opendsp.local" }), "wss://opendsp.local/ws");
});

test("password validation reports the first problem", () => {
  const limits = { min: 8, max: 12 };
  assert.match(passwordProblem("short", "short", limits), /at least 8/);
  assert.match(passwordProblem("x".repeat(13), "x".repeat(13), limits), /at most 12/);
  assert.match(passwordProblem("longenough", "different1", limits), /differ/);
  assert.equal(passwordProblem("longenough", "longenough", limits), "");
});

test("API error codes are explained in plain words", () => {
  assert.match(describeError(new EspApiError(401, "bad_password")), /Wrong password/);
  assert.match(describeError(new EspApiError(500, "something_new")), /something_new/);
  assert.equal(describeError(new Error("offline")), "offline");
});
