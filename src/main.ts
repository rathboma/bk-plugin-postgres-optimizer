import "@beekeeperstudio/plugin/dist/eventForwarder";
import { addNotificationListener, log } from "@beekeeperstudio/plugin";
import { createApp } from "vue";
import App from "./App.vue";
import { themeCss } from "./host/beekeeper";
import "./ui/styles/main.css";

window.addEventListener("error", (e) => log.error(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => log.error(e.reason));

function applyTheme(css: string | null) {
  if (css) document.querySelector("#app-theme")!.textContent = `:root { ${css} }`;
}

void themeCss().then(applyTheme);
addNotificationListener("themeChanged", (theme) => applyTheme(theme.cssString));

createApp(App).mount("#app");
