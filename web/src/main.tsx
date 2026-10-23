import { createRoot } from "react-dom/client";
import { Investigation } from "./Investigation.tsx";
import { Timeline } from "./Timeline.tsx";
import "./tokens.css";

function App() {
  return (
    <main className="wrap">
      <header className="masthead">
        <picture>
          <source srcSet="/wordmark-on-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="/wordmark.png" alt="Black Box" height={44} />
        </picture>
        <p className="muted">Crash investigator for AI agents · Case BB-0417, refund agent</p>
      </header>
      <Investigation />
      <Timeline />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
