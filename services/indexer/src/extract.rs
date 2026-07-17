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

/// A call site: `callee` is invoked at (path, line) from within `in_symbol`.
/// This is the edge of a name-based call graph (blueprint doc 06 §3) — the
/// resolution is heuristic (callee matched by name), so consumers treat it as
/// a hint, not proof, exactly as doc 06 prescribes.
#[derive(Clone, Debug, Serialize)]
pub struct Reference {
    pub callee: String,
    pub path: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_symbol: Option<String>, // enclosing function/method, if any
    pub preview: String,
}

#[derive(Default)]
pub struct FileSymbols {
    pub symbols: Vec<Symbol>,
    pub references: Vec<Reference>,
}

/// Parse source and extract symbols + call references in one tree walk.
/// Returns empty on parse failure — tree-sitter is error-tolerant, so true
/// failures are rare (encoding, OOM).
pub fn extract(path: &str, lang: Lang, source: &str) -> FileSymbols {
    let mut parser = Parser::new();
    if parser.set_language(&lang.grammar()).is_err() {
        return FileSymbols::default();
    }
    let Some(tree) = parser.parse(source, None) else {
        return FileSymbols::default();
    };

    let mut scope = Scope {
        containers: Vec::new(),
        functions: Vec::new(),
    };
    let mut out = FileSymbols::default();
    walk(tree.root_node(), source, path, lang, &mut scope, &mut out);
    out
}

/// Lexical scope stacks maintained during the walk.
struct Scope {
    containers: Vec<String>, // enclosing class/interface/enum → Symbol.container
    functions: Vec<String>,  // enclosing fn/method → Reference.in_symbol
}

fn walk(node: Node, src: &str, path: &str, lang: Lang, scope: &mut Scope, out: &mut FileSymbols) {
    let mut pushed_container = false;
    let mut pushed_function = false;

    if let Some((kind, name)) = classify(node, src, lang) {
        out.symbols.push(Symbol {
            name: name.clone(),
            kind,
            lang: lang.label(),
            path: path.to_string(),
            line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
            container: scope.containers.last().cloned(),
            preview: first_line(node, src),
        });
        match kind {
            "class" | "interface" | "enum" => {
                scope.containers.push(name);
                pushed_container = true;
            }
            "fn" | "method" => {
                scope.functions.push(name);
                pushed_function = true;
            }
            _ => {}
        }
    } else if let Some(callee) = call_callee(node, src, lang) {
        out.references.push(Reference {
            callee,
            path: path.to_string(),
            line: node.start_position().row + 1,
            in_symbol: scope.functions.last().cloned(),
            preview: first_line(node, src),
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, path, lang, scope, out);
    }

    if pushed_container {
        scope.containers.pop();
    }
    if pushed_function {
        scope.functions.pop();
    }
}

/// If `node` is a call expression, return the callee's simple name
/// (last segment of a member/selector/attribute access).
fn call_callee(node: Node, src: &str, lang: Lang) -> Option<String> {
    let callee = match lang {
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            if node.kind() != "call_expression" {
                return None;
            }
            node.child_by_field_name("function")?
        }
        Lang::Python => {
            if node.kind() != "call" {
                return None;
            }
            node.child_by_field_name("function")?
        }
        Lang::Go => {
            if node.kind() != "call_expression" {
                return None;
            }
            node.child_by_field_name("function")?
        }
    };
    simple_callee_name(callee, src)
}

/// Reduce a callee node to a bare name: `foo` → foo, `obj.foo`/`pkg.Foo` → foo.
fn simple_callee_name(node: Node, src: &str) -> Option<String> {
    match node.kind() {
        "identifier" | "type_identifier" => Some(src.get(node.byte_range())?.to_string()),
        // TS/JS member, Python attribute, Go selector: take the property/field.
        "member_expression" => {
            let p = node.child_by_field_name("property")?;
            Some(src.get(p.byte_range())?.to_string())
        }
        "attribute" => {
            let a = node.child_by_field_name("attribute")?;
            Some(src.get(a.byte_range())?.to_string())
        }
        "selector_expression" => {
            let f = node.child_by_field_name("field")?;
            Some(src.get(f.byte_range())?.to_string())
        }
        _ => None,
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
            .symbols
            .into_iter()
            .map(|s| (s.name, s.kind))
            .collect()
    }

    fn callees(path: &str, lang: Lang, src: &str) -> Vec<(String, Option<String>)> {
        extract(path, lang, src)
            .references
            .into_iter()
            .map(|r| (r.callee, r.in_symbol))
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
        let syms = extract("a.ts", Lang::TypeScript, src).symbols;
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

    #[test]
    fn typescript_call_references_with_enclosing_fn() {
        let src = "\
function greet(n) { return n; }
function main() {
  greet('a');
  console.log(greet('b'));
}
greet('top');
";
        let got = callees("a.ts", Lang::TypeScript, src);
        // direct call inside main
        assert!(
            got.contains(&("greet".into(), Some("main".into()))),
            "{got:?}"
        );
        // member call reduces to the property name
        assert!(got.iter().any(|(c, _)| c == "log"), "{got:?}");
        // top-level call has no enclosing symbol
        assert!(got.contains(&("greet".into(), None)), "{got:?}");
    }

    #[test]
    fn python_and_go_call_references() {
        let py = "def a():\n    return b()\n\ndef b():\n    obj.method()\n";
        let got = callees("a.py", Lang::Python, py);
        assert!(got.contains(&("b".into(), Some("a".into()))), "{got:?}");
        assert!(got.contains(&("method".into(), Some("b".into()))), "{got:?}");

        let go = "package p\nfunc New() {}\nfunc use() { New(); fmt.Println(1) }\n";
        let got = callees("a.go", Lang::Go, go);
        assert!(got.contains(&("New".into(), Some("use".into()))), "{got:?}");
        // selector call reduces to the field name
        assert!(got.contains(&("Println".into(), Some("use".into()))), "{got:?}");
    }
}
