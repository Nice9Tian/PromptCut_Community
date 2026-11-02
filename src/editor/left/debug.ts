// For automated verification only: attach the store to window so puppeteer can assert on it. Harmless in production (just two references).
import { getState, actions } from "../../store/project";
declare global { interface Window { __pcStoreLeft?: { getState: typeof getState; actions: typeof actions } } }
window.__pcStoreLeft = { getState, actions };
export {};
