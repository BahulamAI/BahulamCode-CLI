//! Disk-backed cold presentation text; canonical Node history is never modified.
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
#[derive(Debug)]
pub struct Archive {
    file: Mutex<Option<File>>,
    path: PathBuf,
}
#[derive(Debug, Clone)]
pub struct Record {
    archive: Arc<Archive>,
    offset: u64,
    bytes: u64,
    pub has_detail: bool,
}
impl std::hash::Hash for Record {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        self.archive.path.hash(h);
        self.offset.hash(h);
        self.bytes.hash(h);
    }
}
#[derive(Serialize, Deserialize)]
pub struct Text {
    pub body: String,
    pub detail: Option<String>,
}
impl Archive {
    pub fn create() -> std::io::Result<Arc<Self>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "bahulam-transcript-{}-{stamp}-{}.cache",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Arc::new(Self {
            file: Mutex::new(Some(file)),
            path,
        }))
    }
    pub fn append(self: &Arc<Self>, body: &str, detail: Option<&str>) -> std::io::Result<Record> {
        let text = serde_json::to_vec(&(body, detail))?;
        let mut guard = self
            .file
            .lock()
            .map_err(|_| std::io::Error::other("archive lock poisoned"))?;
        let file = guard
            .as_mut()
            .ok_or_else(|| std::io::Error::other("archive closed"))?;
        let offset = file.seek(SeekFrom::End(0))?;
        file.write_all(&text)?;
        Ok(Record {
            archive: self.clone(),
            offset,
            bytes: text.len() as u64,
            has_detail: detail.is_some(),
        })
    }
}
impl Record {
    pub fn read(&self) -> std::io::Result<Text> {
        let mut guard = self
            .archive
            .file
            .lock()
            .map_err(|_| std::io::Error::other("archive lock poisoned"))?;
        let file = guard
            .as_mut()
            .ok_or_else(|| std::io::Error::other("archive closed"))?;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        (&mut *file).take(self.bytes).read_to_end(&mut bytes)?;
        let (body, detail) = serde_json::from_slice(&bytes)?;
        Ok(Text { body, detail })
    }
}
impl Drop for Archive {
    fn drop(&mut self) {
        // Windows cannot unlink an open file: replace/close the handle first.
        if let Ok(file) = self.file.get_mut() {
            drop(file.take());
        }
        let _ = std::fs::remove_file(&self.path);
    }
}
