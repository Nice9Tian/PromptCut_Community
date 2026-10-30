/**
 * 探针自己起的 Chrome(puppeteer 下载的 Chrome for Testing)共用的启动参数。各探针 `puppeteer.launch` 的 `args` 以它打头。
 *
 * `--disable-field-trial-config`:Chrome for Testing 缺省套用 Chromium 的实验配置(几十个在试的功能一起打开,
 * 网络日志常量里的 `activeFieldTrialGroups` 能看到),与用户手里的正式版 Chrome 不同。在这套配置下,站点服务用分块传输发的
 * 在线构建入口脚本(4 MB 多)会偶发永远加载不完:网络层几十毫秒就收完了全部字节,渲染进程却一直没把它收下,页面停在
 * `readyState: 'interactive'`,等不到 DOMContentLoaded;舞台 iframe 里的同一个脚本卡住时,页面退回单舞台。
 * 压测(`online-nav-stress-probe.mjs`)里新开页面约 1%～3% 中招;关掉实验配置、换 chrome-headless-shell、换本机正式版 Chrome
 * 都是 0 次。取证与数据见 `docs/archive/agent-reports/AGENT-nav-hang.md`。
 */
export const PROBE_CHROME_ARGS = Object.freeze(['--disable-field-trial-config']);
