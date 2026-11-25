use std::collections::BTreeMap;
use std::num::NonZeroU32;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lighterm_core::error::{CoreError, CoreResult};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::digest::{digest, SHA256};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;

use crate::models::{EncryptedPayload, SyncPayload};

const KDF_NAME: &str = "pbkdf2-hmac-sha256";
const CIPHER_NAME: &str = "aes-256-gcm";
const PBKDF2_ITERATIONS: u32 = 100_000;
const SYNC_AAD: &[u8] = b"lighterm-sync-v1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

pub fn encrypt_payload(payload: &SyncPayload, passphrase: &str) -> CoreResult<EncryptedPayload> {
    if passphrase.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "Encryption passphrase cannot be empty".to_string(),
        ));
    }

    let plaintext = serde_json::to_vec(payload)
        .map_err(|e| CoreError::PluginError(format!("Failed to serialize sync payload: {e}")))?;

    let rng = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut salt)
        .map_err(|_| CoreError::PluginError("Failed to generate random salt".to_string()))?;
    rng.fill(&mut nonce_bytes)
        .map_err(|_| CoreError::PluginError("Failed to generate random nonce".to_string()))?;

    let mut key_bytes = [0u8; KEY_LEN];
    let iterations = NonZeroU32::new(PBKDF2_ITERATIONS)
        .ok_or_else(|| CoreError::PluginError("Invalid PBKDF2 iteration count".to_string()))?;
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &salt,
        passphrase.as_bytes(),
        &mut key_bytes,
    );

    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| CoreError::PluginError("Failed to construct AES-256-GCM key".to_string()))?;
    let key = LessSafeKey::new(unbound);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut in_out = plaintext;
    key.seal_in_place_append_tag(nonce, Aad::from(SYNC_AAD), &mut in_out)
        .map_err(|_| CoreError::PluginError("Failed to encrypt sync payload".to_string()))?;

    Ok(EncryptedPayload {
        kdf: KDF_NAME.to_string(),
        iterations: PBKDF2_ITERATIONS,
        cipher: CIPHER_NAME.to_string(),
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(in_out),
    })
}

pub fn decrypt_payload(enc: &EncryptedPayload, passphrase: &str) -> CoreResult<SyncPayload> {
    if passphrase.trim().is_empty() {
        return Err(CoreError::AuthFailed(
            "Remote sync data is encrypted. Please enter your Encryption Passphrase in GitHub Sync settings."
                .to_string(),
        ));
    }
    if enc.cipher != CIPHER_NAME || enc.kdf != KDF_NAME || enc.iterations == 0 {
        return Err(CoreError::InvalidInput(format!(
            "Unsupported remote encryption scheme ({}/{})",
            enc.kdf, enc.cipher
        )));
    }

    let salt = BASE64
        .decode(enc.salt.trim())
        .map_err(|_| CoreError::InvalidInput("Invalid encrypted sync salt".to_string()))?;
    let nonce_vec = BASE64
        .decode(enc.nonce.trim())
        .map_err(|_| CoreError::InvalidInput("Invalid encrypted sync nonce".to_string()))?;
    let mut ciphertext = BASE64
        .decode(enc.ciphertext.trim())
        .map_err(|_| CoreError::InvalidInput("Invalid encrypted sync ciphertext".to_string()))?;

    let nonce_bytes: [u8; NONCE_LEN] = nonce_vec
        .try_into()
        .map_err(|_| CoreError::InvalidInput("Invalid AES-GCM nonce length".to_string()))?;

    let mut key_bytes = [0u8; KEY_LEN];
    let iterations = NonZeroU32::new(enc.iterations)
        .ok_or_else(|| CoreError::InvalidInput("Invalid PBKDF2 iteration count".to_string()))?;
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &salt,
        passphrase.as_bytes(),
        &mut key_bytes,
    );

    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| CoreError::PluginError("Failed to construct AES-256-GCM key".to_string()))?;
    let key = LessSafeKey::new(unbound);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let plaintext = key
        .open_in_place(nonce, Aad::from(SYNC_AAD), &mut ciphertext)
        .map_err(|_| {
            CoreError::AuthFailed(
                "Failed to decrypt remote sync data. Please verify your Encryption Passphrase."
                    .to_string(),
            )
        })?;

    serde_json::from_slice(plaintext)
        .map_err(|e| CoreError::PluginError(format!("Failed to parse decrypted sync payload: {e}")))
}

fn canonicalize_value(val: serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k, canonicalize_value(v));
            }
            let mut out = serde_json::Map::new();
            for (k, v) in sorted {
                out.insert(k, v);
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(canonicalize_value).collect())
        }
        other => other,
    }
}

pub fn sha256_hex<T: Serialize>(value: &T) -> CoreResult<String> {
    let raw_val = serde_json::to_value(value)
        .map_err(|e| CoreError::PluginError(format!("Serialization hash error: {e}")))?;
    let canonical = canonicalize_value(raw_val);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|e| CoreError::PluginError(format!("Canonical serialization error: {e}")))?;
    let d = digest(&SHA256, &bytes);
    let mut out = String::with_capacity(d.as_ref().len() * 2);
    for b in d.as_ref() {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}
