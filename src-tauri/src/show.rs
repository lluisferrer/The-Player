// Shows com a CARPETA autocontinguda:
//
//   <carpeta pare>/<Nom>/
//   ├── <Nom>.ezyshow     ← JSON amb rutes RELATIVES ("Media/intro.wav")
//   └── Media/            ← còpia de tots els fitxers que fa servir el show
//
// Aquí només hi ha les operacions de disc: crear la carpeta d'un show nou i
// copiar-hi un fitxer de mèdia (en el moment d'afegir-lo a l'app). La lògica de
// desar/obrir (serialitzar, rutes relatives, recents) viu al frontend.
//
// Seguretat (mateix criteri que read_file_bytes): la còpia només accepta fitxers
// amb extensió de mèdia i només escriu dins la carpeta Media/ d'un show existent
// (un fitxer .ezyshow real), de manera que no es pot fer servir per escriure on
// sigui del disc.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Emitter;

const MEDIA_DIR: &str = "Media";
// Mida del bloc de còpia: prou gran per anar ràpid, prou petit per informar del
// progrés sovint en fitxers de vídeo de diversos GB.
const COPY_CHUNK: usize = 4 * 1024 * 1024;

// Caràcters que Windows no accepta en noms de fitxer/carpeta (a Linux només '/').
// Els rebutgem a tot arreu perquè un show creat a Linux s'ha de poder obrir a Windows.
const INVALID_NAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

fn validate_show_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("The show name is empty.".into());
    }
    if n.chars().any(|c| INVALID_NAME_CHARS.contains(&c) || c.is_control()) {
        return Err("The show name cannot contain < > : \" / \\ | ? *".into());
    }
    if n.ends_with('.') || n == ".." {
        return Err("The show name cannot end with a dot.".into());
    }
    Ok(n.to_string())
}

fn ext_lower(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

// Crea <parent>/<name>/ i <parent>/<name>/Media/ i retorna la ruta del fitxer
// <parent>/<name>/<name>.ezyshow (encara no escrit: el frontend hi escriu la sessió).
// Falla si la carpeta ja existeix i no és buida, per no barrejar dos shows.
#[tauri::command]
pub fn show_create(parent: String, name: String) -> Result<String, String> {
    let name = validate_show_name(&name)?;
    let dir = Path::new(&parent).join(&name);
    if dir.exists() {
        let non_empty = fs::read_dir(&dir)
            .map(|mut it| it.next().is_some())
            .unwrap_or(true);
        if non_empty {
            return Err(format!("A folder named «{name}» already exists there. Choose another name."));
        }
    }
    fs::create_dir_all(dir.join(MEDIA_DIR))
        .map_err(|e| format!("Cannot create the show folder: {e}"))?;
    let file = dir.join(format!("{name}.ezyshow"));
    log::info!("[show] creat {}", file.display());
    Ok(file.to_string_lossy().into_owned())
}

// Carpeta Media/ d'un show, validant que show_file és un .ezyshow que existeix.
fn media_dir_of(show_file: &str) -> Result<PathBuf, String> {
    let sf = Path::new(show_file);
    if ext_lower(sf) != "ezyshow" || !sf.is_file() {
        return Err("No show is open (the .ezyshow file was not found).".into());
    }
    let dir = sf.parent().ok_or("Invalid show path.")?.join(MEDIA_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the Media folder: {e}"))?;
    Ok(dir)
}

// Tria el destí dins Media/ per a un fitxer:
//   · ja hi ha un fitxer amb el mateix nom i la mateixa mida → es reutilitza (None
//     com a "cal copiar", Some(ruta) existent);
//   · el nom està agafat per un fitxer diferent → "nom (2).ext", "nom (3).ext"...
// Retorna (ruta de destí, cal_copiar).
fn pick_destination(media: &Path, src: &Path, size: u64) -> Result<(PathBuf, bool), String> {
    let file_name = src.file_name().ok_or("Invalid media path.")?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("media").to_string();
    let ext = src.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut candidate = media.join(file_name);
    let mut n = 2;
    loop {
        match fs::metadata(&candidate) {
            Err(_) => return Ok((candidate, true)),
            Ok(m) if m.is_file() && m.len() == size => return Ok((candidate, false)),
            Ok(_) => {
                candidate = media.join(format!("{stem} ({n}){ext}"));
                n += 1;
                if n > 999 {
                    return Err("Too many files with the same name in Media.".into());
                }
            }
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct CopyProgress {
    job: u64,
    copied: u64,
    total: u64,
}

fn import_blocking(app: &tauri::AppHandle, show_file: &str, src: &str, job: u64) -> Result<String, String> {
    let src_path = Path::new(src);
    if !crate::ALLOWED_EXTENSIONS.contains(&ext_lower(src_path).as_str()) {
        return Err("Only media files can be added to a show.".into());
    }
    let media = media_dir_of(show_file)?;

    // Ja és dins la carpeta Media d'aquest show: no cal fer res.
    if let (Ok(a), Ok(b)) = (src_path.canonicalize(), media.canonicalize()) {
        if a.starts_with(&b) {
            return Ok(src.to_string());
        }
    }

    let meta = fs::metadata(src_path).map_err(|e| format!("Cannot read {src}: {e}"))?;
    let total = meta.len();
    let (dest, needs_copy) = pick_destination(&media, src_path, total)?;
    if !needs_copy {
        return Ok(dest.to_string_lossy().into_owned());
    }

    // Còpia a un fitxer temporal i reanomenat al final: si l'app es tanca a mitja
    // còpia, a Media/ no hi queda mai un fitxer truncat amb el nom bo.
    let tmp = dest.with_file_name(format!(
        ".{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("media")
    ));
    let result = (|| -> Result<(), String> {
        let mut input = fs::File::open(src_path).map_err(|e| format!("Cannot open {src}: {e}"))?;
        let mut output = fs::File::create(&tmp).map_err(|e| format!("Cannot write to Media: {e}"))?;
        let mut buf = vec![0u8; COPY_CHUNK];
        let mut copied = 0u64;
        loop {
            let n = input.read(&mut buf).map_err(|e| format!("Error reading {src}: {e}"))?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(|e| format!("Error writing to Media (disk full?): {e}"))?;
            copied += n as u64;
            let _ = app.emit("show-media-progress", CopyProgress { job, copied, total });
        }
        output.sync_all().map_err(|e| format!("Error writing to Media: {e}"))?;
        drop(output);
        fs::rename(&tmp, &dest).map_err(|e| format!("Error finishing the copy: {e}"))
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    log::info!("[show] copiat {} → {}", src, dest.display());
    Ok(dest.to_string_lossy().into_owned())
}

// Copia un fitxer de mèdia a la carpeta Media/ del show i en retorna la ruta
// absoluta nova (o la d'un fitxer idèntic que ja hi era). Emet
// `show-media-progress` {job, copied, total} durant la còpia.
#[tauri::command]
pub async fn show_import_media(app: tauri::AppHandle, show_file: String, src: String, job: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_blocking(&app, &show_file, &src, job)
            .inspect_err(|e| log::warn!("[show] no s'ha pogut copiar {src} a {show_file}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Existeix aquest fitxer? (per als shows recents i per reobrir l'últim show).
// Només respon per fitxers .ezyshow: no serveix per sondejar el disc.
#[tauri::command]
pub fn show_exists(path: String) -> bool {
    let p = Path::new(&path);
    ext_lower(p) == "ezyshow" && p.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noms_de_show() {
        assert!(validate_show_name("Gala 2026").is_ok());
        assert_eq!(validate_show_name("  Gala  ").unwrap(), "Gala");
        assert!(validate_show_name("").is_err());
        assert!(validate_show_name("a/b").is_err());
        assert!(validate_show_name("a:b").is_err());
        assert!(validate_show_name("show.").is_err());
    }

    #[test]
    fn desti_reutilitza_o_numera() {
        let dir = std::env::temp_dir().join(format!("ezyshow-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = Path::new("C:/x/intro.wav");
        // Buit → nom original, cal copiar.
        let (d, copy) = pick_destination(&dir, src, 10).unwrap();
        assert_eq!(d, dir.join("intro.wav"));
        assert!(copy);
        // Mateix nom i mida → es reutilitza.
        fs::write(dir.join("intro.wav"), vec![0u8; 10]).unwrap();
        let (d, copy) = pick_destination(&dir, src, 10).unwrap();
        assert_eq!(d, dir.join("intro.wav"));
        assert!(!copy);
        // Mateix nom, mida diferent → "intro (2).wav".
        let (d, copy) = pick_destination(&dir, src, 11).unwrap();
        assert_eq!(d, dir.join("intro (2).wav"));
        assert!(copy);
        fs::remove_dir_all(&dir).unwrap();
    }
}
