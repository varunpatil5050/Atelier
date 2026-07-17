//! Symbol extraction: parse a file with tree-sitter and walk the syntax tree
//! matching per-language node kinds (blueprint doc 06 §2).
//!
//! v0 delta (documented in PROGRESS.md): a kind-table walker instead of .scm
//! query packs — same output for defs, less grammar-API surface. Query packs
//! land with reference extraction, where declarative patterns start paying.

use serde::Serialize;
use tree_sitter::{Node, Parser};

use crate::lang::Lang;

#[derive(Clone, Debug, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: &'static str, // fn | method | class | interface | type | enum
    pub lang: &'static str,
    pub path: String,
    pub line: usize,     // 1-based
    pub end_line: usize, // 1-based inclusive
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>, // enclosing class/interface, if any
    pub preview: String, // first line of the definition, trimmed
}

/// Parse source and extract symbols. Returns an empty vec on parse failure —
/// tree-sitter is error-tolerant, so true failures are rare (encoding, OOM).
pub fn extract(path: &str, lang: Lang, source: &str) -> Vec<Symbol> {
    let mut parser = Parser::new();
    if parser.set_language(&lang.grammar()).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut containers: Vec<String> = Vec::new();
    walk(tree.root_node(), source, path, lang, &mut containers, &mut out);
    out
}

fn walk(
    node: Node,
    src: &str,
    path: &str,
    lang: Lang,
    containers: &mut Vec<String>,
    out: &mut Vec<Symbol>,
) {
    let mut pushed_container = false;

    if let Some((kind, name)) = classify(node, src, lang) {
        let is_container = matches!(kind, "class" | "interface" | "enum");
        out.push(Symbol {
            name: name.clone(),
            kind,
            lang: lang.label(),
            path: path.to_string(),
            line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
            container: containers.last().cloned(),
            preview: first_line(node, src),
        });
        if is_container {
            containers.push(name);
            pushed_container = true;
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, path, lang, containers, out);
    }

    if pushed_container {
        containers.pop();
    }
}

/// Map a node to (symbol kind, name) if it declares something we index.
fn classify(node: Node, src: &str, lang: Lang) -> Option<(&'static str, String)> {
    let kind = node.kind();
    match lang {
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => match kind {
            "function_declaration" | "generator_function_declaration" => {
                Some(("fn", name_field(node, src)?))
            }
            "class_declaration" | "abstract_class_declaration" => {
                Some(("class", name_field(node, src)?))
            }
            "method_definition" => {
                let name = name_field(node, src)?;
                // Constructors are noise in symbol search.
                if name == "constructor" {
                    None
                } else {
                    Some(("method", name))
                }
            }
            "interface_declaration" => Some(("interface", name_field(node, src)?)),
            "type_alias_declaration" => Some(("type", name_field(node, src)?)),
            "enum_declaration" => Some(("enum", name_field(node, src)?)),
            // const f = () => {} / const f = function() {}
            "variable_declarator" => {
                let value = node.child_by_field_name("value")?;
                if matches!(value.kind(), "arrow_function" | "function_expression") {
                    Some(("fn", name_field(node, src)?))
                } else {
                    None
                }
            }
            _ => None,
        },
        Lang::Python => match kind {
            "function_definition" => Some(("fn", name_field(node, src)?)),
            "class_definition" => Some(("class", name_field(node, src)?)),
            _ => None,
        },
        Lang::Go => match kind {
            "function_declaration" => Some(("fn", name_field(node, src)?)),
            "method_declaration" => Some(("method", name_field(node, src)?)),
            "type_spec" => Some(("type", name_field(node, src)?)),
            _ => None,
        },
    }
}

fn name_field(node: Node, src: &str) -> Option<String> {
    let name = node.child_by_field_name("name")?;
    Some(src.get(name.byte_range())?.to_string())
}

fn first_line(node: Node, src: &str) -> String {
    let text = src.get(node.byte_range()).unwrap_or("");
    let line = text.lines().next().unwrap_or("").trim();
    let mut s: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(path: &str, lang: Lang, src: &str) -> Vec<(String, &'static str)> {
        extract(path, lang, src)
            .into_iter()
            .map(|s| (s.name, s.kind))
            .collect()
    }

    #[test]
    fn typescript_symbols() {
        let src = r#"
export function greet(name: string): string { return name; }
const shout = (s: string) => s.toUpperCase();
export class Relay {
  connect(): void {}
}
interface FramePayload { data: number[] }
type ConnStatus = "open" | "closed";
enum Channel { Ctrl, Crdt }
const notAFunction = 42;
"#;
        let got = names("a.ts", Lang::TypeScript, src);
        assert!(got.contains(&("greet".into(), "fn")), "{got:?}");
        assert!(got.contains(&("shout".into(), "fn")), "{got:?}");
        assert!(got.contains(&("Relay".into(), "class")), "{got:?}");
        assert!(got.contains(&("connect".into(), "method")), "{got:?}");
        assert!(got.contains(&("FramePayload".into(), "interface")), "{got:?}");
        assert!(got.contains(&("ConnStatus".into(), "type")), "{got:?}");
        assert!(got.contains(&("Channel".into(), "enum")), "{got:?}");
        assert!(!got.iter().any(|(n, _)| n == "notAFunction"), "{got:?}");
    }

    #[test]
    fn method_records_container() {
        let src = "class Room { broadcast() {} }";
        let syms = extract("a.ts", Lang::TypeScript, src);
        let m = syms.iter().find(|s| s.name == "broadcast").unwrap();
        assert_eq!(m.container.as_deref(), Some("Room"));
    }

    #[test]
    fn python_symbols() {
        let src = "def handler(x):\n    return x\n\nclass DocFs:\n    def sync(self):\n        pass\n";
        let got = names("a.py", Lang::Python, src);
        assert!(got.contains(&("handler".into(), "fn")), "{got:?}");
        assert!(got.contains(&("DocFs".into(), "class")), "{got:?}");
        assert!(got.contains(&("sync".into(), "fn")), "{got:?}");
    }

    #[test]
    fn go_symbols() {
        let src = "package p\n\ntype Store struct{}\n\nfunc (s *Store) Load() {}\n\nfunc New() *Store { return nil }\n";
        let got = names("a.go", Lang::Go, src);
        assert!(got.contains(&("Store".into(), "type")), "{got:?}");
        assert!(got.contains(&("Load".into(), "method")), "{got:?}");
        assert!(got.contains(&("New".into(), "fn")), "{got:?}");
    }

    #[test]
    fn broken_source_still_extracts() {
        // tree-sitter is error-tolerant: the valid function survives the
        // syntax error above it.
        let src = "function broken( {\nfunction fine() {}\n";
        let got = names("a.js", Lang::JavaScript, src);
        assert!(got.iter().any(|(n, _)| n == "fine"), "{got:?}");
    }
}
