use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::models::{HostConfig, SessionKind};
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::ssh::SshConnectionPool;
use parking_lot::{Mutex, RwLock};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStat {
    pub name: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStat {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub source: SessionKind,
    pub hostname: String,
    pub os_name: String,
    pub kernel_version: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub load_avg: [f64; 3],
    pub cpu_usage_percent: f32,
    pub cpu_cores: usize,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub net_rx_bytes_per_sec: u64,
    pub net_tx_bytes_per_sec: u64,
    pub net_total_rx_bytes: u64,
    pub net_total_tx_bytes: u64,
    pub disks: Vec<DiskStat>,
    pub top_processes: Vec<ProcessStat>,
    pub sampled_at: i64,
}

const REMOTE_PROBE_SCRIPT: &str = r#"printf "===HOST===\n"; hostname 2>/dev/null || uname -n; uname -sr; uname -m; printf "===UPTIME===\n"; cat /proc/uptime 2>/dev/null || echo "0 0"; printf "===LOAD===\n"; cat /proc/loadavg 2>/dev/null || echo "0 0 0"; printf "===CPU===\n"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1; head -n 1 /proc/stat 2>/dev/null || true; printf "===MEM===\n"; cat /proc/meminfo 2>/dev/null || true; printf "===NET===\n"; cat /proc/net/dev 2>/dev/null || true; printf "===DISK===\n"; (df -PT -B1 2>/dev/null || df -Pk 2>/dev/null || true); printf "===PROC===\n"; (ps -eo pid=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null || ps -eo pid=,pcpu=,rss=,comm= 2>/dev/null || true) | head -n 16"#;

struct LocalMonitorState {
    sys: System,
    disks: Disks,
    networks: Networks,
    initialized: bool,
    last_net: Option<(Instant, u64, u64)>,
}

#[derive(Default, Clone, Copy)]
pub struct RemotePrevCounters {
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub sampled_at: Option<Instant>,
}

#[derive(Default)]
pub struct MonitorPlugin {
    ssh_pool: RwLock<Option<Arc<SshConnectionPool>>>,
    local: Mutex<Option<LocalMonitorState>>,
    remote_prev: Mutex<HashMap<String, RemotePrevCounters>>,
}

impl MonitorPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn require_pool(&self) -> CoreResult<Arc<SshConnectionPool>> {
        self.ssh_pool
            .read()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| CoreError::PluginDisabled("lighterm.monitor".to_string()))
    }

    pub fn collect_local(&self) -> CoreResult<SystemStats> {
        let mut guard = self.local.lock();
        if guard.is_none() {
            let sys = System::new_all()
                .map_err(|e| CoreError::PluginError(format!("Failed to initialize system monitor: {e}")))?;
            let disks = Disks::new_with_refreshed_list()
                .map_err(|e| CoreError::PluginError(format!("Failed to initialize disk monitor: {e}")))?;
            let networks = Networks::new_with_refreshed_list()
                .map_err(|e| CoreError::PluginError(format!("Failed to initialize network monitor: {e}")))?;
            *guard = Some(LocalMonitorState {
                sys,
                disks,
                networks,
                initialized: false,
                last_net: None,
            });
        }

        let state = guard.as_mut().expect("LocalMonitorState initialized");
        if !state.initialized {
            state.sys.refresh_cpu_usage();
            std::thread::sleep(Duration::from_millis(150));
            state.initialized = true;
        }

        state.sys.refresh_cpu_usage();
        state.sys.refresh_memory();
        state.sys.refresh_processes(ProcessesToUpdate::All, true);
        state.disks.refresh(true);
        state.networks.refresh(true);

        let now = Instant::now();
        let mut total_rx = 0u64;
        let mut total_tx = 0u64;
        for (iface, data) in &state.networks {
            let name = iface.to_string_lossy();
            if name == "lo" || name == "lo0" || name.starts_with("Loopback") {
                continue;
            }
            total_rx = total_rx.saturating_add(data.total_received());
            total_tx = total_tx.saturating_add(data.total_transmitted());
        }

        let (rx_rate, tx_rate) = if let Some((prev_at, prev_rx, prev_tx)) = state.last_net {
            let secs = now.duration_since(prev_at).as_secs_f64().max(0.1);
            let rx_delta = total_rx.saturating_sub(prev_rx) as f64;
            let tx_delta = total_tx.saturating_sub(prev_tx) as f64;
            ((rx_delta / secs) as u64, (tx_delta / secs) as u64)
        } else {
            (0, 0)
        };
        state.last_net = Some((now, total_rx, total_tx));

        let mut seen_mounts = HashSet::new();
        let mut disks: Vec<DiskStat> = state
            .disks
            .into_iter()
            .filter_map(|d| {
                let total = d.total_space();
                if total == 0 {
                    return None;
                }
                let mount = d.mount_point().to_string_lossy().into_owned();
                if !seen_mounts.insert(mount.clone()) {
                    return None;
                }
                let avail = d.available_space();
                let used = total.saturating_sub(avail);
                let usage_percent = (used as f64 / total as f64 * 100.0) as f32;
                Some(DiskStat {
                    name: d.name().to_string_lossy().into_owned(),
                    mount_point: mount,
                    fs_type: d.file_system().to_string_lossy().into_owned(),
                    total_bytes: total,
                    used_bytes: used,
                    usage_percent,
                })
            })
            .collect();

        disks.sort_by(|a, b| {
            let a_root = a.mount_point == "/";
            let b_root = b.mount_point == "/";
            b_root
                .cmp(&a_root)
                .then_with(|| b.total_bytes.cmp(&a.total_bytes))
        });
        disks.truncate(8);

        let mut procs: Vec<ProcessStat> = state
            .sys
            .processes()
            .iter()
            .map(|(pid, proc_item)| ProcessStat {
                pid: pid.as_u32(),
                name: proc_item.name().to_string_lossy().into_owned(),
                cpu_percent: proc_item.cpu_usage(),
                memory_bytes: proc_item.memory(),
            })
            .collect();
        procs.sort_by(|a, b| {
            b.cpu_percent
                .total_cmp(&a.cpu_percent)
                .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
        });
        procs.truncate(8);

        let load = System::load_average().unwrap_or(sysinfo::LoadAvg {
            one: 0.0,
            five: 0.0,
            fifteen: 0.0,
        });
        let os_name = System::name().unwrap_or_else(|_| std::env::consts::OS.to_string());
        let os_ver = System::os_version().unwrap_or_default();
        let full_os = if os_ver.is_empty() {
            os_name
        } else {
            format!("{os_name} {os_ver}")
        };

        Ok(SystemStats {
            source: SessionKind::Local,
            hostname: System::host_name().unwrap_or_else(|_| "localhost".to_string()),
            os_name: full_os,
            kernel_version: System::kernel_version().unwrap_or_default(),
            arch: System::cpu_arch(),
            uptime_secs: System::uptime().unwrap_or(0),
            load_avg: [load.one, load.five, load.fifteen],
            cpu_usage_percent: state.sys.global_cpu_usage(),
            cpu_cores: state.sys.cpus().len().max(1),
            mem_total_bytes: state.sys.total_memory(),
            mem_used_bytes: state.sys.used_memory(),
            swap_total_bytes: state.sys.total_swap(),
            swap_used_bytes: state.sys.used_swap(),
            net_rx_bytes_per_sec: rx_rate,
            net_tx_bytes_per_sec: tx_rate,
            net_total_rx_bytes: total_rx,
            net_total_tx_bytes: total_tx,
            disks,
            top_processes: procs,
            sampled_at: Utc::now().timestamp_millis(),
        })
    }

    pub async fn collect_ssh(&self, host: &HostConfig) -> CoreResult<SystemStats> {
        let pool = self.require_pool()?;
        let handle = pool.get_or_connect(host).await?;
        let mut channel = match handle.channel_open_session().await {
            Ok(ch) => ch,
            Err(_) => {
                pool.invalidate(&host.id);
                let fresh = pool.get_or_connect(host).await?;
                fresh
                    .channel_open_session()
                    .await
                    .map_err(|e| CoreError::SshError(format!("Failed to open monitor channel: {e}")))?
            }
        };

        channel
            .exec(true, REMOTE_PROBE_SCRIPT)
            .await
            .map_err(|e| CoreError::SshError(format!("Remote probe exec failed: {e}")))?;

        let mut output = Vec::with_capacity(8192);
        let read_res = tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => output.extend_from_slice(&data),
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        })
        .await;

        let _ = channel.close().await;

        if read_res.is_err() {
            return Err(CoreError::SshError(
                "Timed out collecting remote system metrics".to_string(),
            ));
        }

        let raw = String::from_utf8_lossy(&output);
        let key = format!("{}@{}:{}", host.username, host.host, host.port);
        let mut map = self.remote_prev.lock();
        let prev = map.entry(key).or_default();
        Ok(parse_remote_probe_output(&raw, &host.host, prev, Instant::now()))
    }
}

impl CorePlugin for MonitorPlugin {
    fn id(&self) -> &'static str {
        "lighterm.monitor"
    }

    fn name(&self) -> &'static str {
        "System Status Monitor"
    }

    fn description(&self) -> &'static str {
        "Real-time local and remote SSH host CPU, memory, network, disk, and process telemetry"
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        *self.ssh_pool.write() = Some(Arc::clone(&ctx.ssh_pool));
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        *self.local.lock() = None;
        self.remote_prev.lock().clear();
        *self.ssh_pool.write() = None;
        Ok(())
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

pub fn parse_remote_probe_output(
    raw: &str,
    fallback_host: &str,
    prev: &mut RemotePrevCounters,
    now: Instant,
) -> SystemStats {
    let mut section = "";
    let mut host_lines: Vec<&str> = Vec::new();
    let mut uptime_lines: Vec<&str> = Vec::new();
    let mut load_lines: Vec<&str> = Vec::new();
    let mut cpu_lines: Vec<&str> = Vec::new();
    let mut mem_lines: Vec<&str> = Vec::new();
    let mut net_lines: Vec<&str> = Vec::new();
    let mut disk_lines: Vec<&str> = Vec::new();
    let mut proc_lines: Vec<&str> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("===") && trimmed.ends_with("===") {
            section = trimmed;
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        match section {
            "===HOST===" => host_lines.push(trimmed),
            "===UPTIME===" => uptime_lines.push(trimmed),
            "===LOAD===" => load_lines.push(trimmed),
            "===CPU===" => cpu_lines.push(trimmed),
            "===MEM===" => mem_lines.push(trimmed),
            "===NET===" => net_lines.push(trimmed),
            "===DISK===" => disk_lines.push(trimmed),
            "===PROC===" => proc_lines.push(trimmed),
            _ => {}
        }
    }

    let hostname = host_lines
        .first()
        .copied()
        .unwrap_or(fallback_host)
        .to_string();
    let kernel_version = host_lines.get(1).copied().unwrap_or("").to_string();
    let arch = host_lines.get(2).copied().unwrap_or("").to_string();
    let os_name = kernel_version
        .split_whitespace()
        .next()
        .unwrap_or("Linux")
        .to_string();

    let uptime_secs = uptime_lines
        .first()
        .and_then(|l| l.split_whitespace().next())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;

    let mut load_avg = [0.0f64; 3];
    if let Some(line) = load_lines.first() {
        let nums: Vec<f64> = line
            .split_whitespace()
            .take(3)
            .filter_map(|s| s.parse::<f64>().ok())
            .collect();
        if nums.len() == 3 {
            load_avg = [nums[0], nums[1], nums[2]];
        }
    }

    let mut cpu_cores = 1usize;
    let mut cpu_usage_percent = 0.0f32;
    if let Some(first) = cpu_lines.first() {
        if let Ok(c) = first.parse::<usize>() {
            cpu_cores = c.max(1);
        }
    }
    if let Some(stat_line) = cpu_lines.iter().find(|l| l.starts_with("cpu ")) {
        let fields: Vec<u64> = stat_line
            .split_whitespace()
            .skip(1)
            .filter_map(|s| s.parse::<u64>().ok())
            .collect();
        if fields.len() >= 4 {
            let idle = fields[3].saturating_add(fields.get(4).copied().unwrap_or(0));
            let total: u64 = fields.iter().sum();
            if prev.cpu_total > 0 && total > prev.cpu_total {
                let d_total = total.saturating_sub(prev.cpu_total);
                let d_idle = idle.saturating_sub(prev.cpu_idle);
                if d_total > 0 {
                    cpu_usage_percent =
                        ((d_total.saturating_sub(d_idle)) as f64 / d_total as f64 * 100.0) as f32;
                }
            }
            prev.cpu_total = total;
            prev.cpu_idle = idle;
        }
    }

    let mut mem_total_kb = 0u64;
    let mut mem_avail_kb: Option<u64> = None;
    let mut mem_free_kb = 0u64;
    let mut buffers_kb = 0u64;
    let mut cached_kb = 0u64;
    let mut swap_total_kb = 0u64;
    let mut swap_free_kb = 0u64;

    for line in mem_lines {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("");
        let val = parts.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        match key {
            "MemTotal:" => mem_total_kb = val,
            "MemAvailable:" => mem_avail_kb = Some(val),
            "MemFree:" => mem_free_kb = val,
            "Buffers:" => buffers_kb = val,
            "Cached:" => cached_kb = val,
            "SwapTotal:" => swap_total_kb = val,
            "SwapFree:" => swap_free_kb = val,
            _ => {}
        }
    }
    let effective_avail_kb = mem_avail_kb.unwrap_or(mem_free_kb + buffers_kb + cached_kb);
    let mem_total_bytes = mem_total_kb.saturating_mul(1024);
    let mem_used_bytes = mem_total_kb
        .saturating_sub(effective_avail_kb)
        .saturating_mul(1024);
    let swap_total_bytes = swap_total_kb.saturating_mul(1024);
    let swap_used_bytes = swap_total_kb
        .saturating_sub(swap_free_kb)
        .saturating_mul(1024);

    let mut total_rx = 0u64;
    let mut total_tx = 0u64;
    for line in net_lines {
        if let Some((iface, rest)) = line.split_once(':') {
            let name = iface.trim();
            if name == "lo" || name == "lo0" {
                continue;
            }
            let nums: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            if nums.len() >= 9 {
                total_rx = total_rx.saturating_add(nums[0]);
                total_tx = total_tx.saturating_add(nums[8]);
            }
        }
    }

    let (net_rx_bytes_per_sec, net_tx_bytes_per_sec) = if let Some(prev_at) = prev.sampled_at {
        let secs = now.duration_since(prev_at).as_secs_f64().max(0.1);
        let rx_delta = total_rx.saturating_sub(prev.net_rx) as f64;
        let tx_delta = total_tx.saturating_sub(prev.net_tx) as f64;
        ((rx_delta / secs) as u64, (tx_delta / secs) as u64)
    } else {
        (0, 0)
    };
    prev.net_rx = total_rx;
    prev.net_tx = total_tx;
    prev.sampled_at = Some(now);

    let mut disks = Vec::new();
    let mut seen_mounts = HashSet::new();
    let mut df_has_type = false;
    for (idx, line) in disk_lines.iter().enumerate() {
        if idx == 0 && (line.starts_with("Filesystem") || line.contains("Mounted on")) {
            df_has_type = line.contains("Type");
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if df_has_type && cols.len() >= 7 {
            let fs_name = cols[0];
            let fs_type = cols[1];
            if matches!(
                fs_type,
                "tmpfs" | "devtmpfs" | "squashfs" | "efivarfs" | "udev" | "proc" | "sysfs"
            ) {
                continue;
            }
            let total = cols[2].parse::<u64>().unwrap_or(0);
            let used = cols[3].parse::<u64>().unwrap_or(0);
            let mount = cols[6..].join(" ");
            if total == 0 || !seen_mounts.insert(mount.clone()) {
                continue;
            }
            disks.push(DiskStat {
                name: fs_name.to_string(),
                mount_point: mount,
                fs_type: fs_type.to_string(),
                total_bytes: total,
                used_bytes: used,
                usage_percent: (used as f64 / total as f64 * 100.0) as f32,
            });
        } else if !df_has_type && cols.len() >= 6 {
            let fs_name = cols[0];
            let total = cols[1].parse::<u64>().unwrap_or(0).saturating_mul(1024);
            let used = cols[2].parse::<u64>().unwrap_or(0).saturating_mul(1024);
            let mount = cols[5..].join(" ");
            if total == 0 || !seen_mounts.insert(mount.clone()) {
                continue;
            }
            disks.push(DiskStat {
                name: fs_name.to_string(),
                mount_point: mount,
                fs_type: "unknown".to_string(),
                total_bytes: total,
                used_bytes: used,
                usage_percent: (used as f64 / total as f64 * 100.0) as f32,
            });
        }
    }
    disks.sort_by(|a, b| {
        let a_root = a.mount_point == "/";
        let b_root = b.mount_point == "/";
        b_root
            .cmp(&a_root)
            .then_with(|| b.total_bytes.cmp(&a.total_bytes))
    });
    disks.truncate(8);

    let mut top_processes = Vec::new();
    for line in proc_lines {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 4 {
            if let Ok(pid) = cols[0].parse::<u32>() {
                let cpu_percent = cols[1].parse::<f32>().unwrap_or(0.0);
                let rss_kb = cols[2].parse::<u64>().unwrap_or(0);
                let name = cols[3..].join(" ");
                top_processes.push(ProcessStat {
                    pid,
                    name,
                    cpu_percent,
                    memory_bytes: rss_kb.saturating_mul(1024),
                });
            }
        }
    }
    top_processes.sort_by(|a, b| {
        b.cpu_percent
            .total_cmp(&a.cpu_percent)
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
    });
    top_processes.truncate(8);

    SystemStats {
        source: SessionKind::Ssh,
        hostname,
        os_name,
        kernel_version,
        arch,
        uptime_secs,
        load_avg,
        cpu_usage_percent,
        cpu_cores,
        mem_total_bytes,
        mem_used_bytes,
        swap_total_bytes,
        swap_used_bytes,
        net_rx_bytes_per_sec,
        net_tx_bytes_per_sec,
        net_total_rx_bytes: total_rx,
        net_total_tx_bytes: total_tx,
        disks,
        top_processes,
        sampled_at: Utc::now().timestamp_millis(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lighterm_core::LightermCore;
    use tempfile::tempdir;

    #[test]
    fn local_and_remote_monitor_collection() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let monitor = Arc::new(MonitorPlugin::new());
        core.register_plugin(monitor.clone()).unwrap();

        let local = monitor.collect_local().unwrap();
        assert_eq!(local.source, SessionKind::Local);
        assert!(local.cpu_cores >= 1);
        assert!(local.mem_total_bytes > 0);
        assert!(!local.top_processes.is_empty());

        let sample_1 = "\
===HOST===
prod-node-01
Linux 6.8.0-45-generic
x86_64
===UPTIME===
123456.78 987654.32
===LOAD===
0.42 0.31 0.25 1/240 1234
===CPU===
4
cpu  1000 0 500 8500 0 0 0 0 0 0
===MEM===
MemTotal:        8192000 kB
MemAvailable:    4096000 kB
SwapTotal:       2048000 kB
SwapFree:        1536000 kB
===NET===
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 10000 100 0 0 0 0 0 0 10000 100 0 0 0 0 0 0
  eth0: 100000 100 0 0 0 0 0 0 50000 80 0 0 0 0 0 0
===DISK===
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/sda1      ext4 107374182400 53687091200 53687091200      50% /
tmpfs          tmpfs 4194304000     1048576  4193255424       1% /run
===PROC===
  101 12.5 102400 nginx
  202  3.2  51200 postgres
";

        let sample_2 = "\
===HOST===
prod-node-01
Linux 6.8.0-45-generic
x86_64
===UPTIME===
123458.78 987656.32
===LOAD===
0.55 0.35 0.27 2/240 1235
===CPU===
4
cpu  1200 0 600 9200 0 0 0 0 0 0
===MEM===
MemTotal:        8192000 kB
MemAvailable:    4096000 kB
SwapTotal:       2048000 kB
SwapFree:        1536000 kB
===NET===
    lo: 10500 102 0 0 0 0 0 0 10500 102 0 0 0 0 0 0
  eth0: 104096 105 0 0 0 0 0 0 52048 84 0 0 0 0 0 0
===DISK===
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/sda1      ext4 107374182400 53687091200 53687091200      50% /
===PROC===
  101 12.5 102400 nginx
  202  3.2  51200 postgres
";

        let t0 = std::time::Instant::now();
        let mut prev = RemotePrevCounters::default();
        let first = parse_remote_probe_output(sample_1, "10.0.0.1", &mut prev, t0);
        assert_eq!(first.hostname, "prod-node-01");
        assert_eq!(first.cpu_cores, 4);
        assert_eq!(first.mem_total_bytes, 8192000 * 1024);
        assert_eq!(first.mem_used_bytes, 4096000 * 1024);
        assert_eq!(first.disks.len(), 1);
        assert_eq!(first.disks[0].mount_point, "/");

        let t1 = t0 + Duration::from_secs(2);
        let second = parse_remote_probe_output(sample_2, "10.0.0.1", &mut prev, t1);
        assert!((second.cpu_usage_percent - 30.0).abs() < 0.1);
        assert_eq!(second.net_rx_bytes_per_sec, 2048);
        assert_eq!(second.net_tx_bytes_per_sec, 1024);
        assert_eq!(second.top_processes[0].name, "nginx");
    }
}
