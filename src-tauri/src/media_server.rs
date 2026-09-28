// ─────────────────────────────────────────────────────────────────────────────
// Servidor de MÈDIA local (només Linux): serveix vídeos i imatges al WebView per
// HTTP a 127.0.0.1.
//
// Per què: a Linux el <video> de WebKitGTK el reprodueix GStreamer, que no es porta
// bé amb el protocol propi de Tauri (asset://): els vídeos quedaven en NEGRE
// ("error de vídeo") tot i que GStreamer els descodifica perfectament des de disc.
// Per HTTP normal (amb Range) GStreamer els llegeix sense problemes, com qualsevol
// reproductor web. A Windows/Mac el protocol asset funciona i no s'usa.
//
// Seguretat:
//   · Escolta NOMÉS a 127.0.0.1, en un port aleatori.
//   · Cada URL porta un TOKEN aleatori de 128 bits generat en arrencar: una altra
//     app o una web oberta al navegador no pot endevinar-lo.
//   · Només serveix fitxers amb extensió de mèdia (la mateixa llista que
//     read_file_bytes); qualsevol altra cosa → 403.
//   · Només GET/HEAD; sense llistats de directoris.
//
// URL: http://127.0.0.1:<port>/<token>/<ruta absoluta codificada amb %XX>
// ─────────────────────────────────────────────────────────────────────────────

// Fora de Linux el servidor no s'arrenca (només es compila la comanda).
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;

static BASE_URL: OnceLock<String> = OnceLock::new();

// Token aleatori de 128 bits. RandomState es llavora amb aleatorietat del SO per
// a cada instància; dues instàncies → dos u64 independents.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Arrenca el servidor (un sol cop). Retorna la URL base o None si no pot escoltar.
pub fn start(allowed_ext: &'static [&'static str]) -> Option<String> {
    if let Some(b) = BASE_URL.get() {
        return Some(b.clone());
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            log::warn!("[media] no s'ha pogut obrir el servidor de mèdia: {e}");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}/");
    let _ = BASE_URL.set(base.clone());
    let prefix = format!("/{token}/");
    std::thread::Builder::new()
        .name("media-server".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let prefix = prefix.clone();
                // Un fil per connexió: el WebView n'obre poques (vídeo + miniatures)
                // i les manté vives mentre reprodueix.
                let _ = std::thread::Builder::new()
                    .name("media-conn".into())
                    .spawn(move || {
                        let _ = handle(conn, &prefix, allowed_ext);
                    });
            }
        })
        .ok()?;
    log::info!("[media] servidor de mèdia local a 127.0.0.1:{port}");
    Some(base)
}

/// URL base del servidor (None si no s'ha arrencat o no és Linux).
#[tauri::command]
pub fn media_base_url() -> Option<String> {
    BASE_URL.get().cloned()
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" | "mpeg" | "mpg" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn respond_status(stream: &mut TcpStream, code: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {code}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    )
}

// Interpreta "bytes=a-b" / "bytes=a-" / "bytes=-n" contra la mida del fitxer.
fn parse_range(v: &str, len: u64) -> Option<(u64, u64)> {
    let r = v.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { len.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(len.checked_sub(1)?) };
    if start > end || start >= len {
        return None;
    }
    Some((start, end))
}

fn handle(mut stream: TcpStream, prefix: &str, allowed_ext: &[&str]) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    // HTTP/1.1 keep-alive: el reproductor fa diverses peticions Range per connexió.
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut range: Option<String> = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h)? == 0 {
                return Ok(());
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_string());
                }
            }
        }

        if method == "OPTIONS" {
            write!(
                stream,
                "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\n\r\n"
            )?;
            continue;
        }
        if method != "GET" && method != "HEAD" {
            return respond_status(&mut stream, "405 Method Not Allowed");
        }
        // Treu la query (?...) i comprova el token.
        let path_part = target.split('?').next().unwrap_or("");
        let Some(enc) = path_part.strip_prefix(prefix) else {
            return respond_status(&mut stream, "403 Forbidden");
        };
        let Some(path) = percent_decode(enc) else {
            return respond_status(&mut stream, "400 Bad Request");
        };
        let p = std::path::Path::new(&path);
        let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
        if !p.is_absolute() || !allowed_ext.contains(&ext.as_str()) {
            return respond_status(&mut stream, "403 Forbidden");
        }
        let Ok(mut file) = std::fs::File::open(p) else {
            return respond_status(&mut stream, "404 Not Found");
        };
        let len = file.metadata()?.len();
        let ctype = content_type(&ext);
        let (status, start, end) = match range.as_deref().map(|r| parse_range(r, len)) {
            Some(Some((s, e))) => ("206 Partial Content", s, e),
            Some(None) => {
                write!(
                    stream,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                )?;
                continue;
            }
            None => ("200 OK", 0, len.saturating_sub(1)),
        };
        let body_len = if len == 0 { 0 } else { end - start + 1 };
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {body_len}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n"
        );
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes())?;
        if method == "HEAD" || body_len == 0 {
            continue;
        }
        file.seek(SeekFrom::Start(start))?;
        let mut remaining = body_len;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let n = (remaining.min(buf.len() as u64)) as usize;
            let got = file.read(&mut buf[..n])?;
            if got == 0 {
                break;
            }
            // Si el reproductor tanca la connexió (seek), l'escriptura falla: normal.
            stream.write_all(&buf[..got])?;
            remaining -= got as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
    }

    #[test]
    fn decode() {
        assert_eq!(percent_decode("%2Fhome%2Fa%20b%C3%A0.mp4").as_deref(), Some("/home/a bà.mp4"));
        assert_eq!(percent_decode("x%2").as_deref(), Some("x%2"));
    }
}
