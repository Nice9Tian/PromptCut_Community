// The render surface's clock must be installed before motion, so this line must come first (see render/stageClockEntry.ts)
import "./render/stageClockEntry";
// The /api guard and invite code reading for online browser mode: must run before any other module is evaluated (C10a, see online/pageBoot.ts)
import "./online/pageBoot";
import { createRoot } from "react-dom/client";
import { installLocaleHeader } from "./i18n/index.ts";
import "./index.css";
import "./skins/skins.css";
import App from "./App";
import Shell from "./Shell";
import ExportView from "./ExportView";
import AudioMixView from "./AudioMixView";
import StageView from "./StageView";
import ThumbStageView from "./ThumbStageView";
import { installFocusZoomReset } from "./ui/focusZoomReset";
import { mountUpdateNotice } from "./editor/sync/UpdateNotice";
// The LAN default member source and join source are registered at the **entry** (see the file header of editor/sync/lanBoot.ts):
// they used to be written at module top level in MembersPanel / JoinPanel, which meant "whoever imports it gets LAN" ——
// on the mobile app's path neither panel is in the closure, and it only doesn't break today because Shell statically imports Editor.
// This is the only edge from core → lan, and also the cut the Lite edition (local only, no LAN) has to make.
import { ONLINE } from "./online/mode";
import { registerLanDefaults } from "./editor/sync/lanBoot";

// No StrictMode: its double mount interrupts Motion entrance animations with a delay (the card stays at initial and does not move).
// In the online build `?stage` is still needed: the same-origin single stage is an iframe of this page with `?stage=1` (src/editor/previewMode.ts)
const q = new URLSearchParams(location.search);
const view = q.has("audioMix") ? <AudioMixView /> : q.has("export") ? <ExportView /> : q.has("stage") ? (q.has("thumb") ? <ThumbStageView /> : <StageView />) : q.has("proto") ? <App /> : <Shell />;
// After a mobile browser auto-zooms on tapping an input, pull back to 100% on blur (see ui/focusZoomReset.ts)
// There is no LAN in online browser mode: members and join are handled by the real implementation registered through the cloud table
if (!ONLINE) registerLanDefaults();
installFocusZoomReset();
installLocaleHeader();
createRoot(document.getElementById("root")!).render(view);
// New-version notice bar for the online browser: mounted only on the editor page of the online build (see editor/sync/UpdateNotice.tsx);
// this file is the entry, so its import.meta.url is the entry script, which is compared with the entry in the server's version.json
mountUpdateNotice(import.meta.url);
