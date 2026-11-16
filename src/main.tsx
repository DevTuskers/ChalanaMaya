import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/kalam/latin-400.css";
import "@fontsource/kalam/latin-700.css";
import "@fontsource/source-sans-3/latin-400.css";
import "@fontsource/source-sans-3/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./ui/styles.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
