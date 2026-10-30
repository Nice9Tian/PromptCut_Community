// 仅供自动化验证用:把 store 挂到 window,方便 puppeteer 断言。生产里无害(只是两个引用)。
import { getState, actions } from "../../store/project";
declare global { interface Window { __pcStoreLeft?: { getState: typeof getState; actions: typeof actions } } }
window.__pcStoreLeft = { getState, actions };
export {};
