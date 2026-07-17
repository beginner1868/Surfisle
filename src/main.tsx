import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const rootElement = document.getElementById("root") as HTMLElement;

const showDevelopmentError = (error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  document.title = `Surfisle dev error: ${message.slice(0, 120)}`;
  rootElement.replaceChildren();
  const output = document.createElement("pre");
  output.style.cssText =
    "margin:0;padding:24px;white-space:pre-wrap;color:#7f1d1d;background:#fef2f2;font:14px/1.5 Consolas,monospace;";
  output.textContent = message;
  rootElement.append(output);
};

if (import.meta.env.DEV) {
  document.title = "Surfisle React loaded";
  window.addEventListener("error", (event) => showDevelopmentError(event.error));
  window.addEventListener("unhandledrejection", (event) =>
    showDevelopmentError(event.reason),
  );
}

ReactDOM.createRoot(rootElement, {
  onUncaughtError: showDevelopmentError,
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
