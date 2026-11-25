//! The one way this app writes files: temp file in the same directory, flush to
//! disk, then rename over the target. A crash mid-write leaves the old file
//! intact (rename is atomic on the same filesystem), never a half-written one.

use std::{fs, io::Write, path::Path};

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("eco-fs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_replaces_and_leaves_no_temp_file() {
        let d = tmpdir("a");
        let p = d.join("history.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two-longer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two-longer");
        assert!(!d.join("history.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_temp_file_from_a_crash_never_replaces_the_real_file() {
        let d = tmpdir("b");
        let p = d.join("history.json");
        write_atomic(&p, b"good").unwrap();
        // Simulate a crash mid-write: a truncated temp file is left beside it.
        fs::write(d.join("history.json.tmp"), b"{trunc").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"good");
        // The next write cleanly overwrites the stale temp.
        write_atomic(&p, b"next").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"next");
        assert!(!d.join("history.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
