import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Investigation } from "./Investigation.tsx";
import { Timeline } from "./Timeline.tsx";
import "./tokens.css";

/** Says plainly when the app is showing recordings instead of live services, and why. */
function ModeBanner() {
  const [mode, setMode] = useState<{ replay: boolean; reason?: string }>();
  useEffect(() => { fetch("/api/mode").then((r) => r.json()).then(setMode).catch(() => {}); }, []);
  if (!mode?.replay) return null;
  return <p className="mode-banner" role="status"><b>Replay mode:</b> showing recorded runs of the live system ({mode.reason}). Every query, model reply and verdict was recorded from a real run; signing and the gate still run here.</p>;
}

function App() {
  return (
    <main className="wrap">
      <ModeBanner />
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
