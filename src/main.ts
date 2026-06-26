import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

type Settings = {
  enabled: boolean;
  intervalMinutes: number;
  breakMinutes: number;
  launchAtLogin: boolean;
};

type RuntimeState = {
  isRunning: boolean;
  isOnBreak: boolean;
  nextBreakAt: number | null;
  breakEndAt: number | null;
};

const SETTINGS_KEY = "cat-clock-settings-v1";
const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  intervalMinutes: 45,
  breakMinutes: 5,
  launchAtLogin: false,
};

const state: Settings & RuntimeState = {
  ...DEFAULT_SETTINGS,
  isRunning: false,
  isOnBreak: false,
  nextBreakAt: null,
  breakEndAt: null,
};

let tickTimer: number | null = null;
let openingBreak = false;

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    state.enabled = parsed.enabled !== false;
    state.intervalMinutes = clampNumber(parsed.intervalMinutes, 1, 240, DEFAULT_SETTINGS.intervalMinutes);
    state.breakMinutes = clampNumber(parsed.breakMinutes, 1, 60, DEFAULT_SETTINGS.breakMinutes);
    state.launchAtLogin = parsed.launchAtLogin === true;
  } catch (_error) {
    // Ignore malformed local settings and keep defaults.
  }
}

function saveSettings() {
  const payload: Settings = {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    breakMinutes: state.breakMinutes,
    launchAtLogin: state.launchAtLogin,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
}

function currentStatusLabel() {
  if (!state.enabled) return "OFF";
  if (state.isOnBreak) return "BREAK";
  if (state.isRunning) return "ON";
  return "PAUSE";
}

async function syncTrayState() {
  try {
    await invoke("update_tray_state", {
      statusLabel: currentStatusLabel(),
      isRunning: state.isRunning,
    });
  } catch (_error) {
    // Keep UI responsive even if tray update fails.
  }
}

function formatMsAsClock(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function resetNextBreak() {
  state.nextBreakAt = Date.now() + state.intervalMinutes * 60 * 1000;
}

function updateStatusView() {
  const statusText = document.getElementById("statusText");
  const nextBreakText = document.getElementById("nextBreakText");
  if (!statusText || !nextBreakText) return;

  if (!state.enabled) {
    statusText.textContent = "Disabled";
    nextBreakText.textContent = "";
    void syncTrayState();
    return;
  }

  if (state.isOnBreak && state.breakEndAt) {
    statusText.textContent = "On Break";
    nextBreakText.textContent = `Break remaining: ${formatMsAsClock(state.breakEndAt - Date.now())}`;
    void syncTrayState();
    return;
  }

  if (state.isRunning && state.nextBreakAt) {
    statusText.textContent = "Running";
    nextBreakText.textContent = `Next break in: ${formatMsAsClock(state.nextBreakAt - Date.now())}`;
    void syncTrayState();
    return;
  }

  statusText.textContent = "Paused";
  nextBreakText.textContent = "";
  void syncTrayState();
}

function syncForm() {
  const enabledInput = document.getElementById("enabled") as HTMLInputElement | null;
  const intervalInput = document.getElementById("intervalMinutes") as HTMLInputElement | null;
  const breakInput = document.getElementById("breakMinutes") as HTMLInputElement | null;
  const launchAtLoginInput = document.getElementById("launchAtLogin") as HTMLInputElement | null;
  if (!enabledInput || !intervalInput || !breakInput || !launchAtLoginInput) return;

  enabledInput.checked = !!state.enabled;
  intervalInput.value = String(state.intervalMinutes);
  breakInput.value = String(state.breakMinutes);
  launchAtLoginInput.checked = !!state.launchAtLogin;
}

async function openBreakWindow() {
  if (openingBreak || state.isOnBreak) return;
  openingBreak = true;
  state.isOnBreak = true;
  state.breakEndAt = Date.now() + state.breakMinutes * 60 * 1000;
  state.nextBreakAt = null;
  updateStatusView();
  try {
    await invoke("open_break_window", { breakMinutes: state.breakMinutes });
  } catch (error) {
    console.error("Failed to open break window:", error);
    state.isOnBreak = false;
    state.breakEndAt = null;
    resetNextBreak();
  } finally {
    openingBreak = false;
    updateStatusView();
  }
}

async function finishBreak() {
  state.isOnBreak = false;
  state.breakEndAt = null;
  resetNextBreak();
  updateStatusView();
  try {
    await invoke("close_break_window");
  } catch (_error) {
    // Ignore if break window is already closed.
  }
}

function startTimer() {
  if (!state.enabled) return;
  state.isRunning = true;
  if (!state.nextBreakAt) {
    resetNextBreak();
  }
  updateStatusView();
}

function pauseTimer() {
  state.isRunning = false;
  updateStatusView();
}

async function skipCycle() {
  if (state.isOnBreak) {
    await finishBreak();
  }
  resetNextBreak();
  updateStatusView();
}

function startTick() {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
  }
  tickTimer = window.setInterval(async () => {
    if (!state.enabled) {
      updateStatusView();
      return;
    }

    if (state.isOnBreak && state.breakEndAt) {
      if (Date.now() >= state.breakEndAt) {
        await finishBreak();
      }
      updateStatusView();
      return;
    }

    if (!state.isRunning) {
      updateStatusView();
      return;
    }

    if (!state.nextBreakAt) {
      resetNextBreak();
      updateStatusView();
      return;
    }

    if (Date.now() >= state.nextBreakAt) {
      await openBreakWindow();
      return;
    }

    updateStatusView();
  }, 1000);
}

function renderMainPanel() {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    <section class="panel">
      <h1>Cat Clock Tauri v2</h1>
      <p class="subtitle">Ultra-simple desktop break reminder</p>

      <label>
        <span>Enable reminders</span>
        <input id="enabled" type="checkbox" />
      </label>

      <label>
        <span>Work interval (minutes)</span>
        <input id="intervalMinutes" type="number" min="1" max="240" value="45" />
      </label>

      <label>
        <span>Break duration (minutes)</span>
        <input id="breakMinutes" type="number" min="1" max="60" value="5" />
      </label>

      <label>
        <span>Launch at login</span>
        <input id="launchAtLogin" type="checkbox" />
      </label>

      <div class="actions">
        <button id="saveBtn">Save</button>
        <button id="startBtn">Start</button>
        <button id="pauseBtn">Pause</button>
        <button id="skipBtn">Skip</button>
      </div>

      <section class="status">
        <h2>Status</h2>
        <p id="statusText">Loading...</p>
        <p id="nextBreakText"></p>
      </section>

      <p class="footnote">Tray menu is enabled. Close window to keep app running in tray.</p>
    </section>
  `;

  syncForm();
  updateStatusView();

  document.getElementById("saveBtn")?.addEventListener("click", () => {
    const enabledInput = document.getElementById("enabled") as HTMLInputElement | null;
    const intervalInput = document.getElementById("intervalMinutes") as HTMLInputElement | null;
    const breakInput = document.getElementById("breakMinutes") as HTMLInputElement | null;
    const launchAtLoginInput = document.getElementById("launchAtLogin") as HTMLInputElement | null;
    if (!enabledInput || !intervalInput || !breakInput || !launchAtLoginInput) return;

    state.enabled = enabledInput.checked;
    state.intervalMinutes = clampNumber(intervalInput.value, 1, 240, DEFAULT_SETTINGS.intervalMinutes);
    state.breakMinutes = clampNumber(breakInput.value, 1, 60, DEFAULT_SETTINGS.breakMinutes);
    state.launchAtLogin = launchAtLoginInput.checked;
    void invoke("set_launch_at_login", { enabled: state.launchAtLogin });
    saveSettings();

    if (!state.enabled) {
      state.isRunning = false;
    } else if (!state.isOnBreak) {
      resetNextBreak();
    }

    syncForm();
    updateStatusView();
  });

  document.getElementById("startBtn")?.addEventListener("click", () => {
    startTimer();
  });

  document.getElementById("pauseBtn")?.addEventListener("click", () => {
    pauseTimer();
  });

  document.getElementById("skipBtn")?.addEventListener("click", () => {
    void skipCycle();
  });
}

async function initializeMainWindow() {
  loadSettings();
  try {
    const launchEnabled = await invoke<boolean>("get_launch_at_login");
    state.launchAtLogin = launchEnabled;
  } catch (_error) {
    // Keep saved value when backend query fails.
  }
  renderMainPanel();
  startTick();
  startTimer();

  await listen<string>("tray-action", async (event) => {
    const action = event.payload;
    if (action === "toggle-timer") {
      if (state.isRunning) {
        pauseTimer();
      } else {
        startTimer();
      }
      return;
    }
    if (action === "skip-cycle") {
      await skipCycle();
    }
  });

  await listen("break-end-now", async () => {
    await finishBreak();
  });
}

function initializeBreakWindow() {
  const app = document.getElementById("app");
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const breakMinutes = clampNumber(params.get("minutes") ?? "5", 1, 60, 5);

  app.className = "break-page";
  app.innerHTML = `
    <main class="break-wrap">
      <div id="mediaContainer" class="media-container">
        <canvas id="videoCanvas" class="break-canvas"></canvas>
        <div id="fallback" class="fallback-content" style="display:none">
          <div class="cat">=^.^=</div>
        </div>
      </div>
      <h1>Break Time</h1>
      <p>Look away from screen, relax your eyes and neck.</p>
      <p class="timer" id="timer">--:--</p>
      <button id="endNowBtn">End Break Now</button>
    </main>
  `;

  const timerNode = document.getElementById("timer");
  const endNowBtn = document.getElementById("endNowBtn");
  const canvas = document.getElementById("videoCanvas") as HTMLCanvasElement | null;
  const fallback = document.getElementById("fallback") as HTMLElement | null;

  if (!timerNode || !endNowBtn || !canvas || !fallback) {
    return;
  }

  const ctx = canvas.getContext("2d");

  // WKWebView's DOM VideoLayer compositor discards VP9A alpha when compositing.
  // Routing drawImage through Canvas 2D bypasses that layer and preserves alpha.
  const introVideo = document.createElement("video");
  const loopVideo = document.createElement("video");
  introVideo.muted = true;
  introVideo.playsInline = true;
  loopVideo.muted = true;
  loopVideo.playsInline = true;
  loopVideo.loop = true;

  let rafId: number | null = null;

  const startRender = (video: HTMLVideoElement) => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    const draw = () => {
      if (ctx && video.readyState >= 2 && video.videoWidth > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0);
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
  };

  const showFallback = () => {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    canvas.style.display = "none";
    fallback.style.display = "grid";
  };

  const initializeVideos = async () => {
    introVideo.src = "/assets/assets1.webm";
    loopVideo.src = "/assets/assets2.webm";
    introVideo.load();
    loopVideo.load();

    introVideo.addEventListener("error", () => showFallback());
    loopVideo.addEventListener("error", () => showFallback());

    introVideo.addEventListener("ended", () => {
      loopVideo.play().then(() => startRender(loopVideo)).catch(() => showFallback());
    }, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        introVideo.addEventListener("loadeddata", () => resolve(), { once: true });
        introVideo.addEventListener("error", () => reject(new Error("load failed")), { once: true });
      });
      await introVideo.play();
      startRender(introVideo);
    } catch (_error) {
      showFallback();
    }
  };

  let remainingSeconds = breakMinutes * 60;
  const updateCountdown = () => {
    const m = Math.floor(remainingSeconds / 60);
    const s = remainingSeconds % 60;
    timerNode.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (remainingSeconds <= 0) {
      void emit("break-end-now");
      void invoke("close_break_window");
      return;
    }
    remainingSeconds -= 1;
  };

  updateCountdown();
  const interval = window.setInterval(updateCountdown, 1000);

  endNowBtn.addEventListener("click", async () => {
    window.clearInterval(interval);
    if (rafId !== null) cancelAnimationFrame(rafId);
    await emit("break-end-now");
    await invoke("close_break_window");
  });

  void initializeVideos();
}

window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("break") === "1") {
    initializeBreakWindow();
    return;
  }
  void initializeMainWindow();
});
