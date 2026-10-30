/** 在线浏览器模式：由在线构建打开（c10a-contract.md 第 2 节）。桌面运行环境（桌面版、本机 dev server）恒为 false。 */
export const ONLINE: boolean = import.meta.env.VITE_PC_ONLINE === "1";
