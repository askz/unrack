import { mount } from "svelte";
import App from "./App.svelte";
import { device } from "./state/device.svelte.ts";
import { bridge } from "./esp/bridge.svelte.ts";
import { demoRequested, startupPlan } from "./state/startup.ts";
import "./theme.css";

const app = mount(App, { target: document.getElementById("app")! });
(globalThis as Record<string, unknown>).device = device; // console handle for hardware debugging

// On the ESP32 build the session comes first: the login screen appears when there is none.
// Elsewhere an already-granted device is bound on load (no prompt), and future plug-ins;
// the web build runs the demo when there is no granted device.
async function start(): Promise<void> {
  const plan = startupPlan({ bridge: bridge.active, demoAvailable: device.demoAvailable, demoRequested: demoRequested(location.search) });
  if (plan === "bridge") await bridge.start();
  else if (plan === "demo") await device.connectDemo();
  else if (plan === "device") await device.autoConnect();
  else if (!(await device.autoConnect())) await device.connectDemo();
}

void start();
export default app;
