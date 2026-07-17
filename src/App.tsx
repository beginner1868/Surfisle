import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  CalendarDays,
  Check,
  ChevronUp,
  ClipboardList,
  Copy,
  ExternalLink,
  GripVertical,
  ImageIcon,
  Keyboard,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  SkipBack,
  SkipForward,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

export type IslandMode = "collapsed" | "expanded";

type IslandPage = "todo" | "music" | "clipboard" | "layout";
type SettingsCategory =
  | "appearance"
  | "todo"
  | "clipboard"
  | "integrations"
  | "about";
type TodoPageMode = "today" | "archive" | "review";
type MediaPlaybackStatus = "unavailable" | "playing" | "paused";
type AgentProvider = "codex" | "claudeCode" | "opencode";
type AgentTaskPhase = "idle" | "running" | "completed" | "failed" | "stale";
type AgentVisualState = "idle" | "running" | "attention";

type TodoItem = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
};

type TodoArchive = {
  date: string;
  todos: TodoItem[];
  dailyNote: string;
  savedAt: number;
  savedToDisk: boolean;
  filePath?: string;
};

type SaveState = "idle" | "saving" | "saved" | "needs-path" | "error";
type SavePathState = "idle" | "saved";

type SaveTodoResult = {
  filePath: string;
};

type MediaState = {
  available: boolean;
  audioActive: boolean;
  audioPeak: number;
  audioBands: number[];
  mediaTitle: string;
  mediaArtist: string;
  sourceApp: string;
  playbackStatus: MediaPlaybackStatus;
  updatedAt: number;
};

type LyricsSearchResult = {
  id: number;
  trackName: string;
  artistName: string;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

type LyricsState =
  | { status: "idle" | "loading" | "empty" | "error" }
  | { status: "ready"; result: LyricsSearchResult; lines: LyricLine[] };

type LyricLine = {
  timeMs: number | null;
  text: string;
};

type MediaStateSnapshot = Omit<MediaState, "audioBands"> & {
  audioBands?: number[];
};

type ClipboardHistorySettings = {
  enabled: boolean;
  captureImages: boolean;
  maxItems: number;
  shortcut: string;
};

type ClipboardHistoryImage = {
  width: number;
  height: number;
  byteSize: number;
  originalPath: string;
  thumbnailPath: string;
  thumbnailDataUrl?: string;
};

type ClipboardHistoryItem = {
  id: string;
  kind: "text" | "image";
  hash: string;
  createdAt: number;
  copiedAt: number;
  favorite?: boolean;
  preview: string;
  text?: string;
  image?: ClipboardHistoryImage;
};

type ClipboardHistorySnapshot = {
  settings: ClipboardHistorySettings;
  items: ClipboardHistoryItem[];
};

type AudioSpectrum = {
  active: boolean;
  peak: number;
  bands: number[];
  updatedAt: number;
};

type AgentTaskStatus = {
  phase: AgentTaskPhase;
  taskId?: string;
  updatedAt: number;
};

type AgentStatusSnapshot = Record<AgentProvider, AgentTaskStatus> & {
  updatedAt: number;
  statusPath: string;
};

type AgentHooksInstallResult = {
  scriptsDir: string;
  statusPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  opencodePluginPath: string;
  installedAt: number;
};

type AgentHooksInstallState = "idle" | "installing" | "installed" | "error";

type IslandSettings = {
  opacity: number;
  sizeScale: number;
  marginY: number;
  todoPageHeight: number;
  musicPageHeight: number;
  clipboardPageHeight: number;
  settingsPageHeight: number;
  taskTextColor: string;
  pulseColor: string;
  pulseBrightness: number;
  islandBackgroundColor: string;
  todoBackgroundColor: string;
  showTitle: boolean;
  carryOverIncompleteTodos: boolean;
  enableTodoReorder: boolean;
  strongCompletionAlert: boolean;
  completionSoundEnabled: boolean;
  monitorIndex: number;
};

type MonitorInfo = {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
};

type IslandPreset = {
  id: string;
  name: string;
  settings: IslandSettings;
  createdAt: number;
  isDefault?: boolean;
};

type IslandShellProps = {
  mode: IslandMode;
  page: IslandPage;
  isTucked: boolean;
  showTitle: boolean;
  activeTaskTitle: string | null;
  pendingTodoCount: number;
  mediaState: MediaState;
  agentVisualState: AgentVisualState;
  agentStatusLabel: string;
  completionAlertToken: number;
  onOpenPage: (page: IslandPage) => void;
  onCollapse: () => void;
  onMinimize: () => void;
  onTuck: () => void;
  onReveal: () => void;
  onPageChange: (page: IslandPage) => void;
  children: ReactNode;
};

const STORAGE_KEY = "surfisle-settings";
const SETTINGS_PRESETS_STORAGE_KEY = "surfisle-setting-presets";
const TODOS_STORAGE_KEY = "surfisle-todos";
const ACTIVE_TODO_STORAGE_KEY = "surfisle-active-todo";
const TODO_DATE_STORAGE_KEY = "surfisle-current-date";
const TODO_ARCHIVE_STORAGE_KEY = "surfisle-archives";
const DAILY_NOTE_STORAGE_KEY = "surfisle-daily-note";
const TODO_SAVE_DIRECTORY_STORAGE_KEY = "surfisle-save-directory";
const LAUNCH_AT_STARTUP_INITIALIZED_STORAGE_KEY =
  "surfisle-launch-at-startup-initialized";
const TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY =
  "surfisle-last-saved-signature";
const TODO_EXPANDED_ISLAND_HEIGHT = 430;
const MUSIC_EXPANDED_ISLAND_HEIGHT = 430;
const CLIPBOARD_EXPANDED_ISLAND_HEIGHT = 430;
const EDITOR_EXPANDED_ISLAND_HEIGHT = 430;
const MIN_EXPANDED_ISLAND_HEIGHT = 306;
const MAX_EXPANDED_ISLAND_HEIGHT = 520;
const TODO_TITLE_CHARACTERS_PER_LINE = 32;
const TODO_MAX_ESTIMATED_TITLE_LINES = 5;
const TODO_SCROLL_START_ROWS = 6;
const MAX_CUSTOM_SETTING_PRESETS = 6;
const DEFAULT_TASK_TEXT_COLOR = "#1afbff";
const DEFAULT_CLIPBOARD_SHORTCUT = "Ctrl+Q";
const AUDIO_ACTIVE_THRESHOLD = 0.000015;
const AUDIO_SPECTRUM_BAND_COUNT = 31;
const lyricsCache = new Map<string, LyricsSearchResult | null>();
const EMPTY_AUDIO_BANDS = Array.from(
  { length: AUDIO_SPECTRUM_BAND_COUNT },
  () => 0,
);
const DEFAULT_MEDIA_STATE: MediaState = {
  available: false,
  audioActive: false,
  audioPeak: 0,
  audioBands: EMPTY_AUDIO_BANDS,
  mediaTitle: "",
  mediaArtist: "",
  sourceApp: "",
  playbackStatus: "unavailable",
  updatedAt: 0,
};
const DEFAULT_AGENT_TASK_STATUS: AgentTaskStatus = {
  phase: "idle",
  updatedAt: 0,
};
const DEFAULT_AGENT_STATUS: AgentStatusSnapshot = {
  codex: DEFAULT_AGENT_TASK_STATUS,
  claudeCode: DEFAULT_AGENT_TASK_STATUS,
  opencode: DEFAULT_AGENT_TASK_STATUS,
  updatedAt: 0,
  statusPath: "",
};
const AGENT_PROVIDERS: AgentProvider[] = ["codex", "claudeCode", "opencode"];
const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: "Codex",
  claudeCode: "Claude Code",
  opencode: "OpenCode",
};
const AUTHOR_URL = "https://github.com/beginner1868";
const DEFAULT_CLIPBOARD_HISTORY: ClipboardHistorySnapshot = {
  settings: {
    enabled: true,
    captureImages: true,
    maxItems: 30,
    shortcut: DEFAULT_CLIPBOARD_SHORTCUT,
  },
  items: [],
};
const DEFAULT_SETTINGS: IslandSettings = {
  opacity: 100,
  sizeScale: 1,
  marginY: 10,
  todoPageHeight: TODO_EXPANDED_ISLAND_HEIGHT,
  musicPageHeight: MUSIC_EXPANDED_ISLAND_HEIGHT,
  clipboardPageHeight: CLIPBOARD_EXPANDED_ISLAND_HEIGHT,
  settingsPageHeight: EDITOR_EXPANDED_ISLAND_HEIGHT,
  taskTextColor: DEFAULT_TASK_TEXT_COLOR,
  pulseColor: "#49e18f",
  pulseBrightness: 100,
  islandBackgroundColor: "#101013",
  todoBackgroundColor: "#ffffff",
  showTitle: true,
  carryOverIncompleteTodos: false,
  enableTodoReorder: false,
  strongCompletionAlert: false,
  completionSoundEnabled: false,
  monitorIndex: 0,
};
const LEGACY_DEFAULT_PRESET_IDS = new Set(["default-white", "default-khaki"]);
const LEGACY_DEFAULT_PRESET_NAMES = new Set(["白色", "卡其"]);

type LegacyIslandSettings = Partial<IslandSettings> & {
  margin?: number;
  taskTitleColor?: string;
  pendingTodoColor?: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

function createCenteredWaveLevels(audioBands: number[], barCount: number) {
  const safeAudioBands = Array.isArray(audioBands) ? audioBands : EMPTY_AUDIO_BANDS;
  const spectrumPeak = safeAudioBands.reduce(
    (peak, band) => Math.max(peak, Number.isFinite(band) ? band : 0),
    0,
  );
  const centerIndex = (barCount - 1) / 2;

  return Array.from({ length: barCount }, (_, index) => {
    const distanceFromCenter =
      centerIndex === 0 ? 0 : Math.abs(index - centerIndex) / centerIndex;
    const spectrumIndex = Math.min(
      safeAudioBands.length - 1,
      Math.round(distanceFromCenter * (safeAudioBands.length - 1)),
    );
    const bandLevel = safeAudioBands[spectrumIndex] ?? 0;
    const signalLevel = Math.max(bandLevel * 0.72, spectrumPeak * 0.55);
    const centerFalloff =
      0.025 + Math.pow(1 - distanceFromCenter, 1.85) * 0.975;

    return clamp(signalLevel * centerFalloff, 0, 1);
  });
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function getColorSetting(value: unknown, fallback: string) {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value
    : fallback;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAgentAttentionPhase(phase: AgentTaskPhase) {
  return phase === "failed" || phase === "stale";
}

function getAgentVisualState(snapshot: AgentStatusSnapshot): AgentVisualState {
  const statuses = AGENT_PROVIDERS.map((provider) => snapshot[provider]);

  if (statuses.some((status) => isAgentAttentionPhase(status.phase))) {
    return "attention";
  }

  if (statuses.some((status) => status.phase === "running")) {
    return "running";
  }

  return "idle";
}

function getAgentStatusLabel(snapshot: AgentStatusSnapshot) {
  const attentionProvider = AGENT_PROVIDERS.find((provider) =>
    isAgentAttentionPhase(snapshot[provider].phase),
  );

  if (attentionProvider) {
    const phase = snapshot[attentionProvider].phase;
    return phase === "stale"
      ? `${AGENT_PROVIDER_LABELS[attentionProvider]} 可能已中断`
      : `${AGENT_PROVIDER_LABELS[attentionProvider]} 运行失败`;
  }

  const runningProvider = AGENT_PROVIDERS.find(
    (provider) => snapshot[provider].phase === "running",
  );

  if (runningProvider) {
    return `${AGENT_PROVIDER_LABELS[runningProvider]} 正在运行`;
  }

  return "AI Agent 空闲或已完成";
}

function getAgentPhaseLabel(phase: AgentTaskPhase) {
  switch (phase) {
    case "running":
      return "正在运行";
    case "completed":
      return "已完成";
    case "failed":
      return "运行失败";
    case "stale":
      return "可能已中断";
    case "idle":
    default:
      return "空闲";
  }
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = HEX_COLOR_PATTERN.test(hex)
    ? hex.slice(1)
    : DEFAULT_SETTINGS.pulseColor.slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

const MODIFIER_KEY_NAMES = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);

function normalizeShortcutKeyLabel(key: string) {
  if (key.length === 1) {
    return key.toUpperCase();
  }

  switch (key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    default:
      return key;
  }
}

function buildShortcutFromEvent(event: ShortcutKeyboardEvent) {
  if (MODIFIER_KEY_NAMES.has(event.key)) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey) {
    parts.push("Ctrl");
  }

  if (event.altKey) {
    parts.push("Alt");
  }

  if (event.shiftKey) {
    parts.push("Shift");
  }

  if (event.metaKey) {
    parts.push("Win");
  }

  if (parts.length === 0) {
    return null;
  }

  parts.push(normalizeShortcutKeyLabel(event.key));
  return parts.join("+");
}

function normalizeClipboardShortcut(shortcut: string | undefined) {
  const text = shortcut?.trim();

  if (!text) {
    return DEFAULT_CLIPBOARD_SHORTCUT;
  }

  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers = new Set<string>();
  let keyLabel = "";

  for (const part of parts) {
    const normalized = part.toLowerCase();

    if (normalized === "ctrl" || normalized === "control") {
      modifiers.add("Ctrl");
    } else if (normalized === "alt" || normalized === "option") {
      modifiers.add("Alt");
    } else if (normalized === "shift") {
      modifiers.add("Shift");
    } else if (
      normalized === "win" ||
      normalized === "windows" ||
      normalized === "meta" ||
      normalized === "cmd" ||
      normalized === "super"
    ) {
      modifiers.add("Win");
    } else if (!keyLabel) {
      keyLabel = normalizeShortcutKeyLabel(part);
    }
  }

  if (!keyLabel || modifiers.size === 0) {
    return DEFAULT_CLIPBOARD_SHORTCUT;
  }

  return ["Ctrl", "Alt", "Shift", "Win"]
    .filter((modifier) => modifiers.has(modifier))
    .concat(keyLabel)
    .join("+");
}

function normalizeClipboardSettings(
  settings: ClipboardHistorySettings,
): ClipboardHistorySettings {
  return {
    ...settings,
    maxItems: clamp(Math.round(settings.maxItems), 5, 200),
    shortcut: normalizeClipboardShortcut(settings.shortcut),
  };
}

function matchesClipboardShortcut(
  event: KeyboardEvent,
  shortcut: string | undefined,
) {
  if (isEditableTarget(event.target)) {
    return false;
  }

  return (
    buildShortcutFromEvent(event) === normalizeClipboardShortcut(shortcut)
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function normalizeSettings(
  settings: LegacyIslandSettings | null | undefined,
): IslandSettings {
  const taskTextColor = getColorSetting(
    settings?.taskTextColor ?? settings?.pendingTodoColor,
    getColorSetting(settings?.taskTitleColor, DEFAULT_SETTINGS.taskTextColor),
  );

  return {
    opacity: clamp(Number(settings?.opacity ?? DEFAULT_SETTINGS.opacity), 50, 100),
    sizeScale: clamp(
      Number(settings?.sizeScale ?? DEFAULT_SETTINGS.sizeScale),
      0.75,
      1.4,
    ),
    marginY: clamp(
      Number(settings?.marginY ?? settings?.margin ?? DEFAULT_SETTINGS.marginY),
      0,
      160,
    ),
    todoPageHeight: clamp(
      Number(settings?.todoPageHeight ?? DEFAULT_SETTINGS.todoPageHeight),
      MIN_EXPANDED_ISLAND_HEIGHT,
      MAX_EXPANDED_ISLAND_HEIGHT,
    ),
    musicPageHeight: clamp(
      Number(settings?.musicPageHeight ?? DEFAULT_SETTINGS.musicPageHeight),
      MIN_EXPANDED_ISLAND_HEIGHT,
      MAX_EXPANDED_ISLAND_HEIGHT,
    ),
    clipboardPageHeight: clamp(
      Number(
        settings?.clipboardPageHeight ?? DEFAULT_SETTINGS.clipboardPageHeight,
      ),
      MIN_EXPANDED_ISLAND_HEIGHT,
      MAX_EXPANDED_ISLAND_HEIGHT,
    ),
    settingsPageHeight: clamp(
      Number(settings?.settingsPageHeight ?? DEFAULT_SETTINGS.settingsPageHeight),
      MIN_EXPANDED_ISLAND_HEIGHT,
      MAX_EXPANDED_ISLAND_HEIGHT,
    ),
    taskTextColor,
    pulseColor: getColorSetting(
      settings?.pulseColor,
      DEFAULT_SETTINGS.pulseColor,
    ),
    pulseBrightness: clamp(
      Number(settings?.pulseBrightness ?? DEFAULT_SETTINGS.pulseBrightness),
      50,
      100,
    ),
    islandBackgroundColor: getColorSetting(
      settings?.islandBackgroundColor,
      DEFAULT_SETTINGS.islandBackgroundColor,
    ),
    todoBackgroundColor: getColorSetting(
      settings?.todoBackgroundColor,
      DEFAULT_SETTINGS.todoBackgroundColor,
    ),
    showTitle:
      typeof settings?.showTitle === "boolean"
        ? settings.showTitle
        : DEFAULT_SETTINGS.showTitle,
    carryOverIncompleteTodos:
      typeof settings?.carryOverIncompleteTodos === "boolean"
        ? settings.carryOverIncompleteTodos
        : DEFAULT_SETTINGS.carryOverIncompleteTodos,
    enableTodoReorder:
      typeof settings?.enableTodoReorder === "boolean"
        ? settings.enableTodoReorder
        : DEFAULT_SETTINGS.enableTodoReorder,
    strongCompletionAlert:
      typeof settings?.strongCompletionAlert === "boolean"
        ? settings.strongCompletionAlert
        : DEFAULT_SETTINGS.strongCompletionAlert,
    completionSoundEnabled:
      typeof settings?.completionSoundEnabled === "boolean"
        ? settings.completionSoundEnabled
        : DEFAULT_SETTINGS.completionSoundEnabled,
    monitorIndex: Math.max(0, Math.floor(Number(settings?.monitorIndex ?? DEFAULT_SETTINGS.monitorIndex))),
  };
}

let completionAudioContext: AudioContext | null = null;

function playCompletionSound() {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextConstructor) {
    return;
  }

  completionAudioContext ??= new AudioContextConstructor();
  const context = completionAudioContext;
  void context.resume();

  const startAt = context.currentTime + 0.01;
  const masterGain = context.createGain();
  masterGain.gain.setValueAtTime(0.0001, startAt);
  masterGain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.018);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.32);
  masterGain.connect(context.destination);

  [523.25, 659.25].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const voiceGain = context.createGain();
    const voiceStart = startAt + index * 0.085;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, voiceStart);
    voiceGain.gain.setValueAtTime(index === 0 ? 0.72 : 1, voiceStart);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.3);
    oscillator.connect(voiceGain).connect(masterGain);
    oscillator.start(voiceStart);
    oscillator.stop(startAt + 0.32);
    oscillator.onended = () => {
      oscillator.disconnect();
      voiceGain.disconnect();
    };
  });

  window.setTimeout(() => masterGain.disconnect(), 400);
}

function getDefaultSettingPresets(): IslandPreset[] {
  return [];
}

function mergeWithDefaultSettingPresets(presets: IslandPreset[]) {
  const defaultPresets = getDefaultSettingPresets();
  const customPresets = presets
    .filter(
      (preset) =>
        !preset.isDefault &&
        !LEGACY_DEFAULT_PRESET_IDS.has(preset.id) &&
        !LEGACY_DEFAULT_PRESET_NAMES.has(preset.name.trim()),
    )
    .map((preset) => ({ ...preset, isDefault: false }))
    .slice(0, MAX_CUSTOM_SETTING_PRESETS);

  return [...defaultPresets, ...customPresets];
}

function isDefaultSettingPreset(presetId: string) {
  return LEGACY_DEFAULT_PRESET_IDS.has(presetId);
}

function getTodoTitleLineCount(title: string) {
  const visualLength = Array.from(title).reduce(
    (total, character) => total + (character.charCodeAt(0) > 255 ? 1.6 : 1),
    0,
  );

  return clamp(
    Math.ceil(visualLength / TODO_TITLE_CHARACTERS_PER_LINE),
    1,
    TODO_MAX_ESTIMATED_TITLE_LINES,
  );
}

function loadSettings(): IslandSettings {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandSettings> & {
      margin?: number;
    };

    return normalizeSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadSettingPresets(): IslandPreset[] {
  const stored = window.localStorage.getItem(SETTINGS_PRESETS_STORAGE_KEY);

  if (!stored) {
    return getDefaultSettingPresets();
  }

  try {
    const parsed = JSON.parse(stored) as Partial<IslandPreset>[];

    if (!Array.isArray(parsed)) {
      return getDefaultSettingPresets();
    }

    const presets = parsed
      .map((preset, index) => ({
        id:
          typeof preset.id === "string" && preset.id
            ? preset.id
            : createTodoId(),
        name:
          typeof preset.name === "string" && preset.name.trim()
            ? preset.name.trim()
            : `样式预设 ${index + 1}`,
        settings: normalizeSettings(preset.settings),
        createdAt:
          typeof preset.createdAt === "number" ? preset.createdAt : Date.now(),
        isDefault: false,
      }));

    return mergeWithDefaultSettingPresets(presets);
  } catch {
    return getDefaultSettingPresets();
  }
}

function normalizeTodo(todo: Partial<TodoItem>): TodoItem {
  return {
    id: typeof todo.id === "string" && todo.id ? todo.id : createTodoId(),
    title: todo.title?.trim() ?? "",
    completed: Boolean(todo.completed),
    createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
  };
}

function loadTodos(): TodoItem[] {
  const stored = window.localStorage.getItem(TODOS_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<TodoItem>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((todo) => typeof todo.title === "string" && todo.title.trim())
      .map(normalizeTodo);
  } catch {
    return [];
  }
}

function loadActiveTodoId() {
  return window.localStorage.getItem(ACTIVE_TODO_STORAGE_KEY);
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function loadCurrentTodoDate() {
  return window.localStorage.getItem(TODO_DATE_STORAGE_KEY) ?? getLocalDateString();
}

function loadTodoArchives(): TodoArchive[] {
  const stored = window.localStorage.getItem(TODO_ARCHIVE_STORAGE_KEY);

  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Partial<TodoArchive>[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((archive) => typeof archive.date === "string" && archive.date)
      .map((archive) => ({
        date: archive.date ?? getLocalDateString(),
        todos: Array.isArray(archive.todos)
          ? archive.todos
              .filter(
                (todo) => typeof todo.title === "string" && todo.title.trim(),
              )
              .map(normalizeTodo)
          : [],
        dailyNote:
          typeof archive.dailyNote === "string" ? archive.dailyNote : "",
        savedAt: typeof archive.savedAt === "number" ? archive.savedAt : 0,
        savedToDisk: Boolean(archive.savedToDisk),
        filePath:
          typeof archive.filePath === "string" ? archive.filePath : undefined,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function loadSaveDirectory() {
  return window.localStorage.getItem(TODO_SAVE_DIRECTORY_STORAGE_KEY) ?? "";
}

function loadDailyNote() {
  return window.localStorage.getItem(DAILY_NOTE_STORAGE_KEY) ?? "";
}

function getTodoSignature(date: string, todos: TodoItem[], dailyNote: string) {
  return JSON.stringify({
    date,
    todos: todos.map((todo) => ({
      title: todo.title,
      completed: todo.completed,
    })),
    dailyNote,
  });
}

function formatTodosAsMarkdown(todos: TodoItem[]) {
  return todos
    .map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.title}`)
    .join("\n");
}

function formatTodoDocumentAsMarkdown(todos: TodoItem[], dailyNote: string) {
  const todoMarkdown = formatTodosAsMarkdown(todos);
  const dailyMarkdown = dailyNote.trimEnd();

  if (todoMarkdown && dailyMarkdown) {
    return `${todoMarkdown}\n\n${dailyMarkdown}`;
  }

  return todoMarkdown || dailyMarkdown;
}

function createTodoId() {
  if ("crypto" in window && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function IslandShell({
  mode,
  page,
  isTucked,
  showTitle,
  activeTaskTitle,
  pendingTodoCount,
  mediaState,
  agentVisualState,
  agentStatusLabel,
  completionAlertToken,
  onOpenPage,
  onCollapse,
  onMinimize,
  onTuck,
  onReveal,
  onPageChange,
  children,
}: IslandShellProps) {
  const isExpanded = mode === "expanded";
  const isMusicPlaying =
    mediaState.playbackStatus === "playing" ||
    (mediaState.playbackStatus !== "paused" && mediaState.audioActive);
  const className = [
    "island",
    `island--${mode}`,
    `island--${page}`,
    showTitle ? "" : "island--title-hidden",
    completionAlertToken > 0 ? "island--strong-alert" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const pulseClassName = [
    "island__pulse",
    `island__pulse--agent-${agentVisualState}`,
  ].join(" ");
  const collapsedLabel = activeTaskTitle
    ? `正在专注：${activeTaskTitle}`
    : "Surfisle";

  return (
    <section
      className={className}
      aria-label={collapsedLabel}
      onClick={() => {
        if (!isExpanded) {
          onOpenPage(page);
        }
      }}
      onMouseEnter={() => {
        if (isTucked) {
          onReveal();
        }
      }}
    >
      <span
        className="island__completion-flash"
        key={completionAlertToken}
        aria-hidden="true"
      />
      <div className="island__collapsed" aria-hidden={isExpanded}>
        <span className={pulseClassName} title={agentStatusLabel} />
        {showTitle && <span className="island__brand">Surfisle</span>}
        {activeTaskTitle ? (
          <span className="island__active-task">{activeTaskTitle}</span>
        ) : (
          <span className="island__todo-count">剩余{pendingTodoCount}个待办</span>
        )}
        <MusicWaveButton
          isAvailable={mediaState.available || mediaState.audioActive}
          isPlaying={isMusicPlaying}
          audioBands={mediaState.audioBands}
          label="打开音乐控制"
          onClick={() => onOpenPage("music")}
        />
        <button
          className="island__quiet-button"
          type="button"
          title="收起"
          aria-label="收起岛屿"
          onClick={(event) => {
            event.stopPropagation();
            onTuck();
          }}
        />
      </div>

      <div className="island__expanded" aria-hidden={!isExpanded}>
        <header className="island__header">
          <div className="island__title">
            <span>Surfisle</span>
          </div>

          <div
            className="editor-dots"
            aria-label="岛屿编辑"
          >
            <button
              className={`dot-button dot-button--todo ${
                page === "todo" ? "dot-button--active" : ""
              }`}
              type="button"
              title="任务清单"
              aria-label="任务清单"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("todo");
              }}
            />
            <button
              className={`dot-button dot-button--music ${
                page === "music" ? "dot-button--active" : ""
              }`}
              type="button"
              title="Music"
              aria-label="Music"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("music");
              }}
            />
            <button
              className={`dot-button dot-button--clipboard ${
                page === "clipboard" ? "dot-button--active" : ""
              }`}
              type="button"
              title="剪贴板历史"
              aria-label="剪贴板历史"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("clipboard");
              }}
            />
            <button
              className={`dot-button dot-button--layout ${
                page === "layout" ? "dot-button--active" : ""
              }`}
              type="button"
              title="布局编辑"
              aria-label="布局编辑"
              onClick={(event) => {
                event.stopPropagation();
                onPageChange("layout");
              }}
            />
          </div>

          <div
            className="island__collapse-target"
            onClick={onCollapse}
          />

          <div className="window-actions">
            <button
              className="icon-button"
              type="button"
              title="收起"
              aria-label="收起岛屿"
              onClick={(event) => {
                event.stopPropagation();
                onCollapse();
              }}
            >
              <ChevronUp size={18} strokeWidth={2.2} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="最小化到托盘"
              aria-label="最小化到托盘"
              onClick={(event) => {
                event.stopPropagation();
                onMinimize();
              }}
            >
              <Minus size={18} strokeWidth={2.2} />
            </button>
          </div>
        </header>
        <div className="island__content">{children}</div>
      </div>
    </section>
  );
}

function MusicWaveButton({
  isAvailable,
  isPlaying,
  audioBands,
  label,
  onClick,
}: {
  isAvailable: boolean;
  isPlaying: boolean;
  audioBands: number[];
  label: string;
  onClick: () => void;
}) {
  const className = [
    "music-wave-button",
    isAvailable ? "music-wave-button--available" : "music-wave-button--idle",
    isPlaying ? "music-wave-button--playing" : "music-wave-button--paused",
  ]
    .filter(Boolean)
    .join(" ");
  const barScales = createCenteredWaveLevels(audioBands, 5).map((level) =>
    clamp((isAvailable ? 0.12 : 0.06) + level * 0.96, 0.06, 1.08),
  );

  return (
    <button
      className={className}
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {barScales.map((scale, index) => (
        <span
          key={index}
          style={
            {
              "--wave-scale": scale.toFixed(3),
              "--wave-opacity": (0.42 + scale * 0.52).toFixed(3),
            } as CSSProperties
          }
        />
      ))}
    </button>
  );
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-control">
      <span className="slider-control__meta">
        <span>{label}</span>
        <strong>
          {step < 1 ? value.toFixed(2) : Math.round(value)}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="color-control">
      <span className="color-control__meta">
        <span>{label}</span>
        <strong>{value.toUpperCase()}</strong>
      </span>
      <input
        type="color"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-control">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle-control__switch" aria-hidden="true" />
    </label>
  );
}

function NumberControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="number-control">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const nextValue = Number(event.currentTarget.value);

          if (Number.isFinite(nextValue)) {
            onChange(clamp(Math.round(nextValue), min, max));
          }
        }}
      />
    </label>
  );
}

function LayoutEditor({
  settings,
  clipboardSettings,
  saveDirectoryDraft,
  savePathState,
  highlightSavePath,
  focusClipboardShortcutToken,
  presets,
  launchAtStartup,
  agentStatus,
  clearingAgentProvider,
  agentHooksInstallState,
  agentHooksInstallResult,
  agentHooksInstallError,
  onSettingsChange,
  onClipboardSettingsChange,
  onSaveDirectoryDraftChange,
  onSaveDirectory,
  onSavePreset,
  onApplyPreset,
  onRenamePreset,
  onDeletePreset,
  onLaunchAtStartupChange,
  onClearAgentStatus,
  onInstallAgentHooks,
  onClipboardShortcutFocusHandled,
}: {
  settings: IslandSettings;
  clipboardSettings: ClipboardHistorySettings;
  saveDirectoryDraft: string;
  savePathState: SavePathState;
  highlightSavePath: boolean;
  focusClipboardShortcutToken: number;
  presets: IslandPreset[];
  launchAtStartup: boolean;
  agentStatus: AgentStatusSnapshot;
  clearingAgentProvider: AgentProvider | null;
  agentHooksInstallState: AgentHooksInstallState;
  agentHooksInstallResult: AgentHooksInstallResult | null;
  agentHooksInstallError: string;
  onSettingsChange: (settings: IslandSettings) => void;
  onClipboardSettingsChange: (settings: ClipboardHistorySettings) => void;
  onSaveDirectoryDraftChange: (value: string) => void;
  onSaveDirectory: () => void;
  onSavePreset: () => void;
  onApplyPreset: (presetId: string) => void;
  onRenamePreset: (presetId: string, name: string) => void;
  onDeletePreset: (presetId: string) => void;
  onLaunchAtStartupChange: (enabled: boolean) => void;
  onClearAgentStatus: (provider: AgentProvider) => void;
  onInstallAgentHooks: () => void;
  onClipboardShortcutFocusHandled: () => void;
}) {
  const savePathPanelRef = useRef<HTMLElement | null>(null);
  const savePathInputRef = useRef<HTMLInputElement | null>(null);
  const clipboardShortcutPanelRef = useRef<HTMLElement | null>(null);
  const clipboardShortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategory>("appearance");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const refreshMonitors = useCallback(() => {
    void invoke<MonitorInfo[]>("get_monitors")
      .then(setMonitors)
      .catch((error) => console.error("Failed to query monitors", error));
  }, []);
  useEffect(() => {
    refreshMonitors();
    const timer = window.setInterval(refreshMonitors, 5000);
    return () => window.clearInterval(timer);
  }, [refreshMonitors]);

  const startPresetRename = useCallback((preset: IslandPreset) => {
    setEditingPresetId(preset.id);
    setPresetNameDraft(preset.name);
  }, []);

  const commitPresetRename = useCallback(() => {
    if (!editingPresetId) {
      return;
    }

    onRenamePreset(editingPresetId, presetNameDraft);
    setEditingPresetId(null);
    setPresetNameDraft("");
  }, [editingPresetId, onRenamePreset, presetNameDraft]);

  useEffect(() => {
    if (!highlightSavePath) {
      return;
    }

    setActiveCategory("todo");
    const frame = window.requestAnimationFrame(() => {
      const editorPanel = savePathPanelRef.current?.closest(
        ".settings-content",
      );

      if (editorPanel instanceof HTMLElement) {
        editorPanel.scrollTo({
          top: editorPanel.scrollHeight,
          behavior: "smooth",
        });
      }

      savePathInputRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [highlightSavePath]);

  useEffect(() => {
    if (focusClipboardShortcutToken <= 0) {
      return;
    }

    setActiveCategory("clipboard");
    const frame = window.requestAnimationFrame(() => {
      const editorPanel = clipboardShortcutPanelRef.current?.closest(
        ".settings-content",
      );

      if (editorPanel instanceof HTMLElement && clipboardShortcutPanelRef.current) {
        const targetTop = clipboardShortcutPanelRef.current.offsetTop - 12;
        editorPanel.scrollTo({ top: targetTop, behavior: "smooth" });
      }

      clipboardShortcutButtonRef.current?.focus({ preventScroll: true });
      setIsRecordingShortcut(true);
      onClipboardShortcutFocusHandled();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusClipboardShortcutToken, onClipboardShortcutFocusHandled]);

  const handleShortcutKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!isRecordingShortcut) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingShortcut(false);
        return;
      }

      const shortcut = buildShortcutFromEvent(event.nativeEvent);

      if (!shortcut) {
        return;
      }

      onClipboardSettingsChange({
        ...clipboardSettings,
        shortcut,
      });
      setIsRecordingShortcut(false);
    },
    [clipboardSettings, isRecordingShortcut, onClipboardSettingsChange],
  );

  const agentStatusRows = AGENT_PROVIDERS.map((provider) => {
    const status = agentStatus[provider];
    return {
      provider,
      label: AGENT_PROVIDER_LABELS[provider],
      phase: status.phase,
      phaseLabel: getAgentPhaseLabel(status.phase),
      needsAttention: isAgentAttentionPhase(status.phase),
    };
  });
  const agentStatusLabel = getAgentStatusLabel(agentStatus);

  return (
    <div className="editor-panel" data-settings-category={activeCategory}>
      <div className="settings-topbar">
        <div className="editor-panel__header">
          <div className="editor-panel__heading">
            <strong>偏好设置</strong>
          </div>
        </div>

        <nav className="settings-nav" aria-label="设置分类">
          {(
            [
              ["appearance", "外观"],
              ["todo", "待办"],
              ["clipboard", "剪切板"],
              ["integrations", "启动与连接"],
              ["about", "关于"],
            ] as const
          ).map(([category, label]) => (
            <button
              className={
                activeCategory === category ? "settings-nav__active" : ""
              }
              type="button"
              key={category}
              aria-pressed={activeCategory === category}
              onClick={() => setActiveCategory(category)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="settings-content">

      <section className="settings-section settings-section--monitor">
        <div className="settings-section__header">
          <span>显示器</span>
        </div>
        <label className="settings-control settings-control--select">
          <span>岛屿显示位置</span>
          <select
            value={settings.monitorIndex}
            onChange={(event) =>
              onSettingsChange({ ...settings, monitorIndex: Number(event.currentTarget.value) })
            }
          >
            {monitors.length === 0 ? (
              <option value={0}>检测中</option>
            ) : (
              monitors.map((monitor) => (
                <option key={monitor.index} value={monitor.index}>
                  {monitor.isPrimary ? "主显示器" : monitor.name} · {monitor.width}×{monitor.height}
                </option>
              ))
            )}
          </select>
          <small>{monitors.length > 0 ? `已检测到 ${monitors.length} 个显示器` : "正在检测显示器"}</small>
        </label>
      </section>

      <section className="settings-section settings-section--layout">
        <div className="settings-section__header">
          <span>大小与位置</span>
          <button
            className="settings-section__reset"
            type="button"
            title="恢复默认尺寸"
            aria-label="恢复默认尺寸"
            onClick={() =>
              onSettingsChange({
                ...settings,
                opacity: DEFAULT_SETTINGS.opacity,
                sizeScale: DEFAULT_SETTINGS.sizeScale,
                marginY: DEFAULT_SETTINGS.marginY,
                todoPageHeight: DEFAULT_SETTINGS.todoPageHeight,
                musicPageHeight: DEFAULT_SETTINGS.musicPageHeight,
                clipboardPageHeight: DEFAULT_SETTINGS.clipboardPageHeight,
                settingsPageHeight: DEFAULT_SETTINGS.settingsPageHeight,
              })
            }
          >
            <RefreshCcw size={12} strokeWidth={2.3} />
            <span>恢复默认</span>
          </button>
        </div>
        <SliderControl
          label="岛屿透明度"
          value={settings.opacity}
          min={50}
          max={100}
          step={1}
          suffix="%"
          onChange={(opacity) => onSettingsChange({ ...settings, opacity })}
        />
        <SliderControl
          label="界面缩放"
          value={settings.sizeScale}
          min={0.75}
          max={1.4}
          step={0.01}
          suffix="x"
          onChange={(sizeScale) => onSettingsChange({ ...settings, sizeScale })}
        />
        <SliderControl
          label="离屏幕顶部"
          value={settings.marginY}
          min={0}
          max={160}
          step={1}
          suffix="px"
          onChange={(marginY) => onSettingsChange({ ...settings, marginY })}
        />
        <SliderControl
          label="待办展开高度"
          value={settings.todoPageHeight}
          min={MIN_EXPANDED_ISLAND_HEIGHT}
          max={MAX_EXPANDED_ISLAND_HEIGHT}
          step={1}
          suffix="px"
          onChange={(todoPageHeight) =>
            onSettingsChange({ ...settings, todoPageHeight })
          }
        />
        <SliderControl
          label="音乐展开高度"
          value={settings.musicPageHeight}
          min={MIN_EXPANDED_ISLAND_HEIGHT}
          max={MAX_EXPANDED_ISLAND_HEIGHT}
          step={1}
          suffix="px"
          onChange={(musicPageHeight) =>
            onSettingsChange({ ...settings, musicPageHeight })
          }
        />
        <SliderControl
          label="剪切板页高度"
          value={settings.clipboardPageHeight}
          min={MIN_EXPANDED_ISLAND_HEIGHT}
          max={MAX_EXPANDED_ISLAND_HEIGHT}
          step={1}
          suffix="px"
          onChange={(clipboardPageHeight) =>
            onSettingsChange({ ...settings, clipboardPageHeight })
          }
        />
        <SliderControl
          label="偏好设置高度"
          value={settings.settingsPageHeight}
          min={MIN_EXPANDED_ISLAND_HEIGHT}
          max={MAX_EXPANDED_ISLAND_HEIGHT}
          step={1}
          suffix="px"
          onChange={(settingsPageHeight) =>
            onSettingsChange({ ...settings, settingsPageHeight })
          }
        />
        <ToggleControl
          label="在岛上显示 Surfisle 名称"
          checked={settings.showTitle}
          onChange={(showTitle) => onSettingsChange({ ...settings, showTitle })}
        />
      </section>

      <section className="settings-section settings-section--system">
        <div className="settings-section__header">
          <span>启动设置</span>
        </div>
        <ToggleControl
          label="开机自启"
          checked={launchAtStartup}
          onChange={onLaunchAtStartupChange}
        />
      </section>

      <section className="settings-section settings-section--todo">
        <div className="settings-section__header">
          <span>待办设置</span>
        </div>
        <ToggleControl
          label="自动延续未完成任务"
          checked={settings.carryOverIncompleteTodos}
          onChange={(carryOverIncompleteTodos) =>
            onSettingsChange({ ...settings, carryOverIncompleteTodos })
          }
        />
        <ToggleControl
          label="启用拖动排序"
          checked={settings.enableTodoReorder}
          onChange={(enableTodoReorder) =>
            onSettingsChange({ ...settings, enableTodoReorder })
          }
        />
      </section>

      <section className="settings-section settings-section--agent-hooks">
        <div className="settings-section__header">
          <span>AI 助手状态</span>
          <button
            className={[
              "agent-hooks-button",
              agentHooksInstallState === "installed"
                ? "agent-hooks-button--installed"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            disabled={agentHooksInstallState === "installing"}
            onClick={onInstallAgentHooks}
          >
            {agentHooksInstallState === "installed" ? (
              <Check size={13} strokeWidth={2.6} />
            ) : (
              <RefreshCcw size={13} strokeWidth={2.4} />
            )}
            <span>
              {agentHooksInstallState === "installing"
                ? "连接中"
                : agentHooksInstallState === "installed"
                  ? "已连接"
                  : "连接"}
            </span>
          </button>
        </div>
        <div
          className={[
            "agent-status-panel",
            `agent-status-panel--${getAgentVisualState(agentStatus)}`,
          ].join(" ")}
        >
          <div className="agent-status-panel__summary">
            <span>当前状态</span>
            <strong>{agentStatusLabel}</strong>
          </div>
          <div className="agent-status-panel__rows">
            {agentStatusRows.map((row) => (
              <div
                className={[
                  "agent-status-row",
                  row.needsAttention ? "agent-status-row--attention" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={row.provider}
              >
                <span>{row.label}</span>
                <strong>{row.phaseLabel}</strong>
                {row.needsAttention ? (
                  <button
                    className="agent-status-clear-button"
                    type="button"
                    disabled={clearingAgentProvider === row.provider}
                    title={`清除 ${row.label} 状态`}
                    aria-label={`清除 ${row.label} 状态`}
                    onClick={() => onClearAgentStatus(row.provider)}
                  >
                    <X size={12} strokeWidth={2.4} />
                    <span>
                      {clearingAgentProvider === row.provider
                        ? "清除中"
                        : "清除状态"}
                    </span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <ToggleControl
          label="强提示"
          checked={settings.strongCompletionAlert}
          onChange={(strongCompletionAlert) =>
            onSettingsChange({ ...settings, strongCompletionAlert })
          }
        />
        <div className="settings-subcontrol">
          <ToggleControl
            label="提示音"
            checked={settings.completionSoundEnabled}
            onChange={(completionSoundEnabled) => {
              onSettingsChange({ ...settings, completionSoundEnabled });
              if (completionSoundEnabled) {
                playCompletionSound();
              }
            }}
          />
        </div>
        {agentHooksInstallState === "installed" && agentHooksInstallResult ? (
          <div className="agent-hooks-status agent-hooks-status--ok">
            <span>组件目录</span>
            <strong title={agentHooksInstallResult.scriptsDir}>
              {agentHooksInstallResult.scriptsDir}
            </strong>
          </div>
        ) : null}
        {agentHooksInstallState === "error" ? (
          <div className="agent-hooks-status agent-hooks-status--error">
            {agentHooksInstallError}
          </div>
        ) : null}
      </section>

      <section
        className={[
          "settings-section",
          "settings-section--clipboard",
          focusClipboardShortcutToken > 0 ? "settings-section--attention" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ref={clipboardShortcutPanelRef}
      >
        <div className="settings-section__header">
          <span>剪切板</span>
        </div>
        <ToggleControl
          label="启用剪切板历史"
          checked={clipboardSettings.enabled}
          onChange={(enabled) =>
            onClipboardSettingsChange({ ...clipboardSettings, enabled })
          }
        />
        <ToggleControl
          label="记录图片"
          checked={clipboardSettings.captureImages}
          onChange={(captureImages) =>
            onClipboardSettingsChange({ ...clipboardSettings, captureImages })
          }
        />
        <NumberControl
          label="历史记录上限"
          value={clipboardSettings.maxItems}
          min={5}
          max={200}
          onChange={(maxItems) =>
            onClipboardSettingsChange({ ...clipboardSettings, maxItems })
          }
        />
        <div className="shortcut-control">
          <div className="shortcut-control__meta">
            <span>剪切板快捷键</span>
            <strong>{normalizeClipboardShortcut(clipboardSettings.shortcut)}</strong>
          </div>
          <button
            ref={clipboardShortcutButtonRef}
            className={[
              "shortcut-record-button",
              isRecordingShortcut ? "shortcut-record-button--recording" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={() => setIsRecordingShortcut(true)}
            onKeyDown={handleShortcutKeyDown}
            onBlur={() => setIsRecordingShortcut(false)}
          >
            <Keyboard size={14} strokeWidth={2.3} />
            <span>
              {isRecordingShortcut
                ? "按下组合键"
                : normalizeClipboardShortcut(clipboardSettings.shortcut)}
            </span>
          </button>
        </div>
      </section>

      <section className="settings-section settings-section--colors">
        <div className="settings-section__header">
          <span>配色</span>
        </div>
        <div className="color-grid">
          <ColorControl
            label="待办文字"
            value={settings.taskTextColor}
            onChange={(taskTextColor) =>
              onSettingsChange({ ...settings, taskTextColor })
            }
          />
          <ColorControl
            label="状态亮点"
            value={settings.pulseColor}
            onChange={(pulseColor) =>
              onSettingsChange({ ...settings, pulseColor })
            }
          />
          <ColorControl
            label="岛屿底色"
            value={settings.islandBackgroundColor}
            onChange={(islandBackgroundColor) =>
              onSettingsChange({ ...settings, islandBackgroundColor })
            }
          />
          <ColorControl
            label="待办页面"
            value={settings.todoBackgroundColor}
            onChange={(todoBackgroundColor) =>
              onSettingsChange({ ...settings, todoBackgroundColor })
            }
          />
        </div>
        <SliderControl
          label="状态亮点强度"
          value={settings.pulseBrightness}
          min={50}
          max={100}
          step={1}
          suffix="%"
          onChange={(pulseBrightness) =>
            onSettingsChange({ ...settings, pulseBrightness })
          }
        />
      </section>

      <section className="settings-section settings-section--presets">
        <div className="settings-section__header">
          <span>样式预设</span>
          <button
            className="preset-save-button"
            type="button"
            onClick={onSavePreset}
          >
            <Save size={13} strokeWidth={2.2} />
            <span>保存当前样式</span>
          </button>
        </div>
        {presets.length === 0 ? (
          <div className="preset-empty">暂无自定义样式</div>
        ) : (
          <div className="preset-list" role="list">
            {presets.map((preset) => (
              <div
                className={[
                  "preset-item",
                  preset.isDefault ? "preset-item--default" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={preset.id}
                role="listitem"
              >
                {editingPresetId === preset.id ? (
                  <input
                    className="preset-name-input"
                    value={presetNameDraft}
                    aria-label="已保存样式的名称"
                    autoFocus
                    onChange={(event) =>
                      setPresetNameDraft(event.currentTarget.value)
                    }
                    onBlur={commitPresetRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitPresetRename();
                      }

                      if (event.key === "Escape") {
                        setEditingPresetId(null);
                        setPresetNameDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    className="preset-name-button"
                    type="button"
                    title={preset.isDefault ? "默认样式" : "给这个样式改名"}
                    disabled={preset.isDefault}
                    onClick={() => {
                      if (!preset.isDefault) {
                        startPresetRename(preset);
                      }
                    }}
                  >
                    {preset.name}
                  </button>
                )}
                <button
                  className="preset-apply-button"
                  type="button"
                  onClick={() => onApplyPreset(preset.id)}
                >
                  应用
                </button>
                {preset.isDefault ? (
                  <span className="preset-delete-spacer" aria-hidden="true" />
                ) : (
                  <button
                    className="preset-delete-button"
                    type="button"
                    title="删除这个样式"
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => onDeletePreset(preset.id)}
                  >
                    <Trash2 size={13} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        className={[
          "settings-section",
          "settings-section--storage",
          "save-path-panel",
          highlightSavePath ? "save-path-panel--attention" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ref={savePathPanelRef}
      >
        <div className="settings-section__header save-path-panel__header">
          <span>待办保存位置</span>
        </div>
        <div className="save-path-row">
          <label className="save-path-field">
            <span>保存文件夹</span>
            <input
              ref={savePathInputRef}
              value={saveDirectoryDraft}
              placeholder="D:/Todos"
              aria-label="待办清单保存文件夹"
              onChange={(event) =>
                onSaveDirectoryDraftChange(event.currentTarget.value)
              }
            />
          </label>
          <button
            className={[
              "save-path-button",
              savePathState === "saved" ? "save-path-button--saved" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={onSaveDirectory}
          >
            {savePathState === "saved" ? (
              <>
                <Check className="save-check-icon" size={15} strokeWidth={2.6} />
                <span>位置已保存</span>
              </>
            ) : (
              <>
                <Save size={14} strokeWidth={2.2} />
                <span>保存位置</span>
              </>
            )}
          </button>
        </div>
      </section>

      <section className="settings-section settings-section--about">
        <div className="settings-section__header">
          <span>关于 Surfisle</span>
        </div>
        <div className="about-product">
          <strong>Surfisle</strong>
          <span>由 ryancy 设计并开发</span>
        </div>
        <button
          className="about-author-link"
          type="button"
          onClick={() => {
            void openUrl(AUTHOR_URL).catch((error) => {
              console.error("Failed to open author page", error);
            });
          }}
        >
          <span>github.com/beginner1868</span>
          <ExternalLink size={14} strokeWidth={2.2} />
        </button>
        <p className="about-license">Source Available · Surfisle License 1.0</p>
        <p className="about-copyright">Copyright (c) 2026 ryancy</p>
      </section>
      </div>
    </div>
  );
}

function TodoNotebook({
  todos,
  draft,
  activeTodoId,
  currentDate,
  pageMode,
  archives,
  selectedArchive,
  enableTodoReorder,
  onDraftChange,
  onAddTodo,
  onToggleTodo,
  onUpdateTodo,
  onStartTodo,
  onDeleteTodo,
  onReorderTodo,
  onShowArchive,
  onShowToday,
  onSelectArchive,
}: {
  todos: TodoItem[];
  draft: string;
  activeTodoId: string | null;
  currentDate: string;
  pageMode: TodoPageMode;
  archives: TodoArchive[];
  selectedArchive: TodoArchive | null;
  enableTodoReorder: boolean;
  onDraftChange: (value: string) => void;
  onAddTodo: () => void;
  onToggleTodo: (id: string) => void;
  onUpdateTodo: (id: string, title: string) => void;
  onStartTodo: (id: string) => void;
  onDeleteTodo: (id: string) => void;
  onReorderTodo: (sourceId: string, targetId: string) => void;
  onShowArchive: () => void;
  onShowToday: () => void;
  onSelectArchive: (date: string) => void;
}) {
  const displayedTodos =
    pageMode === "review" ? selectedArchive?.todos ?? [] : todos;
  const isTodayMode = pageMode === "today";
  const isArchiveMode = pageMode === "archive";
  const isReviewMode = pageMode === "review";
  const openCount = displayedTodos.filter((todo) => !todo.completed).length;
  const listClassName = [
    "todo-list",
    displayedTodos.length > TODO_SCROLL_START_ROWS ? "todo-list--scroll" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const inputPlaceholder =
    pageMode === "today"
      ? `添加 ${currentDate} 的任务`
      : "查看归档任务";
  const notebookClassName = [
    "todo-notebook",
    isArchiveMode ? "todo-notebook--archive" : "",
    isReviewMode ? "todo-notebook--review" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [todoTitleDraft, setTodoTitleDraft] = useState("");
  const [draggedTodoId, setDraggedTodoId] = useState<string | null>(null);
  const [dragOverTodoId, setDragOverTodoId] = useState<string | null>(null);
  const canReorderTodos = isTodayMode && enableTodoReorder;

  const startTodoTitleEdit = useCallback((todo: TodoItem) => {
    if (!isTodayMode) {
      return;
    }

    setEditingTodoId(todo.id);
    setTodoTitleDraft(todo.title);
  }, [isTodayMode]);

  const commitTodoTitleEdit = useCallback(() => {
    if (!editingTodoId) {
      return;
    }

    const nextTitle = todoTitleDraft.trim();

    if (nextTitle) {
      onUpdateTodo(editingTodoId, nextTitle);
    }

    setEditingTodoId(null);
    setTodoTitleDraft("");
  }, [editingTodoId, onUpdateTodo, todoTitleDraft]);

  const getTodoIdAtPoint = useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const todoElement = element?.closest("[data-todo-id]");

    return todoElement instanceof HTMLElement
      ? todoElement.dataset.todoId ?? null
      : null;
  }, []);

  const startTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, todoId: string) => {
      if (!canReorderTodos || editingTodoId === todoId) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraggedTodoId(todoId);
      setDragOverTodoId(null);
    },
    [canReorderTodos, editingTodoId],
  );

  const moveTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedTodoId) {
        return;
      }

      event.preventDefault();
      const targetTodoId = getTodoIdAtPoint(event.clientX, event.clientY);
      setDragOverTodoId(
        targetTodoId && targetTodoId !== draggedTodoId ? targetTodoId : null,
      );
    },
    [draggedTodoId, getTodoIdAtPoint],
  );

  const finishTodoDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggedTodoId) {
        return;
      }

      event.preventDefault();
      const targetTodoId =
        dragOverTodoId || getTodoIdAtPoint(event.clientX, event.clientY);

      if (targetTodoId && targetTodoId !== draggedTodoId) {
        onReorderTodo(draggedTodoId, targetTodoId);
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      setDraggedTodoId(null);
      setDragOverTodoId(null);
    },
    [dragOverTodoId, draggedTodoId, getTodoIdAtPoint, onReorderTodo],
  );

  const cancelTodoDrag = useCallback(() => {
    setDraggedTodoId(null);
    setDragOverTodoId(null);
  }, []);

  return (
    <section className={notebookClassName} aria-label="任务清单">
      <div className="todo-notebook__spine">
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--today",
            isTodayMode ? "todo-spine-button--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title="返回今日待办"
          aria-label="返回今日待办"
          onClick={onShowToday}
        >
          <CalendarDays size={15} strokeWidth={2.1} />
        </button>
        <button
          className={[
            "todo-spine-button",
            "todo-spine-button--archive",
            pageMode === "archive" || pageMode === "review"
              ? "todo-spine-button--active"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          title="查看待办归档"
          aria-label="查看待办归档"
          onClick={onShowArchive}
        >
          <Archive size={15} strokeWidth={2.1} />
        </button>
      </div>

      <div className="todo-notebook__topline">
        <div className="todo-notebook__title-group">
          <span className="todo-notebook__tab">
            <ClipboardList size={15} strokeWidth={2.1} />
            {isReviewMode
              ? selectedArchive?.date ?? "归档"
              : "任务清单"}
          </span>
        </div>
        {!isArchiveMode && (
          <span className="todo-notebook__open-count">{openCount} 项未完成</span>
        )}
      </div>

      {!isArchiveMode && (
        <form
          className="todo-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (isTodayMode) {
              onAddTodo();
            }
          }}
        >
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          <input
            value={draft}
            disabled={!isTodayMode}
            placeholder={inputPlaceholder}
            aria-label="添加任务，按回车保存"
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
        </form>
      )}

      {isArchiveMode ? (
        <ArchiveBrowser
          archives={archives}
          onSelectArchive={onSelectArchive}
        />
      ) : (
        <div className={listClassName} role="list">
          {displayedTodos.length === 0 ? (
            <div className="todo-empty">
              {isReviewMode ? "暂无归档内容" : "暂无待办"}
            </div>
          ) : (
            displayedTodos.map((todo) => {
              const isActive =
                isTodayMode && todo.id === activeTodoId && !todo.completed;
              const titleLineCount = getTodoTitleLineCount(todo.title);

              return (
                <div
                  className={[
                    "todo-item",
                    todo.completed ? "todo-item--done" : "",
                    isActive ? "todo-item--active" : "",
                    canReorderTodos ? "todo-item--reorderable" : "",
                    draggedTodoId === todo.id ? "todo-item--dragging" : "",
                    dragOverTodoId === todo.id ? "todo-item--drag-over" : "",
                    !isTodayMode ? "todo-item--readonly" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={todo.id}
                  role="listitem"
                  data-todo-id={todo.id}
                  style={
                    {
                      "--todo-title-min-height": `${titleLineCount * 19}px`,
                    } as CSSProperties
                  }
                >
                  <button
                    className="todo-check"
                    type="button"
                    aria-pressed={todo.completed}
                    disabled={!isTodayMode}
                    title={todo.completed ? "标记未完成" : "完成"}
                    aria-label={`${todo.completed ? "标记未完成" : "完成"}：${
                      todo.title
                    }`}
                    onClick={() => onToggleTodo(todo.id)}
                  >
                    {todo.completed && <Check size={14} strokeWidth={2.5} />}
                  </button>
                  {isTodayMode && editingTodoId === todo.id ? (
                    <input
                      className="todo-title-input"
                      value={todoTitleDraft}
                      aria-label="编辑任务名"
                      autoFocus
                      onChange={(event) =>
                        setTodoTitleDraft(event.currentTarget.value)
                      }
                      onBlur={commitTodoTitleEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitTodoTitleEdit();
                        }

                        if (event.key === "Escape") {
                          setEditingTodoId(null);
                          setTodoTitleDraft("");
                        }
                      }}
                    />
                  ) : isTodayMode ? (
                    <button
                      className="todo-title todo-title--editable"
                      type="button"
                      title="编辑任务名"
                      onClick={() => startTodoTitleEdit(todo)}
                    >
                      {todo.title}
                    </button>
                  ) : (
                    <span className="todo-title">{todo.title}</span>
                  )}
                  {isTodayMode && (
                    <>
                      <button
                        className={["todo-start", isActive ? "todo-start--active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        type="button"
                        title={isActive ? "结束" : "开始"}
                        aria-label={`${isActive ? "结束" : "开始"}：${todo.title}`}
                        disabled={todo.completed}
                        onClick={() => onStartTodo(todo.id)}
                      >
                        <Play size={13} strokeWidth={2.4} />
                        <span>{isActive ? "结束" : "开始"}</span>
                      </button>
                      <button
                        className="todo-delete"
                        type="button"
                        title="删除"
                        aria-label={`删除：${todo.title}`}
                        onClick={() => onDeleteTodo(todo.id)}
                      >
                        <Trash2 size={14} strokeWidth={2.2} />
                      </button>
                      {canReorderTodos && (
                        <button
                          className="todo-drag-handle"
                          type="button"
                          title="拖动排序"
                          aria-label={`拖动排序：${todo.title}`}
                          disabled={editingTodoId === todo.id}
                          onPointerDown={(event) => startTodoDrag(event, todo.id)}
                          onPointerMove={moveTodoDrag}
                          onPointerUp={finishTodoDrag}
                          onPointerCancel={cancelTodoDrag}
                        >
                          <GripVertical size={15} strokeWidth={2.4} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function ArchiveBrowser({
  archives,
  onSelectArchive,
}: {
  archives: TodoArchive[];
  onSelectArchive: (date: string) => void;
}) {
  if (archives.length === 0) {
    return <div className="todo-empty">暂无待办归档</div>;
  }

  return (
    <div className="archive-timeline" role="list">
      {archives.map((archive) => (
        <button
          className="archive-timeline__item"
          key={archive.date}
          type="button"
          role="listitem"
          onClick={() => onSelectArchive(archive.date)}
        >
          <span className="archive-timeline__dot" />
          <span>{archive.date}</span>
        </button>
      ))}
    </div>
  );
}

function getLyricsLines(result: LyricsSearchResult) {
  const syncedLines = (result.syncedLyrics || "")
    .split(/\r?\n/)
    .map<LyricLine | null>((line) => {
      const match = line.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d+))?\]\s*(.*)$/);

      if (!match || !match[4].trim()) {
        return null;
      }

      const fraction = match[3] || "0";
      const fractionMs = Number(fraction.padEnd(3, "0").slice(0, 3));

      return {
        timeMs: Number(match[1]) * 60_000 + Number(match[2]) * 1000 + fractionMs,
        text: match[4].trim(),
      } satisfies LyricLine;
    })
    .filter((line): line is LyricLine => line !== null);

  if (syncedLines.length > 0) {
    return syncedLines;
  }

  return (result.plainLyrics || "")
    .split(/\r?\n/)
    .map((line) => ({ timeMs: null, text: line.trim() }))
    .filter((line) => Boolean(line.text));
}

function getActiveLyricIndex(lines: LyricLine[], positionMs: number) {
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const timeMs = lines[index].timeMs;

    if (timeMs === null || timeMs > positionMs) {
      break;
    }

    activeIndex = index;
  }

  return activeIndex;
}

function MusicPlayerPanel({
  mediaState,
  onPlayPause,
  onNext,
  onPrevious,
}: {
  mediaState: MediaState;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const isPlaying =
    mediaState.playbackStatus === "playing" ||
    (mediaState.playbackStatus !== "paused" && mediaState.audioActive);
  const isPaused = mediaState.playbackStatus === "paused";
  const hasAudioSignal = mediaState.available || mediaState.audioActive;
  const mediaTitle = mediaState.mediaTitle.trim();
  const mediaArtist = mediaState.mediaArtist.trim();
  const mediaLabel =
    [mediaTitle, mediaArtist].filter(Boolean).join(" — ") ||
    mediaState.sourceApp.trim() ||
    (isPaused ? "已暂停" : hasAudioSignal ? "正在播放" : "未检测到媒体");
  const [lyricsState, setLyricsState] = useState<LyricsState>({ status: "idle" });
  const lyricsViewportRef = useRef<HTMLDivElement>(null);
  const playbackClockRef = useRef({
    mediaKey: "",
    startedAt: Date.now(),
    pausedAt: null as number | null,
    pausedDurationMs: 0,
  });
  const safeAudioBands = Array.isArray(mediaState.audioBands)
    ? mediaState.audioBands
    : EMPTY_AUDIO_BANDS;
  const spectrumPeak = safeAudioBands.reduce(
    (peak, band) => Math.max(peak, Number.isFinite(band) ? band : 0),
    0,
  );
  const liftedPeak = clamp(
    Math.log1p(clamp(mediaState.audioPeak, 0, 1) * 180) / Math.log1p(180),
    0,
    1,
  );
  const glowEnergy = Math.max(spectrumPeak, liftedPeak);
  const splitIndex = Math.ceil(safeAudioBands.length / 2);
  const leftEnergy = Math.max(...safeAudioBands.slice(0, splitIndex), 0);
  const rightEnergy = Math.max(...safeAudioBands.slice(splitIndex), 0);
  const glowStyle = {
    "--music-surface-energy": (0.1 + glowEnergy * 0.1).toFixed(3),
    "--music-edge-energy": (0.14 + glowEnergy * 0.12).toFixed(3),
    "--music-light-shift": `${clamp((rightEnergy - leftEnergy) * 4, -3, 3).toFixed(2)}%`,
    "--music-wave-energy": (0.74 + glowEnergy * 0.26).toFixed(3),
  } as CSSProperties;
  const mediaKey = `${mediaTitle}\n${mediaArtist}`.toLocaleLowerCase();
  const clock = playbackClockRef.current;
  const now = Date.now();

  if (mediaKey && mediaKey !== clock.mediaKey) {
    clock.mediaKey = mediaKey;
    clock.startedAt = now;
    clock.pausedAt = isPlaying ? null : now;
    clock.pausedDurationMs = 0;
  } else if (mediaKey && isPlaying && clock.pausedAt !== null) {
    clock.pausedDurationMs += now - clock.pausedAt;
    clock.pausedAt = null;
  } else if (mediaKey && !isPlaying && clock.pausedAt === null) {
    clock.pausedAt = now;
  }

  const estimatedPositionMs = mediaKey
    ? Math.max(
        0,
        (clock.pausedAt ?? now) - clock.startedAt - clock.pausedDurationMs,
      )
    : 0;
  const activeLyricIndex =
    lyricsState.status === "ready"
      ? getActiveLyricIndex(lyricsState.lines, estimatedPositionMs)
      : -1;
  const shouldShowLyrics = lyricsState.status === "ready";

  useEffect(() => {
    if (!mediaTitle) {
      setLyricsState({ status: "idle" });
      return;
    }

    const cacheKey = `${mediaTitle}\n${mediaArtist}`.toLocaleLowerCase();
    const cachedResult = lyricsCache.get(cacheKey);

    if (cachedResult !== undefined) {
      setLyricsState(
        cachedResult
          ? { status: "ready", result: cachedResult, lines: getLyricsLines(cachedResult) }
          : { status: "empty" },
      );
      return;
    }

    const controller = new AbortController();
    let didCancel = false;
    const timeoutId = window.setTimeout(() => controller.abort(), 9000);
    const params = new URLSearchParams();

    if (mediaArtist) {
      params.set("track_name", mediaTitle);
      params.set("artist_name", mediaArtist);
    } else {
      params.set("q", mediaTitle);
    }

    setLyricsState({ status: "loading" });

    void fetch(`https://lrclib.net/api/search?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Lyrics request failed: ${response.status}`);
        }

        return response.json() as Promise<LyricsSearchResult[]>;
      })
      .then((results) => {
        const matchedResult =
          results.find(
            (result) =>
              !result.instrumental &&
              Boolean(result.plainLyrics || result.syncedLyrics),
          ) ?? null;

        lyricsCache.set(cacheKey, matchedResult);
        setLyricsState(
          matchedResult
            ? {
                status: "ready",
                result: matchedResult,
                lines: getLyricsLines(matchedResult),
              }
            : { status: "empty" },
        );
      })
      .catch((error: unknown) => {
        if (didCancel) {
          return;
        }

        console.error("Failed to load lyrics", error);
        setLyricsState({ status: "error" });
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      didCancel = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [mediaArtist, mediaTitle]);

  useEffect(() => {
    if (activeLyricIndex < 0) {
      return;
    }

    const viewport = lyricsViewportRef.current;
    const activeLine = viewport?.querySelector(
      `[data-lyric-index="${activeLyricIndex}"]`,
    );

    if (!viewport || !(activeLine instanceof HTMLElement)) {
      return;
    }

    viewport.scrollTo({
      top:
        activeLine.offsetTop -
        (viewport.clientHeight - activeLine.clientHeight) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [activeLyricIndex]);

  return (
    <section
      className={[
        "music-player",
        hasAudioSignal ? "" : "music-player--empty",
        isPlaying ? "music-player--playing" : "",
        isPaused ? "music-player--paused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={glowStyle}
      aria-label={`媒体播放器：${mediaLabel}`}
    >
      <div className="music-player__status">
        <span>{mediaLabel}</span>
      </div>
      <MusicLevelWave
        isAvailable={hasAudioSignal}
        audioBands={mediaState.audioBands}
      />

      <div className="music-player__lyrics" aria-live="polite">
        {shouldShowLyrics && (
          <div className="music-player__lyrics-lines" ref={lyricsViewportRef}>
            {lyricsState.lines.map((line, index) => (
              <p
                className={index === activeLyricIndex ? "music-player__lyric--active" : ""}
                data-lyric-index={index}
                key={`${index}-${line.text}`}
              >
                {line.text}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="music-player__controls">
        <button
          className="music-control-button"
          type="button"
          aria-label="Previous track"
          onClick={onPrevious}
        >
          <SkipBack size={18} strokeWidth={2.4} />
        </button>
        <button
          className="music-control-button music-control-button--primary"
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={onPlayPause}
        >
          {isPlaying ? (
            <Pause size={20} strokeWidth={2.5} />
          ) : (
            <Play size={20} strokeWidth={2.5} />
          )}
        </button>
        <button
          className="music-control-button"
          type="button"
          aria-label="Next track"
          onClick={onNext}
        >
          <SkipForward size={18} strokeWidth={2.4} />
        </button>
      </div>
    </section>
  );
}

function MusicLevelWave({
  isAvailable,
  audioBands,
}: {
  isAvailable: boolean;
  audioBands: number[];
}) {
  const bars = createCenteredWaveLevels(
    audioBands,
    AUDIO_SPECTRUM_BAND_COUNT,
  ).map((level) =>
    clamp((isAvailable ? 0.08 : 0.04) + level * 0.98, 0.04, 1.08),
  );

  return (
    <div className="music-player__wave" aria-hidden="true">
      {bars.map((scale, index) => (
        <span
          key={index}
          style={
            {
              "--wave-scale": scale.toFixed(3),
              "--wave-opacity": (0.3 + scale * 0.68).toFixed(3),
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function ClipboardHistoryPanel({
  snapshot,
  onCopyItem,
  onToggleFavorite,
  onDeleteItem,
  onClear,
}: {
  snapshot: ClipboardHistorySnapshot;
  onCopyItem: (id: string) => Promise<boolean> | boolean;
  onToggleFavorite: (id: string) => Promise<void> | void;
  onDeleteItem: (id: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [clipboardView, setClipboardView] = useState<"all" | "favorites">("all");
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const copiedResetRef = useRef<number | null>(null);
  const confirmClearResetRef = useRef<number | null>(null);
  const itemElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const itemPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const normalizedQuery = query.trim().toLowerCase();
  const favoriteItems = useMemo(
    () => snapshot.items.filter((item) => item.favorite),
    [snapshot.items],
  );
  const viewedItems = clipboardView === "favorites" ? favoriteItems : snapshot.items;
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) {
      return viewedItems;
    }

    return viewedItems.filter((item) => {
      const haystack = [
        item.preview,
        item.text ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return item.kind === "text" && haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, viewedItems]);

  useEffect(
    () => () => {
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }

      if (confirmClearResetRef.current !== null) {
        window.clearTimeout(confirmClearResetRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const visibleIds = new Set(filteredItems.map((item) => item.id));
    const nextPositions = new Map<string, DOMRect>();
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    itemElementsRef.current.forEach((element, id) => {
      if (!visibleIds.has(id)) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const previousRect = itemPositionsRef.current.get(id);
      nextPositions.set(id, nextRect);

      if (!previousRect || prefersReducedMotion) {
        return;
      }

      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;

      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      element.getAnimations().forEach((animation) => animation.cancel());
      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 280,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
    });

    itemPositionsRef.current = nextPositions;
  }, [filteredItems]);

  useEffect(() => {
    if (confirmClearResetRef.current !== null) {
      window.clearTimeout(confirmClearResetRef.current);
      confirmClearResetRef.current = null;
    }

    if (!isConfirmingClear) {
      return;
    }

    confirmClearResetRef.current = window.setTimeout(() => {
      setIsConfirmingClear(false);
      confirmClearResetRef.current = null;
    }, 3000);

    return () => {
      if (confirmClearResetRef.current !== null) {
        window.clearTimeout(confirmClearResetRef.current);
        confirmClearResetRef.current = null;
      }
    };
  }, [isConfirmingClear]);

  useEffect(() => {
    if (!isConfirmingClear) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const isConfirmControl = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches("[data-clipboard-confirm-control='true']"),
        );

      if (isConfirmControl) {
        return;
      }

      setIsConfirmingClear(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isConfirmingClear]);

  useEffect(() => {
    if (snapshot.items.length === 0) {
      setIsConfirmingClear(false);
    }
  }, [snapshot.items]);

  const showCopiedState = useCallback((id: string) => {
    setCopiedItemId(id);

    if (copiedResetRef.current !== null) {
      window.clearTimeout(copiedResetRef.current);
    }

    copiedResetRef.current = window.setTimeout(() => {
      setCopiedItemId(null);
      copiedResetRef.current = null;
    }, 1100);
  }, []);

  const handleCopyItem = useCallback(
    (id: string) => {
      void Promise.resolve(onCopyItem(id)).then((didCopy) => {
        if (didCopy) {
          showCopiedState(id);
        }
      });
    },
    [onCopyItem, showCopiedState],
  );

  const handleToggleFavorite = useCallback(
    (id: string) => {
      void Promise.resolve(onToggleFavorite(id));
    },
    [onToggleFavorite],
  );

  const handleDeleteItem = useCallback(
    (id: string) => {
      setIsConfirmingClear(false);
      void Promise.resolve(onDeleteItem(id));
    },
    [onDeleteItem],
  );

  const handleClear = useCallback(() => {
    if (!isConfirmingClear) {
      setIsConfirmingClear(true);
      return;
    }

    setIsConfirmingClear(false);
    void Promise.resolve(onClear());
  }, [isConfirmingClear, onClear]);

  return (
    <section className="clipboard-panel" aria-label="剪贴板历史">
      <header className="clipboard-panel__header">
        <div className="clipboard-panel__title">
          <ClipboardList size={16} strokeWidth={2.2} />
          <span>剪切板</span>
        </div>
        <label className="clipboard-search">
          <Search size={14} strokeWidth={2.2} />
          <input
            value={query}
            placeholder="搜索"
            aria-label="搜索剪贴板文字"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={12} strokeWidth={2.4} />
            </button>
          )}
        </label>
        <div className="clipboard-panel__tools">
          <span className="clipboard-shortcut-display" aria-label="展开快捷键">
            <Keyboard size={14} strokeWidth={2.3} />
            <span>{normalizeClipboardShortcut(snapshot.settings.shortcut)}</span>
          </span>
          <button
            className={[
              "clipboard-clear-button",
              isConfirmingClear ? "clipboard-clear-button--confirming" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            disabled={snapshot.items.length === 0}
            title={isConfirmingClear ? "确认清空" : "清空"}
            aria-label={isConfirmingClear ? "确认清空" : "清空剪贴板历史"}
            onClick={handleClear}
            data-clipboard-confirm-control="true"
          >
            {isConfirmingClear ? (
              <Check className="save-check-icon" size={14} strokeWidth={2.7} />
            ) : (
              "清空"
            )}
          </button>
        </div>
      </header>

      <div className="clipboard-segments" aria-label="剪贴板栏目">
        <button
          className={clipboardView === "all" ? "clipboard-segment--active" : ""}
          type="button"
          aria-pressed={clipboardView === "all"}
          onClick={() => setClipboardView("all")}
        >
          全部
        </button>
        <button
          className={clipboardView === "favorites" ? "clipboard-segment--active" : ""}
          type="button"
          aria-pressed={clipboardView === "favorites"}
          onClick={() => setClipboardView("favorites")}
        >
          收藏
        </button>
      </div>

      <div className="clipboard-list" role="list">
        {filteredItems.length === 0 ? (
          <div className="clipboard-empty">
            {snapshot.items.length === 0
              ? "还没有剪切记录"
              : clipboardView === "favorites" && favoriteItems.length === 0
                ? "还没有收藏剪贴记录"
                : "没有匹配的剪贴记录"}
          </div>
        ) : (
          filteredItems.map((item) => (
            <article
              className="clipboard-item"
              key={item.id}
              role="listitem"
              ref={(node) => {
                if (node) {
                  itemElementsRef.current.set(item.id, node);
                } else {
                  itemElementsRef.current.delete(item.id);
                }
              }}
            >
              <button
                className="clipboard-item__main"
                type="button"
                title="复制回剪贴板"
                onClick={() => handleCopyItem(item.id)}
              >
                {item.kind === "image" ? (
                  <span className="clipboard-item__thumb">
                    {item.image?.thumbnailDataUrl ? (
                      <img src={item.image.thumbnailDataUrl} alt="" />
                    ) : (
                      <ImageIcon size={20} strokeWidth={2.1} />
                    )}
                  </span>
                ) : (
                  <span className="clipboard-item__text-icon">
                    <ClipboardList size={17} strokeWidth={2.1} />
                  </span>
                )}
                <span className="clipboard-item__body">
                  <span className="clipboard-item__preview">{item.preview}</span>
                </span>
              </button>
              <div className="clipboard-item__actions">
                <button
                  className={[
                    "clipboard-favorite-button",
                    item.favorite ? "clipboard-favorite-button--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  title={item.favorite ? "取消收藏" : "收藏"}
                  aria-label={item.favorite ? "取消收藏剪贴记录" : "收藏剪贴记录"}
                  aria-pressed={item.favorite}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleFavorite(item.id);
                  }}
                >
                  <Star
                    size={14}
                    strokeWidth={2.3}
                    fill={item.favorite ? "currentColor" : "none"}
                  />
                </button>
                <button
                  className="clipboard-delete-button"
                  type="button"
                  title="删除"
                  aria-label="删除剪贴记录"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDeleteItem(item.id);
                  }}
                >
                  <Trash2 size={14} strokeWidth={2.3} />
                </button>
                <button
                  className={[
                    "clipboard-copy-button",
                    copiedItemId === item.id ? "clipboard-copy-button--copied" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  title={copiedItemId === item.id ? "已复制" : "复制"}
                  aria-label="复制回剪贴板"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCopyItem(item.id);
                  }}
                >
                  {copiedItemId === item.id ? (
                    <Check className="save-check-icon" size={14} strokeWidth={2.7} />
                  ) : (
                    <Copy size={14} strokeWidth={2.3} />
                  )}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<IslandMode>("collapsed");
  const [isTucked, setIsTucked] = useState(false);
  const [page, setPage] = useState<IslandPage>("todo");
  const [mediaState, setMediaState] =
    useState<MediaState>(DEFAULT_MEDIA_STATE);
  const [agentStatus, setAgentStatus] =
    useState<AgentStatusSnapshot>(DEFAULT_AGENT_STATUS);
  const isRefreshingAgentStatus = useRef(false);
  const isRefreshingMediaState = useRef(false);
  const isRefreshingAudioSpectrum = useRef(false);
  const mediaStatusLockUntil = useRef(0);
  const [settings, setSettings] = useState<IslandSettings>(loadSettings);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [settingPresets, setSettingPresets] =
    useState<IslandPreset[]>(loadSettingPresets);
  const [todos, setTodos] = useState<TodoItem[]>(loadTodos);
  const [dailyNote, setDailyNote] = useState(loadDailyNote);
  const [draftTodo, setDraftTodo] = useState("");
  const [activeTodoId, setActiveTodoId] = useState<string | null>(
    loadActiveTodoId,
  );
  const [currentTodoDate, setCurrentTodoDate] =
    useState<string>(loadCurrentTodoDate);
  const [archives, setArchives] = useState<TodoArchive[]>(loadTodoArchives);
  const [todoPageMode, setTodoPageMode] = useState<TodoPageMode>("today");
  const [selectedArchiveDate, setSelectedArchiveDate] = useState<string | null>(
    null,
  );
  const [saveDirectory, setSaveDirectory] = useState(loadSaveDirectory);
  const [saveDirectoryDraft, setSaveDirectoryDraft] =
    useState(loadSaveDirectory);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savePathState, setSavePathState] = useState<SavePathState>("idle");
  const [clipboardHistory, setClipboardHistory] =
    useState<ClipboardHistorySnapshot>(DEFAULT_CLIPBOARD_HISTORY);
  const [agentHooksInstallState, setAgentHooksInstallState] =
    useState<AgentHooksInstallState>("idle");
  const [agentHooksInstallResult, setAgentHooksInstallResult] =
    useState<AgentHooksInstallResult | null>(null);
  const [agentHooksInstallError, setAgentHooksInstallError] = useState("");
  const [clearingAgentProvider, setClearingAgentProvider] =
    useState<AgentProvider | null>(null);
  const [focusClipboardShortcutToken, setFocusClipboardShortcutToken] =
    useState(0);
  const [completionAlertToken, setCompletionAlertToken] = useState(0);
  const previousAgentPhases = useRef<Record<AgentProvider, AgentTaskPhase> | null>(
    null,
  );
  const clipboardShortcutToggleAt = useRef(0);
  const shouldInitializeDefaultSaveDirectory = useRef(
    window.localStorage.getItem(TODO_SAVE_DIRECTORY_STORAGE_KEY) === null,
  );
  const defaultSaveDirectoryRequestInFlight = useRef(false);
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveRequestId = useRef(0);
  const didHydrateAutoSave = useRef(false);
  const didCheckDate = useRef(false);
  const didShowInitialWindow = useRef(false);
  const selectedArchive =
    archives.find((archive) => archive.date === selectedArchiveDate) ?? null;
  const expandedIslandHeight =
    page === "todo"
      ? settings.todoPageHeight
      : page === "music"
        ? settings.musicPageHeight
        : page === "clipboard"
          ? settings.clipboardPageHeight
          : settings.settingsPageHeight;
  const layoutSync = useRef<{
    frame: number | null;
    inFlight: boolean;
    pending: IslandSettings;
    active: IslandSettings;
  }>({
    frame: null,
    inFlight: false,
    pending: settings,
    active: settings,
  });

  const stageStyle = useMemo(
    () =>
      ({
        "--island-opacity": settings.opacity / 100,
        "--island-scale": settings.sizeScale,
        "--expanded-island-height": `${expandedIslandHeight}px`,
        "--task-text-color": settings.taskTextColor,
        "--island-pulse-color": settings.pulseColor,
        "--island-pulse-glow-color": hexToRgba(settings.pulseColor, 0.72),
        "--island-pulse-brightness": `${settings.pulseBrightness}%`,
        "--island-background-color": settings.islandBackgroundColor,
        "--todo-background-color": settings.todoBackgroundColor,
      }) as CSSProperties,
    [
      expandedIslandHeight,
      settings.islandBackgroundColor,
      settings.opacity,
      settings.pulseBrightness,
      settings.pulseColor,
      settings.sizeScale,
      settings.taskTextColor,
      settings.todoBackgroundColor,
    ],
  );

  const syncNativeLayout = useCallback(async (nextSettings: IslandSettings) => {
    try {
      await invoke("set_island_layout", {
          layout: {
          sizeScale: nextSettings.sizeScale,
          marginY: nextSettings.marginY,
          monitorIndex: nextSettings.monitorIndex,
        },
      });
    } catch (error) {
      console.error("Failed to sync island layout", error);
    }
  }, []);

  const flushNativeLayout = useCallback(() => {
    const syncState = layoutSync.current;

    if (syncState.inFlight) {
      return;
    }

    const nextSettings = syncState.pending;
    syncState.active = nextSettings;
    syncState.inFlight = true;

    void syncNativeLayout(nextSettings).finally(() => {
      const latestState = layoutSync.current;
      latestState.inFlight = false;

      if (latestState.pending !== latestState.active) {
        latestState.frame = window.requestAnimationFrame(() => {
          latestState.frame = null;
          flushNativeLayout();
        });
      }
    });
  }, [syncNativeLayout]);

  const scheduleNativeLayout = useCallback(
    (nextSettings: IslandSettings) => {
      const syncState = layoutSync.current;
      syncState.pending = nextSettings;

      if (syncState.frame !== null || syncState.inFlight) {
        return;
      }

      syncState.frame = window.requestAnimationFrame(() => {
        syncState.frame = null;
        flushNativeLayout();
      });
    },
    [flushNativeLayout],
  );

  const syncNativeInteraction = useCallback(
    async (
      nextMode: IslandMode,
      nextSettings: IslandSettings,
      nextExpandedHeight: number,
      nextIsTucked: boolean,
    ) => {
      try {
        await invoke("set_island_interaction", {
          mode: nextMode,
          sizeScale: nextSettings.sizeScale,
          marginY: nextSettings.marginY,
          monitorIndex: nextSettings.monitorIndex,
          expandedHeight: nextExpandedHeight,
          isTucked: nextIsTucked,
        });
      } catch (error) {
        console.error("Failed to sync island interaction", error);
      }
    },
    [],
  );

  const showReadyIsland = useCallback(async () => {
    if (didShowInitialWindow.current) {
      return;
    }

    didShowInitialWindow.current = true;

    try {
      await invoke("show_ready_island");
    } catch (error) {
      console.error("Failed to show island", error);
    }
  }, []);

  const refreshClipboardHistory = useCallback(async () => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "get_clipboard_history",
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to read clipboard history", error);
    }
  }, []);

  const refreshAgentStatus = useCallback(async () => {
    if (isRefreshingAgentStatus.current) {
      return;
    }

    isRefreshingAgentStatus.current = true;
    try {
      const snapshot = await invoke<AgentStatusSnapshot>("get_agent_status");
      setAgentStatus(snapshot);
    } catch (error) {
      console.error("Failed to read agent status", error);
      setAgentStatus(DEFAULT_AGENT_STATUS);
    } finally {
      isRefreshingAgentStatus.current = false;
    }
  }, []);

  const clearAgentStatus = useCallback(async (provider: AgentProvider) => {
    setClearingAgentProvider(provider);
    try {
      const snapshot = await invoke<AgentStatusSnapshot>("clear_agent_status", {
        provider,
      });
      setAgentStatus(snapshot);
    } catch (error) {
      console.error("Failed to clear agent status", error);
    } finally {
      setClearingAgentProvider(null);
    }
  }, []);

  const updateClipboardSettings = useCallback(
    async (nextSettings: ClipboardHistorySettings) => {
      const normalizedSettings = normalizeClipboardSettings(nextSettings);

      setClipboardHistory((currentHistory) => ({
        ...currentHistory,
        settings: normalizedSettings,
      }));

      try {
        const snapshot = await invoke<ClipboardHistorySnapshot>(
          "set_clipboard_history_settings",
          { settings: normalizedSettings },
        );
        setClipboardHistory(snapshot);
      } catch (error) {
        console.error("Failed to update clipboard history settings", error);
        void refreshClipboardHistory();
      }
    },
    [refreshClipboardHistory],
  );

  const copyClipboardHistoryItem = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "copy_clipboard_history_item",
        { id },
      );
      setClipboardHistory(snapshot);
      return true;
    } catch (error) {
      console.error("Failed to copy clipboard history item", error);
      return false;
    }
  }, []);

  const toggleClipboardHistoryFavorite = useCallback(async (id: string) => {
    setClipboardHistory((currentHistory) => ({
      ...currentHistory,
      items: currentHistory.items.map((item) =>
        item.id === id ? { ...item, favorite: !item.favorite } : item,
      ),
    }));

    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "toggle_clipboard_history_favorite",
        { id },
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to toggle clipboard history favorite", error);
      await refreshClipboardHistory();
    }
  }, [refreshClipboardHistory]);

  const deleteClipboardHistoryItem = useCallback(async (id: string) => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "delete_clipboard_history_item",
        { id },
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to delete clipboard history item", error);
    }
  }, []);

  const clearClipboardHistoryItems = useCallback(async () => {
    try {
      const snapshot = await invoke<ClipboardHistorySnapshot>(
        "clear_clipboard_history",
      );
      setClipboardHistory(snapshot);
    } catch (error) {
      console.error("Failed to clear clipboard history", error);
    }
  }, []);

  const minimizeIsland = useCallback(async () => {
    try {
      await invoke("minimize_island");
    } catch (error) {
      console.error("Failed to minimize island", error);
    }
  }, []);

  const setIslandMode = useCallback((nextMode: IslandMode) => {
    setMode(nextMode);
    setIsTucked(false);
  }, []);

  const tuckIsland = useCallback(() => {
    setIslandMode("collapsed");
    setIsTucked(true);
  }, [setIslandMode]);

  const revealIsland = useCallback(() => {
    setIsTucked(false);
  }, []);

  const openIslandPage = useCallback((nextPage: IslandPage) => {
    setPage(nextPage);
    setMode("expanded");
    setIsTucked(false);
  }, []);

  const openClipboardHistory = useCallback(() => {
    openIslandPage("clipboard");
  }, [openIslandPage]);

  const toggleClipboardHistory = useCallback(() => {
    const now = Date.now();

    if (now - clipboardShortcutToggleAt.current < 250) {
      return;
    }

    clipboardShortcutToggleAt.current = now;

    if (mode === "expanded" && page === "clipboard") {
      setIslandMode("collapsed");
      return;
    }

    openClipboardHistory();
  }, [mode, openClipboardHistory, page, setIslandMode]);

  const clearClipboardShortcutFocus = useCallback(() => {
    setFocusClipboardShortcutToken(0);
  }, []);

  const collapseIsland = useCallback(() => {
    setIslandMode("collapsed");
  }, [setIslandMode]);

  const refreshMediaState = useCallback(async () => {
    if (isRefreshingMediaState.current) {
      return;
    }

    isRefreshingMediaState.current = true;

    try {
      const nextMediaState = await invoke<MediaStateSnapshot>("get_media_state");

      setMediaState((currentState) => {
        const isStatusLocked = Date.now() < mediaStatusLockUntil.current;
        const nextPeak = Math.max(
          currentState.audioPeak * 0.82,
          nextMediaState.audioPeak,
        );
        const measuredAudioActive =
          nextMediaState.audioActive || nextPeak > AUDIO_ACTIVE_THRESHOLD;
        const audioActive =
          isStatusLocked && currentState.playbackStatus === "paused"
            ? false
            : measuredAudioActive;
        const playbackStatus = isStatusLocked
          ? currentState.playbackStatus
          : nextMediaState.playbackStatus !== "unavailable"
            ? nextMediaState.playbackStatus
            : audioActive
              ? "playing"
              : "unavailable";

        return {
          ...nextMediaState,
          audioActive,
          audioPeak: audioActive ? nextPeak : 0,
          mediaTitle:
            nextMediaState.mediaTitle.trim() || currentState.mediaTitle,
          mediaArtist:
            nextMediaState.mediaArtist.trim() || currentState.mediaArtist,
          sourceApp:
            nextMediaState.sourceApp.trim() || currentState.sourceApp,
          audioBands: Array.isArray(nextMediaState.audioBands)
            ? nextMediaState.audioBands
            : currentState.audioBands,
          playbackStatus,
        };
      });
    } catch (error) {
      console.error("Failed to read media state", error);
      setMediaState((currentState) => ({
        ...DEFAULT_MEDIA_STATE,
        audioActive: currentState.audioActive,
        audioPeak: currentState.audioPeak * 0.72,
        playbackStatus: currentState.audioActive ? "playing" : "unavailable",
      }));
    } finally {
      isRefreshingMediaState.current = false;
    }
  }, []);

  const runMediaCommand = useCallback(
    async (command: "media_play_pause" | "media_next" | "media_previous") => {
      if (command === "media_play_pause") {
        setMediaState((currentState) => {
          const isCurrentlyPlaying =
            currentState.playbackStatus === "playing" ||
            (currentState.playbackStatus !== "paused" &&
              currentState.audioActive);
          const nextStatus: MediaPlaybackStatus = isCurrentlyPlaying
            ? "paused"
            : "playing";
          mediaStatusLockUntil.current = Date.now() + 900;

          return {
            ...currentState,
            available: nextStatus === "playing" || currentState.available,
            audioActive: nextStatus === "playing",
            audioPeak:
              nextStatus === "playing"
                ? Math.max(currentState.audioPeak, 0.08)
                : 0,
            playbackStatus: nextStatus,
          };
        });
      }

      try {
        await invoke<void>(command);
      } catch (error) {
        console.error(`Failed to run media command: ${command}`, error);
      }
      window.setTimeout(() => void refreshMediaState(), 120);
      window.setTimeout(() => void refreshMediaState(), 980);
    },
    [refreshMediaState],
  );

  useEffect(() => {
    let didCancel = false;

    const refreshAudioSpectrum = async () => {
      if (isRefreshingAudioSpectrum.current) {
        return;
      }

      isRefreshingAudioSpectrum.current = true;

      try {
        const audioSpectrum = await invoke<AudioSpectrum>("get_audio_spectrum");

        if (didCancel) {
          return;
        }

        setMediaState((currentState) => {
          const isStatusLocked = Date.now() < mediaStatusLockUntil.current;
          const shouldSuppressAudio =
            isStatusLocked && currentState.playbackStatus === "paused";
          const decayedPeak = currentState.audioPeak * 0.82;
          const nextPeak = audioSpectrum.active
            ? Math.max(decayedPeak, audioSpectrum.peak)
            : decayedPeak;
          const nextBands = Array.from(
            { length: AUDIO_SPECTRUM_BAND_COUNT },
            (_, index) =>
              Math.max(
                (currentState.audioBands[index] ?? 0) * 0.7,
                audioSpectrum.bands[index] ?? 0,
              ),
          );
          const audioActive =
            !shouldSuppressAudio &&
            (audioSpectrum.active || nextPeak > AUDIO_ACTIVE_THRESHOLD * 1.5);

          return {
            ...currentState,
            audioActive,
            audioPeak: audioActive ? nextPeak : 0,
            audioBands: audioActive ? nextBands : nextBands.map((band) => band * 0.55),
            playbackStatus:
              isStatusLocked
                ? currentState.playbackStatus
                : audioActive
                  ? "playing"
                  : currentState.playbackStatus === "paused"
                    ? "paused"
                  : "unavailable",
          };
        });
      } catch (error) {
        console.error("Failed to read audio spectrum", error);
      } finally {
        isRefreshingAudioSpectrum.current = false;
      }
    };

    void refreshAudioSpectrum();

    const interval = window.setInterval(() => {
      void refreshAudioSpectrum();
    }, 120);

    return () => {
      didCancel = true;
      window.clearInterval(interval);
    };
  }, []);

  const addTodo = useCallback(() => {
    const title = draftTodo.trim();

    if (!title) {
      return;
    }

    setTodos((currentTodos) => [
      {
        id: createTodoId(),
        title,
        completed: false,
        createdAt: Date.now(),
      },
      ...currentTodos,
    ]);
    setDraftTodo("");
  }, [draftTodo]);

  const toggleTodo = useCallback(
    (id: string) => {
      setTodos((currentTodos) =>
        currentTodos.map((todo) =>
          todo.id === id ? { ...todo, completed: !todo.completed } : todo,
        ),
      );
      setActiveTodoId((currentId) => (currentId === id ? null : currentId));
    },
    [],
  );

  const updateTodoTitle = useCallback((id: string, title: string) => {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return;
    }

    setTodos((currentTodos) =>
      currentTodos.map((todo) =>
        todo.id === id ? { ...todo, title: nextTitle } : todo,
      ),
    );
  }, []);

  const startTodo = useCallback(
    (id: string) => {
      const todo = todos.find((item) => item.id === id);

      if (!todo || todo.completed) {
        return;
      }

      if (activeTodoId === id) {
        setActiveTodoId(null);
        return;
      }

      setActiveTodoId(id);
      setIslandMode("collapsed");
    },
    [activeTodoId, setIslandMode, todos],
  );

  const deleteTodo = useCallback((id: string) => {
    setTodos((currentTodos) => currentTodos.filter((todo) => todo.id !== id));
    setActiveTodoId((currentId) => (currentId === id ? null : currentId));
  }, []);

  const reorderTodo = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    setTodos((currentTodos) => {
      const sourceIndex = currentTodos.findIndex((todo) => todo.id === sourceId);
      const targetIndex = currentTodos.findIndex((todo) => todo.id === targetId);

      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return currentTodos;
      }

      const nextTodos = [...currentTodos];
      const [movedTodo] = nextTodos.splice(sourceIndex, 1);
      const insertIndex = targetIndex;
      nextTodos.splice(insertIndex, 0, movedTodo);

      return nextTodos;
    });
  }, []);

  const upsertArchive = useCallback(
    (
      date: string,
      todoList: TodoItem[],
      nextDailyNote: string,
      savedToDisk: boolean,
      filePath?: string,
    ) => {
      const archive: TodoArchive = {
        date,
        todos: todoList,
        dailyNote: nextDailyNote,
        savedAt: Date.now(),
        savedToDisk,
        filePath,
      };

      setArchives((currentArchives) =>
        [archive, ...currentArchives.filter((item) => item.date !== date)].sort(
          (a, b) => b.date.localeCompare(a.date),
        ),
      );
    },
    [],
  );

  const saveTodosToDisk = useCallback(
    async (date: string, todoList: TodoItem[], nextDailyNote: string) => {
      const directory = saveDirectory.trim();

      if (!directory) {
        throw new Error("Missing todo save path.");
      }

      const result = await invoke<SaveTodoResult>("save_todo_markdown", {
        directory,
        date,
        content: formatTodoDocumentAsMarkdown(todoList, nextDailyNote),
      });

      upsertArchive(date, todoList, nextDailyNote, true, result.filePath);
      window.localStorage.setItem(
        TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
        getTodoSignature(date, todoList, nextDailyNote),
      );

      return result;
    },
    [saveDirectory, upsertArchive],
  );

  const saveDirectoryFromEditor = useCallback(() => {
    const nextDirectory = saveDirectoryDraft.trim();

    setSaveDirectory(nextDirectory);
    setSaveDirectoryDraft(nextDirectory);
    setSaveState("idle");
    setSavePathState("saved");
    window.setTimeout(() => setSavePathState("idle"), 1200);
  }, [saveDirectoryDraft]);

  const showArchive = useCallback(() => {
    setTodoPageMode("archive");
    setSelectedArchiveDate(null);
    setDraftTodo("");
  }, []);

  const showToday = useCallback(() => {
    setTodoPageMode("today");
    setSelectedArchiveDate(null);
    setDraftTodo("");
  }, []);

  const selectArchive = useCallback(
    (date: string) => {
      if (date === currentTodoDate) {
        showToday();
        return;
      }

      setSelectedArchiveDate(date);
      setTodoPageMode("review");
      setDraftTodo("");
    },
    [currentTodoDate, showToday],
  );

  const rolloverToToday = useCallback(
    async (nextDate: string) => {
      const signature = getTodoSignature(currentTodoDate, todos, dailyNote);
      const lastSavedSignature = window.localStorage.getItem(
        TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
      );
      const carryOverCreatedAt = Date.now();
      const carriedTodos = settings.carryOverIncompleteTodos
        ? todos
            .filter((todo) => !todo.completed)
            .map((todo, index) => ({
              ...todo,
              id: createTodoId(),
              completed: false,
              createdAt: carryOverCreatedAt + index,
            }))
        : [];

      if (
        (todos.length > 0 || dailyNote.trim()) &&
        signature !== lastSavedSignature
      ) {
        if (saveDirectory.trim()) {
          try {
            await saveTodosToDisk(currentTodoDate, todos, dailyNote);
          } catch (error) {
            console.error("Failed to auto-save todo markdown", error);
            upsertArchive(currentTodoDate, todos, dailyNote, false);
          }
        } else {
          upsertArchive(currentTodoDate, todos, dailyNote, false);
        }
      }

      setTodos(carriedTodos);
      setDailyNote("");
      setActiveTodoId(null);
      setCurrentTodoDate(nextDate);
      setTodoPageMode("today");
      setSelectedArchiveDate(null);

      if (carriedTodos.length > 0) {
        window.localStorage.removeItem(TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
          getTodoSignature(nextDate, [], ""),
        );
      }
    },
    [
      currentTodoDate,
      dailyNote,
      saveDirectory,
      saveTodosToDisk,
      settings.carryOverIncompleteTodos,
      todos,
      upsertArchive,
    ],
  );

  const saveSettingsPreset = useCallback(() => {
    setSettingPresets((currentPresets) => {
      const customPresetCount = currentPresets.filter(
        (preset) => !preset.isDefault && !isDefaultSettingPreset(preset.id),
      ).length;
      const preset: IslandPreset = {
        id: createTodoId(),
        name: `样式预设 ${customPresetCount + 1}`,
        settings,
        createdAt: Date.now(),
        isDefault: false,
      };

      return mergeWithDefaultSettingPresets([preset, ...currentPresets]);
    });
  }, [settings]);

  const applySettingsPreset = useCallback(
    (presetId: string) => {
      const preset = settingPresets.find((item) => item.id === presetId);

      if (!preset) {
        return;
      }

      const nextSettings = normalizeSettings(preset.settings);
      setSettings(nextSettings);
      scheduleNativeLayout(nextSettings);
    },
    [scheduleNativeLayout, settingPresets],
  );

  const renameSettingsPreset = useCallback((presetId: string, name: string) => {
    const nextName = name.trim();

    if (
      !nextName ||
      isDefaultSettingPreset(presetId) ||
      LEGACY_DEFAULT_PRESET_NAMES.has(nextName)
    ) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.map((preset) =>
        preset.id === presetId ? { ...preset, name: nextName } : preset,
      ),
    );
  }, []);

  const deleteSettingsPreset = useCallback((presetId: string) => {
    if (isDefaultSettingPreset(presetId)) {
      return;
    }

    setSettingPresets((currentPresets) =>
      currentPresets.filter((preset) => preset.id !== presetId),
    );
  }, []);

  const updateLaunchAtStartup = useCallback(async (enabled: boolean) => {
    setLaunchAtStartup(enabled);
    window.localStorage.setItem(
      LAUNCH_AT_STARTUP_INITIALIZED_STORAGE_KEY,
      "true",
    );

    try {
      await invoke("set_launch_at_startup", { enabled });
    } catch (error) {
      console.error("Failed to update launch at startup", error);
      setLaunchAtStartup(!enabled);
    }
  }, []);

  const installAgentHooks = useCallback(async () => {
    setAgentHooksInstallState("installing");
    setAgentHooksInstallError("");

    try {
      const result = await invoke<AgentHooksInstallResult>(
        "install_agent_status_hooks",
      );
      setAgentHooksInstallResult(result);
      setAgentHooksInstallState("installed");
      void refreshAgentStatus();
    } catch (error) {
      console.error("Failed to install agent status hooks", error);
      setAgentHooksInstallError(getErrorMessage(error));
      setAgentHooksInstallState("error");
    }
  }, [refreshAgentStatus]);

  useEffect(() => {
    const hasInitializedLaunchAtStartup =
      window.localStorage.getItem(LAUNCH_AT_STARTUP_INITIALIZED_STORAGE_KEY) ===
      "true";

    if (!hasInitializedLaunchAtStartup) {
      setLaunchAtStartup(true);
      void invoke("set_launch_at_startup", { enabled: true })
        .then(() => {
          window.localStorage.setItem(
            LAUNCH_AT_STARTUP_INITIALIZED_STORAGE_KEY,
            "true",
          );
        })
        .catch((error) => {
          console.error("Failed to enable launch at startup by default", error);
          setLaunchAtStartup(false);
        });
      return;
    }

    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch((error) => {
        console.error("Failed to read launch at startup", error);
      });
  }, []);

  useEffect(() => {
    void refreshClipboardHistory();

    let unlistenChanges: (() => void) | null = null;
    let unlistenShortcut: (() => void) | null = null;

    void listen("clipboard-history-changed", () => {
      void refreshClipboardHistory();
    })
      .then((nextUnlisten) => {
        unlistenChanges = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for clipboard history changes", error);
      });

    void listen("clipboard-history-shortcut", () => {
      toggleClipboardHistory();
    })
      .then((nextUnlisten) => {
        unlistenShortcut = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for clipboard history shortcut", error);
      });

    return () => {
      unlistenChanges?.();
      unlistenShortcut?.();
    };
  }, [refreshClipboardHistory, toggleClipboardHistory]);

  useEffect(() => {
    void refreshMediaState();

    const interval = window.setInterval(() => {
      void refreshMediaState();
    }, 1500);

    return () => window.clearInterval(interval);
  }, [refreshMediaState]);

  useEffect(() => {
    void refreshAgentStatus();

    const interval = window.setInterval(() => {
      void refreshAgentStatus();
    }, 200);

    return () => window.clearInterval(interval);
  }, [refreshAgentStatus]);

  useEffect(() => {
    void invoke<AgentHooksInstallResult | null>(
      "get_agent_status_hooks_connection",
    )
      .then((result) => {
        if (!result) {
          return;
        }

        setAgentHooksInstallResult(result);
        setAgentHooksInstallState("installed");
      })
      .catch((error) => {
        console.error("Failed to read agent hooks connection", error);
      });
  }, []);

  useEffect(() => {
    const nextPhases = Object.fromEntries(
      AGENT_PROVIDERS.map((provider) => [provider, agentStatus[provider].phase]),
    ) as Record<AgentProvider, AgentTaskPhase>;
    const previousPhases = previousAgentPhases.current;

    if (
      previousPhases &&
      settings.strongCompletionAlert &&
      AGENT_PROVIDERS.some(
        (provider) =>
          previousPhases[provider] !== "completed" &&
          nextPhases[provider] === "completed",
      )
    ) {
      setCompletionAlertToken((currentToken) => currentToken + 1);
      if (settings.completionSoundEnabled) {
        playCompletionSound();
      }
    }

    previousAgentPhases.current = nextPhases;
  }, [
    agentStatus,
    settings.completionSoundEnabled,
    settings.strongCompletionAlert,
  ]);

  useEffect(() => {
    if (
      !shouldInitializeDefaultSaveDirectory.current ||
      saveDirectory.trim() ||
      defaultSaveDirectoryRequestInFlight.current
    ) {
      return;
    }

    let didCancel = false;
    defaultSaveDirectoryRequestInFlight.current = true;

    void invoke<string>("get_default_todo_save_directory")
      .then((defaultDirectory) => {
        if (didCancel) {
          return;
        }

        const nextDirectory = defaultDirectory.trim();

        if (!nextDirectory) {
          return;
        }

        shouldInitializeDefaultSaveDirectory.current = false;
        setSaveDirectory((currentDirectory) =>
          currentDirectory.trim() ? currentDirectory : nextDirectory,
        );
        setSaveDirectoryDraft((currentDirectory) =>
          currentDirectory.trim() ? currentDirectory : nextDirectory,
        );
      })
      .catch((error) => {
        console.error("Failed to resolve default todo save path", error);
      })
      .finally(() => {
        if (!didCancel) {
          defaultSaveDirectoryRequestInFlight.current = false;
        }
      });

    return () => {
      didCancel = true;
      defaultSaveDirectoryRequestInFlight.current = false;
    };
  }, [saveDirectory]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(
      SETTINGS_PRESETS_STORAGE_KEY,
      JSON.stringify(settingPresets),
    );
  }, [settingPresets]);

  useEffect(() => {
    window.localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
  }, [todos]);

  useEffect(() => {
    window.localStorage.setItem(DAILY_NOTE_STORAGE_KEY, dailyNote);
  }, [dailyNote]);

  useEffect(() => {
    window.localStorage.setItem(TODO_DATE_STORAGE_KEY, currentTodoDate);
  }, [currentTodoDate]);

  useEffect(() => {
    window.localStorage.setItem(TODO_ARCHIVE_STORAGE_KEY, JSON.stringify(archives));
  }, [archives]);

  useEffect(() => {
    if (!saveDirectory && shouldInitializeDefaultSaveDirectory.current) {
      return;
    }

    window.localStorage.setItem(TODO_SAVE_DIRECTORY_STORAGE_KEY, saveDirectory);
  }, [saveDirectory]);

  useEffect(() => {
    if (!didHydrateAutoSave.current) {
      didHydrateAutoSave.current = true;
      return;
    }

    if (autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    if (!saveDirectory.trim()) {
      return;
    }

    const signature = getTodoSignature(currentTodoDate, todos, dailyNote);
    const lastSavedSignature = window.localStorage.getItem(
      TODO_LAST_SAVED_SIGNATURE_STORAGE_KEY,
    );

    if (!todos.length && !dailyNote.trim() && !lastSavedSignature) {
      return;
    }

    if (signature === lastSavedSignature) {
      return;
    }

    const timer = window.setTimeout(() => {
      autoSaveTimer.current = null;
      autoSaveRequestId.current += 1;
      const requestId = autoSaveRequestId.current;

      void saveTodosToDisk(currentTodoDate, todos, dailyNote)
        .catch((error) => {
          if (requestId === autoSaveRequestId.current) {
            console.error("Failed to auto-save todo markdown", error);
            setSaveState("error");
          }
        });
    }, 700);

    autoSaveTimer.current = timer;

    return () => {
      if (autoSaveTimer.current === timer) {
        window.clearTimeout(timer);
        autoSaveTimer.current = null;
      }
    };
  }, [
    currentTodoDate,
    dailyNote,
    saveDirectory,
    saveTodosToDisk,
    todos,
  ]);

  useEffect(
    () => () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current);
      }

    },
    [],
  );

  useEffect(() => {
    if (activeTodoId) {
      window.localStorage.setItem(ACTIVE_TODO_STORAGE_KEY, activeTodoId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_TODO_STORAGE_KEY);
  }, [activeTodoId]);

  useEffect(() => {
    if (
      activeTodoId &&
      !todos.some((todo) => todo.id === activeTodoId && !todo.completed)
    ) {
      setActiveTodoId(null);
    }
  }, [activeTodoId, todos]);

  useEffect(() => {
    if (didCheckDate.current) {
      return;
    }

    didCheckDate.current = true;
    const today = getLocalDateString();

    if (currentTodoDate !== today) {
      void rolloverToToday(today);
    }
  }, [currentTodoDate, rolloverToToday]);

  useEffect(() => {
    const checkForNewDay = () => {
      const today = getLocalDateString();

      if (currentTodoDate !== today) {
        void rolloverToToday(today);
      }
    };

    const interval = window.setInterval(checkForNewDay, 30_000);
    return () => window.clearInterval(interval);
  }, [currentTodoDate, rolloverToToday]);

  useEffect(() => {
    scheduleNativeLayout(settings);
  }, [settings.marginY, settings.monitorIndex, scheduleNativeLayout]);

  useEffect(() => {
    void syncNativeInteraction(
      mode,
      settings,
      expandedIslandHeight,
      isTucked,
    ).finally(() => {
      void showReadyIsland();
    });
  }, [
    expandedIslandHeight,
    isTucked,
    mode,
    settings.marginY,
    settings.monitorIndex,
    settings.sizeScale,
    showReadyIsland,
    syncNativeInteraction,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (matchesClipboardShortcut(event, clipboardHistory.settings.shortcut)) {
        event.preventDefault();
        toggleClipboardHistory();
        return;
      }

      if (event.key === "Escape") {
        collapseIsland();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clipboardHistory.settings.shortcut, collapseIsland, toggleClipboardHistory]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused && mode === "expanded") {
          collapseIsland();
        }
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for island focus changes", error);
      });

    return () => {
      unlisten?.();
    };
  }, [collapseIsland, mode]);

  const activeTaskTitle = useMemo(() => {
    const activeTodo = todos.find(
      (todo) => todo.id === activeTodoId && !todo.completed,
    );

    return activeTodo?.title ?? null;
  }, [activeTodoId, todos]);
  const openTodoCount = useMemo(
    () => todos.filter((todo) => !todo.completed).length,
    [todos],
  );
  const agentVisualState = useMemo(
    () => getAgentVisualState(agentStatus),
    [agentStatus],
  );
  const agentStatusLabel = useMemo(
    () => getAgentStatusLabel(agentStatus),
    [agentStatus],
  );

  return (
    <main className="stage" style={stageStyle}>
      <IslandShell
        mode={mode}
        page={page}
        isTucked={isTucked}
        showTitle={settings.showTitle}
        activeTaskTitle={activeTaskTitle}
        pendingTodoCount={openTodoCount}
        mediaState={mediaState}
        agentVisualState={agentVisualState}
        agentStatusLabel={agentStatusLabel}
        completionAlertToken={completionAlertToken}
        onOpenPage={openIslandPage}
        onCollapse={collapseIsland}
        onMinimize={minimizeIsland}
        onTuck={tuckIsland}
        onReveal={revealIsland}
        onPageChange={setPage}
      >
        {page === "layout" && (
          <LayoutEditor
            settings={settings}
            clipboardSettings={clipboardHistory.settings}
            saveDirectoryDraft={saveDirectoryDraft}
            savePathState={savePathState}
            highlightSavePath={saveState === "needs-path"}
            focusClipboardShortcutToken={focusClipboardShortcutToken}
            presets={settingPresets}
            launchAtStartup={launchAtStartup}
            agentStatus={agentStatus}
            clearingAgentProvider={clearingAgentProvider}
            agentHooksInstallState={agentHooksInstallState}
            agentHooksInstallResult={agentHooksInstallResult}
            agentHooksInstallError={agentHooksInstallError}
            onSettingsChange={setSettings}
            onClipboardSettingsChange={updateClipboardSettings}
            onSaveDirectoryDraftChange={setSaveDirectoryDraft}
            onSaveDirectory={saveDirectoryFromEditor}
            onSavePreset={saveSettingsPreset}
            onApplyPreset={applySettingsPreset}
            onRenamePreset={renameSettingsPreset}
            onDeletePreset={deleteSettingsPreset}
            onLaunchAtStartupChange={updateLaunchAtStartup}
            onClearAgentStatus={clearAgentStatus}
            onInstallAgentHooks={installAgentHooks}
            onClipboardShortcutFocusHandled={clearClipboardShortcutFocus}
          />
        )}
        {page === "music" && (
          <MusicPlayerPanel
            mediaState={mediaState}
            onPlayPause={() => void runMediaCommand("media_play_pause")}
            onNext={() => void runMediaCommand("media_next")}
            onPrevious={() => void runMediaCommand("media_previous")}
          />
        )}
        {page === "clipboard" && (
          <ClipboardHistoryPanel
            snapshot={clipboardHistory}
            onCopyItem={copyClipboardHistoryItem}
            onToggleFavorite={toggleClipboardHistoryFavorite}
            onDeleteItem={deleteClipboardHistoryItem}
            onClear={clearClipboardHistoryItems}
          />
        )}
        {page === "todo" && (
          <TodoNotebook
            todos={todos}
            draft={draftTodo}
            activeTodoId={activeTodoId}
            currentDate={currentTodoDate}
            pageMode={todoPageMode}
            archives={archives}
            selectedArchive={selectedArchive}
            enableTodoReorder={settings.enableTodoReorder}
            onDraftChange={setDraftTodo}
            onAddTodo={addTodo}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodoTitle}
            onStartTodo={startTodo}
            onDeleteTodo={deleteTodo}
            onReorderTodo={reorderTodo}
            onShowArchive={showArchive}
            onShowToday={showToday}
            onSelectArchive={selectArchive}
          />
        )}
      </IslandShell>
    </main>
  );
}

export default App;
