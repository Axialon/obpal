//! ob.Pal Desktop: the native helper behind the ob.Pal Link extension's PC target.
//!
//! Chrome launches `obpal-desktop.exe chrome-extension://<id>/` and talks to it over stdin/stdout
//! (Native Messaging). There is no other way in: no socket, no listener, no file that is watched.
//! `obpal-desktop.exe install | uninstall | status` manage the per-user registration.

use obpal_desktop::{protocol, scope, session};
#[cfg(windows)]
use obpal_desktop::win;

use std::env;
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use protocol::{parse_request, read_message, write_message, Reply};
use scope::Config;
use session::Session;

const POLL: Duration = Duration::from_millis(50);

fn usage() {
    println!(
        "obpal-desktop {}\n\n  obpal-desktop install [--origin chrome-extension://<id>/ ...]   register for Chrome, Chromium, Edge, Brave, Vivaldi (this user)\n  obpal-desktop uninstall                                        remove that registration\n  obpal-desktop status                                           show where it is registered\n\nWithout a command it serves the browser that launched it over stdin/stdout.",
        session::VERSION
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("install") => {
            let mut origins = Vec::new();
            let mut it = args[1..].iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--origin" => match it.next() {
                        Some(o) => origins.push(o.clone()),
                        None => return fail("--origin needs a value"),
                    },
                    other => return fail(&format!("unknown option {other}")),
                }
            }
            report(platform::install(&origins))
        }
        Some("uninstall") => report(platform::uninstall()),
        Some("status") => report(platform::status()),
        Some("--version" | "-V" | "version") => {
            println!("obpal-desktop {}", session::VERSION);
            ExitCode::SUCCESS
        }
        Some("--help" | "-h" | "help") => {
            usage();
            ExitCode::SUCCESS
        }
        _ => serve(&args),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("obpal-desktop: {msg}");
    ExitCode::from(2)
}

fn report(r: Result<Vec<String>, String>) -> ExitCode {
    match r {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}

enum Event {
    Msg(Vec<u8>),
    Eof,
    Failed(String),
}

/// Serve the extension over stdio until the port closes.
fn serve(args: &[String]) -> ExitCode {
    let log = Log::open();
    let origin = args.iter().find(|a| a.starts_with("chrome-extension://")).cloned();
    let Some(origin) = origin else {
        log.line("started without an extension origin; nothing to serve (use: obpal-desktop install)");
        usage();
        return ExitCode::from(2);
    };
    if !platform::origin_allowed(&origin) {
        log.line(&format!("refused origin {origin}"));
        eprintln!("obpal-desktop: {origin} is not an allowed extension");
        return ExitCode::from(3);
    }
    let cfg_path = Config::default_path();
    let cfg = cfg_path.as_deref().map(Config::load).unwrap_or_default();
    log.line(&format!("serving {origin} (v{}, {} allowed programs)", session::VERSION, cfg.programs.len()));

    let (tx, rx) = mpsc::channel::<Event>();
    let reader_tx = tx.clone();
    thread::Builder::new()
        .name("stdin".into())
        .spawn(move || {
            let mut stdin = io::stdin().lock();
            loop {
                match read_message(&mut stdin) {
                    Ok(Some(bytes)) => {
                        if reader_tx.send(Event::Msg(bytes)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        reader_tx.send(Event::Eof).ok();
                        break;
                    }
                    Err(e) => {
                        reader_tx.send(Event::Failed(e.to_string())).ok();
                        break;
                    }
                }
            }
        })
        .expect("stdin thread");

    let panic = Arc::new(AtomicBool::new(false));
    let hotkey = platform::start_panic_hotkey({
        let panic = panic.clone();
        move || panic.store(true, Ordering::SeqCst)
    });
    log.line(&format!("panic hotkey: {}", hotkey.as_deref().unwrap_or("not available")));

    let browser = platform::browser();
    log.line(&format!("browser: {}", browser.as_deref().unwrap_or("not found")));
    let (injector, foreground) = platform::backends(browser);
    let mut session = Session::new(injector, foreground, cfg, cfg_path, hotkey);
    let mut out = io::stdout().lock();
    let send = |replies: Vec<Reply>, out: &mut io::StdoutLock| -> bool {
        for r in replies {
            if write_message(out, &r.to_bytes()).is_err() {
                return false;
            }
        }
        true
    };

    loop {
        if panic.swap(false, Ordering::SeqCst) {
            log.line("panic hotkey pressed: released everything, stopped");
            if !send(session.on_panic(), &mut out) {
                break;
            }
        }
        let replies = match rx.recv_timeout(POLL) {
            Ok(Event::Msg(bytes)) => match parse_request(&bytes) {
                Ok(req) => session.handle(req, Instant::now()),
                Err(e) => vec![Reply::error("bad-message", e)],
            },
            Ok(Event::Eof) => {
                log.line("port closed");
                break;
            }
            Ok(Event::Failed(e)) => {
                log.line(&format!("stdin failed: {e}"));
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => session.poll(Instant::now()),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if !send(replies, &mut out) {
            log.line("stdout closed");
            break;
        }
    }
    session.shutdown();
    let s = session.stats();
    log.line(&format!("stopped: {} frames, {} injected, refused {:?}{}", s.frames, s.injected, s.refused, platform::inject_report()));
    ExitCode::SUCCESS
}

/// A small lifecycle log next to the config (`%APPDATA%\obpal\desktop.log`). Never input.
struct Log(Option<std::fs::File>);

impl Log {
    fn open() -> Log {
        let Some(path) = Config::default_path().map(|p| p.with_file_name("desktop.log")) else { return Log(None) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        if std::fs::metadata(&path).map_or(false, |m| m.len() > 1_000_000) {
            std::fs::remove_file(&path).ok();
        }
        Log(std::fs::OpenOptions::new().create(true).append(true).open(path).ok())
    }

    fn line(&self, msg: &str) {
        if let Some(mut f) = self.0.as_ref() {
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "{t} [{}] {msg}", std::process::id());
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::win;
    use obpal_desktop::session::{Foreground, Injector};

    pub fn install(origins: &[String]) -> Result<Vec<String>, String> {
        win::install::install(origins).map(|r| r.lines)
    }
    pub fn uninstall() -> Result<Vec<String>, String> {
        win::install::uninstall().map(|r| r.lines)
    }
    pub fn status() -> Result<Vec<String>, String> {
        win::install::status().map(|r| r.lines)
    }
    pub fn origin_allowed(origin: &str) -> bool {
        win::install::installed_origins().iter().any(|o| o == origin)
    }
    pub fn start_panic_hotkey(on_panic: impl Fn() + Send + 'static) -> Option<String> {
        win::hotkey::start(on_panic)
    }
    pub fn browser() -> Option<String> {
        win::process::launcher_path()
    }
    pub fn backends(browser: Option<String>) -> (impl Injector, impl Foreground) {
        (win::inject::WinInjector, win::foreground::WinForeground::new(browser))
    }
    pub fn inject_report() -> String {
        use std::sync::atomic::Ordering;
        let failures = win::inject::FAILURES.load(Ordering::Relaxed);
        if failures == 0 { String::new() } else { format!(", {failures} SendInput failures (last error {})", win::inject::LAST_ERROR.load(Ordering::Relaxed)) }
    }
}

#[cfg(not(windows))]
mod platform {
    //! Other platforms: the session logic compiles and is tested; injectors (CGEventPost, uinput) are still to come.
    use obpal_desktop::keys::KeyDef;
    use obpal_desktop::protocol::MouseButton;
    use obpal_desktop::session::{Foreground, FrontWindow, Injector};

    const UNSUPPORTED: &str = "ob.Pal Desktop supports Windows only for now";

    pub fn install(_: &[String]) -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn uninstall() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn status() -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn origin_allowed(_: &str) -> bool {
        false
    }
    pub fn start_panic_hotkey(_: impl Fn() + Send + 'static) -> Option<String> {
        None
    }
    pub struct Nothing;
    impl Injector for Nothing {
        fn key(&mut self, _: &'static KeyDef, _: bool) {}
        fn button(&mut self, _: MouseButton, _: bool) {}
        fn mouse_move(&mut self, _: i32, _: i32) {}
        fn wheel(&mut self, _: i32, _: i32) {}
    }
    impl Foreground for Nothing {
        fn front(&mut self) -> Option<FrontWindow> {
            None
        }
    }
    pub fn browser() -> Option<String> {
        None
    }
    pub fn backends(_: Option<String>) -> (impl Injector, impl Foreground) {
        (Nothing, Nothing)
    }
    pub fn inject_report() -> String {
        String::new()
    }
}
