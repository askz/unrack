import { mount } from "svelte";
import App from "./App.svelte";
import { device } from "./state/device.svelte.ts";
import { bridge } from "./esp/bridge.svelte.ts";
import "./theme.css";

const app = mount(App, { target: document.getElementById("app")! });
(globalThis as Record<string, unknown>).device = device; // console handle for hardware debugging
// Bind an already-granted device on load (no prompt), and future plug-ins. On the ESP32 build the
// session comes first: the login screen appears when there is none.
if (bridge.active) void bridge.start();
else void device.autoConnect();
export default app;
