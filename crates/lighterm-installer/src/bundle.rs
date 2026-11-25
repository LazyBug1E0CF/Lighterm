use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use crc32fast::Hasher as Crc32Hasher;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;

use crate::config::UNINSTALL_EXE_NAME;

pub const SFX_MAGIC: [u8; 8] = *b"LTRMSFX1";
pub const TRAILER_LEN: usize = 36;
const CHUNK_SIZE: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfxTrailer {
    pub stub_len: u64,
    pub payload_len: u64,
    pub uncompressed_bytes: u64,
    pub payload_crc32: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfxSummary {
    pub file_count: u32,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub files: Vec<String>,
}

fn validate_rel_path(rel_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel_path);
    if rel_path.is_empty() || p.is_absolute() {
        return Err(format!("Invalid archive entry path: '{rel_path}'"));
    }
    let mut clean = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => clean.push(seg),
            _ => return Err(format!("Unsafe archive entry path: '{rel_path}'")),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(format!("Empty archive entry path: '{rel_path}'"));
    }
    Ok(clean)
}

fn read_u32_le<R: Read>(r: &mut R) -> Result<u32, String> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)
        .map_err(|e| format!("Failed reading u32 from bundle: {e}"))?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(r: &mut R) -> Result<u64, String> {
    let mut buf = [0u8; 8];
    r.read_exact(&mut buf)
        .map_err(|e| format!("Failed reading u64 from bundle: {e}"))?;
    Ok(u64::from_le_bytes(buf))
}

/// Packs `stub_path` + gzipped `entries` + 36-byte `LTRMSFX1` trailer into `out_path`.
pub fn pack_sfx_executable(
    stub_path: &Path,
    entries: &[(&str, &Path)],
    out_path: &Path,
) -> Result<SfxTrailer, String> {
    if entries.is_empty() {
        return Err("At least one payload entry is required".to_string());
    }

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory '{}': {e}", parent.display()))?;
    }

    let stub_bytes = fs::read(stub_path)
        .map_err(|e| format!("Failed to read stub '{}': {e}", stub_path.display()))?;
    let stub_len = stub_bytes.len() as u64;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let entry_count = u32::try_from(entries.len())
        .map_err(|_| "Too many entries for SFX bundle".to_string())?;
    encoder
        .write_all(&entry_count.to_le_bytes())
        .map_err(|e| format!("Failed writing entry count: {e}"))?;

    let mut uncompressed_bytes = 0u64;
    for (rel_path, src_path) in entries {
        let _ = validate_rel_path(rel_path)?;
        let rel_bytes = rel_path.as_bytes();
        let rel_len = u32::try_from(rel_bytes.len())
            .map_err(|_| format!("Entry path too long: '{rel_path}'"))?;

        let data = fs::read(src_path)
            .map_err(|e| format!("Failed reading payload file '{}': {e}", src_path.display()))?;
        let data_len = data.len() as u64;
        uncompressed_bytes = uncompressed_bytes
            .checked_add(data_len)
            .ok_or_else(|| "Payload size overflow".to_string())?;

        encoder
            .write_all(&rel_len.to_le_bytes())
            .and_then(|_| encoder.write_all(rel_bytes))
            .and_then(|_| encoder.write_all(&data_len.to_le_bytes()))
            .and_then(|_| encoder.write_all(&data))
            .map_err(|e| format!("Failed compressing '{rel_path}': {e}"))?;
    }

    let compressed = encoder
        .finish()
        .map_err(|e| format!("Failed finishing gzip stream: {e}"))?;
    let payload_len = compressed.len() as u64;
    let payload_crc32 = crc32fast::hash(&compressed);

    let mut out = File::create(out_path)
        .map_err(|e| format!("Failed creating '{}': {e}", out_path.display()))?;
    out.write_all(&stub_bytes)
        .and_then(|_| out.write_all(&compressed))
        .and_then(|_| out.write_all(&stub_len.to_le_bytes()))
        .and_then(|_| out.write_all(&payload_len.to_le_bytes()))
        .and_then(|_| out.write_all(&uncompressed_bytes.to_le_bytes()))
        .and_then(|_| out.write_all(&payload_crc32.to_le_bytes()))
        .and_then(|_| out.write_all(&SFX_MAGIC))
        .and_then(|_| out.flush())
        .map_err(|e| format!("Failed writing SFX executable '{}': {e}", out_path.display()))?;

    Ok(SfxTrailer {
        stub_len,
        payload_len,
        uncompressed_bytes,
        payload_crc32,
    })
}

/// Inspects the end of `exe_path` for an embedded `LTRMSFX1` trailer.
/// Returns `Ok(None)` when the binary is a standalone stub (e.g. `uninstall.exe`).
pub fn inspect_sfx(exe_path: &Path) -> Result<Option<SfxTrailer>, String> {
    let mut file = File::open(exe_path)
        .map_err(|e| format!("Failed opening '{}': {e}", exe_path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("Failed reading metadata for '{}': {e}", exe_path.display()))?
        .len();

    if file_len < TRAILER_LEN as u64 {
        return Ok(None);
    }

    file.seek(SeekFrom::End(-(TRAILER_LEN as i64)))
        .map_err(|e| format!("Failed seeking SFX trailer: {e}"))?;
    let mut raw = [0u8; TRAILER_LEN];
    file.read_exact(&mut raw)
        .map_err(|e| format!("Failed reading SFX trailer: {e}"))?;

    if raw[28..36] != SFX_MAGIC {
        return Ok(None);
    }

    let stub_len = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let payload_len = u64::from_le_bytes(raw[8..16].try_into().unwrap());
    let uncompressed_bytes = u64::from_le_bytes(raw[16..24].try_into().unwrap());
    let payload_crc32 = u32::from_le_bytes(raw[24..28].try_into().unwrap());

    let expected_total = stub_len
        .checked_add(payload_len)
        .and_then(|sum| sum.checked_add(TRAILER_LEN as u64));
    if expected_total != Some(file_len) || payload_len == 0 || stub_len == 0 {
        return Err("Corrupted SFX trailer offsets".to_string());
    }

    Ok(Some(SfxTrailer {
        stub_len,
        payload_len,
        uncompressed_bytes,
        payload_crc32,
    }))
}

fn verify_payload_crc(file: &mut File, trailer: &SfxTrailer) -> Result<(), String> {
    file.seek(SeekFrom::Start(trailer.stub_len))
        .map_err(|e| format!("Failed seeking payload start: {e}"))?;

    let mut limited = file.take(trailer.payload_len);
    let mut hasher = Crc32Hasher::new();
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut total_read = 0u64;

    loop {
        let n = limited
            .read(&mut buf)
            .map_err(|e| format!("Failed reading payload for CRC check: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total_read += n as u64;
    }

    if total_read != trailer.payload_len {
        return Err("Truncated SFX payload".to_string());
    }

    let actual = hasher.finalize();
    if actual != trailer.payload_crc32 {
        return Err(format!(
            "SFX payload CRC32 mismatch (expected {:#010x}, got {actual:#010x})",
            trailer.payload_crc32
        ));
    }

    Ok(())
}

/// Verifies the SFX trailer, CRC32 checksum, and full gzip stream integrity.
pub fn verify_sfx_bundle(exe_path: &Path) -> Result<SfxSummary, String> {
    let trailer = inspect_sfx(exe_path)?
        .ok_or_else(|| format!("'{}' does not contain an embedded SFX bundle", exe_path.display()))?;

    let mut file = File::open(exe_path)
        .map_err(|e| format!("Failed opening '{}': {e}", exe_path.display()))?;
    verify_payload_crc(&mut file, &trailer)?;

    file.seek(SeekFrom::Start(trailer.stub_len))
        .map_err(|e| format!("Failed seeking payload start: {e}"))?;
    let limited = file.take(trailer.payload_len);
    let mut decoder = GzDecoder::new(limited);

    let file_count = read_u32_le(&mut decoder)?;
    let mut files = Vec::with_capacity(file_count as usize);
    let mut uncompressed_bytes = 0u64;
    let mut scratch = vec![0u8; CHUNK_SIZE];

    for _ in 0..file_count {
        let rel_len = read_u32_le(&mut decoder)? as usize;
        if rel_len == 0 || rel_len > 4096 {
            return Err("Invalid entry path length in SFX bundle".to_string());
        }
        let mut rel_buf = vec![0u8; rel_len];
        decoder
            .read_exact(&mut rel_buf)
            .map_err(|e| format!("Failed reading entry path: {e}"))?;
        let rel_str = String::from_utf8(rel_buf)
            .map_err(|e| format!("Invalid UTF-8 path in SFX bundle: {e}"))?;
        let _ = validate_rel_path(&rel_str)?;
        files.push(rel_str);

        let entry_len = read_u64_le(&mut decoder)?;
        let mut remaining = entry_len;
        while remaining > 0 {
            let chunk = remaining.min(scratch.len() as u64) as usize;
            decoder
                .read_exact(&mut scratch[..chunk])
                .map_err(|e| format!("Failed verifying entry payload: {e}"))?;
            remaining -= chunk as u64;
        }
        uncompressed_bytes = uncompressed_bytes
            .checked_add(entry_len)
            .ok_or_else(|| "Uncompressed byte count overflow".to_string())?;
    }

    if uncompressed_bytes != trailer.uncompressed_bytes {
        return Err(format!(
            "Uncompressed byte count mismatch (trailer {}, actual {})",
            trailer.uncompressed_bytes, uncompressed_bytes
        ));
    }

    // Drain any trailing gzip trailer bytes.
    io::copy(&mut decoder, &mut io::sink())
        .map_err(|e| format!("Failed finalizing gzip stream verification: {e}"))?;

    Ok(SfxSummary {
        file_count,
        compressed_bytes: trailer.payload_len,
        uncompressed_bytes,
        files,
    })
}

/// Extracts all embedded files into `target_dir` and copies the clean stub (`[0..stub_len]`)
/// to `target_dir/uninstall.exe`.
pub fn extract_sfx_to_dir<F>(
    exe_path: &Path,
    trailer: &SfxTrailer,
    target_dir: &Path,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(f64, &str),
{
    on_progress(0.05, "正在校验安装包完整性 (CRC32)...");
    let mut file = File::open(exe_path)
        .map_err(|e| format!("Failed opening installer executable: {e}"))?;
    verify_payload_crc(&mut file, trailer)?;

    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed creating install directory '{}': {e}", target_dir.display()))?;

    file.seek(SeekFrom::Start(trailer.stub_len))
        .map_err(|e| format!("Failed seeking payload start: {e}"))?;
    let limited = (&mut file).take(trailer.payload_len);
    let mut decoder = GzDecoder::new(limited);

    let file_count = read_u32_le(&mut decoder)?;
    let total_bytes = trailer.uncompressed_bytes.max(1);
    let mut written_total = 0u64;
    let mut buf = vec![0u8; CHUNK_SIZE];

    for _ in 0..file_count {
        let rel_len = read_u32_le(&mut decoder)? as usize;
        if rel_len == 0 || rel_len > 4096 {
            return Err("Invalid entry path length in SFX bundle".to_string());
        }
        let mut rel_buf = vec![0u8; rel_len];
        decoder
            .read_exact(&mut rel_buf)
            .map_err(|e| format!("Failed reading entry path: {e}"))?;
        let rel_str = String::from_utf8(rel_buf)
            .map_err(|e| format!("Invalid UTF-8 entry path: {e}"))?;
        let clean_rel = validate_rel_path(&rel_str)?;
        let dest_path = target_dir.join(&clean_rel);

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed creating '{}': {e}", parent.display()))?;
        }

        let entry_len = read_u64_le(&mut decoder)?;
        let mut out_file = File::create(&dest_path)
            .map_err(|e| format!("Failed creating '{}': {e}", dest_path.display()))?;

        let status_msg = format!("正在释放 {rel_str}...");
        on_progress(
            0.10 + 0.72 * (written_total as f64 / total_bytes as f64),
            &status_msg,
        );

        let mut remaining = entry_len;
        while remaining > 0 {
            let to_read = remaining.min(buf.len() as u64) as usize;
            decoder
                .read_exact(&mut buf[..to_read])
                .map_err(|e| format!("Failed decompressing '{rel_str}': {e}"))?;
            out_file
                .write_all(&buf[..to_read])
                .map_err(|e| format!("Failed writing '{}': {e}", dest_path.display()))?;
            remaining -= to_read as u64;
            written_total += to_read as u64;

            let frac = (written_total as f64 / total_bytes as f64).min(1.0);
            on_progress(0.10 + 0.72 * frac, &status_msg);
        }
        out_file
            .flush()
            .map_err(|e| format!("Failed flushing '{}': {e}", dest_path.display()))?;
    }

    // Write clean stub bytes [0..stub_len] as uninstall.exe.
    on_progress(0.85, "正在生成独立卸载程序 uninstall.exe...");
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed seeking stub start: {e}"))?;
    let uninstall_path = target_dir.join(UNINSTALL_EXE_NAME);
    let mut uninstall_out = File::create(&uninstall_path)
        .map_err(|e| format!("Failed creating '{}': {e}", uninstall_path.display()))?;

    let mut stub_remaining = trailer.stub_len;
    while stub_remaining > 0 {
        let to_read = stub_remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..to_read])
            .map_err(|e| format!("Failed reading stub bytes: {e}"))?;
        uninstall_out
            .write_all(&buf[..to_read])
            .map_err(|e| format!("Failed writing '{}': {e}", uninstall_path.display()))?;
        stub_remaining -= to_read as u64;
    }
    uninstall_out
        .flush()
        .map_err(|e| format!("Failed flushing '{}': {e}", uninstall_path.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lighterm-sfx-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pack_verify_and_extract_round_trip() {
        let dir = temp_test_dir("roundtrip");
        let stub_path = dir.join("stub.exe");
        let app_path = dir.join("lighterm.exe");
        let sfx_path = dir.join("Lighterm-Setup.exe");
        let extract_dir = dir.join("installed");

        let stub_data = b"MZ-FAKE-STUB-BINARY-PAYLOAD-0123456789";
        let app_data = vec![0x5Au8; 400_000];
        fs::write(&stub_path, stub_data).unwrap();
        fs::write(&app_path, &app_data).unwrap();

        assert_eq!(inspect_sfx(&stub_path).unwrap(), None);

        let trailer = pack_sfx_executable(&stub_path, &[("lighterm.exe", &app_path)], &sfx_path)
            .expect("pack should succeed");
        assert_eq!(trailer.stub_len, stub_data.len() as u64);
        assert_eq!(trailer.uncompressed_bytes, app_data.len() as u64);

        let inspected = inspect_sfx(&sfx_path).unwrap().expect("trailer present");
        assert_eq!(inspected, trailer);

        let summary = verify_sfx_bundle(&sfx_path).expect("verify should pass");
        assert_eq!(summary.file_count, 1);
        assert_eq!(summary.files, vec!["lighterm.exe"]);
        assert_eq!(summary.uncompressed_bytes, app_data.len() as u64);

        let mut progress_points = Vec::new();
        extract_sfx_to_dir(&sfx_path, &trailer, &extract_dir, |p, _| {
            progress_points.push(p);
        })
        .expect("extract should succeed");

        assert!(!progress_points.is_empty());
        assert_eq!(fs::read(extract_dir.join("lighterm.exe")).unwrap(), app_data);
        assert_eq!(
            fs::read(extract_dir.join("uninstall.exe")).unwrap(),
            stub_data
        );
        assert_eq!(
            inspect_sfx(&extract_dir.join("uninstall.exe")).unwrap(),
            None
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tamper_in_payload_fails_crc32_verification() {
        let dir = temp_test_dir("tamper");
        let stub_path = dir.join("stub.exe");
        let app_path = dir.join("lighterm.exe");
        let sfx_path = dir.join("Lighterm-Setup.exe");

        fs::write(&stub_path, b"STUB").unwrap();
        fs::write(&app_path, b"LIGHTERM-PAYLOAD-DATA").unwrap();

        let trailer = pack_sfx_executable(&stub_path, &[("lighterm.exe", &app_path)], &sfx_path)
            .expect("pack should succeed");

        let mut bytes = fs::read(&sfx_path).unwrap();
        let flip_idx = trailer.stub_len as usize;
        bytes[flip_idx] ^= 0xFF;
        fs::write(&sfx_path, &bytes).unwrap();

        let err = verify_sfx_bundle(&sfx_path).expect_err("tampered payload must fail");
        assert!(err.contains("CRC32 mismatch"));

        let _ = fs::remove_dir_all(&dir);
    }
}
