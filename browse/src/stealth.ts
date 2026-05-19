/**
 * Stealth init script — Layer C of GBrowser's anti-detection plan.
 *
 * D7 (codex correction, kept): we DON'T fake navigator.plugins or
 * navigator.languages — modern fingerprinters cross-check those against
 * userAgent / platform / OS, and synthesizing fixed values flags MORE
 * bot-like, not less. Plugins and languages surface their native
 * Chromium values.
 *
 * What this script DOES do (the new additions for Phase 1):
 *   1. Mask navigator.webdriver (the canonical headless tell).
 *   2. Restore window.chrome.runtime / app / csi / loadTimes — real
 *      Chrome ships them; their absence in headless/automation is a
 *      universally-checked tell. (Vendor research: Cloudflare + DataDome
 *      check chrome.runtime presence + enum shape.)
 *   3. Align Notification.permission with the Permissions API spoof
 *      that the inline addInitScript already applies — `denied` while
 *      Permissions returns `prompt` is a cross-source inconsistency
 *      detectors flag.
 *   4. Report per-install hardware values via GSTACK_HW_CONCURRENCY /
 *      GSTACK_DEVICE_MEMORY env vars (set by gbd at startup via
 *      system_profiler + sysctl). Per-install honesty avoids the
 *      cross-user fingerprint cluster a hardcoded default would create.
 *   5. Install a Function.prototype.toString Proxy that makes every
 *      patched getter report `function ... { [native code] }` at every
 *      recursion depth — defeats the well-known depth-3 detection trick
 *      (`fn.toString.toString.toString().includes('[native code]')`)
 *      that breaks naive stealth tooling.
 *
 * Codex caveat (acknowledged): a Proxy on Function.prototype.toString
 * still has detection surfaces (descriptors, Reflect.ownKeys, cross-
 * realm identity). Phase 2's C++ patches make this layer obsolete by
 * pushing the spoofs to native code where toString is truly native.
 * Until then, this is the best JS-only approach.
 */

import type { BrowserContext } from 'playwright';

/**
 * Host hardware values resolved at browser-manager startup. Values come
 * from the gbd `host_profile.go` detection (system_profiler + sysctl
 * on macOS), passed through the GSTACK_* env vars. Each field falls
 * back to a documented default if the env var is missing or unparseable.
 */
interface HostProfile {
  platform: string;
  hwConcurrency: number;
  deviceMemory: number;
}

function readHostProfile(): HostProfile {
  const env = (globalThis as any).process?.env ?? {};
  const concurrency = Number(env.GSTACK_HW_CONCURRENCY);
  const memory = Number(env.GSTACK_DEVICE_MEMORY);
  return {
    platform: env.GSTACK_PLATFORM || 'MacIntel',
    hwConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 8,
    deviceMemory: Number.isFinite(memory) && memory > 0 ? memory : 8,
  };
}

/**
 * Build the full Layer C stealth init script. The function template-
 * literal-interpolates the host values so they bake into the script the
 * page sees — process.env is not accessible from a page-world init script,
 * so values must be resolved by the browser-manager process before
 * injection.
 *
 * The script is one big self-invoking function so all the patches
 * happen atomically before any page code runs. Order matters: the
 * Function.prototype.toString Proxy installs FIRST so all subsequent
 * defineProperty getters are covered by its native-code lie.
 */
export function buildStealthScript(hw: HostProfile): string {
  return `(() => {
  // ──── Function.prototype.toString Proxy (must run first) ────
  // Make every patched getter / function below report
  // 'function NAME() { [native code] }' at every recursion depth.
  // Defeats fn.toString.toString.toString() integrity checks.
  const patchedFns = new WeakSet();
  const nativeToString = Function.prototype.toString;
  const toStringProxy = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (patchedFns.has(thisArg)) {
        const name = (thisArg && thisArg.name) || '';
        return 'function ' + name + '() { [native code] }';
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  Object.defineProperty(Function.prototype, 'toString', {
    value: toStringProxy, writable: true, configurable: true,
  });
  const markNative = (fn, name) => {
    if (name) {
      try { Object.defineProperty(fn, 'name', { value: name }); } catch {}
    }
    patchedFns.add(fn);
    return fn;
  };

  // ──── navigator.webdriver (canonical mask, kept from D7) ────
  try {
    const webdriverGetter = markNative(function() { return false; }, 'get webdriver');
    Object.defineProperty(navigator, 'webdriver', { get: webdriverGetter, configurable: true });
  } catch {}

  // ──── window.chrome.* restoration ────
  // Real Chrome ships these objects with rich enum / method shape.
  // Headless Chromium / Playwright's launch strips them. Their absence
  // is a universally-checked tell (verified in Cloudflare + DataDome
  // RE catalogs). We don't try to perfectly mimic — we ship plausible
  // shape with native-code-looking methods.
  try {
    if (!('chrome' in window)) {
      window.chrome = {};
    }
    const chrome = window.chrome;
    if (!chrome.runtime) {
      chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install',
                            SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64',
                       X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64',
                           X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
                     MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled',
                                   UPDATE_AVAILABLE: 'update_available' },
        connect: markNative(function connect() {
          throw new TypeError('Error in invocation of runtime.connect: No matching signature.');
        }, 'connect'),
        sendMessage: markNative(function sendMessage() {
          throw new TypeError('Error in invocation of runtime.sendMessage: No matching signature.');
        }, 'sendMessage'),
        id: undefined,
      };
    }
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = markNative(function csi() {
        return {
          onloadT: Date.now(),
          pageT: performance.now(),
          startE: Date.now() - 1000,
          tran: 15,
        };
      }, 'csi');
    }
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = markNative(function loadTimes() {
        const t = performance.timing;
        return {
          requestTime: t.requestStart / 1000,
          startLoadTime: t.requestStart / 1000,
          commitLoadTime: t.responseStart / 1000,
          finishDocumentLoadTime: t.domContentLoadedEventEnd / 1000,
          finishLoadTime: t.loadEventEnd / 1000,
          firstPaintTime: t.responseEnd / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      }, 'loadTimes');
    }
  } catch (err) {
    // Non-fatal — page might have a stricter Content Security Policy
    // that blocks property mutation on window. Leave chrome.* whatever
    // shape it was; navigator.webdriver mask still applies.
  }

  // ──── Notification.permission align with Permissions API ────
  // The inline addInitScript already overrides permissions.query for
  // notifications → 'prompt'. Notification.permission must match
  // ('default' in real Chrome on pages that haven't asked yet).
  try {
    if (typeof Notification !== 'undefined') {
      const notificationPermissionGetter = markNative(function() { return 'default'; }, 'get permission');
      Object.defineProperty(Notification, 'permission', {
        get: notificationPermissionGetter,
        configurable: true,
      });
    }
  } catch {}

  // ──── Per-install hardware values from GSTACK_* env (T2) ────
  // gbd's host_profile.go fed real host values via cmdline env. Reporting
  // those (not hardcoded defaults) avoids the cross-user GBrowser
  // fingerprint cluster.
  try {
    const hwConcurrencyGetter = markNative(function() { return ${hw.hwConcurrency}; }, 'get hardwareConcurrency');
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: hwConcurrencyGetter,
      configurable: true,
    });
  } catch {}
  try {
    const deviceMemoryGetter = markNative(function() { return ${hw.deviceMemory}; }, 'get deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', {
      get: deviceMemoryGetter,
      configurable: true,
    });
  } catch {}

  // ──── Selenium / Phantom / Nightmare / Playwright global cleanup ────
  // 25 Selenium globals + Playwright markers + PhantomJS/Nightmare
  // traces. The inline addInitScript already covers cdc_/__webdriver
  // dynamic prefixes — this is the static known-name list.
  try {
    const auto = [
      '__driver_evaluate', '__webdriver_evaluate', '__selenium_evaluate', '__fxdriver_evaluate',
      '__driver_unwrapped', '__webdriver_unwrapped', '__selenium_unwrapped', '__fxdriver_unwrapped',
      '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
      '$chrome_asyncScriptInfo',
      '__$webdriverAsyncExecutor', '__webdriverFunc',
      'domAutomation', 'domAutomationController',
      '__lastWatirAlert', '__lastWatirConfirm', '__lastWatirPrompt',
      '__webdriver_script_fn', '_WEBDRIVER_ELEM_CACHE',
      'callPhantom', '_phantom', 'phantom', '__nightmare',
      '__pwInitScripts', '__playwright__binding__',
    ];
    for (const k of auto) {
      try { delete window[k]; } catch {}
    }
    try { delete document.__webdriver_script_fn; } catch {}
  } catch {}
})();`;
}

/**
 * Apply stealth patches to a fresh BrowserContext (or persistent context).
 * Called by browser-manager.launch() and launchHeaded().
 *
 * Resolves the host profile from process.env at call time so per-install
 * values bake into the script before Playwright sends it to Chromium via
 * Page.addScriptToEvaluateOnNewDocument.
 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  const hw = readHostProfile();
  const script = buildStealthScript(hw);
  await context.addInitScript({ content: script });
}

/**
 * The legacy single-line webdriver mask, exported for backwards
 * compatibility with any caller that uses it directly. New callers
 * should use applyStealth() which includes this plus the Layer C
 * additions.
 */
export const WEBDRIVER_MASK_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

/**
 * Args added to chromium.launch's `args` to suppress the
 * AutomationControlled blink feature. This is independent of the init
 * script — it changes how Chromium identifies itself in the protocol layer.
 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
];

/**
 * Build the `--gstack-*=` cmdline switches that the Pack 1 Chromium
 * patches read (webgl-vendor-spoof, ua-client-hints-stealth, worker-
 * navigator-stealth). Values come from the GSTACK_* env vars that
 * gbd populates from host_profile.go at startup.
 *
 * Each switch is only emitted when its env var is non-empty — empty
 * env values fall through to the patch's "no override" path, which
 * returns the real Chromium native value. This keeps the helper safe
 * on builds that DO NOT have the C++ patches applied (gbrowser
 * pre-Pack-1) and on hosts where gbd hasn't yet populated some
 * fields (legacy installs).
 *
 * Mapping (gbd env → Chromium cmdline switch → C++ patch consumer):
 *   GSTACK_GPU_VENDOR        → --gstack-gpu-vendor        → webgl-vendor-spoof.patch
 *   GSTACK_GPU_RENDERER      → --gstack-gpu-renderer      → webgl-vendor-spoof.patch
 *   GSTACK_PLATFORM          → --gstack-ua-platform       → ua-client-hints-stealth.patch
 *                              (maps MacARM/MacIntel → "macOS")
 *   GSTACK_GPU_CHIPSET       → --gstack-ua-model          → ua-client-hints-stealth.patch
 *   GSTACK_HW_CONCURRENCY    → --gstack-hw-concurrency    → worker-navigator-stealth.patch
 *   GSTACK_DEVICE_MEMORY     → --gstack-device-memory     → worker-navigator-stealth.patch
 */
export function buildGStackLaunchArgs(): string[] {
  const env = (globalThis as any).process?.env ?? {};
  const args: string[] = [];

  const vendor = env.GSTACK_GPU_VENDOR;
  if (vendor) args.push(`--gstack-gpu-vendor=${vendor}`);

  const renderer = env.GSTACK_GPU_RENDERER;
  if (renderer) args.push(`--gstack-gpu-renderer=${renderer}`);

  // Map gbd's "MacARM"/"MacIntel" classification to the UA-CH "macOS"
  // platform string Chromium emits natively. Other future platforms
  // would map similarly (Win32 → "Windows", Linux → "Linux").
  const platform = env.GSTACK_PLATFORM;
  if (platform === 'MacARM' || platform === 'MacIntel') {
    args.push('--gstack-ua-platform=macOS');
  } else if (platform === 'Win32') {
    args.push('--gstack-ua-platform=Windows');
  } else if (platform && platform.startsWith('Linux')) {
    args.push('--gstack-ua-platform=Linux');
  }

  const chipset = env.GSTACK_GPU_CHIPSET;
  if (chipset) args.push(`--gstack-ua-model=${chipset}`);

  const hw = env.GSTACK_HW_CONCURRENCY;
  if (hw) args.push(`--gstack-hw-concurrency=${hw}`);

  const memory = env.GSTACK_DEVICE_MEMORY;
  if (memory) args.push(`--gstack-device-memory=${memory}`);

  return args;
}

/**
 * Playwright default args to strip via ignoreDefaultArgs.
 *
 * Playwright passes these by default. Each one is a visible automation
 * tell at some layer:
 *   --enable-automation                              → infobar + chrome shape
 *   --disable-extensions                             → blocks our extension
 *   --disable-component-extensions-with-background-pages → blocks component ext
 *   --disable-popup-blocking                         → automation default
 *   --disable-component-update                       → automation default
 *   --disable-default-apps                           → affects plugin enum
 *
 * Used by browser-manager via spread into ignoreDefaultArgs to keep
 * the list in one place across launchHeaded() and handoff().
 */
export const STEALTH_IGNORE_DEFAULT_ARGS = [
  '--enable-automation',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
];
