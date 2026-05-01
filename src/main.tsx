import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("App failed to mount: missing #root");
}

createRoot(rootElement).render(<App />);
