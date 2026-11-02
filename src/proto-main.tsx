// Random numbers / the wall clock must be pinned before any third-party library, so this line goes first (see render/stageClockEntry.ts)
import "./render/stageClockEntry";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ExportView from "./ExportView";

/** Prototype entry (proto.html): ?export=1 takes the export view, otherwise the card preview App.
 *  Not wrapped in StrictMode: its fake unmount interrupts Motion's entrance animation with a delay (it would stop at initial); the export view is not wrapped either. */
const isExport = new URLSearchParams(location.search).has("export");
createRoot(document.getElementById("root")!).render(
  isExport ? <ExportView /> : <App />,
);
