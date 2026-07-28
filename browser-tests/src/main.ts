import { mount } from "svelte";
import BrowserHarness from "./BrowserHarness.svelte";

const target = document.querySelector<HTMLElement>("#app");
if (target === null) throw new Error("browser test root is missing");

mount(BrowserHarness, { target });
