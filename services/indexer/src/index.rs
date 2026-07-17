//! In-memory symbol + reference index with ranked fuzzy search and a
//! name-based call graph.
//!
//! v0 storage: per-file symbol/reference lists in HashMaps — replaced wholesale
//! on re-index, so file updates are naturally atomic. The mmap-able CSR graph
//! artifacts of blueprint doc 06 §4 arrive when resolution graduates from
//! name-based (heuristic) to scope-aware.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::extract::{FileSymbols, Reference, Symbol};

#[derive(Default)]
pub struct SymbolIndex {
    symbols: HashMap<String, Vec<Symbol>>,
    references: HashMap<String, Vec<Reference>>,
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
    pub fn replace_file(&mut self, path: &str, parsed: FileSymbols) {
        if parsed.symbols.is_empty() {
            self.symbols.remove(path);
        } else {
            self.symbols.insert(path.to_string(), parsed.symbols);
        }
        if parsed.references.is_empty() {
            self.references.remove(path);
        } else {
            self.references.insert(path.to_string(), parsed.references);
        }
    }

    pub fn remove_file(&mut self, path: &str) {
        self.symbols.remove(path);
        self.references.remove(path);
    }

    pub fn stats(&self) -> Stats {
        Stats {
            files: self.symbols.keys().chain(self.references.keys()).collect::<HashSet<_>>().len(),
            symbols: self.symbols.values().map(Vec::len).sum(),
            references: self.references.values().map(Vec::len).sum(),
        }
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

    fn index() -> SymbolIndex {
        let mut idx = SymbolIndex::default();
        idx.replace_file(
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
        idx.replace_file("a.ts", only_symbols(vec![sym("only", "fn", "a.ts")]));
        assert_eq!(idx.stats().symbols, 1);
        assert!(idx.search("greet", 10).is_empty());
        idx.remove_file("a.ts");
        assert_eq!(idx.stats().files, 0);
    }

    #[test]
    fn refs_aggregate_callers_across_files_with_blast_summary() {
        let mut idx = SymbolIndex::default();
        idx.replace_file(
            "a.ts",
            FileSymbols {
                symbols: vec![sym("greet", "fn", "a.ts")],
                references: vec![
                    reference("greet", "a.ts", Some("main")),
                    reference("other", "a.ts", None),
                ],
            },
        );
        idx.replace_file(
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
        idx.replace_file("b.ts", FileSymbols::default());
        assert_eq!(idx.refs_to("greet", 10).count, 1);
    }
}
