// Standalone entry only. Next.js imports HelpApp without mounting a second React root.
import { createRoot } from "react-dom/client";
import { HelpApp } from "./App.tsx";

const mount = document.getElementById("app");
if (!mount) throw new Error("Missing standalone Help mount #app");
createRoot(mount).render(<HelpApp />);
