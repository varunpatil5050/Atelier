//! In-memory symbol index with ranked fuzzy search.
//!
//! v0 storage: per-file symbol lists in a HashMap — replaced wholesale on
//! re-index, so file updates are naturally atomic. The mmap-able graph
//! artifacts of blueprint doc 06 §4 arrive with reference/call edges.

use std::collections::HashMap;

use serde::Serialize;

use crate::extract::Symbol;

#[derive(Default)]
pub struct SymbolIndex {
    files: HashMap<String, Vec<Symbol>>,
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
}

impl SymbolIndex {
    pub fn replace_file(&mut self, path: &str, symbols: Vec<Symbol>) {
        if symbols.is_empty() {
            self.files.remove(path);
        } else {
            self.files.insert(path.to_string(), symbols);
        }
    }

    pub fn remove_file(&mut self, path: &str) {
        self.files.remove(path);
    }

    pub fn stats(&self) -> Stats {
        Stats {
            files: self.files.len(),
            symbols: self.files.values().map(Vec::len).sum(),
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
        for symbols in self.files.values() {
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

    fn index() -> SymbolIndex {
        let mut idx = SymbolIndex::default();
        idx.replace_file(
            "a.ts",
            vec![
                sym("greet", "fn", "a.ts"),
                sym("greetEveryone", "fn", "a.ts"),
                sym("regreet", "fn", "a.ts"),
                sym("GreetingService", "class", "a.ts"),
            ],
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
        idx.replace_file("a.ts", vec![sym("only", "fn", "a.ts")]);
        assert_eq!(idx.stats().symbols, 1);
        assert!(idx.search("greet", 10).is_empty());
        idx.remove_file("a.ts");
        assert_eq!(idx.stats().files, 0);
    }
}
