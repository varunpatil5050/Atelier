//! In-memory symbol + reference index with ranked fuzzy search and a
//! name-based call graph.
//!
//! v0 storage: per-file symbol/reference lists in HashMaps — replaced wholesale
//! on re-index, so file updates are naturally atomic. The mmap-able CSR graph
//! artifacts of blueprint doc 06 §4 arrive when resolution graduates from
//! name-based (heuristic) to scope-aware.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::chunk::Chunk;
use crate::embed::{cosine, tokenize};
use crate::extract::{FileSymbols, Reference, Symbol};

/// A chunk plus its precomputed embedding and lexical token set.
pub struct StoredChunk {
    pub chunk: Chunk,
    pub embedding: Vec<f32>,
    pub tokens: HashSet<String>,
}

impl StoredChunk {
    pub fn new(chunk: Chunk, embedding: Vec<f32>) -> Self {
        let tokens = tokenize(&chunk.text).into_iter().collect();
        StoredChunk {
            chunk,
            embedding,
            tokens,
        }
    }
}

#[derive(Default)]
pub struct SymbolIndex {
    symbols: HashMap<String, Vec<Symbol>>,
    references: HashMap<String, Vec<Reference>>,
    chunks: HashMap<String, Vec<StoredChunk>>,
}

#[derive(Serialize)]
pub struct Hit {
    pub score: i64,
    #[serde(flatten)]
    pub symbol: Symbol,
}

#[derive(Serialize)]
pub struct Stats {
    pub files: usize,
    pub symbols: usize,
    pub references: usize,
    pub chunks: usize,
}

/// A hybrid-retrieval result: a chunk with its fused score and which signals
/// surfaced it (blueprint doc 06 §6 — results carry their provenance).
#[derive(Serialize)]
pub struct Retrieved {
    pub path: String,
    pub line: usize,
    pub end_line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub kind: &'static str,
    pub header: String,
    pub preview: String,
    pub score: f64,
    pub why: Vec<&'static str>, // "semantic" and/or "lexical"
}

/// Callers of a symbol plus a 1-hop blast-radius summary (blueprint doc 06 §8).
#[derive(Serialize)]
pub struct Refs {
    pub name: String,
    pub confidence: &'static str, // "heuristic" — name-based resolution
    pub count: usize,             // total call sites
    pub files: usize,             // distinct files touching it
    pub callers: Vec<Reference>,
}

impl SymbolIndex {
    /// Replace a file's symbols, references, and chunks atomically. Chunks are
    /// pre-embedded by the caller (which owns the Embedder).
    pub fn replace_file(&mut self, path: &str, parsed: FileSymbols, chunks: Vec<StoredChunk>) {
        set_or_remove(&mut self.symbols, path, parsed.symbols);
        set_or_remove(&mut self.references, path, parsed.references);
        set_or_remove(&mut self.chunks, path, chunks);
    }

    pub fn remove_file(&mut self, path: &str) {
        self.symbols.remove(path);
        self.references.remove(path);
        self.chunks.remove(path);
    }

    pub fn stats(&self) -> Stats {
        let files = self
            .symbols
            .keys()
            .chain(self.references.keys())
            .chain(self.chunks.keys())
            .collect::<HashSet<_>>()
            .len();
        Stats {
            files,
            symbols: self.symbols.values().map(Vec::len).sum(),
            references: self.references.values().map(Vec::len).sum(),
            chunks: self.chunks.values().map(Vec::len).sum(),
        }
    }

    /// Hybrid retrieval: fuse a semantic ranking (cosine over chunk embeddings)
    /// and a lexical ranking (query-token overlap) with Reciprocal Rank Fusion
    /// (blueprint doc 06 §6). `query_vec` is the query embedding; `query_text`
    /// is tokenized for the lexical signal.
    pub fn retrieve(&self, query_vec: &[f32], query_text: &str, limit: usize) -> Vec<Retrieved> {
        const RRF_K: f64 = 60.0;
        const PER_SIGNAL: usize = 50;

        let all: Vec<&StoredChunk> = self.chunks.values().flatten().collect();
        if all.is_empty() {
            return Vec::new();
        }

        // Semantic ranking (skip non-positive similarity — e.g. empty query).
        let mut semantic: Vec<(usize, f32)> = all
            .iter()
            .enumerate()
            .map(|(i, c)| (i, cosine(query_vec, &c.embedding)))
            .filter(|(_, s)| *s > 0.0)
            .collect();
        semantic.sort_by(|a, b| b.1.total_cmp(&a.1));

        // Lexical ranking by query-token overlap count.
        let qtokens: HashSet<String> = tokenize(query_text).into_iter().collect();
        let mut lexical: Vec<(usize, usize)> = all
            .iter()
            .enumerate()
            .map(|(i, c)| (i, c.tokens.intersection(&qtokens).count()))
            .filter(|(_, n)| *n > 0)
            .collect();
        lexical.sort_by_key(|&(_, n)| std::cmp::Reverse(n));

        // Fuse.
        let mut fused: HashMap<usize, (f64, Vec<&'static str>)> = HashMap::new();
        for (rank, (i, _)) in semantic.iter().take(PER_SIGNAL).enumerate() {
            let e = fused.entry(*i).or_insert((0.0, Vec::new()));
            e.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
            e.1.push("semantic");
        }
        for (rank, (i, _)) in lexical.iter().take(PER_SIGNAL).enumerate() {
            let e = fused.entry(*i).or_insert((0.0, Vec::new()));
            e.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
            e.1.push("lexical");
        }

        let mut ranked: Vec<Retrieved> = fused
            .into_iter()
            .map(|(i, (score, why))| {
                let c = &all[i].chunk;
                Retrieved {
                    path: c.path.clone(),
                    line: c.line,
                    end_line: c.end_line,
                    symbol: c.symbol.clone(),
                    kind: c.kind,
                    header: c.header.clone(),
                    preview: c.preview.clone(),
                    score,
                    why,
                }
            })
            .collect();
        ranked.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.line.cmp(&b.line))
        });
        ranked.truncate(limit);
        ranked
    }

    /// Callers of `name`, sorted by location, with a blast-radius summary.
    pub fn refs_to(&self, name: &str, limit: usize) -> Refs {
        let mut callers: Vec<Reference> = self
            .references
            .values()
            .flatten()
            .filter(|r| r.callee == name)
            .cloned()
            .collect();
        callers.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        let count = callers.len();
        let files = callers.iter().map(|r| &r.path).collect::<HashSet<_>>().len();
        callers.truncate(limit);
        Refs {
            name: name.to_string(),
            confidence: "heuristic",
            count,
            files,
            callers,
        }
    }

    /// Ranked search: exact > prefix > substring > subsequence, with shorter
    /// names and definition-like kinds breaking ties.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let q = query.to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<Hit> = Vec::new();
        for symbols in self.symbols.values() {
            for sym in symbols {
                if let Some(score) = score(&q, sym) {
                    hits.push(Hit {
                        score,
                        symbol: sym.clone(),
                    });
                }
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.symbol.name.len().cmp(&b.symbol.name.len()))
                .then_with(|| a.symbol.path.cmp(&b.symbol.path))
        });
        hits.truncate(limit);
        hits
    }
}

/// Insert `values` at `path`, or remove the key entirely when empty — so an
/// emptied file leaves no stale entries.
fn set_or_remove<T>(map: &mut HashMap<String, Vec<T>>, path: &str, values: Vec<T>) {
    if values.is_empty() {
        map.remove(path);
    } else {
        map.insert(path.to_string(), values);
    }
}

fn score(q: &str, sym: &Symbol) -> Option<i64> {
    let name = sym.name.to_lowercase();
    let base = if name == *q {
        1000
    } else if name.starts_with(q) {
        500
    } else if name.contains(q) {
        250
    } else if is_subsequence(q, &name) {
        100
    } else {
        return None;
    };
    let kind_boost = match sym.kind {
        "fn" | "class" => 30,
        "method" | "interface" => 20,
        _ => 10,
    };
    // Shorter names are better matches for the same base score.
    Some(base + kind_boost - name.len().min(50) as i64)
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = haystack.chars();
    needle.chars().all(|c| chars.any(|h| h == c))
}

impl std::fmt::Debug for Retrieved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Retrieved({:?} {}:{} why={:?} score={:.4})",
            self.symbol, self.path, self.line, self.why, self.score
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(name: &str, kind: &'static str, path: &str) -> Symbol {
        Symbol {
            name: name.into(),
            kind,
            lang: "ts",
            path: path.into(),
            line: 1,
            end_line: 1,
            container: None,
            preview: String::new(),
        }
    }

    fn reference(callee: &str, path: &str, in_symbol: Option<&str>) -> Reference {
        Reference {
            callee: callee.into(),
            path: path.into(),
            line: 1,
            in_symbol: in_symbol.map(String::from),
            preview: String::new(),
        }
    }

    fn only_symbols(symbols: Vec<Symbol>) -> FileSymbols {
        FileSymbols {
            symbols,
            references: Vec::new(),
        }
    }

    /// replace_file with no chunks — for symbol/reference-only tests.
    fn put(idx: &mut SymbolIndex, path: &str, parsed: FileSymbols) {
        idx.replace_file(path, parsed, Vec::new());
    }

    fn index() -> SymbolIndex {
        let mut idx = SymbolIndex::default();
        put(
            &mut idx,
            "a.ts",
            only_symbols(vec![
                sym("greet", "fn", "a.ts"),
                sym("greetEveryone", "fn", "a.ts"),
                sym("regreet", "fn", "a.ts"),
                sym("GreetingService", "class", "a.ts"),
            ]),
        );
        idx
    }

    #[test]
    fn ranking_prefers_exact_then_prefix_then_substring() {
        let idx = index();
        let hits = idx.search("greet", 10);
        let names: Vec<&str> = hits.iter().map(|h| h.symbol.name.as_str()).collect();
        assert_eq!(names[0], "greet");
        assert_eq!(names[1], "greetEveryone");
        // substring matches follow prefix matches
        assert!(names.contains(&"regreet"));
        assert!(names.contains(&"GreetingService"));
    }

    #[test]
    fn subsequence_matches_camel_abbreviations() {
        let idx = index();
        let hits = idx.search("gsvc", 10);
        assert!(hits.iter().any(|h| h.symbol.name == "GreetingService"));
    }

    #[test]
    fn replace_file_swaps_symbols_atomically() {
        let mut idx = index();
        assert_eq!(idx.stats().symbols, 4);
        put(&mut idx, "a.ts", only_symbols(vec![sym("only", "fn", "a.ts")]));
        assert_eq!(idx.stats().symbols, 1);
        assert!(idx.search("greet", 10).is_empty());
        idx.remove_file("a.ts");
        assert_eq!(idx.stats().files, 0);
    }

    #[test]
    fn refs_aggregate_callers_across_files_with_blast_summary() {
        let mut idx = SymbolIndex::default();
        put(
            &mut idx,
            "a.ts",
            FileSymbols {
                symbols: vec![sym("greet", "fn", "a.ts")],
                references: vec![
                    reference("greet", "a.ts", Some("main")),
                    reference("other", "a.ts", None),
                ],
            },
        );
        put(
            &mut idx,
            "b.ts",
            FileSymbols {
                symbols: vec![],
                references: vec![reference("greet", "b.ts", Some("run"))],
            },
        );

        let refs = idx.refs_to("greet", 10);
        assert_eq!(refs.count, 2, "two call sites");
        assert_eq!(refs.files, 2, "across two files");
        assert_eq!(refs.confidence, "heuristic");
        // sorted by path then line: a.ts before b.ts
        assert_eq!(refs.callers[0].path, "a.ts");
        assert_eq!(refs.callers[1].path, "b.ts");
        assert_eq!(idx.stats().references, 3);

        // Re-indexing a file swaps its references atomically.
        put(&mut idx, "b.ts", FileSymbols::default());
        assert_eq!(idx.refs_to("greet", 10).count, 1);
    }

    #[test]
    fn hybrid_retrieval_finds_a_function_by_its_body_and_marks_provenance() {
        use crate::chunk::chunk_file;
        use crate::embed::{Embedder, HashEmbedder};
        use crate::extract::extract;
        use crate::lang::Lang;

        let embedder = HashEmbedder::default();
        let mut idx = SymbolIndex::default();

        let files = [
            (
                "greet.ts",
                "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n",
            ),
            (
                "sock.ts",
                "export class TcpSocket {\n  connect(port: number) { return port; }\n}\n",
            ),
        ];
        for (path, src) in files {
            let parsed = extract(path, Lang::TypeScript, src);
            let stored: Vec<StoredChunk> = chunk_file(path, "ts", src, &parsed.symbols)
                .into_iter()
                .map(|c| {
                    let v = embedder.embed(&c.text);
                    StoredChunk::new(c, v)
                })
                .collect();
            idx.replace_file(path, parsed, stored);
        }

        // "hello name" appears only in greet's BODY — not in any symbol name.
        let q = "hello name";
        let results = idx.retrieve(&embedder.embed(q), q, 10);
        assert!(!results.is_empty(), "expected hybrid results");
        let top = &results[0];
        assert_eq!(top.symbol.as_deref(), Some("greet"), "results: {results:?}");
        // Both signals should have surfaced greet: its body has the tokens
        // (lexical) and its embedding is closest (semantic).
        assert!(top.why.contains(&"lexical"), "why: {:?}", top.why);
        assert!(top.why.contains(&"semantic"), "why: {:?}", top.why);
        // greet (1) + TcpSocket class + connect method (2) = 3 chunks.
        assert_eq!(idx.stats().chunks, 3);
    }
}
