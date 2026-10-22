import { createRoot } from "react-dom/client";
import "./tokens.css";

function App() {
  return (
    <main className="wrap">
      <img src="/wordmark.png" alt="Black Box" height={44} />
      <p className="muted">Crash investigator for AI agents.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
