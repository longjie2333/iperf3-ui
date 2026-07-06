use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Read},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewWindow};
use uuid::Uuid;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const RUN_EVENT_NAME: &str = "iperf-run-event";
const EMBEDDED_IPERF3_EXE: &[u8] = include_bytes!("../bin/iperf3.exe");
const EMBEDDED_CYGWIN_DLL: &[u8] = include_bytes!("../bin/cygwin1.dll");
const REMOTE_PID_MARKER: &str = "__IPERF3_UI_PID__:";

#[cfg(target_os = "windows")]
fn hide_child_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_child_window(_command: &mut Command) {}

fn clamp_window_size(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

fn compute_initial_window_size(work_width: f64, work_height: f64) -> LogicalSize<f64> {
    let aspect = work_width / work_height.max(1.0);
    let max_width = (work_width - 48.0).max(900.0);
    let max_height = (work_height - 48.0).max(640.0);
    let min_width = 960.0_f64.min(max_width);
    let min_height = 680.0_f64.min(max_height);
    let mut width = work_width * if aspect >= 1.65 { 0.78 } else { 0.88 };
    let mut height = width / aspect.max(0.75);

    if height < min_height {
        height = min_height;
        width = height * aspect;
    }
    if height > max_height {
        height = max_height;
        width = height * aspect;
    }
    if width > max_width {
        width = max_width;
        height = width / aspect.max(0.75);
    }

    LogicalSize::new(
        clamp_window_size(width, min_width, max_width).round(),
        clamp_window_size(height, min_height, max_height).round(),
    )
}

fn size_window_for_current_monitor<R: Runtime>(window: &WebviewWindow<R>) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let work_area = monitor.work_area();
        let logical = work_area.size.to_logical::<f64>(monitor.scale_factor());
        let _ = window.set_size(compute_initial_window_size(logical.width, logical.height));
        let _ = window.center();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IperfConfig {
    mode: String,
    host: String,
    port: String,
    client_port: String,
    custom_binary_path: String,
    protocol: String,
    direction: String,
    transfer_mode: String,
    time: String,
    bytes: String,
    blockcount: String,
    length: String,
    bitrate: String,
    pacing_timer: String,
    fq_rate: String,
    no_fq_socket_pacing: bool,
    parallel: String,
    window: String,
    mss: String,
    no_delay: bool,
    ip_version: String,
    bind: String,
    bind_dev: String,
    tos: String,
    dscp: String,
    flowlabel: String,
    xbind: String,
    sctp_streams: String,
    zerocopy: bool,
    skip_rx_copy: bool,
    omit: String,
    title: String,
    extra_data: String,
    congestion: String,
    mptcp: bool,
    udp_counters64bit: bool,
    repeating_payload: bool,
    dont_fragment: bool,
    verbose: bool,
    debug: bool,
    format: String,
    output_mode: String,
    json_stream_full_output: bool,
    logfile: String,
    forceflush: bool,
    timestamps: bool,
    timestamp_format: String,
    rcv_timeout: String,
    snd_timeout: String,
    connect_timeout: String,
    get_server_output: bool,
    daemon: bool,
    one_off: bool,
    pidfile: String,
    idle_timeout: String,
    server_max_duration: String,
    server_bitrate_limit: String,
    affinity: String,
    username: String,
    password: String,
    rsa_public_key_path: String,
    rsa_private_key_path: String,
    authorized_users_path: String,
    time_skew_threshold: String,
    use_pkcs1_padding: bool,
    expert_mode: bool,
    raw_args: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    host: String,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    level: String,
    field: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPreview {
    binary: String,
    args: Vec<String>,
    preview: String,
    issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryResolution {
    path: String,
    source: String,
    exists: bool,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProfile {
    id: String,
    name: String,
    created_at: String,
    config: Value,
    ssh_config: Option<SshConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSession {
    id: String,
    command: CommandPreview,
    started_at: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    id: String,
    session_id: String,
    kind: String,
    timestamp: String,
    message: String,
    payload: Option<Value>,
}

#[derive(Debug, Clone)]
struct SessionState {
    pid: Option<u32>,
    status: String,
    stop_requested: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, SessionState>>,
    events: Mutex<HashMap<String, Vec<RunEvent>>>,
    event_counter: AtomicU64,
}

fn now_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

fn clean(value: &str) -> String {
    value.trim().to_string()
}

fn push_arg(args: &mut Vec<String>, flag: &str, value: &str) {
    let value = clean(value);
    if !value.is_empty() {
        args.push(flag.to_string());
        args.push(value);
    }
}

fn push_flag(args: &mut Vec<String>, flag: &str, enabled: bool) {
    if enabled {
        args.push(flag.to_string());
    }
}

fn split_raw_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if (ch == '"' || ch == '\'') && quote.is_none() {
            quote = Some(ch);
            continue;
        }
        if Some(ch) == quote {
            quote = None;
            continue;
        }
        if ch.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }

    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn build_args(config: &IperfConfig) -> Vec<String> {
    let mut args = Vec::new();

    if config.mode == "server" {
        args.push("-s".to_string());
    } else {
        args.push("-c".to_string());
        args.push(clean(&config.host));
    }

    push_arg(&mut args, "-p", &config.port);
    push_arg(&mut args, "-f", &config.format);
    push_arg(&mut args, "-A", &config.affinity);
    push_arg(&mut args, "-B", &config.bind);
    push_arg(&mut args, "--bind-dev", &config.bind_dev);
    push_flag(&mut args, "-V", config.verbose);
    push_flag(&mut args, "-d", config.debug);

    match config.output_mode.as_str() {
        "json" => args.push("-J".to_string()),
        _ => {}
    }

    push_arg(&mut args, "--logfile", &config.logfile);
    push_flag(&mut args, "--forceflush", config.forceflush);
    if config.timestamps {
        let format = clean(&config.timestamp_format);
        if format.is_empty() {
            args.push("--timestamps".to_string());
        } else {
            args.push(format!("--timestamps={format}"));
        }
    }
    push_arg(&mut args, "--rcv-timeout", &config.rcv_timeout);
    push_arg(&mut args, "--snd-timeout", &config.snd_timeout);
    push_flag(&mut args, "--use-pkcs1-padding", config.use_pkcs1_padding);

    if config.mode == "server" {
        push_flag(&mut args, "-D", config.daemon);
        push_flag(&mut args, "-1", config.one_off);
        push_arg(&mut args, "-I", &config.pidfile);
        push_arg(&mut args, "--idle-timeout", &config.idle_timeout);
        push_arg(
            &mut args,
            "--server-max-duration",
            &config.server_max_duration,
        );
        push_arg(
            &mut args,
            "--server-bitrate-limit",
            &config.server_bitrate_limit,
        );
        push_arg(
            &mut args,
            "--rsa-private-key-path",
            &config.rsa_private_key_path,
        );
        push_arg(
            &mut args,
            "--authorized-users-path",
            &config.authorized_users_path,
        );
        push_arg(
            &mut args,
            "--time-skew-threshold",
            &config.time_skew_threshold,
        );
    } else {
        push_flag(&mut args, "-u", config.protocol == "udp");
        push_flag(&mut args, "--sctp", config.protocol == "sctp");
        push_flag(&mut args, "-m", config.protocol == "tcp" && config.mptcp);
        push_arg(&mut args, "--connect-timeout", &config.connect_timeout);
        push_arg(&mut args, "--cport", &config.client_port);
        push_arg(&mut args, "-b", &config.bitrate);
        push_arg(&mut args, "--pacing-timer", &config.pacing_timer);
        push_arg(&mut args, "--fq-rate", &config.fq_rate);
        push_flag(
            &mut args,
            "--no-fq-socket-pacing",
            config.no_fq_socket_pacing,
        );

        match config.transfer_mode.as_str() {
            "bytes" => push_arg(&mut args, "-n", &config.bytes),
            "blockcount" => push_arg(&mut args, "-k", &config.blockcount),
            _ => push_arg(&mut args, "-t", &config.time),
        }

        push_arg(&mut args, "-l", &config.length);
        push_arg(&mut args, "-P", &config.parallel);
        push_flag(&mut args, "-R", config.direction == "reverse");
        push_flag(&mut args, "--bidir", config.direction == "bidir");
        push_arg(&mut args, "-w", &config.window);
        if config.protocol != "udp" {
            push_arg(&mut args, "-M", &config.mss);
            push_flag(&mut args, "-N", config.no_delay);
        }
        push_flag(&mut args, "-4", config.ip_version == "ipv4");
        push_flag(&mut args, "-6", config.ip_version == "ipv6");
        push_arg(&mut args, "-S", &config.tos);
        push_arg(&mut args, "--dscp", &config.dscp);
        push_arg(&mut args, "-L", &config.flowlabel);
        if config.protocol == "sctp" {
            push_arg(&mut args, "-X", &config.xbind);
            push_arg(&mut args, "--nstreams", &config.sctp_streams);
        }
        push_flag(&mut args, "-Z", config.zerocopy);
        push_flag(&mut args, "--skip-rx-copy", config.skip_rx_copy);
        push_arg(&mut args, "-O", &config.omit);
        push_arg(&mut args, "-T", &config.title);
        push_arg(&mut args, "--extra-data", &config.extra_data);
        if config.protocol == "tcp" {
            push_arg(&mut args, "-C", &config.congestion);
        }
        push_flag(&mut args, "--get-server-output", config.get_server_output);
        push_flag(
            &mut args,
            "--udp-counters-64bit",
            config.protocol == "udp" && config.udp_counters64bit,
        );
        push_flag(&mut args, "--repeating-payload", config.repeating_payload);
        push_flag(
            &mut args,
            "--dont-fragment",
            config.protocol == "udp" && config.dont_fragment,
        );
        push_arg(&mut args, "--username", &config.username);
        push_arg(
            &mut args,
            "--rsa-public-key-path",
            &config.rsa_public_key_path,
        );
    }

    args.extend(split_raw_args(&config.raw_args));
    args
}

fn quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if !arg.chars().any(|ch| {
        ch.is_whitespace() || ['"', '\'', '`', '$', '&', '|', '<', '>', '^'].contains(&ch)
    }) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

fn command_string(binary: &str, args: &[String]) -> String {
    std::iter::once(quote_arg(binary))
        .chain(args.iter().map(|arg| quote_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_posix_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }
    if arg
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_@%+=:,./-".contains(ch))
    {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn posix_command_string(binary: &str, args: &[String]) -> String {
    std::iter::once(quote_posix_arg(binary))
        .chain(args.iter().map(|arg| quote_posix_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn remote_iperf_wrapper_command(args: &[String], daemon_pidfile: Option<&str>) -> String {
    let remote_command = posix_command_string("iperf3", args);
    let script = if let Some(pidfile) = daemon_pidfile {
        let pidfile = quote_posix_arg(pidfile);
        format!(
            "{remote_command}; code=$?; if [ \"$code\" -ne 0 ]; then exit \"$code\"; fi; pid=\"\"; i=0; while [ \"$i\" -lt 50 ]; do if [ -s {pidfile} ]; then pid=$(cat {pidfile} 2>/dev/null | tr -dc '0-9'); if [ -n \"$pid\" ]; then break; fi; fi; i=$((i + 1)); sleep 0.1; done; if [ -z \"$pid\" ]; then echo \"Unable to read iperf3 daemon pidfile\" >&2; exit 1; fi; echo {REMOTE_PID_MARKER}$pid; while kill -0 \"$pid\" 2>/dev/null; do sleep 1; done; exit 0"
        )
    } else {
        let exec_script = format!("exec {remote_command}");
        format!(
            "if command -v setsid >/dev/null 2>&1; then setsid sh -c {} & pid=$!; else sh -c {} & pid=$!; fi; echo {REMOTE_PID_MARKER}$pid; wait \"$pid\"; code=$?; exit \"$code\"",
            quote_posix_arg(&exec_script),
            quote_posix_arg(&exec_script),
        )
    };
    format!("sh -lc {}", quote_posix_arg(&script))
}

fn remote_kill_command(pid: u32) -> String {
    let script = format!(
        "kill -TERM -{pid} 2>/dev/null || kill -TERM {pid} 2>/dev/null; sleep 1; kill -0 {pid} 2>/dev/null && (kill -KILL -{pid} 2>/dev/null || kill -KILL {pid} 2>/dev/null); true"
    );
    format!("sh -lc {}", quote_posix_arg(&script))
}

fn ssh_target(ssh: &SshConfig) -> String {
    format!("{}@{}", ssh_username(ssh), clean(&ssh.host))
}

fn ssh_username(ssh: &SshConfig) -> String {
    let username = clean(&ssh.username);
    if username.is_empty() {
        "root".to_string()
    } else {
        username
    }
}

fn parse_ssh_host(value: &str) -> Result<(String, u16), String> {
    let value = clean(value);
    if value.is_empty() {
        return Err("SSH host is required.".to_string());
    }

    if let Some(rest) = value.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = clean(&rest[..end]);
            let tail = &rest[end + 1..];
            if host.is_empty() {
                return Err("SSH host is required.".to_string());
            }
            if tail.is_empty() {
                return Ok((host, 22));
            }
            if let Some(port) = tail.strip_prefix(':') {
                let port = port
                    .parse::<u16>()
                    .map_err(|_| "SSH port must be between 1 and 65535.".to_string())?;
                if port == 0 {
                    return Err("SSH port must be between 1 and 65535.".to_string());
                }
                return Ok((host, port));
            }
            return Err("SSH host should use host, host:port, or [IPv6]:port.".to_string());
        }
    }

    if value.matches(':').count() == 1 {
        if let Some((host, port)) = value.rsplit_once(':') {
            if !host.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
                let port = port
                    .parse::<u16>()
                    .map_err(|_| "SSH port must be between 1 and 65535.".to_string())?;
                if port == 0 {
                    return Err("SSH port must be between 1 and 65535.".to_string());
                }
                return Ok((host.to_string(), port));
            }
        }
    }

    Ok((value, 22))
}

fn validate_ssh_config(ssh: &SshConfig) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if clean(&ssh.host).is_empty() {
        issues.push(issue("error", "command", "SSH host is required."));
    } else if let Err(message) = parse_ssh_host(&ssh.host) {
        issues.push(issue("error", "command", &message));
    }
    issues
}

fn default_ssh_key_paths() -> Vec<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from);
    let Some(home) = home else {
        return Vec::new();
    };
    let ssh_dir = home.join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"]
        .into_iter()
        .map(|name| ssh_dir.join(name))
        .filter(|path| path.is_file())
        .collect()
}

fn userauth_with_default_keys(session: &ssh2::Session, username: &str) -> Result<(), String> {
    let mut attempts = Vec::new();

    match session.userauth_agent(username) {
        Ok(()) => return Ok(()),
        Err(error) => attempts.push(format!("ssh-agent: {error}")),
    }

    let key_paths = default_ssh_key_paths();
    for path in &key_paths {
        match session.userauth_pubkey_file(username, None, path, None) {
            Ok(()) => return Ok(()),
            Err(error) => attempts.push(format!("{}: {error}", path.display())),
        }
    }

    if key_paths.is_empty() {
        attempts.push("no default private key found under ~/.ssh".to_string());
    }

    Err(format!(
        "SSH key authentication failed. {}",
        attempts.join("; ")
    ))
}

fn issue(level: &str, field: &str, message: &str) -> ValidationIssue {
    ValidationIssue {
        level: level.to_string(),
        field: field.to_string(),
        message: message.to_string(),
    }
}

fn is_integer(value: &str) -> bool {
    !value.trim().is_empty() && value.trim().chars().all(|ch| ch.is_ascii_digit())
}

fn validate_port(issues: &mut Vec<ValidationIssue>, field: &str, value: &str, label: &str) {
    let value = clean(value);
    if value.is_empty() {
        return;
    }
    if !is_integer(&value) {
        issues.push(issue(
            "error",
            field,
            &format!("{label} must be an integer."),
        ));
        return;
    }
    let parsed = value.parse::<u32>().unwrap_or_default();
    if parsed == 0 || parsed > 65535 {
        issues.push(issue(
            "error",
            field,
            &format!("{label} must be between 1 and 65535."),
        ));
    }
}

fn validate_numeric(issues: &mut Vec<ValidationIssue>, field: &str, value: &str, label: &str) {
    let value = clean(value);
    if value.is_empty() {
        return;
    }
    if value.parse::<f64>().is_err() {
        issues.push(issue("error", field, &format!("{label} must be numeric.")));
    }
}

fn validate_config_inner(config: &IperfConfig) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();

    if config.mode == "client" && clean(&config.host).is_empty() {
        issues.push(issue(
            "error",
            "host",
            "Client mode requires a server host.",
        ));
    }

    validate_port(&mut issues, "port", &config.port, "Server port");

    if config.output_mode == "json" {
        issues.push(issue(
            "info",
            "outputMode",
            "JSON -J normally writes the complete result after the test finishes. Use human output for live logs.",
        ));
    }

    if config.mode == "client" {
        validate_port(
            &mut issues,
            "clientPort",
            &config.client_port,
            "Client port",
        );
        validate_numeric(&mut issues, "omit", &config.omit, "Omit duration");

        if config.transfer_mode == "time" {
            validate_numeric(&mut issues, "time", &config.time, "Test duration");
        }

        if config.protocol == "sctp" {
            issues.push(issue(
                "warning",
                "protocol",
                "SCTP is generally unavailable in community Windows iperf3 builds.",
            ));
        }

        let mut sensitive_fields = vec![
            ("flowlabel", !clean(&config.flowlabel).is_empty()),
            ("fqRate", !clean(&config.fq_rate).is_empty()),
        ];
        if config.protocol == "sctp" {
            sensitive_fields.push(("xbind", !clean(&config.xbind).is_empty()));
        }
        if config.protocol == "tcp" {
            sensitive_fields.push(("mptcp", config.mptcp));
            sensitive_fields.push(("congestion", !clean(&config.congestion).is_empty()));
        }

        for (field, enabled) in sensitive_fields {
            if enabled {
                issues.push(issue(
                    "info",
                    field,
                    "This option depends on OS or iperf3 build support and may not work on Windows.",
                ));
            }
        }
    }

    issues
}

fn bundled_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = app
        .path()
        .resolve("bin/iperf3.exe", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(path);
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("bin").join("iperf3.exe"));
        candidates.push(current_dir.join("src-tauri").join("bin").join("iperf3.exe"));
    }

    candidates
}

fn write_embedded_file(path: &PathBuf, contents: &[u8]) -> Result<(), String> {
    let should_write = fs::metadata(path)
        .map(|metadata| metadata.len() != contents.len() as u64)
        .unwrap_or(true);
    if !should_write {
        return Ok(());
    }

    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, contents).map_err(|error| {
        format!(
            "Failed to write embedded binary {}: {error}",
            path.display()
        )
    })?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| {
            format!(
                "Failed to replace embedded binary {}: {error}",
                path.display()
            )
        })?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "Failed to activate embedded binary {}: {error}",
            path.display()
        )
    })
}

fn embedded_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?
        .join("embedded-bin");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create embedded binary dir: {error}"))?;

    let dll_path = dir.join("cygwin1.dll");
    let exe_path = dir.join("iperf3.exe");
    write_embedded_file(&dll_path, EMBEDDED_CYGWIN_DLL)?;
    write_embedded_file(&exe_path, EMBEDDED_IPERF3_EXE)?;
    Ok(exe_path)
}

fn resolve_binary_inner(app: &AppHandle, custom_path: &str) -> BinaryResolution {
    let custom_path = clean(custom_path);
    if !custom_path.is_empty() {
        let exists = PathBuf::from(&custom_path).is_file();
        let version = detect_version(if exists { &custom_path } else { "" });
        return BinaryResolution {
            path: custom_path,
            source: "custom".to_string(),
            exists,
            version,
        };
    }

    if let Ok(path) = embedded_binary_path(app) {
        if path.is_file() {
            let path = path.to_string_lossy().to_string();
            return BinaryResolution {
                path: path.clone(),
                source: "embedded".to_string(),
                exists: true,
                version: detect_version(&path),
            };
        }
    }

    for path in bundled_candidates(app) {
        if path.is_file() {
            let path = path.to_string_lossy().to_string();
            return BinaryResolution {
                path: path.clone(),
                source: "bundled".to_string(),
                exists: true,
                version: detect_version(&path),
            };
        }
    }

    BinaryResolution {
        path: "iperf3".to_string(),
        source: "path".to_string(),
        exists: command_available("iperf3"),
        version: detect_version("iperf3"),
    }
}

fn command_available(binary: &str) -> bool {
    let mut command = Command::new(binary);
    hide_child_window(&mut command);
    command
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn detect_version(binary: &str) -> Option<String> {
    if binary.is_empty() {
        return None;
    }
    let mut command = Command::new(binary);
    hide_child_window(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.to_string())
}

fn build_command_inner(app: &AppHandle, config: &IperfConfig) -> CommandPreview {
    let binary = resolve_binary_inner(app, &config.custom_binary_path).path;
    let args = build_args(config);
    CommandPreview {
        preview: command_string(&binary, &args),
        binary,
        args,
        issues: validate_config_inner(config),
    }
}

fn push_event(
    state: &AppState,
    session_id: &str,
    kind: &str,
    message: String,
    payload: Option<Value>,
) -> RunEvent {
    let id = state.event_counter.fetch_add(1, Ordering::SeqCst);
    let event = RunEvent {
        id: format!("{session_id}-{id}"),
        session_id: session_id.to_string(),
        kind: kind.to_string(),
        timestamp: now_string(),
        message,
        payload,
    };
    if let Ok(mut events) = state.events.lock() {
        events
            .entry(session_id.to_string())
            .or_default()
            .push(event.clone());
    }
    event
}

fn push_event_and_emit(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    kind: &str,
    message: String,
    payload: Option<Value>,
) {
    let event = push_event(state, session_id, kind, message, payload);
    let _ = app.emit(RUN_EVENT_NAME, event);
}

fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("Failed to create app data dir: {error}"))?;
    Ok(dir.join(name))
}

fn profiles_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, "profiles.json")
}

fn write_profiles(app: &AppHandle, profiles: &[SavedProfile]) -> Result<(), String> {
    let path = profiles_file(app)?;
    let json = serde_json::to_string_pretty(profiles)
        .map_err(|error| format!("Failed to serialize profiles: {error}"))?;
    fs::write(&path, json).map_err(|error| format!("Failed to write profiles: {error}"))
}

fn register_child_session(
    app: AppHandle,
    state: &AppState,
    mut child: Child,
    preview: CommandPreview,
    process_label: &str,
) -> Result<RunSession, String> {
    let pid = child.id();
    let session_id = Uuid::new_v4().to_string();
    let started_at = now_string();

    state
        .sessions
        .lock()
        .map_err(|_| "Session lock failed.")?
        .insert(
            session_id.clone(),
            SessionState {
                pid: Some(pid),
                status: "running".to_string(),
                stop_requested: None,
            },
        );
    state
        .events
        .lock()
        .map_err(|_| "Event lock failed.")?
        .insert(session_id.clone(), Vec::new());
    push_event_and_emit(
        &app,
        state,
        &session_id,
        "status",
        format!("Started {process_label} with PID {pid}."),
        None,
    );

    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        let session = session_id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let app_state = app_handle.state::<AppState>();
                push_event_and_emit(&app_handle, &app_state, &session, "stdout", line, None);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        let session = session_id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let app_state = app_handle.state::<AppState>();
                push_event_and_emit(&app_handle, &app_state, &session, "stderr", line, None);
            }
        });
    }

    let app_handle = app.clone();
    let session_for_wait = session_id.clone();
    let wait_label = process_label.to_string();
    thread::spawn(move || {
        let app_state = app_handle.state::<AppState>();
        let status = child.wait();
        match status {
            Ok(exit_status) => {
                let exit_message = exit_status
                    .code()
                    .map(|code| format!("{wait_label} exited with code {code}."))
                    .unwrap_or_else(|| format!("{wait_label} exited."));
                push_event_and_emit(
                    &app_handle,
                    &app_state,
                    &session_for_wait,
                    "exit",
                    exit_message,
                    None,
                );
                if let Ok(mut sessions) = app_state.sessions.lock() {
                    if let Some(session) = sessions.get_mut(&session_for_wait) {
                        session.status = "completed".to_string();
                    }
                }
            }
            Err(error) => {
                push_event_and_emit(
                    &app_handle,
                    &app_state,
                    &session_for_wait,
                    "error",
                    format!("Failed to wait for {wait_label}: {error}"),
                    None,
                );
                if let Ok(mut sessions) = app_state.sessions.lock() {
                    if let Some(session) = sessions.get_mut(&session_for_wait) {
                        session.status = "failed".to_string();
                    }
                }
            }
        }
    });

    Ok(RunSession {
        id: session_id,
        command: preview,
        started_at,
        status: "running".to_string(),
    })
}

fn set_session_status(state: &AppState, session_id: &str, status: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(session) = sessions.get_mut(session_id) {
            session.status = status.to_string();
        }
    }
}

fn append_and_emit_lines(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    kind: &str,
    buffer: &mut String,
    bytes: &[u8],
) {
    buffer.push_str(&String::from_utf8_lossy(bytes));
    while let Some(index) = buffer.find('\n') {
        let mut line = buffer[..index].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        buffer.drain(..=index);
        push_event_and_emit(app, state, session_id, kind, line, None);
    }
}

fn handle_ssh_stdout_line(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    remote_pid: &mut Option<u32>,
    line: String,
) {
    if let Some(pid) = line.strip_prefix(REMOTE_PID_MARKER) {
        match pid.trim().parse::<u32>() {
            Ok(pid) => {
                *remote_pid = Some(pid);
                push_event_and_emit(
                    app,
                    state,
                    session_id,
                    "status",
                    format!("Remote process PID {pid}."),
                    None,
                );
            }
            Err(_) => push_event_and_emit(
                app,
                state,
                session_id,
                "stderr",
                format!("Unable to parse remote PID marker: {line}"),
                None,
            ),
        }
        return;
    }

    push_event_and_emit(app, state, session_id, "stdout", line, None);
}

fn append_and_emit_ssh_stdout_lines(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    buffer: &mut String,
    bytes: &[u8],
    remote_pid: &mut Option<u32>,
) {
    buffer.push_str(&String::from_utf8_lossy(bytes));
    while let Some(index) = buffer.find('\n') {
        let mut line = buffer[..index].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        buffer.drain(..=index);
        handle_ssh_stdout_line(app, state, session_id, remote_pid, line);
    }
}

fn flush_line_buffer(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    kind: &str,
    buffer: &mut String,
) {
    if buffer.is_empty() {
        return;
    }
    let line = buffer.trim_end_matches('\r').to_string();
    buffer.clear();
    push_event_and_emit(app, state, session_id, kind, line, None);
}

fn flush_ssh_stdout_line_buffer(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    buffer: &mut String,
    remote_pid: &mut Option<u32>,
) {
    if buffer.is_empty() {
        return;
    }
    let line = buffer.trim_end_matches('\r').to_string();
    buffer.clear();
    handle_ssh_stdout_line(app, state, session_id, remote_pid, line);
}

fn read_ssh_stream<R: Read>(
    stream: &mut R,
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    kind: &str,
    line_buffer: &mut String,
) -> Result<bool, String> {
    let mut progressed = false;
    let mut read_buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut read_buffer) {
            Ok(0) => return Ok(progressed),
            Ok(read) => {
                progressed = true;
                append_and_emit_lines(
                    app,
                    state,
                    session_id,
                    kind,
                    line_buffer,
                    &read_buffer[..read],
                );
                if read < read_buffer.len() {
                    return Ok(progressed);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(progressed);
            }
            Err(error) => return Err(format!("SSH {kind} read failed: {error}")),
        }
    }
}

fn read_ssh_stdout_stream<R: Read>(
    stream: &mut R,
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    line_buffer: &mut String,
    remote_pid: &mut Option<u32>,
) -> Result<bool, String> {
    let mut progressed = false;
    let mut read_buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut read_buffer) {
            Ok(0) => return Ok(progressed),
            Ok(read) => {
                progressed = true;
                append_and_emit_ssh_stdout_lines(
                    app,
                    state,
                    session_id,
                    line_buffer,
                    &read_buffer[..read],
                    remote_pid,
                );
                if read < read_buffer.len() {
                    return Ok(progressed);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(progressed);
            }
            Err(error) => return Err(format!("SSH stdout read failed: {error}")),
        }
    }
}

fn terminate_remote_process(
    session: &ssh2::Session,
    remote_pid: Option<u32>,
) -> Result<(), String> {
    let pid = remote_pid.ok_or_else(|| "Remote process PID is not known yet.".to_string())?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Failed to open SSH kill channel: {error}"))?;
    channel
        .exec(&remote_kill_command(pid))
        .map_err(|error| format!("Failed to send remote stop command: {error}"))?;
    let mut output = String::new();
    let _ = channel.read_to_string(&mut output);
    let _ = channel.stderr().read_to_string(&mut output);
    let _ = channel.wait_close();
    let status = channel.exit_status().unwrap_or(0);
    if status == 0 {
        Ok(())
    } else {
        Err(format!("Remote stop command exited with code {status}."))
    }
}

fn run_ssh_thread(
    app: AppHandle,
    session_id: String,
    stop_requested: Arc<AtomicBool>,
    ssh: SshConfig,
    remote_command: String,
) {
    let app_state = app.state::<AppState>();
    let result = (|| -> Result<i32, String> {
        let (host, port) = parse_ssh_host(&ssh.host)?;
        let tcp = TcpStream::connect((host.as_str(), port))
            .map_err(|error| format!("Failed to connect SSH {host}:{port}: {error}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
        tcp.set_write_timeout(Some(Duration::from_secs(10))).ok();

        let mut session = ssh2::Session::new()
            .map_err(|error| format!("Failed to create SSH session: {error}"))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|error| format!("SSH handshake failed: {error}"))?;
        let username = ssh_username(&ssh);
        let password = clean(&ssh.password);
        if password.is_empty() {
            userauth_with_default_keys(&session, &username)?;
        } else {
            session
                .userauth_password(&username, &password)
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;
        }
        if !session.authenticated() {
            return Err("SSH authentication failed.".to_string());
        }

        push_event_and_emit(
            &app,
            &app_state,
            &session_id,
            "status",
            format!("SSH authenticated as {username}."),
            None,
        );

        let mut channel = session
            .channel_session()
            .map_err(|error| format!("Failed to open SSH channel: {error}"))?;
        channel
            .exec(&remote_command)
            .map_err(|error| format!("Failed to start remote command: {error}"))?;
        session.set_blocking(false);

        let mut stderr = channel.stderr();
        let mut stdout_buffer = String::new();
        let mut stderr_buffer = String::new();
        let mut remote_pid = None;

        loop {
            if stop_requested.load(Ordering::SeqCst) {
                for _ in 0..10 {
                    if remote_pid.is_some() {
                        break;
                    }
                    let _ = read_ssh_stdout_stream(
                        &mut channel,
                        &app,
                        &app_state,
                        &session_id,
                        &mut stdout_buffer,
                        &mut remote_pid,
                    );
                    let _ = read_ssh_stream(
                        &mut stderr,
                        &app,
                        &app_state,
                        &session_id,
                        "stderr",
                        &mut stderr_buffer,
                    );
                    if remote_pid.is_none() {
                        thread::sleep(Duration::from_millis(50));
                    }
                }

                session.set_blocking(true);
                match terminate_remote_process(&session, remote_pid) {
                    Ok(()) => push_event_and_emit(
                        &app,
                        &app_state,
                        &session_id,
                        "status",
                        "Remote process stop command sent.".to_string(),
                        None,
                    ),
                    Err(error) => {
                        push_event_and_emit(&app, &app_state, &session_id, "stderr", error, None)
                    }
                }
                let _ = channel.close();
                flush_ssh_stdout_line_buffer(
                    &app,
                    &app_state,
                    &session_id,
                    &mut stdout_buffer,
                    &mut remote_pid,
                );
                flush_line_buffer(&app, &app_state, &session_id, "stderr", &mut stderr_buffer);
                push_event_and_emit(
                    &app,
                    &app_state,
                    &session_id,
                    "status",
                    "Stop requested for SSH session.".to_string(),
                    None,
                );
                return Ok(-1);
            }

            let stdout_progress = read_ssh_stdout_stream(
                &mut channel,
                &app,
                &app_state,
                &session_id,
                &mut stdout_buffer,
                &mut remote_pid,
            )?;
            let stderr_progress = read_ssh_stream(
                &mut stderr,
                &app,
                &app_state,
                &session_id,
                "stderr",
                &mut stderr_buffer,
            )?;

            if channel.eof() {
                break;
            }
            if !stdout_progress && !stderr_progress {
                thread::sleep(Duration::from_millis(60));
            }
        }

        session.set_blocking(true);
        flush_ssh_stdout_line_buffer(
            &app,
            &app_state,
            &session_id,
            &mut stdout_buffer,
            &mut remote_pid,
        );
        flush_line_buffer(&app, &app_state, &session_id, "stderr", &mut stderr_buffer);
        let _ = channel.wait_close();
        channel
            .exit_status()
            .map_err(|error| format!("Failed to read remote exit status: {error}"))
    })();

    match result {
        Ok(-1) => {
            push_event_and_emit(
                &app,
                &app_state,
                &session_id,
                "exit",
                "SSH session stopped.".to_string(),
                None,
            );
            set_session_status(&app_state, &session_id, "stopped");
        }
        Ok(code) => {
            push_event_and_emit(
                &app,
                &app_state,
                &session_id,
                "exit",
                format!("Remote command exited with code {code}."),
                None,
            );
            set_session_status(&app_state, &session_id, "completed");
        }
        Err(error) => {
            push_event_and_emit(&app, &app_state, &session_id, "error", error, None);
            set_session_status(&app_state, &session_id, "failed");
        }
    }
}

fn register_ssh_session(
    app: AppHandle,
    state: &AppState,
    preview: CommandPreview,
    ssh: SshConfig,
    remote_command: String,
) -> Result<RunSession, String> {
    let session_id = Uuid::new_v4().to_string();
    let started_at = now_string();
    let stop_requested = Arc::new(AtomicBool::new(false));

    state
        .sessions
        .lock()
        .map_err(|_| "Session lock failed.")?
        .insert(
            session_id.clone(),
            SessionState {
                pid: None,
                status: "running".to_string(),
                stop_requested: Some(stop_requested.clone()),
            },
        );
    state
        .events
        .lock()
        .map_err(|_| "Event lock failed.")?
        .insert(session_id.clone(), Vec::new());

    push_event_and_emit(
        &app,
        state,
        &session_id,
        "status",
        format!("Started SSH session to {}.", ssh_target(&ssh)),
        None,
    );

    let app_handle = app.clone();
    let session_for_thread = session_id.clone();
    thread::spawn(move || {
        run_ssh_thread(
            app_handle,
            session_for_thread,
            stop_requested,
            ssh,
            remote_command,
        );
    });

    Ok(RunSession {
        id: session_id,
        command: preview,
        started_at,
        status: "running".to_string(),
    })
}

#[tauri::command]
fn resolve_binary(app: AppHandle, custom_path: String) -> BinaryResolution {
    resolve_binary_inner(&app, &custom_path)
}

#[tauri::command]
fn select_iperf_binary() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        const SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = 'iperf3.exe|iperf3.exe|Executable files (*.exe)|*.exe|All files (*.*)|*.*'
$dialog.Title = 'Select iperf3.exe'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.FileName
}
"#;
        let mut command = Command::new("powershell.exe");
        hide_child_window(&mut command);
        let output = command
            .args(["-NoProfile", "-Sta", "-Command", SCRIPT])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
fn validate_config(config: IperfConfig) -> Vec<ValidationIssue> {
    validate_config_inner(&config)
}

#[tauri::command]
fn build_command(app: AppHandle, config: IperfConfig) -> CommandPreview {
    build_command_inner(&app, &config)
}

#[tauri::command]
fn start_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: IperfConfig,
) -> Result<RunSession, String> {
    let preview = build_command_inner(&app, &config);
    let blocking = preview.issues.iter().any(|issue| issue.level == "error");
    if blocking {
        return Err("Cannot start iperf3 while validation errors are present.".to_string());
    }

    let mut command = Command::new(&preview.binary);
    hide_child_window(&mut command);
    command
        .args(&preview.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let password = clean(&config.password);
    if !password.is_empty() {
        command.env("IPERF3_PASSWORD", password);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start iperf3: {error}"))?;
    register_child_session(app, &state, child, preview, "iperf3")
}

#[tauri::command]
fn start_ssh_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    ssh: SshConfig,
    mut config: IperfConfig,
) -> Result<RunSession, String> {
    config.mode = "server".to_string();

    let mut issues = validate_config_inner(&config);
    issues.extend(validate_ssh_config(&ssh));
    if issues.iter().any(|issue| issue.level == "error") {
        return Err("Cannot start SSH run while validation errors are present.".to_string());
    }

    let daemon_pidfile = if config.daemon {
        let pidfile = clean(&config.pidfile);
        if pidfile.is_empty() {
            let generated = format!("/tmp/iperf3-ui-{}.pid", Uuid::new_v4());
            config.pidfile = generated.clone();
            Some(generated)
        } else {
            Some(pidfile)
        }
    } else {
        None
    };
    let remote_args = build_args(&config);
    let preview_remote_command = command_string("iperf3", &remote_args);
    let remote_command = remote_iperf_wrapper_command(&remote_args, daemon_pidfile.as_deref());
    let args = vec![ssh_target(&ssh), preview_remote_command];
    let preview = CommandPreview {
        binary: "ssh".to_string(),
        args: args.clone(),
        preview: command_string("ssh", &args),
        issues,
    };

    register_ssh_session(app, &state, preview, ssh, remote_command)
}

#[tauri::command]
fn stop_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let (pid, stop_requested) = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock failed.")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "Unknown session.".to_string())?;
        (session.pid, session.stop_requested.clone())
    };

    if let Some(stop_requested) = stop_requested {
        stop_requested.store(true, Ordering::SeqCst);
        push_event_and_emit(
            &app,
            &state,
            &session_id,
            "status",
            "Stop requested for SSH session.".to_string(),
            None,
        );
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(session) = sessions.get_mut(&session_id) {
                session.status = "stopped".to_string();
            }
        }
        return Ok(());
    }

    let pid = pid.ok_or_else(|| "Session has no local process to stop.".to_string())?;

    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("taskkill");
        hide_child_window(&mut command);
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match status {
        Ok(_) => {
            push_event_and_emit(
                &app,
                &state,
                &session_id,
                "status",
                format!("Stop requested for PID {pid}."),
                None,
            );
            if let Ok(mut sessions) = state.sessions.lock() {
                if let Some(session) = sessions.get_mut(&session_id) {
                    session.status = "stopped".to_string();
                }
            }
            Ok(())
        }
        Err(error) => Err(format!("Failed to stop process {pid}: {error}")),
    }
}

#[tauri::command]
fn get_run_events(state: tauri::State<'_, AppState>, session_id: String) -> Vec<RunEvent> {
    state
        .events
        .lock()
        .ok()
        .and_then(|events| events.get(&session_id).cloned())
        .unwrap_or_default()
}

#[tauri::command]
fn load_profiles(app: AppHandle) -> Result<Vec<SavedProfile>, String> {
    let path = profiles_file(&app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read profiles: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("Failed to parse profiles: {error}"))
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: SavedProfile) -> Result<Vec<SavedProfile>, String> {
    let mut profiles = load_profiles(app.clone()).unwrap_or_default();
    profiles.retain(|item| item.id != profile.id);
    profiles.insert(0, profile);
    write_profiles(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
fn rename_profile(app: AppHandle, id: String, name: String) -> Result<Vec<SavedProfile>, String> {
    let name = clean(&name);
    if name.is_empty() {
        return Err("Profile name is required.".to_string());
    }
    let mut profiles = load_profiles(app.clone()).unwrap_or_default();
    let mut renamed = false;
    for profile in &mut profiles {
        if profile.id == id {
            profile.name = name.clone();
            renamed = true;
            break;
        }
    }
    if !renamed {
        return Err("Profile not found.".to_string());
    }
    write_profiles(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
fn delete_profile(app: AppHandle, id: String) -> Result<Vec<SavedProfile>, String> {
    let mut profiles = load_profiles(app.clone()).unwrap_or_default();
    profiles.retain(|profile| profile.id != id);
    write_profiles(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
fn profiles_storage_path(app: AppHandle) -> Result<String, String> {
    profiles_file(&app).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn export_result(app: AppHandle, result: Value, format: String) -> Result<String, String> {
    let extension = match format.as_str() {
        "csv" => "csv",
        "txt" => "txt",
        _ => "json",
    };
    let name = format!("iperf3-result-{}.{}", now_string(), extension);
    let path = app_data_file(&app, &name)?;
    let content = match extension {
        "csv" => {
            let mut lines = vec![
                "start,end,seconds,bits_per_second,retransmits,jitter_ms,lost_percent".to_string(),
            ];
            if let Some(intervals) = result.get("intervals").and_then(Value::as_array) {
                for interval in intervals {
                    let row = [
                        interval
                            .get("start")
                            .and_then(Value::as_f64)
                            .unwrap_or_default()
                            .to_string(),
                        interval
                            .get("end")
                            .and_then(Value::as_f64)
                            .unwrap_or_default()
                            .to_string(),
                        interval
                            .get("seconds")
                            .and_then(Value::as_f64)
                            .unwrap_or_default()
                            .to_string(),
                        interval
                            .get("bitsPerSecond")
                            .and_then(Value::as_f64)
                            .unwrap_or_default()
                            .to_string(),
                        interval
                            .get("retransmits")
                            .and_then(Value::as_i64)
                            .map(|value| value.to_string())
                            .unwrap_or_default(),
                        interval
                            .get("jitterMs")
                            .and_then(Value::as_f64)
                            .map(|value| value.to_string())
                            .unwrap_or_default(),
                        interval
                            .get("lostPercent")
                            .and_then(Value::as_f64)
                            .map(|value| value.to_string())
                            .unwrap_or_default(),
                    ];
                    lines.push(row.join(","));
                }
            }
            lines.join("\n")
        }
        "txt" => result
            .get("rawText")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => serde_json::to_string_pretty(&result)
            .map_err(|error| format!("Failed to serialize result: {error}"))?,
    };
    fs::write(&path, content).map_err(|error| format!("Failed to export result: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Some(window) = app.get_webview_window("main") {
                size_window_for_current_monitor(&window);
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_binary,
            select_iperf_binary,
            build_command,
            validate_config,
            start_run,
            start_ssh_run,
            stop_run,
            get_run_events,
            save_profile,
            load_profiles,
            rename_profile,
            delete_profile,
            profiles_storage_path,
            export_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
