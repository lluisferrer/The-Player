// Descodificació en STREAMING per al motor ASIO (decode-ahead amb ring buffer).
//
// Per a pistes llargues (playlist: sets de DJ d'hores, o cues ASIO llargs),
// descodificar el fitxer SENCER a RAM no és viable (una pista de 2,5 h ≈ 3 GB de
// PCM f32). Aquí mantenim el descodificador obert en un FIL dedicat que va omplint
// un buffer d'uns segons; el callback RT en consumeix sense bloquejar-se.
//
// Disseny:
//   · El fil descodificador empeny mostres f32 INTERLEAVED a la FREQÜÈNCIA DEL
//     FITXER dins una VecDeque protegida per Mutex (productor únic).
//   · El callback (consumidor únic) llegeix del davant amb interpolació LINEAL
//     per resamplejar a la freqüència del driver (resample al consumidor: estat
//     simple, sense fer-lo al fil del decoder).
//   · Backpressure: si el buffer és prou ple, el decoder dorm.
//   · Seek/stop es comuniquen amb àtomics (`StreamCtrl`).
//
// El callback NO toca symphonia ni assigna res gran; només llegeix del deque.

#![cfg(feature = "asio")]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::sample::Sample;
use symphonia::core::units::Time;

// Buffer compartit entre el fil descodificador i el callback.
pub struct StreamRing {
    // Mostres INTERLEAVED (frame = `channels` mostres consecutives), a `file_rate`.
    pub samples: VecDeque<f32>,
    pub channels: usize, // 0 fins que arriba el primer paquet
    pub file_rate: u32,  // 0 fins que arriba el primer paquet
    pub eof: bool,       // el decoder ha arribat al final del fitxer
    pub cap_samples: usize, // límit tou per al backpressure
}

impl StreamRing {
    fn new() -> Self {
        StreamRing {
            samples: VecDeque::new(),
            channels: 0,
            file_rate: 0,
            eof: false,
            cap_samples: 0,
        }
    }
    // Frames disponibles ara mateix.
    pub fn avail_frames(&self) -> usize {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels
        }
    }
    // Mostra al frame `f`, canal `c` (sense comprovació de límits: el cridador en té cura).
    #[inline]
    pub fn sample(&self, f: usize, c: usize) -> f32 {
        *self.samples.get(f * self.channels + c).unwrap_or(&0.0)
    }
    // Descarta `n` frames del davant (ja consumits).
    pub fn pop_frames(&mut self, n: usize) {
        let k = (n * self.channels).min(self.samples.len());
        self.samples.drain(0..k);
    }
}

// Control del fil descodificador des d'altres fils (motor/callback).
pub struct StreamCtrl {
    pub stop: AtomicBool,
    // Posició on saltar, en MIL·LISEGONS (-1 = cap petició). En ms per no dependre
    // del file_rate (que no es coneix fins al primer paquet).
    pub seek_ms: AtomicI64,
}

impl StreamCtrl {
    fn new() -> Self {
        StreamCtrl {
            stop: AtomicBool::new(false),
            seek_ms: AtomicI64::new(-1),
        }
    }
}

// Mànec d'un stream actiu: el ring i el control. El StreamVoice del motor en té
// un clon de cada Arc.
pub struct StreamHandle {
    pub ring: Arc<Mutex<StreamRing>>,
    pub ctrl: Arc<StreamCtrl>,
}

// Arrenca un fil descodificador per a `file_path`, opcionalment començant a
// `start_secs`. Retorna el mànec immediatament (la descodificació passa al fil;
// el callback veu silenci fins al primer paquet).
pub fn spawn_stream(file_path: String, start_secs: f64) -> StreamHandle {
    let ring = Arc::new(Mutex::new(StreamRing::new()));
    let ctrl = Arc::new(StreamCtrl::new());
    let ring_t = ring.clone();
    let ctrl_t = ctrl.clone();
    std::thread::Builder::new()
        .name("asio-stream".into())
        .spawn(move || decoder_main(file_path, ring_t, ctrl_t, start_secs))
        .ok();
    StreamHandle { ring, ctrl }
}

fn to_f32<S: Sample>(s: S) -> f32
where
    f32: symphonia::core::conv::FromSample<S>,
{
    use symphonia::core::conv::FromSample;
    f32::from_sample(s)
}

// Afegeix un AudioBufferRef (planar) a un Vec INTERLEAVED f32.
fn interleave_into(decoded: &AudioBufferRef, out: &mut Vec<f32>, channels: usize) {
    macro_rules! do_buf {
        ($buf:expr) => {{
            let b = $buf;
            let frames = b.frames();
            let chs = b.spec().channels.count().min(channels);
            out.reserve(frames * channels);
            for f in 0..frames {
                for c in 0..channels {
                    let v = if c < chs { to_f32(b.chan(c)[f]) } else { 0.0 };
                    out.push(v);
                }
            }
        }};
    }
    match decoded {
        AudioBufferRef::U8(b) => do_buf!(b),
        AudioBufferRef::U16(b) => do_buf!(b),
        AudioBufferRef::U24(b) => do_buf!(b),
        AudioBufferRef::U32(b) => do_buf!(b),
        AudioBufferRef::S8(b) => do_buf!(b),
        AudioBufferRef::S16(b) => do_buf!(b),
        AudioBufferRef::S24(b) => do_buf!(b),
        AudioBufferRef::S32(b) => do_buf!(b),
        AudioBufferRef::F32(b) => do_buf!(b),
        AudioBufferRef::F64(b) => do_buf!(b),
    }
}

// Bucle del fil descodificador.
fn decoder_main(path: String, ring: Arc<Mutex<StreamRing>>, ctrl: Arc<StreamCtrl>, start_secs: f64) {
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[asio-stream] obrir '{}': {}", path, e);
            if let Ok(mut r) = ring.lock() { r.eof = true; }
            return;
        }
    };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(&path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = match symphonia::default::get_probe().format(
        &hint, mss, &FormatOptions::default(), &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[asio-stream] probe '{}': {}", path, e);
            if let Ok(mut r) = ring.lock() { r.eof = true; }
            return;
        }
    };
    let mut format = probed.format;
    let track = match format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL) {
        Some(t) => t,
        None => { if let Ok(mut r) = ring.lock() { r.eof = true; } return; }
    };
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let mut decoder = match symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default()) {
        Ok(d) => d,
        Err(e) => { eprintln!("[asio-stream] decoder: {}", e); if let Ok(mut r) = ring.lock() { r.eof = true; } return; }
    };

    let mut channels = codec_params.channels.map(|c| c.count()).unwrap_or(0);
    let mut file_rate = codec_params.sample_rate.unwrap_or(0);

    // Seek inicial (offset de represa o start_point).
    if start_secs > 0.0 {
        let _ = format.seek(
            SeekMode::Coarse,
            SeekTo::Time { time: Time::from(start_secs), track_id: Some(track_id) },
        );
    }

    let mut scratch: Vec<f32> = Vec::new();

    loop {
        if ctrl.stop.load(Ordering::Relaxed) {
            break;
        }
        // Petició de seek (en ms)?
        let sk = ctrl.seek_ms.swap(-1, Ordering::Relaxed);
        if sk >= 0 {
            let secs = sk as f64 / 1000.0;
            let _ = format.seek(
                SeekMode::Coarse,
                SeekTo::Time { time: Time::from(secs), track_id: Some(track_id) },
            );
            if let Ok(mut r) = ring.lock() {
                r.samples.clear();
                r.eof = false;
            }
            decoder.reset();
        }

        // Backpressure: si el buffer ja té prou, dorm una mica.
        {
            let r = match ring.lock() { Ok(r) => r, Err(_) => return };
            if r.cap_samples > 0 && r.samples.len() >= r.cap_samples {
                drop(r);
                std::thread::sleep(std::time::Duration::from_millis(4));
                continue;
            }
        }

        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                // Final del fitxer: marca eof i espera stop o seek.
                if let Ok(mut r) = ring.lock() { r.eof = true; }
                loop {
                    if ctrl.stop.load(Ordering::Relaxed) { return; }
                    let sk2 = ctrl.seek_ms.load(Ordering::Relaxed);
                    if sk2 >= 0 { break; } // hi ha un seek pendent: surt a tornar a decodificar
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                continue;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(_) => { std::thread::sleep(std::time::Duration::from_millis(4)); continue; }
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if channels == 0 { channels = decoded.spec().channels.count(); }
                if file_rate == 0 { file_rate = decoded.spec().rate; }
                if channels == 0 { continue; }
                scratch.clear();
                interleave_into(&decoded, &mut scratch, channels);
                if let Ok(mut r) = ring.lock() {
                    if r.channels == 0 {
                        r.channels = channels;
                        r.file_rate = file_rate;
                        r.cap_samples = (file_rate as usize * channels * 4).max(1 << 15); // ~4 s
                    }
                    r.samples.extend(scratch.iter().copied());
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }
}
