import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, getSkin, skins } from "./skins";
import { expandOverrides, subscribeOverrides } from "./overrides";

/**
 * 皮肤状态:选中的 id 存 localStorage(pc.skin);应用时把该皮肤的 --ui-* 变量逐个写到 <html>,
 * 并挂 data-skin(皮肤 id)和 data-skin-mode(dark/light)。skins.css 只按这两个属性和变量工作,
 * 所以新增皮肤只要加数据,不用改 CSS。
 */
let currentSkin = DEFAULT_SKIN;
try {
  let saved = localStorage.getItem("pc.skin");
  // 旧默认 indigo-dark 迁到 studio-dark 只在第一次启动做一回;标记不管迁没迁都写上,
  // 之后用户在皮肤里主动挑回 indigo-dark 不会再被改掉
  if (!localStorage.getItem("pc.skin.studioMigrated")) {
    if (saved === "indigo-dark") {
      saved = "studio-dark";
      localStorage.setItem("pc.skin", saved);
    }
    localStorage.setItem("pc.skin.studioMigrated", "1");
  }
  if (saved && skins.some((s) => s.id === saved)) currentSkin = saved;
} catch {
  // ignore
}

const listeners = new Set<() => void>();
let appliedVars: string[] = [];

function applySkin(id: string) {
  if (typeof document === "undefined") return;
  const skin = getSkin(id);
  const root = document.documentElement;
  for (const k of appliedVars) root.style.removeProperty(`--${k}`);
  // 预设先铺一层,用户的自定义再压上去;两层的键都记进 appliedVars,下次换皮肤好一起撤干净
  const custom = expandOverrides(skin.mode);
  const merged = { ...skin.vars, ...custom };
  appliedVars = Object.keys(merged);
  for (const [k, v] of Object.entries(merged)) root.style.setProperty(`--${k}`, v);
  root.dataset.skin = skin.id;
  root.dataset.skinMode = skin.mode;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSkin;
}

export function setSkin(id: string) {
  if (id === currentSkin || !skins.some((s) => s.id === id)) return;
  currentSkin = id;
  try {
    localStorage.setItem("pc.skin", id);
  } catch {
    // ignore
  }
  const root = document.documentElement;
  // 只在切换那一刻开 200ms 的颜色过渡,平时关掉,免得拖时间轴时每帧都在过渡
  root.classList.add("skin-swapping");
  applySkin(id);
  setTimeout(() => root.classList.remove("skin-swapping"), 200);
  listeners.forEach((l) => l());
}

applySkin(currentSkin);

// 用户改了自定义配色就地重刷,不用等换皮肤
subscribeOverrides(() => {
  applySkin(currentSkin);
  listeners.forEach((l) => l());
});

export function useSkin() {
  const skinId = useSyncExternalStore(subscribe, getSnapshot);
  return { skinId, setSkin };
}

export { skins };
