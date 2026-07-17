//! AST-aware chunking (blueprint doc 06 §5): one chunk per extracted symbol,
//! carrying a context header (path · lang · scope · name) that materially
//! improves retrieval — a query like "validate jwt" can match a function whose
//! body never says "JWT" but whose header names the file/scope.
//!
//! Symbol-less code files get a single capped whole-file fallback chunk so
//! retrieval covers everything, not just declarations.

use crate::extract::Symbol;

const MAX_CHUNK_LINES: usize = 200;
const FILE_FALLBACK_LINES: usize = 200;

#[derive(Clone, Debug)]
pub struct Chunk {
    pub path: String,
    pub line: usize,     // 1-based
    pub end_line: usize, // 1-based inclusive
    pub symbol: Option<String>,
    pub kind: &'static str, // symbol kind, or "file"
    pub header: String,
    /// Header + body — the text that gets embedded and lexically tokenized.
    pub text: String,
    /// First body line, trimmed — for display.
    pub preview: String,
}

/// Build chunks for a file from its extracted symbols and source.
pub fn chunk_file(path: &str, lang: &str, source: &str, symbols: &[Symbol]) -> Vec<Chunk> {
    let lines: Vec<&str> = source.lines().collect();
    let mut chunks = Vec::new();

    for sym in symbols {
        let start = sym.line.saturating_sub(1);
        let end = sym.end_line.min(start + MAX_CHUNK_LINES);
        let body = slice_lines(&lines, start, end);
        let scope = sym.container.as_deref().unwrap_or("");
        let header = format!(
            "{path} · {lang} · {scope}{}{} {}",
            if scope.is_empty() { "" } else { " · " },
            sym.kind,
            sym.name
        );
        let preview = body.lines().next().unwrap_or("").trim().to_string();
        chunks.push(Chunk {
            path: path.to_string(),
            line: sym.line,
            end_line: sym.end_line,
            symbol: Some(sym.name.clone()),
            kind: sym.kind,
            text: format!("{header}\n{body}"),
            header,
            preview: truncate(&preview, 120),
        });
    }

    // Fallback: a symbol-less code file still deserves to be retrievable.
    if chunks.is_empty() && !lines.is_empty() {
        let end = lines.len().min(FILE_FALLBACK_LINES);
        let body = slice_lines(&lines, 0, end);
        let header = format!("{path} · {lang} · file");
        let preview = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        chunks.push(Chunk {
            path: path.to_string(),
            line: 1,
            end_line: end.max(1),
            symbol: None,
            kind: "file",
            text: format!("{header}\n{body}"),
            header,
            preview: truncate(preview, 120),
        });
    }

    chunks
}

fn slice_lines(lines: &[&str], start: usize, end: usize) -> String {
    let end = end.min(lines.len());
    if start >= end {
        return String::new();
    }
    lines[start..end].join("\n")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::extract;
    use crate::lang::Lang;

    #[test]
    fn one_chunk_per_symbol_with_header() {
        let src = "export function greet(name) {\n  return `Hello, ${name}`;\n}\n";
        let syms = extract("app.ts", Lang::TypeScript, src).symbols;
        let chunks = chunk_file("app.ts", "ts", src, &syms);
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert_eq!(c.symbol.as_deref(), Some("greet"));
        assert!(c.header.contains("app.ts") && c.header.contains("greet"));
        // The embedded text includes both the header and the body.
        assert!(c.text.contains("greet") && c.text.contains("Hello"));
    }

    #[test]
    fn method_chunk_header_includes_container_scope() {
        let src = "class Room {\n  broadcast(msg) { return msg; }\n}\n";
        let syms = extract("r.ts", Lang::TypeScript, src).symbols;
        let chunks = chunk_file("r.ts", "ts", src, &syms);
        let m = chunks.iter().find(|c| c.symbol.as_deref() == Some("broadcast")).unwrap();
        assert!(m.header.contains("Room"), "header was {:?}", m.header);
    }

    #[test]
    fn symbol_less_file_gets_a_fallback_chunk() {
        let src = "console.log('just statements');\nconst x = 1 + 2;\n";
        let syms = extract("s.js", Lang::JavaScript, src).symbols;
        assert!(syms.is_empty());
        let chunks = chunk_file("s.js", "js", src, &syms);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].kind, "file");
        assert!(chunks[0].text.contains("statements"));
    }
}
