use std::path::PathBuf;

use lighterm_installer::bundle::{pack_sfx_executable, verify_sfx_bundle};

fn parse_arg(args: &[String], flag: &str) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let stub = parse_arg(&args, "--stub").unwrap_or_else(|| {
        eprintln!("Usage: pack-setup --stub <installer.exe> --app <lighterm.exe> --out <setup.exe>");
        std::process::exit(2);
    });
    let app = parse_arg(&args, "--app").unwrap_or_else(|| {
        eprintln!("Missing --app <lighterm.exe>");
        std::process::exit(2);
    });
    let out = parse_arg(&args, "--out").unwrap_or_else(|| {
        eprintln!("Missing --out <setup.exe>");
        std::process::exit(2);
    });

    let trailer = match pack_sfx_executable(&stub, &[("lighterm.exe", &app)], &out) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("Failed packing SFX setup: {err}");
            std::process::exit(1);
        }
    };

    match verify_sfx_bundle(&out) {
        Ok(summary) => {
            println!(
                "Packed {} (stub={} B, compressed={} B, uncompressed={} B, files={:?})",
                out.display(),
                trailer.stub_len,
                summary.compressed_bytes,
                summary.uncompressed_bytes,
                summary.files
            );
        }
        Err(err) => {
            eprintln!("Packed bundle verification failed: {err}");
            std::process::exit(1);
        }
    }
}
