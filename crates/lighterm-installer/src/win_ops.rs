use std::borrow::Cow;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

use crate::config::{
    append_to_user_path, remove_from_user_path, InstallOptions, APP_EXE_NAME, APP_NAME,
    APP_VERSION, MANIFEST_FILE_NAME, UNINSTALL_EXE_NAME,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const UNINSTALL_REG_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Lighterm";
const DIR_SHELL_SUBKEY: &str = r"Software\Classes\Directory\shell\Lighterm";
const DIR_BG_SHELL_SUBKEY: &str = r"Software\Classes\Directory\Background\shell\Lighterm";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub version: String,
    pub install_dir: String,
    pub options: InstallOptions,
}

fn to_wide_null(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn encode_utf16_reg_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn decode_utf16_reg_bytes(bytes: &[u8]) -> String {
    let mut u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    while u16s.last() == Some(&0) {
        u16s.pop();
    }
    String::from_utf16_lossy(&u16s)
}

/// Returns free bytes available to the current user on the volume containing `path`.
pub fn get_free_disk_bytes(path: &Path) -> Result<u64, String> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    if !probe.exists() {
        probe = PathBuf::from(r"C:\");
    }

    let wide = to_wide_null(probe.as_os_str());
    let mut free_bytes: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR::from_raw(wide.as_ptr()),
            Some(&mut free_bytes),
            None,
            None,
        )
        .map_err(|e| format!("Failed querying disk free space for '{}': {e}", probe.display()))?;
    }
    Ok(free_bytes)
}

/// Terminates any locked running `lighterm.exe` before replacing or removing it.
pub fn stop_running_lighterm(target_exe: &Path) {
    if target_exe.exists() {
        let writable = OpenOptions::new().write(true).open(target_exe).is_ok();
        if writable {
            return;
        }
    }

    let _ = Command::new("taskkill")
        .args(["/F", "/IM", APP_EXE_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    std::thread::sleep(Duration::from_millis(250));
}

fn create_shortcut(
    lnk_path: &Path,
    target_exe: &Path,
    working_dir: &Path,
    description: &str,
) -> Result<(), String> {
    if let Some(parent) = lnk_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating shortcut folder '{}': {e}", parent.display()))?;
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninit = hr.is_ok();

        let res = (|| -> Result<(), String> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(ShellLink) failed: {e}"))?;

            let target_h = HSTRING::from(target_exe.as_os_str());
            let dir_h = HSTRING::from(working_dir.as_os_str());
            let desc_h = HSTRING::from(description);
            let lnk_h = HSTRING::from(lnk_path.as_os_str());

            link.SetPath(&target_h)
                .map_err(|e| format!("IShellLinkW::SetPath failed: {e}"))?;
            link.SetWorkingDirectory(&dir_h)
                .map_err(|e| format!("IShellLinkW::SetWorkingDirectory failed: {e}"))?;
            link.SetDescription(&desc_h)
                .map_err(|e| format!("IShellLinkW::SetDescription failed: {e}"))?;
            link.SetIconLocation(&target_h, 0)
                .map_err(|e| format!("IShellLinkW::SetIconLocation failed: {e}"))?;

            let persist: IPersistFile = windows::core::Interface::cast(&link)
                .map_err(|e| format!("Cast to IPersistFile failed: {e}"))?;
            persist
                .Save(&lnk_h, true)
                .map_err(|e| format!("IPersistFile::Save('{}') failed: {e}", lnk_path.display()))?;

            Ok(())
        })();

        if should_uninit {
            CoUninitialize();
        }
        res
    }
}

fn desktop_shortcut_path() -> Option<PathBuf> {
    dirs::desktop_dir().map(|d| d.join(format!("{APP_NAME}.lnk")))
}

fn start_menu_shortcut_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| {
        d.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(format!("{APP_NAME}.lnk"))
    })
}

fn broadcast_environment_change() {
    let wide = to_wide_null(OsStr::new("Environment"));
    unsafe {
        let mut _result: usize = 0;
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(wide.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            1000,
            Some(&mut _result),
        );
    }
}

fn update_user_path(install_dir: &Path, add: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env_key = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .or_else(|_| hkcu.create_subkey("Environment").map(|(k, _)| k))
        .map_err(|e| format!("Failed opening HKCU\\Environment: {e}"))?;

    let existing = match env_key.get_raw_value("Path") {
        Ok(val) => decode_utf16_reg_bytes(&val.bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("Failed reading HKCU\\Environment\\Path: {err}")),
    };

    let dir_str = install_dir.to_string_lossy();
    let next_value = if add {
        append_to_user_path(&existing, &dir_str)
    } else {
        remove_from_user_path(&existing, &dir_str)
    };

    if let Some(updated) = next_value {
        let reg_val = RegValue {
            bytes: Cow::Owned(encode_utf16_reg_bytes(&updated)),
            vtype: RegType::REG_EXPAND_SZ,
        };
        env_key
            .set_raw_value("Path", &reg_val)
            .map_err(|e| format!("Failed updating HKCU\\Environment\\Path: {e}"))?;
        broadcast_environment_change();
    }

    Ok(())
}

fn set_context_menu_entries(target_exe: &Path, enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if !enabled {
        let _ = hkcu.delete_subkey_all(DIR_SHELL_SUBKEY);
        let _ = hkcu.delete_subkey_all(DIR_BG_SHELL_SUBKEY);
        return Ok(());
    }

    let exe_str = target_exe.to_string_lossy();
    let icon_val = format!("{exe_str},0");
    let cmd_val = format!("\"{exe_str}\" \"%V\"");

    for base_subkey in [DIR_SHELL_SUBKEY, DIR_BG_SHELL_SUBKEY] {
        let (shell_key, _) = hkcu
            .create_subkey(base_subkey)
            .map_err(|e| format!("Failed creating context menu key '{base_subkey}': {e}"))?;
        shell_key
            .set_value("", &"在此处打开 Lighterm")
            .and_then(|_| shell_key.set_value("Icon", &icon_val))
            .map_err(|e| format!("Failed configuring context menu key '{base_subkey}': {e}"))?;

        let (cmd_key, _) = shell_key
            .create_subkey("command")
            .map_err(|e| format!("Failed creating command subkey under '{base_subkey}': {e}"))?;
        cmd_key
            .set_value("", &cmd_val)
            .map_err(|e| format!("Failed setting context menu command: {e}"))?;
    }

    Ok(())
}

fn write_uninstall_registry(
    install_dir: &Path,
    target_exe: &Path,
    uninstall_exe: &Path,
    uncompressed_bytes: u64,
) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(UNINSTALL_REG_SUBKEY)
        .map_err(|e| format!("Failed creating Uninstall registry entry: {e}"))?;

    let exe_str = target_exe.to_string_lossy().into_owned();
    let dir_str = install_dir.to_string_lossy().into_owned();
    let uninstall_str = format!("\"{}\" --uninstall", uninstall_exe.to_string_lossy());
    let quiet_str = format!("\"{}\" --uninstall --silent", uninstall_exe.to_string_lossy());
    let estimated_kb = ((uncompressed_bytes / 1024).max(1)) as u32;

    key.set_value("DisplayName", &APP_NAME)
        .and_then(|_| key.set_value("DisplayVersion", &APP_VERSION))
        .and_then(|_| key.set_value("Publisher", &APP_NAME))
        .and_then(|_| key.set_value("DisplayIcon", &format!("{exe_str},0")))
        .and_then(|_| key.set_value("InstallLocation", &dir_str))
        .and_then(|_| key.set_value("UninstallString", &uninstall_str))
        .and_then(|_| key.set_value("QuietUninstallString", &quiet_str))
        .and_then(|_| key.set_value("NoModify", &1u32))
        .and_then(|_| key.set_value("NoRepair", &1u32))
        .and_then(|_| key.set_value("EstimatedSize", &estimated_kb))
        .map_err(|e| format!("Failed writing Uninstall registry values: {e}"))?;

    Ok(())
}

/// Applies shortcuts, PATH, Explorer context menu, Uninstall entry, and install manifest
/// after `lighterm.exe` and `uninstall.exe` have been extracted.
pub fn apply_install_integrations(
    options: &InstallOptions,
    uncompressed_bytes: u64,
    touch_system_integration: bool,
    on_progress: &mut dyn FnMut(f64, &str),
) -> Result<(), String> {
    let install_dir = PathBuf::from(&options.install_dir);
    let target_exe = install_dir.join(APP_EXE_NAME);
    let uninstall_exe = install_dir.join(UNINSTALL_EXE_NAME);

    if touch_system_integration {
        on_progress(0.90, "正在创建快捷方式与系统集成...");
        if let Some(desktop_lnk) = desktop_shortcut_path() {
            if options.desktop_shortcut {
                create_shortcut(
                    &desktop_lnk,
                    &target_exe,
                    &install_dir,
                    "Lighterm Terminal & SSH/SFTP Workbench",
                )?;
            } else {
                let _ = fs::remove_file(&desktop_lnk);
            }
        }

        if let Some(start_lnk) = start_menu_shortcut_path() {
            if options.start_menu_shortcut {
                create_shortcut(
                    &start_lnk,
                    &target_exe,
                    &install_dir,
                    "Lighterm Terminal & SSH/SFTP Workbench",
                )?;
            } else {
                let _ = fs::remove_file(&start_lnk);
            }
        }

        update_user_path(&install_dir, options.add_to_path)?;
        set_context_menu_entries(&target_exe, options.context_menu)?;

        on_progress(0.95, "正在注册 Windows 卸载信息...");
        write_uninstall_registry(&install_dir, &target_exe, &uninstall_exe, uncompressed_bytes)?;
    }

    let manifest = InstallManifest {
        version: APP_VERSION.to_string(),
        install_dir: options.install_dir.clone(),
        options: options.clone(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed serializing install manifest: {e}"))?;
    fs::write(install_dir.join(MANIFEST_FILE_NAME), manifest_json)
        .map_err(|e| format!("Failed writing install manifest: {e}"))?;

    on_progress(1.0, "安装完成");
    Ok(())
}

/// Resolves the installation directory for uninstall mode using manifest, registry, or exe parent.
pub fn resolve_uninstall_dir(cli_dir: Option<&str>, current_exe: &Path) -> PathBuf {
    if let Some(dir) = cli_dir {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir.trim());
        }
    }

    if let Some(parent) = current_exe.parent() {
        if parent.join(MANIFEST_FILE_NAME).exists() || parent.join(APP_EXE_NAME).exists() {
            return parent.to_path_buf();
        }
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(UNINSTALL_REG_SUBKEY) {
        if let Ok(loc) = key.get_value::<String, _>("InstallLocation") {
            if !loc.trim().is_empty() {
                return PathBuf::from(loc);
            }
        }
    }

    crate::config::default_install_dir()
}

/// Removes Lighterm binaries, shortcuts, registry entries, and optionally user config data.
pub fn run_uninstall(
    install_dir: &Path,
    purge_user_data: bool,
    touch_system_integration: bool,
    on_progress: &mut dyn FnMut(f64, &str),
) -> Result<(), String> {
    let target_exe = install_dir.join(APP_EXE_NAME);

    on_progress(0.15, "正在检查并关闭运行中的 Lighterm...");
    stop_running_lighterm(&target_exe);

    on_progress(0.40, "正在移除应用程序文件...");
    if target_exe.exists() {
        fs::remove_file(&target_exe)
            .map_err(|e| format!("Failed removing '{}': {e}", target_exe.display()))?;
    }
    let manifest_path = install_dir.join(MANIFEST_FILE_NAME);
    if manifest_path.exists() {
        let _ = fs::remove_file(&manifest_path);
    }

    if touch_system_integration {
        on_progress(0.65, "正在清理快捷方式、PATH 与注册表项...");
        if let Some(desktop_lnk) = desktop_shortcut_path() {
            let _ = fs::remove_file(desktop_lnk);
        }
        if let Some(start_lnk) = start_menu_shortcut_path() {
            let _ = fs::remove_file(start_lnk);
        }
        let _ = update_user_path(install_dir, false);
        let _ = set_context_menu_entries(&target_exe, false);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(UNINSTALL_REG_SUBKEY);
    }

    if purge_user_data {
        on_progress(0.85, "正在清理个人配置与主机数据...");
        if let Some(roaming) = dirs::data_dir() {
            let _ = fs::remove_dir_all(roaming.join("com.lighterm.app"));
        }
        if let Some(local) = dirs::data_local_dir() {
            let _ = fs::remove_dir_all(local.join("com.lighterm.app"));
        }
    }

    // Remove uninstall.exe directly if we are NOT currently running from it; otherwise defer self-delete.
    if let Ok(current_exe) = std::env::current_exe() {
        let uninstall_exe = install_dir.join(UNINSTALL_EXE_NAME);
        let same_dir = current_exe
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .zip(install_dir.canonicalize().ok())
            .is_some_and(|(a, b)| a == b);
        if !same_dir && uninstall_exe.exists() {
            let _ = fs::remove_file(&uninstall_exe);
            let _ = fs::remove_dir(install_dir);
        }
    }

    on_progress(1.0, "卸载完成");
    Ok(())
}

/// If running from `<install_dir>\uninstall.exe`, spawns a detached hidden `cmd.exe`
/// that deletes `uninstall.exe` and removes the empty directory after process exit.
pub fn schedule_self_delete_if_inside(install_dir: &Path) {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let same_dir = current_exe
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .zip(install_dir.canonicalize().ok())
        .is_some_and(|(a, b)| a == b);
    if !same_dir {
        return;
    }

    let exe_str = current_exe.to_string_lossy();
    let dir_str = install_dir.to_string_lossy();
    let cmd_script = format!(
        "ping 127.0.0.1 -n 2 > nul & del /f /q \"{exe_str}\" & rmdir \"{dir_str}\""
    );

    let _ = Command::new("cmd.exe")
        .args(["/C", &cmd_script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Launches the installed `lighterm.exe` detached from the installer process.
pub fn launch_installed_app(install_dir: &Path) -> Result<(), String> {
    let exe_path = install_dir.join(APP_EXE_NAME);
    Command::new(&exe_path)
        .current_dir(install_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed launching '{}': {e}", exe_path.display()))?;
    Ok(())
}
