fn main() {
    #[cfg(target_os = "windows")]
    {
        // Only attach Windows icon/version resources when compiling on Windows.
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon("../../src-tauri/icons/icon.ico")
            .set("ProductName", "Lighterm")
            .set("FileDescription", "Lighterm Setup")
            .set("CompanyName", "Lighterm")
            .set("ProductVersion", "0.1.0")
            .set("FileVersion", "0.1.0");
        res.compile().expect("Failed to compile Windows resources for lighterm-installer");
    }
}
