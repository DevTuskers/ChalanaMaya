import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/kalam/latin-400.css";
import "@fontsource/kalam/latin-700.css";
import "@fontsource/source-sans-3/latin-400.css";
import "@fontsource/source-sans-3/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./ui/styles.css";
import { App } from "./App";
import { Boot } from "./sync/Boot";
import { installCanvasMeasure } from "./ui/measure";

installCanvasMeasure();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <Boot render={(boot) => <App key={boot.id} boot={boot} />} />
  </StrictMode>,
);
