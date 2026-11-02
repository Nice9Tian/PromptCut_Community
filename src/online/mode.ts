/** Online browser mode: enabled by online build (c10a-contract.md Section 2). Always false in desktop runtime environments (desktop app, local dev server). */
export const ONLINE: boolean = import.meta.env.VITE_PC_ONLINE === "1";
