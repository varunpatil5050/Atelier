//! Language registry: file extension → tree-sitter grammar + label.

use tree_sitter::Language;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
}

impl Lang {
    pub fn from_path(path: &str) -> Option<Lang> {
        let ext = path.rsplit('.').next()?;
        match ext {
            "ts" | "mts" | "cts" => Some(Lang::TypeScript),
            "tsx" => Some(Lang::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Lang::JavaScript),
            "py" => Some(Lang::Python),
            "go" => Some(Lang::Go),
            _ => None,
        }
    }

    pub fn grammar(self) -> Language {
        match self {
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Lang::TypeScript | Lang::Tsx => "ts",
            Lang::JavaScript => "js",
            Lang::Python => "py",
            Lang::Go => "go",
        }
    }
}
