/**
 * Shared launch arguments for Chrome started by probes (Chrome for Testing downloaded by
 * puppeteer). Each probe's `puppeteer.launch` `args` begins with this.
 *
 * `--disable-field-trial-config`: Chrome for Testing applies Chromium experimental configuration
 * by default (dozens of experimental features enabled at once, visible in `activeFieldTrialGroups`
 * in network log constants), differing from release Chrome in users' hands. Under this
 * configuration, the online build entry script (over 4 MB) sent via chunked transfer by the site
 * service occasionally never finishes loading: the network layer receives all bytes in tens of
 * milliseconds, but the render process never accepts it, leaving the page stuck at
 * `readyState: 'interactive'` without reaching DOMContentLoaded; when the same script in the stage
 * iframe hangs, the page falls back to single stage. In stress testing
 * (`online-nav-stress-probe.mjs`), about 1%-3% of newly opened pages are affected; disabling
 * experimental configuration, switching to chrome-headless-shell, or switching to local release
 * Chrome all yield 0 occurrences. For forensics and data, see
 * `docs/archive/agent-reports/AGENT-nav-hang.md`.
 */
export const PROBE_CHROME_ARGS = Object.freeze(['--disable-field-trial-config']);
