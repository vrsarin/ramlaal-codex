import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initAuth } from "./auth";
import "./styles.css";

initAuth().then(
  () => createRoot(document.getElementById("root")!).render(<App />),
  (e) => {
    document.getElementById("root")!.textContent = `Sign-in is unavailable: ${e?.message ?? e}`;
  },
);
