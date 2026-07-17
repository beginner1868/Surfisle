mod clipboard_history;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    env,
    f32::consts::PI,
    ffi::c_void,
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(debug_assertions)]
use tauri::window::Color;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow,
};
use windows::core::{Interface, BOOL};
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT, RPC_E_CHANGED_MODE},
    Media::Audio::Endpoints::IAudioMeterInformation,
    Media::Audio::{
        eCommunications, eConsole, eMultimedia, eRender, AudioSessionStateActive,
        IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
    },
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    },
    UI::{
        Input::KeyboardAndMouse::{
            keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK,
            VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
        },
        WindowsAndMessaging::{
            EnumWindows, GetCursorPos, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
            GetWindowThreadProcessId, IsWindowVisible,
        },
    },
};

const WINDOW_LABEL: &str = "main";
const STAGE_WINDOW_WIDTH: f64 = 820.0;
const STAGE_WINDOW_HEIGHT: f64 = 460.0;
const DEFAULT_MARGIN_Y: f64 = 10.0;
const DEFAULT_SCALE: f64 = 1.0;
const COLLAPSED_ISLAND_WIDTH: f64 = 320.0;
const COLLAPSED_ISLAND_HEIGHT: f64 = 58.0;
const EXPANDED_ISLAND_WIDTH: f64 = 560.0;
const DEFAULT_EXPANDED_ISLAND_HEIGHT: f64 = 306.0;
const EXPANDED_ISLAND_HEIGHT_RANGE: f64 = 240.0;
const EXPANDED_RADIUS: f64 = 30.0;
const STAGE_WINDOW_PADDING_Y: f64 = 24.0;
const TUCKED_VISIBLE_EDGE_HEIGHT: f64 = 10.0;
const STARTUP_REGISTRY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_REGISTRY_VALUE: &str = "Surfisle";
const AUDIO_ACTIVE_THRESHOLD: f32 = 0.000015;
const AUDIO_SPECTRUM_BAND_COUNT: usize = 31;
const AUDIO_SPECTRUM_SAMPLE_COUNT: usize = 512;
const AUDIO_SPECTRUM_CAPTURE_DELAY: Duration = Duration::from_millis(45);
const CREATE_NO_WINDOW: u32 = 0x08000000;
const AGENT_STATUS_FILE_NAME: &str = "agent-status.json";
const CODEX_RUNNING_MARKER_FILE_NAME: &str = "agent-codex-running.flag";
const CODEX_RUNNING_HOLD_FILE_NAME: &str = "agent-codex-running-hold.flag";
const CLAUDE_CODE_RUNNING_MARKER_FILE_NAME: &str = "agent-claudeCode-running.flag";
const CLAUDE_CODE_RUNNING_HOLD_FILE_NAME: &str = "agent-claudeCode-running-hold.flag";
const OPENCODE_RUNNING_MARKER_FILE_NAME: &str = "agent-opencode-running.flag";
const OPENCODE_RUNNING_HOLD_FILE_NAME: &str = "agent-opencode-running-hold.flag";
const OPENCODE_PLUGIN_FILE_NAME: &str = "surfisle-status.js";
const AGENT_RUNNING_SCRIPT_FILE_NAME: &str = "surfisle-agent-running.cmd";
const AGENT_STATUS_SCRIPT_FILE_NAME: &str = "surfisle-agent-status.ps1";
const AGENT_RUNNING_STALE_AFTER_MS: i64 = 10 * 60 * 1000;
const SURFISLE_AGENT_HOOK_BLOCK_BEGIN: &str = "# BEGIN Surfisle Agent Status Hooks";
const SURFISLE_AGENT_HOOK_BLOCK_END: &str = "# END Surfisle Agent Status Hooks";
const SURFISLE_AGENT_HOOK_SIGNATURE: &str = "surfisle-agent-";
const AGENT_RUNNING_SCRIPT: &str = include_str!("../../scripts/surfisle-agent-running.cmd");
const AGENT_STATUS_SCRIPT: &str = include_str!("../../scripts/surfisle-agent-status.ps1");

static WINDOW_STATE: OnceLock<Mutex<IslandWindowState>> = OnceLock::new();

#[derive(Clone, Copy)]
enum IslandMode {
    Collapsed,
    Expanded,
}

impl IslandMode {
    fn from_value(value: &str) -> Result<Self, String> {
        match value {
            "collapsed" => Ok(Self::Collapsed),
            "expanded" => Ok(Self::Expanded),
            _ => Err(format!("Unsupported island mode: {value}")),
        }
    }

    fn base_size(self, expanded_height: f64) -> (f64, f64) {
        match self {
            Self::Collapsed => (COLLAPSED_ISLAND_WIDTH, COLLAPSED_ISLAND_HEIGHT),
            Self::Expanded => (EXPANDED_ISLAND_WIDTH, expanded_height),
        }
    }

    fn corner_radius(self) -> f64 {
        match self {
            Self::Collapsed => COLLAPSED_ISLAND_HEIGHT / 2.0,
            Self::Expanded => EXPANDED_RADIUS,
        }
    }
}

#[derive(Clone, Copy)]
struct IslandWindowState {
    mode: IslandMode,
    is_tucked: bool,
    size_scale: f64,
    margin_y: f64,
    expanded_height: f64,
    monitor_index: usize,
}

impl Default for IslandWindowState {
    fn default() -> Self {
        Self {
            mode: IslandMode::Collapsed,
            is_tucked: false,
            size_scale: DEFAULT_SCALE,
            margin_y: DEFAULT_MARGIN_Y,
            expanded_height: DEFAULT_EXPANDED_ISLAND_HEIGHT,
            monitor_index: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IslandLayout {
    size_scale: f64,
    margin_y: f64,
    #[serde(default)]
    monitor_index: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    is_primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveTodoMarkdownResult {
    file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaState {
    available: bool,
    audio_active: bool,
    audio_peak: f32,
    media_title: String,
    media_artist: String,
    source_app: String,
    playback_status: String,
    updated_at: i64,
}

impl Default for MediaState {
    fn default() -> Self {
        Self {
            available: false,
            audio_active: false,
            audio_peak: 0.0,
            media_title: String::new(),
            media_artist: String::new(),
            source_app: String::new(),
            playback_status: "unavailable".to_string(),
            updated_at: current_unix_millis(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskStatus {
    #[serde(default = "default_agent_phase")]
    phase: String,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    updated_at: i64,
}

impl Default for AgentTaskStatus {
    fn default() -> Self {
        Self {
            phase: default_agent_phase(),
            task_id: None,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAgentStatus {
    #[serde(default)]
    codex: AgentTaskStatus,
    #[serde(default)]
    claude_code: AgentTaskStatus,
    #[serde(default)]
    opencode: AgentTaskStatus,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatusSnapshot {
    codex: AgentTaskStatus,
    claude_code: AgentTaskStatus,
    opencode: AgentTaskStatus,
    updated_at: i64,
    status_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHooksInstallResult {
    scripts_dir: String,
    status_path: String,
    codex_config_path: String,
    claude_config_path: String,
    opencode_plugin_path: String,
    installed_at: i64,
}

fn default_agent_phase() -> String {
    "idle".to_string()
}

#[tauri::command]
fn set_island_layout(app: AppHandle, layout: IslandLayout) -> Result<(), String> {
    let window = main_window(&app)?;
    let state = mutate_window_state(|state| {
        state.size_scale = layout.size_scale.clamp(0.75, 1.4);
        state.margin_y = layout.margin_y.clamp(0.0, 160.0);
        state.monitor_index = layout.monitor_index;
        *state
    });
    apply_stage_geometry(&window, state)
}

#[tauri::command]
fn set_island_interaction(
    app: AppHandle,
    mode: String,
    size_scale: f64,
    margin_y: Option<f64>,
    expanded_height: Option<f64>,
    is_tucked: Option<bool>,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mode = IslandMode::from_value(&mode)?;
    let state = mutate_window_state(|state| {
        state.mode = mode;
        state.is_tucked = is_tucked.unwrap_or(false);
        if let Some(monitor_index) = monitor_index {
            state.monitor_index = monitor_index;
        }
        state.size_scale = size_scale.clamp(0.75, 1.4);
        if let Some(margin_y) = margin_y {
            state.margin_y = margin_y.clamp(0.0, 160.0);
        }
        if let Some(expanded_height) = expanded_height {
            state.expanded_height = expanded_height.clamp(
                DEFAULT_EXPANDED_ISLAND_HEIGHT,
                DEFAULT_EXPANDED_ISLAND_HEIGHT + EXPANDED_ISLAND_HEIGHT_RANGE,
            );
        }
        *state
    });
    apply_stage_geometry(&window, state)
}

#[tauri::command]
fn get_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let window = main_window(&app)?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let result: Vec<MonitorInfo> = monitors
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let size = monitor.size();
            let is_primary = primary
                .as_ref()
                .map(|item| item.position() == monitor.position() && item.size() == size)
                .unwrap_or(false);
            MonitorInfo {
                index,
                name: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("显示器 {}", index + 1)),
                width: size.width,
                height: size.height,
                is_primary,
            }
        })
        .collect();
    Ok(result)
}

#[tauri::command]
fn minimize_island(app: AppHandle) -> Result<(), String> {
    hide_island(&app);
    Ok(())
}

#[tauri::command]
fn show_ready_island(app: AppHandle) -> Result<(), String> {
    show_island(&app)
}

#[tauri::command]
fn get_launch_at_startup() -> Result<bool, String> {
    let mut command = Command::new("reg");
    let status = command
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", STARTUP_REGISTRY_KEY, "/v", STARTUP_REGISTRY_VALUE])
        .status()
        .map_err(|error| format!("Failed to query startup registry: {error}"))?;

    Ok(status.success())
}

#[tauri::command]
fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    let status = if enabled {
        let current_exe = std::env::current_exe()
            .map_err(|error| format!("Failed to resolve current executable: {error}"))?;
        let startup_value = format!("\"{}\"", current_exe.display());

        let mut command = Command::new("reg");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "add",
                STARTUP_REGISTRY_KEY,
                "/v",
                STARTUP_REGISTRY_VALUE,
                "/t",
                "REG_SZ",
                "/d",
            ])
            .arg(startup_value)
            .arg("/f")
            .status()
    } else {
        let mut command = Command::new("reg");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "delete",
                STARTUP_REGISTRY_KEY,
                "/v",
                STARTUP_REGISTRY_VALUE,
                "/f",
            ])
            .status()
    }
    .map_err(|error| format!("Failed to update startup registry: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Startup registry command failed.".to_string())
    }
}

#[tauri::command]
fn save_todo_markdown(
    directory: String,
    date: String,
    content: String,
) -> Result<SaveTodoMarkdownResult, String> {
    let directory = directory.trim();

    if directory.is_empty() {
        return Err("Todo save path is empty.".to_string());
    }

    if !date.chars().all(|ch| ch.is_ascii_digit() || ch == '-') {
        return Err("Todo date contains invalid filename characters.".to_string());
    }

    let directory_path = PathBuf::from(directory);
    fs::create_dir_all(&directory_path).map_err(|error| error.to_string())?;

    let file_path = directory_path.join(format!("{date}.md"));
    fs::write(&file_path, content).map_err(|error| error.to_string())?;

    Ok(SaveTodoMarkdownResult {
        file_path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn get_default_todo_save_directory() -> Result<String, String> {
    let home_dir = windows_home_dir()?;
    Ok(home_dir
        .join("Documents")
        .join("Surfisle")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn get_agent_status(app: AppHandle) -> Result<AgentStatusSnapshot, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    let status_path = app_dir.join(AGENT_STATUS_FILE_NAME);
    let status_path_display = status_path.to_string_lossy().to_string();
    let mut snapshot = match fs::read_to_string(&status_path) {
        Ok(content) => match serde_json::from_str::<PersistedAgentStatus>(&content) {
            Ok(persisted) => agent_status_snapshot_from_persisted(persisted, status_path_display),
            Err(_) => default_agent_status_snapshot(status_path_display),
        },
        Err(_) => default_agent_status_snapshot(status_path_display),
    };
    apply_agent_running_markers(&app_dir, &mut snapshot);

    Ok(snapshot)
}

#[tauri::command]
fn clear_agent_status(app: AppHandle, provider: String) -> Result<AgentStatusSnapshot, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    let status_path = app_dir.join(AGENT_STATUS_FILE_NAME);
    let status_path_display = status_path.to_string_lossy().to_string();
    let mut persisted = match fs::read_to_string(&status_path) {
        Ok(content) => serde_json::from_str::<PersistedAgentStatus>(&content)
            .unwrap_or_else(|_| default_persisted_agent_status()),
        Err(_) => default_persisted_agent_status(),
    };

    let now = current_unix_millis();
    let cleared_status = AgentTaskStatus {
        phase: default_agent_phase(),
        task_id: None,
        updated_at: now,
    };

    match provider.as_str() {
        "codex" => {
            persisted.codex = cleared_status;
            remove_agent_marker_files(
                &app_dir,
                CODEX_RUNNING_MARKER_FILE_NAME,
                CODEX_RUNNING_HOLD_FILE_NAME,
            );
        }
        "claudeCode" => {
            persisted.claude_code = cleared_status;
            remove_agent_marker_files(
                &app_dir,
                CLAUDE_CODE_RUNNING_MARKER_FILE_NAME,
                CLAUDE_CODE_RUNNING_HOLD_FILE_NAME,
            );
        }
        "opencode" => {
            persisted.opencode = cleared_status;
            remove_agent_marker_files(
                &app_dir,
                OPENCODE_RUNNING_MARKER_FILE_NAME,
                OPENCODE_RUNNING_HOLD_FILE_NAME,
            );
        }
        _ => {
            return Err("Unsupported agent provider.".to_string());
        }
    }

    persisted.updated_at = now;
    let content = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("Failed to serialize agent status: {error}"))?;
    write_text_file(&status_path, &content)?;

    Ok(agent_status_snapshot_from_persisted(
        persisted,
        status_path_display,
    ))
}

#[tauri::command]
fn install_agent_status_hooks(app: AppHandle) -> Result<AgentHooksInstallResult, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    install_agent_hook_scripts(&app_dir)?;

    let running_script_path = app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME);
    let status_script_path = app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME);
    let home_dir = windows_home_dir()?;
    let codex_config_path = codex_home_dir(&home_dir).join("config.toml");
    let claude_config_path = home_dir.join(".claude").join("settings.json");
    let opencode_plugin_path = home_dir
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join(OPENCODE_PLUGIN_FILE_NAME);

    install_codex_status_hooks(
        &codex_config_path,
        &running_script_path,
        &status_script_path,
    )?;
    install_claude_code_status_hooks(
        &claude_config_path,
        &running_script_path,
        &status_script_path,
    )?;
    install_opencode_status_plugin(
        &opencode_plugin_path,
        &running_script_path,
        &status_script_path,
    )?;

    Ok(AgentHooksInstallResult {
        scripts_dir: app_dir.to_string_lossy().to_string(),
        status_path: app_dir
            .join(AGENT_STATUS_FILE_NAME)
            .to_string_lossy()
            .to_string(),
        codex_config_path: codex_config_path.to_string_lossy().to_string(),
        claude_config_path: claude_config_path.to_string_lossy().to_string(),
        opencode_plugin_path: opencode_plugin_path.to_string_lossy().to_string(),
        installed_at: current_unix_millis(),
    })
}

#[tauri::command]
fn get_agent_status_hooks_connection(
    app: AppHandle,
) -> Result<Option<AgentHooksInstallResult>, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let running_script_path = app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME);
    let status_script_path = app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME);

    if !running_script_path.is_file() || !status_script_path.is_file() {
        return Ok(None);
    }

    let home_dir = windows_home_dir()?;
    let codex_config_path = codex_home_dir(&home_dir).join("config.toml");
    let claude_config_path = home_dir.join(".claude").join("settings.json");
    let opencode_plugin_path = home_dir
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join(OPENCODE_PLUGIN_FILE_NAME);
    let codex_connected = fs::read_to_string(&codex_config_path)
        .is_ok_and(|content| content.contains(SURFISLE_AGENT_HOOK_BLOCK_BEGIN));
    let claude_connected = fs::read_to_string(&claude_config_path)
        .is_ok_and(|content| content.contains(SURFISLE_AGENT_HOOK_SIGNATURE));
    let opencode_connected = opencode_plugin_path.is_file();

    if !codex_connected && !claude_connected && !opencode_connected {
        return Ok(None);
    }

    Ok(Some(AgentHooksInstallResult {
        scripts_dir: app_dir.to_string_lossy().to_string(),
        status_path: app_dir
            .join(AGENT_STATUS_FILE_NAME)
            .to_string_lossy()
            .to_string(),
        codex_config_path: codex_config_path.to_string_lossy().to_string(),
        claude_config_path: claude_config_path.to_string_lossy().to_string(),
        opencode_plugin_path: opencode_plugin_path.to_string_lossy().to_string(),
        installed_at: 0,
    }))
}

fn ensure_opencode_status_plugin(app: &AppHandle) -> Result<(), String> {
    let home_dir = windows_home_dir()?;
    let opencode_dir = home_dir.join(".config").join("opencode");
    if !opencode_dir.exists() {
        return Ok(());
    }

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    install_agent_hook_scripts(&app_dir)?;

    install_opencode_status_plugin(
        &opencode_dir.join("plugins").join(OPENCODE_PLUGIN_FILE_NAME),
        &app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME),
        &app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME),
    )
}

fn ensure_codex_status_hooks(app: &AppHandle) -> Result<(), String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    install_agent_hook_scripts(&app_dir)?;
    let home_dir = windows_home_dir()?;
    let config_path = codex_home_dir(&home_dir).join("config.toml");
    if !config_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read Codex config: {error}"))?;
    if !content.contains(SURFISLE_AGENT_HOOK_BLOCK_BEGIN) {
        install_codex_status_hooks(
            &config_path,
            &app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME),
            &app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME),
        )?;
    }
    Ok(())
}

#[tauri::command]
async fn get_media_state() -> MediaState {
    read_media_state().await
}

#[tauri::command]
fn get_audio_spectrum() -> AudioSpectrum {
    capture_system_audio_spectrum().unwrap_or_else(|_| AudioSpectrum {
        bands: vec![0.0; AUDIO_SPECTRUM_BAND_COUNT],
        updated_at: current_unix_millis(),
        ..Default::default()
    })
}

#[tauri::command]
fn media_play_pause() {
    send_media_key(VK_MEDIA_PLAY_PAUSE);
}

#[tauri::command]
fn media_next() {
    send_media_key(VK_MEDIA_NEXT_TRACK);
}

#[tauri::command]
fn media_previous() {
    send_media_key(VK_MEDIA_PREV_TRACK);
}

async fn read_media_state() -> MediaState {
    let (audio_peak, media_title, source_app) = tauri::async_runtime::spawn_blocking(|| {
        let audio_peak = read_system_audio_peak_window(3, Duration::from_millis(6)).unwrap_or(0.0);
        let (media_title, source_app) = read_active_audio_window_title();
        (audio_peak, media_title, source_app)
    })
    .await
    .unwrap_or_default();
    let audio_active = audio_peak > AUDIO_ACTIVE_THRESHOLD;

    MediaState {
        available: audio_active || !media_title.is_empty() || !source_app.is_empty(),
        audio_active,
        audio_peak,
        media_title,
        media_artist: String::new(),
        source_app,
        playback_status: if audio_active {
            "playing"
        } else {
            "unavailable"
        }
        .to_string(),
        updated_at: current_unix_millis(),
    }
}

fn default_agent_status_snapshot(status_path: String) -> AgentStatusSnapshot {
    AgentStatusSnapshot {
        codex: AgentTaskStatus::default(),
        claude_code: AgentTaskStatus::default(),
        opencode: AgentTaskStatus::default(),
        updated_at: current_unix_millis(),
        status_path,
    }
}

fn default_persisted_agent_status() -> PersistedAgentStatus {
    PersistedAgentStatus {
        codex: AgentTaskStatus::default(),
        claude_code: AgentTaskStatus::default(),
        opencode: AgentTaskStatus::default(),
        updated_at: current_unix_millis(),
    }
}

fn agent_status_snapshot_from_persisted(
    persisted: PersistedAgentStatus,
    status_path: String,
) -> AgentStatusSnapshot {
    AgentStatusSnapshot {
        codex: normalize_agent_task_status(persisted.codex),
        claude_code: normalize_agent_task_status(persisted.claude_code),
        opencode: normalize_agent_task_status(persisted.opencode),
        updated_at: if persisted.updated_at > 0 {
            persisted.updated_at
        } else {
            current_unix_millis()
        },
        status_path,
    }
}

fn apply_agent_running_markers(app_dir: &Path, snapshot: &mut AgentStatusSnapshot) {
    let now = current_unix_millis();

    if let Some(marker_status) = active_agent_running_marker_status(
        app_dir,
        &snapshot.codex,
        CODEX_RUNNING_MARKER_FILE_NAME,
        CODEX_RUNNING_HOLD_FILE_NAME,
        now,
    ) {
        snapshot.codex.phase = marker_status.phase;
        snapshot.codex.updated_at = marker_status.updated_at;
    }

    if let Some(marker_status) = active_agent_running_marker_status(
        app_dir,
        &snapshot.claude_code,
        CLAUDE_CODE_RUNNING_MARKER_FILE_NAME,
        CLAUDE_CODE_RUNNING_HOLD_FILE_NAME,
        now,
    ) {
        snapshot.claude_code.phase = marker_status.phase;
        snapshot.claude_code.updated_at = marker_status.updated_at;
    }

    if let Some(marker_status) = active_agent_running_marker_status(
        app_dir,
        &snapshot.opencode,
        OPENCODE_RUNNING_MARKER_FILE_NAME,
        OPENCODE_RUNNING_HOLD_FILE_NAME,
        now,
    ) {
        snapshot.opencode.phase = marker_status.phase;
        snapshot.opencode.updated_at = marker_status.updated_at;
    }
}

fn active_agent_running_marker_status(
    app_dir: &Path,
    status: &AgentTaskStatus,
    running_file_name: &str,
    hold_file_name: &str,
    now: i64,
) -> Option<AgentTaskStatus> {
    let running_path = app_dir.join(running_file_name);
    if running_path.is_file() {
        let marker_updated_at = file_modified_unix_millis(&running_path).unwrap_or(now);
        if status.phase != "running"
            && status.updated_at > 0
            && status.updated_at >= marker_updated_at
        {
            return None;
        }

        let phase = if now.saturating_sub(marker_updated_at) >= AGENT_RUNNING_STALE_AFTER_MS {
            "stale"
        } else {
            "running"
        };

        return Some(AgentTaskStatus {
            phase: phase.to_string(),
            task_id: status.task_id.clone(),
            updated_at: marker_updated_at,
        });
    }

    let hold_path = app_dir.join(hold_file_name);
    let visible_until = fs::read_to_string(hold_path)
        .ok()
        .and_then(|content| content.trim().parse::<i64>().ok())?;
    if visible_until > now {
        Some(AgentTaskStatus {
            phase: "running".to_string(),
            task_id: status.task_id.clone(),
            updated_at: now,
        })
    } else {
        None
    }
}

fn remove_agent_marker_files(app_dir: &Path, running_file_name: &str, hold_file_name: &str) {
    fs::remove_file(app_dir.join(running_file_name)).ok();
    fs::remove_file(app_dir.join(hold_file_name)).ok();
}

fn normalize_agent_task_status(mut status: AgentTaskStatus) -> AgentTaskStatus {
    if !matches!(
        status.phase.as_str(),
        "idle" | "running" | "completed" | "failed" | "stale"
    ) {
        status.phase = default_agent_phase();
    }

    status
}

fn install_agent_hook_scripts(app_dir: &Path) -> Result<(), String> {
    write_text_file(
        &app_dir.join(AGENT_RUNNING_SCRIPT_FILE_NAME),
        &normalize_windows_line_endings(AGENT_RUNNING_SCRIPT),
    )?;
    write_text_file(
        &app_dir.join(AGENT_STATUS_SCRIPT_FILE_NAME),
        &normalize_windows_line_endings(AGENT_STATUS_SCRIPT),
    )
}

fn install_codex_status_hooks(
    config_path: &Path,
    running_script_path: &Path,
    status_script_path: &Path,
) -> Result<(), String> {
    let content = fs::read_to_string(config_path).unwrap_or_default();
    let content = remove_managed_codex_hook_block(&content);
    let block = build_codex_hook_block(running_script_path, status_script_path);
    let mut next_content = content.trim_end().to_string();
    if !next_content.is_empty() {
        next_content.push_str("\n\n");
    }
    next_content.push_str(&block);

    write_text_file(config_path, &next_content)
}

fn install_claude_code_status_hooks(
    config_path: &Path,
    running_script_path: &Path,
    status_script_path: &Path,
) -> Result<(), String> {
    let mut config = match fs::read_to_string(config_path) {
        Ok(content) if !content.trim().is_empty() => serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Failed to parse Claude Code settings.json: {error}"))?,
        _ => json!({}),
    };

    let Some(root) = config.as_object_mut() else {
        return Err("Claude Code settings.json must contain a JSON object.".to_string());
    };

    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "Failed to prepare Claude Code hooks object.".to_string())?;

    install_claude_code_hook_event(
        hooks,
        "UserPromptSubmit",
        claude_code_running_hook_entry(running_script_path),
    );
    install_claude_code_hook_event(
        hooks,
        "PreToolUse",
        claude_code_match_all_hook_entry(claude_code_running_hook_entry(running_script_path)),
    );
    install_claude_code_hook_event(
        hooks,
        "Stop",
        claude_code_status_hook_entry(status_script_path, "completed"),
    );
    install_claude_code_hook_event(
        hooks,
        "StopFailure",
        claude_code_status_hook_entry(status_script_path, "failed"),
    );

    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize Claude Code settings.json: {error}"))?;
    write_text_file(config_path, &json)
}

fn install_opencode_status_plugin(
    plugin_path: &Path,
    running_script_path: &Path,
    status_script_path: &Path,
) -> Result<(), String> {
    let running_script = serde_json::to_string(&running_script_path.to_string_lossy())
        .map_err(|error| format!("Failed to encode OpenCode running script path: {error}"))?;
    let status_script = serde_json::to_string(&status_script_path.to_string_lossy())
        .map_err(|error| format!("Failed to encode OpenCode status script path: {error}"))?;
    let plugin = format!(
        r#"const runningScript = {running_script};
const statusScript = {status_script};

const runHidden = async (command, args) => {{
  const child = Bun.spawn([command, ...args], {{
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  }});
  await child.exited;
}};

const markRunning = async () =>
  runHidden("cmd.exe", ["/d", "/s", "/c", `"${{runningScript}}" opencode`]);

const markFinished = async (phase, sessionID = "") =>
  runHidden("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    statusScript,
    "opencode",
    phase,
    sessionID,
  ]);

export const SurfisleStatusPlugin = async () => ({{
  event: async ({{ event }}) => {{
    const sessionID = event.properties?.sessionID ?? "";

    if (event.type === "session.status") {{
      const status = event.properties?.status?.type;
      if (status === "busy" || status === "retry") await markRunning();
      if (status === "idle") await markFinished("completed", sessionID);
      return;
    }}

    if (event.type === "session.idle") {{
      await markFinished("completed", sessionID);
    }} else if (event.type === "session.error") {{
      await markFinished("failed", sessionID);
    }}
  }},
}});
"#,
    );

    write_text_file(plugin_path, &plugin)
}

fn install_claude_code_hook_event(hooks: &mut Map<String, Value>, event_name: &str, entry: Value) {
    let mut entries = hooks
        .remove(event_name)
        .and_then(|value| match value {
            Value::Array(entries) => Some(entries),
            _ => None,
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(remove_managed_claude_code_hooks)
        .collect::<Vec<_>>();

    entries.push(entry);
    hooks.insert(event_name.to_string(), Value::Array(entries));
}

fn remove_managed_claude_code_hooks(mut entry: Value) -> Option<Value> {
    let Value::Object(entry_object) = &mut entry else {
        return Some(entry);
    };

    let Some(hooks_value) = entry_object.get_mut("hooks") else {
        return Some(entry);
    };

    let Value::Array(hooks) = hooks_value else {
        return Some(entry);
    };

    hooks.retain(|hook| !value_contains_surfisle_hook_signature(hook));
    if hooks.is_empty() {
        None
    } else {
        Some(entry)
    }
}

fn value_contains_surfisle_hook_signature(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains(SURFISLE_AGENT_HOOK_SIGNATURE),
        Value::Array(values) => values.iter().any(value_contains_surfisle_hook_signature),
        Value::Object(values) => values.values().any(value_contains_surfisle_hook_signature),
        _ => false,
    }
}

fn claude_code_match_all_hook_entry(mut entry: Value) -> Value {
    if let Value::Object(object) = &mut entry {
        object.insert("matcher".to_string(), Value::String("*".to_string()));
    }

    entry
}

fn claude_code_running_hook_entry(script_path: &Path) -> Value {
    claude_code_hook_entry(
        "cmd.exe",
        vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            format!("\"{}\" claudeCode", script_path.to_string_lossy()),
        ],
        1,
    )
}

fn claude_code_status_hook_entry(script_path: &Path, phase: &str) -> Value {
    claude_code_hook_entry(
        "powershell.exe",
        vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script_path.to_string_lossy().to_string(),
            "claudeCode".to_string(),
            phase.to_string(),
        ],
        5,
    )
}

fn claude_code_hook_entry(command: &str, args: Vec<String>, timeout: i64) -> Value {
    json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "args": args,
                "timeout": timeout
            }
        ]
    })
}

fn build_codex_hook_block(running_script_path: &Path, status_script_path: &Path) -> String {
    let submit_command = agent_running_command(running_script_path, "codex");
    let stop_command = agent_status_command(status_script_path, "codex", "completed");

    format!(
        r#"{begin}

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = {submit_command}
command_windows = {submit_command}
timeout = 1
statusMessage = "Updating Surfisle agent status"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = {stop_command}
command_windows = {stop_command}
timeout = 5
statusMessage = "Updating Surfisle agent status"

{end}"#,
        begin = SURFISLE_AGENT_HOOK_BLOCK_BEGIN,
        end = SURFISLE_AGENT_HOOK_BLOCK_END,
        submit_command = toml_basic_string(&submit_command),
        stop_command = toml_basic_string(&stop_command),
    )
}

fn remove_managed_codex_hook_block(content: &str) -> String {
    let mut remaining = content;
    let mut next_content = String::new();

    while let Some(start) = remaining.find(SURFISLE_AGENT_HOOK_BLOCK_BEGIN) {
        next_content.push_str(&remaining[..start]);
        let after_begin = &remaining[start..];
        let Some(end) = after_begin.find(SURFISLE_AGENT_HOOK_BLOCK_END) else {
            remaining = "";
            break;
        };

        remaining = &after_begin[end + SURFISLE_AGENT_HOOK_BLOCK_END.len()..];
        if let Some(stripped) = remaining.strip_prefix("\r\n") {
            remaining = stripped;
        } else if let Some(stripped) = remaining.strip_prefix('\n') {
            remaining = stripped;
        }
    }

    next_content.push_str(remaining);
    remove_stale_codex_surfisle_hooks(&next_content)
}

fn remove_stale_codex_surfisle_hooks(content: &str) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let mut next_lines: Vec<&str> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if let Some(hook_path) = codex_hook_event_path(trimmed) {
            let start = index;
            index += 1;

            while index < lines.len() && !lines[index].trim().starts_with('[') {
                index += 1;
            }

            let metadata_end = index;
            let mut kept_child_ranges = Vec::new();
            let mut removed_managed_child = false;

            while index < lines.len() {
                let candidate = lines[index].trim();
                if !is_codex_nested_hook_header_for(candidate, &hook_path) {
                    break;
                }

                let child_start = index;
                index += 1;
                while index < lines.len() && !lines[index].trim().starts_with('[') {
                    index += 1;
                }

                let child_block = lines[child_start..index].join("\n");
                if child_block.contains(SURFISLE_AGENT_HOOK_SIGNATURE) {
                    removed_managed_child = true;
                } else {
                    kept_child_ranges.push(child_start..index);
                }
            }

            if !removed_managed_child {
                next_lines.extend_from_slice(&lines[start..index]);
                continue;
            }

            if kept_child_ranges.is_empty() {
                continue;
            }

            next_lines.extend_from_slice(&lines[start..metadata_end]);
            for range in kept_child_ranges {
                next_lines.extend_from_slice(&lines[range]);
            }
            continue;
        }

        next_lines.push(lines[index]);
        index += 1;
    }

    next_lines.join("\n")
}

fn codex_hook_event_path(header: &str) -> Option<String> {
    if !header.starts_with("[[hooks.") || !header.ends_with("]]") {
        return None;
    }

    let hook_path = header.strip_prefix("[[")?.strip_suffix("]]")?;
    if hook_path.ends_with(".hooks") {
        return None;
    }

    Some(hook_path.to_string())
}

fn is_codex_nested_hook_header_for(header: &str, hook_path: &str) -> bool {
    header == format!("[[{hook_path}.hooks]]")
}

fn agent_running_command(script_path: &Path, provider: &str) -> String {
    format!(
        "cmd.exe /d /s /c \"\"{}\" {}\"",
        script_path.to_string_lossy(),
        provider
    )
}

fn agent_status_command(script_path: &Path, provider: &str, phase: &str) -> String {
    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\" {} {}",
        script_path.to_string_lossy(),
        provider,
        phase
    )
}

fn toml_basic_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let temporary_path = path.with_extension("tmp");
    fs::write(&temporary_path, content)
        .map_err(|error| format!("Failed to write {}: {error}", temporary_path.display()))?;
    fs::rename(&temporary_path, path)
        .or_else(|_| {
            fs::remove_file(path).ok();
            fs::rename(&temporary_path, path)
        })
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

fn normalize_windows_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn windows_home_dir() -> Result<PathBuf, String> {
    if let Ok(user_profile) = env::var("USERPROFILE") {
        let user_profile = user_profile.trim();
        if !user_profile.is_empty() {
            return Ok(PathBuf::from(user_profile));
        }
    }

    match (env::var("HOMEDRIVE"), env::var("HOMEPATH")) {
        (Ok(home_drive), Ok(home_path)) if !home_drive.is_empty() && !home_path.is_empty() => {
            Ok(PathBuf::from(format!("{home_drive}{home_path}")))
        }
        _ => Err("Failed to resolve the Windows user profile directory.".to_string()),
    }
}

fn codex_home_dir(home_dir: &Path) -> PathBuf {
    env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".codex"))
}

fn read_system_audio_peak_window(samples: usize, delay: Duration) -> Result<f32, String> {
    unsafe {
        let did_initialize_com = initialize_com_for_audio();
        let peak_result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(media_error)?;
            let mut meters: Vec<IAudioMeterInformation> = Vec::new();

            for role in [eMultimedia, eConsole, eCommunications] {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, role) {
                    if let Ok(meter) = device.Activate(CLSCTX_ALL, None) {
                        meters.push(meter);
                    }
                }
            }

            if meters.is_empty() {
                return Err("No default render audio endpoint was available.".to_string());
            }

            let mut peak = 0.0_f32;

            for sample_index in 0..samples.max(1) {
                for meter in &meters {
                    if let Ok(value) = meter.GetPeakValue() {
                        peak = peak.max(value);
                    }
                }

                if !delay.is_zero() && sample_index + 1 < samples {
                    thread::sleep(delay);
                }
            }

            Ok(peak.clamp(0.0, 1.0))
        })();

        if did_initialize_com {
            CoUninitialize();
        }

        peak_result
    }
}

struct WindowTitleSearch {
    process_id: u32,
    title: Option<String>,
}

unsafe extern "system" fn find_process_window_title(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = unsafe { &mut *(lparam.0 as *mut WindowTitleSearch) };

    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return BOOL(1);
    }

    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };

    if process_id != search.process_id {
        return BOOL(1);
    }

    let title_length = unsafe { GetWindowTextLengthW(hwnd) };
    if title_length <= 0 {
        return BOOL(1);
    }

    let mut buffer = vec![0_u16; title_length as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if copied > 0 {
        let title = String::from_utf16_lossy(&buffer[..copied as usize])
            .trim()
            .to_string();
        if !title.is_empty() {
            search.title = Some(title);
            return BOOL(0);
        }
    }

    BOOL(1)
}

fn window_title_for_process(process_id: u32) -> Option<String> {
    let mut search = WindowTitleSearch {
        process_id,
        title: None,
    };

    unsafe {
        let _ = EnumWindows(
            Some(find_process_window_title),
            LPARAM((&mut search as *mut WindowTitleSearch) as isize),
        );
    }

    search.title
}

fn read_active_audio_window_title() -> (String, String) {
    let did_initialize_com = initialize_com_for_audio();
    let result = (|| unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(media_error)?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(media_error)?;
        let session_manager: IAudioSessionManager2 =
            device.Activate(CLSCTX_ALL, None).map_err(media_error)?;
        let sessions = session_manager
            .GetSessionEnumerator()
            .map_err(media_error)?;
        let count = sessions.GetCount().map_err(media_error)?;
        let mut titles = Vec::new();

        for index in 0..count {
            let control = match sessions.GetSession(index) {
                Ok(control) => control,
                Err(_) => continue,
            };
            if control.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(control) => control,
                Err(_) => continue,
            };
            let process_id = match control2.GetProcessId() {
                Ok(process_id) if process_id > 0 => process_id,
                _ => continue,
            };
            if let Some(title) = window_title_for_process(process_id) {
                titles.push(title);
            }
        }

        titles.sort_by_key(|title| usize::MAX - title.chars().count());
        Ok::<_, String>(titles.into_iter().next().unwrap_or_default())
    })()
    .unwrap_or_default();

    if did_initialize_com {
        unsafe { CoUninitialize() };
    }

    (result, String::new())
}

fn capture_system_audio_spectrum() -> Result<AudioSpectrum, String> {
    unsafe {
        let did_initialize_com = initialize_com_for_audio();
        let spectrum_result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(media_error)?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .map_err(media_error)?;
            let audio_client: IAudioClient =
                device.Activate(CLSCTX_ALL, None).map_err(media_error)?;
            let mix_format = audio_client.GetMixFormat().map_err(media_error)?;

            let capture_result = (|| {
                audio_client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK,
                        0,
                        0,
                        mix_format,
                        None,
                    )
                    .map_err(media_error)?;
                let capture_client: IAudioCaptureClient =
                    audio_client.GetService().map_err(media_error)?;

                audio_client.Start().map_err(media_error)?;
                thread::sleep(AUDIO_SPECTRUM_CAPTURE_DELAY);

                let mut samples = Vec::with_capacity(AUDIO_SPECTRUM_SAMPLE_COUNT * 2);
                let mut capture_error = None;

                loop {
                    let packet_size = match capture_client.GetNextPacketSize() {
                        Ok(size) => size,
                        Err(error) => {
                            capture_error = Some(media_error(error));
                            break;
                        }
                    };

                    if packet_size == 0 {
                        break;
                    }

                    let mut data = core::ptr::null_mut();
                    let mut frames = 0;
                    let mut flags = 0;

                    if let Err(error) =
                        capture_client.GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    {
                        capture_error = Some(media_error(error));
                        break;
                    }

                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 && !data.is_null() {
                        if let Err(error) =
                            append_mono_samples(data, frames as usize, mix_format, &mut samples)
                        {
                            capture_error = Some(error);
                        }
                    }

                    if let Err(error) = capture_client.ReleaseBuffer(frames) {
                        capture_error = Some(media_error(error));
                        break;
                    }

                    if capture_error.is_some() {
                        break;
                    }
                }

                let stop_result = audio_client.Stop().map_err(media_error);
                stop_result?;

                if let Some(error) = capture_error {
                    return Err(error);
                }

                Ok(analyze_audio_spectrum(
                    &samples,
                    (*mix_format).nSamplesPerSec as f32,
                ))
            })();

            CoTaskMemFree(Some(mix_format.cast::<c_void>()));
            capture_result
        })();

        if did_initialize_com {
            CoUninitialize();
        }

        spectrum_result
    }
}

unsafe fn append_mono_samples(
    data: *const u8,
    frames: usize,
    format: *const WAVEFORMATEX,
    output: &mut Vec<f32>,
) -> Result<(), String> {
    let channels = (*format).nChannels as usize;
    let bits_per_sample = (*format).wBitsPerSample as usize;
    let block_align = (*format).nBlockAlign as usize;

    if channels == 0 || block_align == 0 || !matches!(bits_per_sample, 16 | 24 | 32) {
        return Err("Unsupported system audio format for spectrum analysis.".to_string());
    }

    let bytes_per_sample = bits_per_sample / 8;
    if block_align < channels * bytes_per_sample {
        return Err("Invalid system audio frame alignment.".to_string());
    }

    let is_float = is_float_wave_format(format);

    for frame_index in 0..frames {
        let frame = data.add(frame_index * block_align);
        let mut sample_sum = 0.0;

        for channel_index in 0..channels {
            let sample = frame.add(channel_index * bytes_per_sample);
            sample_sum += decode_audio_sample(sample, bits_per_sample, is_float);
        }

        output.push(sample_sum / channels as f32);
    }

    Ok(())
}

unsafe fn is_float_wave_format(format: *const WAVEFORMATEX) -> bool {
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;

    match (*format).wFormatTag {
        WAVE_FORMAT_IEEE_FLOAT => true,
        WAVE_FORMAT_EXTENSIBLE => {
            let sub_format_data_1 =
                core::ptr::read_unaligned((format as *const u8).add(24).cast::<u32>());
            sub_format_data_1 == WAVE_FORMAT_IEEE_FLOAT as u32
        }
        _ => false,
    }
}

unsafe fn decode_audio_sample(sample: *const u8, bits_per_sample: usize, is_float: bool) -> f32 {
    match (bits_per_sample, is_float) {
        (32, true) => f32::from_le_bytes([*sample, *sample.add(1), *sample.add(2), *sample.add(3)]),
        (32, false) => {
            i32::from_le_bytes([*sample, *sample.add(1), *sample.add(2), *sample.add(3)]) as f32
                / i32::MAX as f32
        }
        (24, _) => {
            let value =
                (*sample as i32) | ((*sample.add(1) as i32) << 8) | ((*sample.add(2) as i32) << 16);
            let signed_value = if value & 0x80_0000 != 0 {
                value | !0x00ff_ffff
            } else {
                value
            };
            signed_value as f32 / 8_388_608.0
        }
        (16, _) => i16::from_le_bytes([*sample, *sample.add(1)]) as f32 / 32_768.0,
        _ => 0.0,
    }
}

fn analyze_audio_spectrum(samples: &[f32], sample_rate: f32) -> AudioSpectrum {
    if samples.is_empty() || sample_rate <= 0.0 {
        return AudioSpectrum {
            bands: vec![0.0; AUDIO_SPECTRUM_BAND_COUNT],
            updated_at: current_unix_millis(),
            ..Default::default()
        };
    }

    let mut windowed_samples = vec![0.0; AUDIO_SPECTRUM_SAMPLE_COUNT];
    let available_samples = samples.len().min(AUDIO_SPECTRUM_SAMPLE_COUNT);
    let source_start = samples.len() - available_samples;
    let target_start = AUDIO_SPECTRUM_SAMPLE_COUNT - available_samples;

    for (offset, sample) in samples[source_start..].iter().enumerate() {
        let index = target_start + offset;
        let window =
            0.5 - 0.5 * (2.0 * PI * index as f32 / (AUDIO_SPECTRUM_SAMPLE_COUNT - 1) as f32).cos();
        windowed_samples[index] = sample * window;
    }

    let nyquist = sample_rate / 2.0;
    let max_frequency = nyquist.min(16_000.0).max(40.0);
    let min_frequency = 35.0_f32.min(max_frequency);
    let log_range = (max_frequency / min_frequency).ln();
    let mut bands = Vec::with_capacity(AUDIO_SPECTRUM_BAND_COUNT);

    for band_index in 0..AUDIO_SPECTRUM_BAND_COUNT {
        let position = band_index as f32 / (AUDIO_SPECTRUM_BAND_COUNT - 1) as f32;
        let target_frequency = min_frequency * (log_range * position).exp();
        let bin = ((target_frequency * AUDIO_SPECTRUM_SAMPLE_COUNT as f32 / sample_rate).round()
            as usize)
            .clamp(1, AUDIO_SPECTRUM_SAMPLE_COUNT / 2 - 1);
        let coefficient = 2.0 * (2.0 * PI * bin as f32 / AUDIO_SPECTRUM_SAMPLE_COUNT as f32).cos();
        let mut previous = 0.0;
        let mut previous_previous = 0.0;

        for sample in &windowed_samples {
            let current = sample + coefficient * previous - previous_previous;
            previous_previous = previous;
            previous = current;
        }

        let magnitude = (previous * previous + previous_previous * previous_previous
            - coefficient * previous * previous_previous)
            .max(0.0)
            .sqrt()
            / AUDIO_SPECTRUM_SAMPLE_COUNT as f32;
        bands.push((magnitude * 28.0).sqrt().clamp(0.0, 1.0));
    }

    let peak = samples
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));

    AudioSpectrum {
        active: peak > AUDIO_ACTIVE_THRESHOLD,
        peak,
        bands,
        updated_at: current_unix_millis(),
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioSpectrum {
    active: bool,
    peak: f32,
    bands: Vec<f32>,
    updated_at: i64,
}

fn initialize_com_for_audio() -> bool {
    unsafe {
        let result = CoInitializeEx(None, COINIT_MULTITHREADED);

        if result == RPC_E_CHANGED_MODE {
            false
        } else {
            result.is_ok()
        }
    }
}

fn send_media_key(key: VIRTUAL_KEY) {
    let key_code = key.0 as u8;

    unsafe {
        keybd_event(key_code, 0, KEYBD_EVENT_FLAGS(0), 0);
        thread::sleep(Duration::from_millis(18));
        keybd_event(key_code, 0, KEYEVENTF_KEYUP, 0);
    }
}

fn file_modified_unix_millis(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    system_time_to_unix_millis(modified)
}

fn current_unix_millis() -> i64 {
    system_time_to_unix_millis(SystemTime::now()).unwrap_or_default()
}

fn system_time_to_unix_millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .ok()
}

fn media_error(error: windows::core::Error) -> String {
    format!("Windows media session error: {error}")
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "Main island window was not found.".to_string())
}

fn show_island(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn hide_island(app: &AppHandle) {
    if let Ok(window) = main_window(app) {
        let _ = window.hide();
    }
}

fn window_state() -> &'static Mutex<IslandWindowState> {
    WINDOW_STATE.get_or_init(|| Mutex::new(IslandWindowState::default()))
}

fn mutate_window_state(
    update: impl FnOnce(&mut IslandWindowState) -> IslandWindowState,
) -> IslandWindowState {
    let mut state = window_state().lock().expect("window state poisoned");
    update(&mut state)
}

fn read_window_state() -> IslandWindowState {
    *window_state().lock().expect("window state poisoned")
}

fn apply_stage_geometry(window: &WebviewWindow, state: IslandWindowState) -> Result<(), String> {
    if cfg!(debug_assertions) {
        window
            .set_size(Size::Logical(LogicalSize::new(
                STAGE_WINDOW_WIDTH,
                STAGE_WINDOW_HEIGHT,
            )))
            .map_err(|error| error.to_string())?;
        return window.center().map_err(|error| error.to_string());
    }

    let (_, base_height) = state.mode.base_size(state.expanded_height);
    let stage_height =
        STAGE_WINDOW_HEIGHT.max((base_height * state.size_scale).ceil() + STAGE_WINDOW_PADDING_Y);

    window
        .set_size(Size::Logical(LogicalSize::new(
            STAGE_WINDOW_WIDTH,
            stage_height,
        )))
        .map_err(|error| error.to_string())?;

    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let monitor = monitors
        .get(state.monitor_index)
        .cloned()
        .or(primary)
        .or(window.current_monitor().map_err(|error| error.to_string())?)
        .ok_or_else(|| "No monitor is available for island positioning.".to_string())?;

    let scale = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let physical_width = (STAGE_WINDOW_WIDTH * scale).round() as i32;
    let physical_top_offset = if matches!(state.mode, IslandMode::Collapsed) && state.is_tucked {
        -((COLLAPSED_ISLAND_HEIGHT * state.size_scale - TUCKED_VISIBLE_EDGE_HEIGHT).max(0.0)
            * scale)
            .round() as i32
    } else {
        (state.margin_y * scale).round() as i32
    };
    let x = monitor_position.x + ((monitor_size.width as i32 - physical_width) / 2);
    let y = monitor_position.y + physical_top_offset;

    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

fn start_cursor_passthrough_loop(window: WebviewWindow) {
    thread::spawn(move || {
        let mut ignoring_cursor = false;

        loop {
            let should_ignore = !cursor_is_inside_island(&window);

            if should_ignore != ignoring_cursor {
                if window.set_ignore_cursor_events(should_ignore).is_ok() {
                    ignoring_cursor = should_ignore;
                }
            }

            thread::sleep(Duration::from_millis(12));
        }
    });
}

fn cursor_is_inside_island(window: &WebviewWindow) -> bool {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(_) => return true,
    };
    let mut window_rect = RECT::default();
    let mut cursor = POINT::default();

    if unsafe { GetWindowRect(hwnd, &mut window_rect) }.is_err() {
        return true;
    }

    if unsafe { GetCursorPos(&mut cursor) }.is_err() {
        return true;
    }

    let window_width = (window_rect.right - window_rect.left).max(1) as f64;
    let physical_scale = window_width / STAGE_WINDOW_WIDTH;
    let local_x = (cursor.x - window_rect.left) as f64;
    let local_y = (cursor.y - window_rect.top) as f64;
    let state = read_window_state();
    let (base_width, base_height) = state.mode.base_size(state.expanded_height);
    let island_width = base_width * state.size_scale * physical_scale;
    let island_height = base_height * state.size_scale * physical_scale;
    let island_left = (window_width - island_width) / 2.0;
    let island_top = 0.0;
    let radius = state.mode.corner_radius() * state.size_scale * physical_scale;

    point_in_rounded_rect(
        local_x,
        local_y,
        island_left,
        island_top,
        island_width,
        island_height,
        radius,
    )
}

fn point_in_rounded_rect(
    x: f64,
    y: f64,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    radius: f64,
) -> bool {
    let right = left + width;
    let bottom = top + height;

    if x < left || x > right || y < top || y > bottom {
        return false;
    }

    let radius = radius.min(width / 2.0).min(height / 2.0);
    let center_x = if x < left + radius {
        left + radius
    } else if x > right - radius {
        right - radius
    } else {
        x
    };
    let center_y = if y < top + radius {
        top + radius
    } else if y > bottom - radius {
        bottom - radius
    } else {
        y
    };
    let dx = x - center_x;
    let dy = y - center_y;

    (dx * dx) + (dy * dy) <= radius * radius
}

fn build_tray(app: &App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Island", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "Hide Island", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("Surfisle")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let _ = show_island(app);
            }
            "hide" => hide_island(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_island(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_island(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            build_tray(app)?;
            if let Err(error) = ensure_opencode_status_plugin(app.handle()) {
                eprintln!("failed to install OpenCode status plugin: {error}");
            }
            if let Err(error) = ensure_codex_status_hooks(app.handle()) {
                eprintln!("failed to install Codex status hooks: {error}");
            }
            if let Err(error) = clipboard_history::init(app.handle()) {
                eprintln!("failed to initialize clipboard history: {error}");
            }
            match main_window(app.handle()) {
                Ok(window) => {
                    if let Err(error) = apply_stage_geometry(&window, IslandWindowState::default())
                    {
                        eprintln!("failed to size and position island window: {error}");
                    }
                    #[cfg(debug_assertions)]
                    {
                        if let Err(error) = window.set_decorations(true) {
                            eprintln!("failed to enable development window decorations: {error}");
                        }
                        if let Err(error) = window.set_resizable(true) {
                            eprintln!("failed to make development window resizable: {error}");
                        }
                        if let Err(error) = window.set_always_on_top(false) {
                            eprintln!("failed to disable development always-on-top: {error}");
                        }
                        if let Err(error) = window.set_skip_taskbar(false) {
                            eprintln!("failed to show development window in taskbar: {error}");
                        }
                        if let Err(error) =
                            window.set_background_color(Some(Color(242, 242, 242, 255)))
                        {
                            eprintln!("failed to set development window background: {error}");
                        }
                        if let Err(error) = window.center() {
                            eprintln!("failed to center development window: {error}");
                        }
                        if let Err(error) = window.show() {
                            eprintln!("failed to show island window in development: {error}");
                        }
                        if let Err(error) = window.set_focus() {
                            eprintln!("failed to activate island window in development: {error}");
                        }
                        let development_window = window.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(800));
                            let _ = development_window.show();
                            let _ = development_window.set_focus();
                        });
                    }
                    #[cfg(not(debug_assertions))]
                    start_cursor_passthrough_loop(window);
                }
                Err(error) => eprintln!("failed to resolve main development window: {error}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_island_layout,
            set_island_interaction,
            get_monitors,
            save_todo_markdown,
            get_default_todo_save_directory,
            show_ready_island,
            minimize_island,
            get_launch_at_startup,
            set_launch_at_startup,
            get_agent_status,
            clear_agent_status,
            install_agent_status_hooks,
            get_agent_status_hooks_connection,
            get_media_state,
            get_audio_spectrum,
            media_play_pause,
            media_next,
            media_previous,
            clipboard_history::get_clipboard_history,
            clipboard_history::set_clipboard_history_settings,
            clipboard_history::copy_clipboard_history_item,
            clipboard_history::toggle_clipboard_history_favorite,
            clipboard_history::delete_clipboard_history_item,
            clipboard_history::clear_clipboard_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running Surfisle");
}
