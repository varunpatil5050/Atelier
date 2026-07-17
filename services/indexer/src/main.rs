//! atelier-indexer: the intelligence plane's structural + semantic index
//! (blueprint doc 06). Walks a workspace, extracts symbols and call edges with
//! tree-sitter, chunks + embeds files for semantic retrieval, keeps everything
//! fresh via file watching, and serves symbol search, find-references, and
//! hybrid retrieval over HTTP.
//!
//!   indexer --dir ./data/workspaces/demo --addr 127.0.0.1:8789

mod chunk;
mod embed;
mod extract;
mod index;
mod lang;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::HeaderValue;
use axum::routing::{get, post};
use axum::{Json, Router};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use walkdir::WalkDir;

use crate::embed::{Embedder, HashEmbedder};
use crate::index::{StoredChunk, SymbolIndex};
use crate::lang::Lang;

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".turbo",
    "dist",
    "target",
    "data",
    "coverage",
    "test-results",
    ".pnpm-store",
];
const MAX_FILE_BYTES: u64 = 1 << 20;

struct App {
    dir: PathBuf,
    index: RwLock<SymbolIndex>,
    dirty: Mutex<HashSet<PathBuf>>,
    embedder: HashEmbedder,
}

fn main() {
    let (dir, addr) = parse_args();
    let dir = dir.canonicalize().unwrap_or_else(|e| {
        eprintln!("indexer: bad --dir {}: {e}", dir.display());
        std::process::exit(2);
    });

    let app = Arc::new(App {
        dir: dir.clone(),
        index: RwLock::new(SymbolIndex::default()),
        dirty: Mutex::new(HashSet::new()),
        embedder: HashEmbedder::default(),
    });

    // Initial full pass.
    let started = Instant::now();
    let files = full_index(&app);
    let stats = app.index.read().unwrap().stats();
    println!(
        "indexer: indexed {} files → {} symbols, {} refs, {} chunks (embed dim {}) in {:?} (dir: {})",
        files,
        stats.symbols,
        stats.references,
        stats.chunks,
        app.embedder.dim(),
        started.elapsed(),
        dir.display()
    );

    // Watcher: mark paths dirty; a flusher thread re-indexes at a debounce.
    let watch_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let mut dirty = watch_app.dirty.lock().unwrap();
            for path in event.paths {
                dirty.insert(path);
            }
        }
    })
    .expect("indexer: watcher init");
    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .expect("indexer: watch dir");

    let flush_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let paths: Vec<PathBuf> = flush_app.dirty.lock().unwrap().drain().collect();
        for path in paths {
            reindex_path(&flush_app, &path);
        }
    });

    // HTTP server.
    let rt = tokio::runtime::Runtime::new().expect("indexer: tokio runtime");
    rt.block_on(async move {
        let cors = CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
                origin
                    .to_str()
                    .map(|o| {
                        o.starts_with("http://localhost") || o.starts_with("http://127.0.0.1")
                    })
                    .unwrap_or(false)
            }))
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST]);

        let router = Router::new()
            .route("/healthz", get(health))
            .route("/v1/search", get(search))
            .route("/v1/refs", get(refs))
            .route("/v1/retrieve", get(retrieve))
            .route("/v1/stats", get(stats_handler))
            .route("/v1/reindex", post(reindex_all))
            .layer(cors)
            .with_state(app);

        let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
        println!("indexer: listening on http://{addr}");
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
            .expect("serve");
    });
}

fn parse_args() -> (PathBuf, SocketAddr) {
    let mut dir = PathBuf::from(".");
    let mut addr: SocketAddr = "127.0.0.1:8789".parse().unwrap();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dir" => dir = PathBuf::from(args.next().expect("--dir value")),
            "--addr" => addr = args.next().expect("--addr value").parse().expect("addr"),
            other => {
                eprintln!("indexer: unknown flag {other} (usage: indexer --dir <path> [--addr host:port])");
                std::process::exit(2);
            }
        }
    }
    (dir, addr)
}

// ── indexing ─────────────────────────────────────────────────────────────

/// Ignore rules apply to WORKSPACE-RELATIVE components only — the workspace
/// itself may live under a directory whose name is in the ignore list
/// (e.g. …/data/workspaces/demo), which must not exclude everything.
fn is_ignored_rel(root: &Path, abs: &Path) -> bool {
    let Ok(rel) = abs.strip_prefix(root) else {
        return true; // outside the workspace
    };
    rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| IGNORED_DIRS.contains(&s))
            .unwrap_or(false)
    })
}

fn full_index(app: &App) -> usize {
    let mut count = 0;
    let root = app.dir.clone();
    for entry in WalkDir::new(&app.dir)
        .into_iter()
        .filter_entry(|e| !is_ignored_rel(&root, e.path()))
        .flatten()
    {
        if entry.file_type().is_file() && reindex_path(app, entry.path()) {
            count += 1;
        }
    }
    count
}

/// (Re-)index one absolute path. Returns true if the file was indexable.
fn reindex_path(app: &App, abs: &Path) -> bool {
    if is_ignored_rel(&app.dir, abs) {
        return false;
    }
    let Ok(rel) = abs.strip_prefix(&app.dir) else {
        return false;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    let Some(lang) = Lang::from_path(&rel) else {
        return false;
    };

    match std::fs::metadata(abs) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {}
        Ok(_) => return false,
        Err(_) => {
            // Deleted (or unreadable): drop its symbols.
            app.index.write().unwrap().remove_file(&rel);
            return false;
        }
    }
    let Ok(source) = std::fs::read_to_string(abs) else {
        return false; // binary/non-utf8
    };

    let parsed = extract::extract(&rel, lang, &source);
    // Chunk + embed for semantic retrieval. Embedding is CPU-only (HashEmbedder),
    // so this stays on the indexing path; a network-backed embedder would move
    // to a batched queue (blueprint doc 06 §5).
    let stored: Vec<StoredChunk> = chunk::chunk_file(&rel, lang.label(), &source, &parsed.symbols)
        .into_iter()
        .map(|c| {
            let v = app.embedder.embed(&c.text);
            StoredChunk::new(c, v)
        })
        .collect();
    app.index.write().unwrap().replace_file(&rel, parsed, stored);
    true
}

// ── handlers ─────────────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    limit: Option<usize>,
}

async fn search(
    State(app): State<Arc<App>>,
    Query(params): Query<SearchParams>,
) -> Json<serde_json::Value> {
    let started = Instant::now();
    let limit = params.limit.unwrap_or(20).min(100);
    let hits = app.index.read().unwrap().search(&params.q, limit);
    Json(json!({
        "query": params.q,
        "tookUs": started.elapsed().as_micros(),
        "results": hits,
    }))
}

#[derive(Deserialize)]
struct RefsParams {
    name: String,
    limit: Option<usize>,
}

async fn refs(
    State(app): State<Arc<App>>,
    Query(params): Query<RefsParams>,
) -> Json<serde_json::Value> {
    let started = Instant::now();
    let limit = params.limit.unwrap_or(100).min(500);
    let refs = app.index.read().unwrap().refs_to(&params.name, limit);
    Json(json!({
        "tookUs": started.elapsed().as_micros(),
        "refs": refs,
    }))
}

/// Hybrid retrieval: the endpoint agents call for "find code relevant to X"
/// (blueprint doc 06 §6/§8). Fuses semantic + lexical rankings.
async fn retrieve(
    State(app): State<Arc<App>>,
    Query(params): Query<SearchParams>,
) -> Json<serde_json::Value> {
    let started = Instant::now();
    let limit = params.limit.unwrap_or(10).min(50);
    let query_vec = app.embedder.embed(&params.q);
    let results = app.index.read().unwrap().retrieve(&query_vec, &params.q, limit);
    Json(json!({
        "query": params.q,
        "tookUs": started.elapsed().as_micros(),
        "results": results,
    }))
}

async fn stats_handler(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let stats = app.index.read().unwrap().stats();
    Json(json!({
        "files": stats.files,
        "symbols": stats.symbols,
        "references": stats.references,
        "chunks": stats.chunks,
    }))
}

async fn reindex_all(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let started = Instant::now();
    let files = full_index(&app);
    let stats = app.index.read().unwrap().stats();
    Json(json!({
        "files": files,
        "symbols": stats.symbols,
        "tookMs": started.elapsed().as_millis(),
    }))
}
