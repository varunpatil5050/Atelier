//! Embeddings for semantic retrieval (blueprint doc 06 §5).
//!
//! The `Embedder` trait is the seam: `HashEmbedder` is a deterministic,
//! dependency-free local embedder for dev and tests; a `GatewayEmbedder`
//! calling a real code-embedding model behind the model-gateway (doc 02 §3)
//! swaps in later without touching the retrieval engine.
//!
//! `HashEmbedder` uses the hashing trick (feature hashing): tokens are split
//! on camelCase/snake_case boundaries, each hashed into a fixed-width vector
//! with a signed bucket, then the vector is L2-normalized. Cosine similarity
//! then reflects shared-token overlap — enough to demonstrate hybrid
//! retrieval mechanics and to search code by *content*, not just symbol name.

pub trait Embedder: Send + Sync {
    fn dim(&self) -> usize;
    /// Returns an L2-normalized embedding (zero vector for empty input).
    fn embed(&self, text: &str) -> Vec<f32>;
}

pub struct HashEmbedder {
    dim: usize,
}

impl HashEmbedder {
    pub fn new(dim: usize) -> Self {
        assert!(dim > 0);
        Self { dim }
    }
}

impl Default for HashEmbedder {
    fn default() -> Self {
        Self::new(256)
    }
}

impl Embedder for HashEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; self.dim];
        for tok in tokenize(text) {
            let h = fnv1a(tok.as_bytes());
            let idx = (h % self.dim as u64) as usize;
            // Second, independent hash bit picks the sign — halves collisions.
            let sign = if (h >> 32) & 1 == 0 { 1.0 } else { -1.0 };
            v[idx] += sign;
        }
        normalize(&mut v);
        v
    }
}

/// Split identifiers into lowercased tokens on non-alphanumeric boundaries and
/// camelCase transitions, including acronym boundaries:
/// `parseHTTPRequest_v2` → parse, http, request, v2.
pub fn tokenize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    for i in 0..chars.len() {
        let ch = chars[i];
        if !ch.is_alphanumeric() {
            flush(&mut cur, &mut tokens);
            continue;
        }
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied();
        let boundary = if ch.is_uppercase() {
            // lower/digit → Upper (camelCase), or Upper → Upper → lower
            // (end of an ACRONYM before a new word, e.g. HTTP|Request).
            matches!(prev, Some(p) if p.is_lowercase() || p.is_numeric())
                || matches!((prev, next), (Some(p), Some(n)) if p.is_uppercase() && n.is_lowercase())
        } else {
            false
        };
        if boundary && !cur.is_empty() {
            flush(&mut cur, &mut tokens);
        }
        cur.push(ch.to_ascii_lowercase());
    }
    flush(&mut cur, &mut tokens);
    tokens
}

fn flush(cur: &mut String, out: &mut Vec<String>) {
    if cur.len() >= 2 {
        out.push(std::mem::take(cur));
    } else {
        cur.clear();
    }
}

/// Cosine similarity. With normalized inputs this is a dot product; we
/// normalize defensively so callers can pass raw vectors too.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_splits_camel_and_snake() {
        assert_eq!(tokenize("parseHTTPRequest_v2"), vec!["parse", "http", "request", "v2"]);
        assert_eq!(tokenize("greet(name)"), vec!["greet", "name"]);
    }

    #[test]
    fn embedding_is_deterministic_and_normalized() {
        let e = HashEmbedder::default();
        let a = e.embed("return `Hello, ${name}!`");
        let b = e.embed("return `Hello, ${name}!`");
        assert_eq!(a, b);
        let norm: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "norm was {norm}");
    }

    #[test]
    fn empty_input_is_zero_vector() {
        let e = HashEmbedder::default();
        assert!(e.embed("").iter().all(|&x| x == 0.0));
    }

    #[test]
    fn similar_text_scores_higher_than_unrelated() {
        let e = HashEmbedder::default();
        let q = e.embed("hello name greeting");
        let related = e.embed("function greet(name) { return `Hello, ${name}` }");
        let unrelated = e.embed("class TcpSocket { connect(port) {} }");
        let s_rel = cosine(&q, &related);
        let s_unrel = cosine(&q, &unrelated);
        assert!(s_rel > s_unrel, "related {s_rel} should beat unrelated {s_unrel}");
        assert!(s_rel > 0.0);
    }
}
