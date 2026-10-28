//! Read-only MCP tool datasets (ANT-850 Phase 2: Mintlify-sourced index).
//!
//! All four tools serve the committed generated index in
//! [`crate::generated_docs`] (emitted offline by
//! `apps/mcp/scripts/sync-docs` from `apps/docs/`; no network fetch, no
//! HTTPS outcalls — see `docs/sync-notes.md`). Every string is a verbatim
//! span of the Mintlify sources; truncation is marked with `…`.
//!
//! `search_docs` matching is a case-insensitive substring over title+excerpt
//! only (URLs are never matched). Results are ranked by match position (title
//! matches first), ties broken lexicographically by title, so output is
//! deterministic.
//!
//! Pure logic: no `ic-*` dependencies, fully unit-testable on host.

use serde::{Deserialize, Serialize};

pub use crate::generated_docs::{
    CONTENT_HASH, DOCS, EXAMPLE_NAMES, EXAMPLES, GUIDE_TOPICS, GUIDES, SDK_DOCS,
    SDK_MODULES, SOURCE_REV,
};

/// One documentation entry in the generated search corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocEntry {
    pub title: &'static str,
    pub url: &'static str,
    pub excerpt: &'static str,
}

/// One integration guide in the generated index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuideEntry {
    pub topic: &'static str,
    pub title: &'static str,
    pub url: &'static str,
    pub body: &'static str,
}

/// One code example in the generated index (code is verbatim from docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExampleEntry {
    pub name: &'static str,
    pub title: &'static str,
    pub language: &'static str,
    pub code: &'static str,
    pub description: &'static str,
    /// Canonical Mintlify page the fence was taken from (source attribution).
    pub source_url: &'static str,
}

/// One documented SDK symbol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SymbolEntry {
    pub name: &'static str,
    pub kind: &'static str,
    pub signature: &'static str,
    pub doc: &'static str,
}

/// One documented SDK module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SdkModule {
    pub module: &'static str,
    pub version: &'static str,
    pub summary: &'static str,
    pub symbols: &'static [SymbolEntry],
}

/// Maximum number of hits returned per search call.
pub const MAX_RESULTS: usize = 5;

/// A single search hit, as returned inside the `tools/call` text payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocHit {
    pub title: String,
    pub url: String,
    pub excerpt: String,
}

/// Rank `docs` against `query` (already validated non-empty).
///
/// Sort key: title matches before excerpt-only matches, then earliest match
/// position, then title lexicographically. Truncated to [`MAX_RESULTS`].
pub fn rank(query: &str, docs: &[DocEntry]) -> Vec<DocHit> {
    let q = query.to_lowercase();
    let mut scored: Vec<(u8, usize, &DocEntry)> = Vec::new();
    for doc in docs {
        let title_lc = doc.title.to_lowercase();
        let excerpt_lc = doc.excerpt.to_lowercase();
        let title_pos = title_lc.find(q.as_str());
        let excerpt_pos = excerpt_lc.find(q.as_str());
        match (title_pos, excerpt_pos) {
            (Some(tp), _) => scored.push((0, tp, doc)),
            (None, Some(ep)) => scored.push((1, ep, doc)),
            (None, None) => {}
        }
    }
    scored.sort_by(|a, b| (a.0, a.1, a.2.title).cmp(&(b.0, b.1, b.2.title)));
    scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(_, _, doc)| DocHit {
            title: doc.title.to_string(),
            url: doc.url.to_string(),
            excerpt: doc.excerpt.to_string(),
        })
        .collect()
}

/// Search the generated Mintlify corpus.
pub fn search_docs(query: &str) -> Vec<DocHit> {
    rank(query, &DOCS)
}

// ---------------------------------------------------------------------------
// get_integration_guide: topic -> step-by-step guide (baked, read-only).
// ---------------------------------------------------------------------------

/// Stacks the guides are written against. The guides are stack-agnostic;
/// the `stack` argument is accepted, validated, and echoed back.
pub const GUIDE_STACKS: [&str; 4] = ["android", "backend", "ios", "web"];

/// A guide lookup hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuideHit {
    pub topic: String,
    pub title: String,
    pub url: String,
    pub body: String,
}

/// Look up one guide by topic (case-insensitive). `None` = unknown topic
/// (caller renders `isError:true`; this is a tool-level miss, not a
/// protocol error).
pub fn get_integration_guide(topic: &str) -> Option<GuideHit> {
    let t = topic.to_lowercase();
    GUIDES.iter().find(|g| g.topic == t).map(|g| GuideHit {
        topic: g.topic.to_string(),
        title: g.title.to_string(),
        url: g.url.to_string(),
        body: g.body.to_string(),
    })
}

// ---------------------------------------------------------------------------
// get_example: name -> runnable code sample (baked, read-only, verbatim).
// ---------------------------------------------------------------------------

/// A code-example lookup hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExampleHit {
    pub name: String,
    pub title: String,
    pub language: String,
    pub code: String,
    pub description: String,
    pub source_url: String,
}

/// Look up one example by name (case-insensitive). `None` = unknown name.
pub fn get_example(name: &str) -> Option<ExampleHit> {
    let n = name.to_lowercase();
    EXAMPLES.iter().find(|e| e.name == n).map(|e| ExampleHit {
        name: e.name.to_string(),
        title: e.title.to_string(),
        language: e.language.to_string(),
        code: e.code.to_string(),
        description: e.description.to_string(),
        source_url: e.source_url.to_string(),
    })
}

// ---------------------------------------------------------------------------
// get_sdk_reference: module (+ optional symbol) -> API reference.
// ---------------------------------------------------------------------------

/// An SDK reference lookup hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkHit {
    pub module: String,
    pub version: String,
    pub summary: String,
    pub symbols: Vec<SdkSymbol>,
}

/// One symbol inside an [`SdkHit`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkSymbol {
    pub name: String,
    pub kind: String,
    pub signature: String,
    pub doc: String,
}

/// Look up a module, optionally filtered to one symbol (both case-insensitive).
/// `None` = unknown module; `Some((module, vec![]))` with an empty symbol list
/// is never returned — an unknown symbol is also `None` so the caller can
/// render `isError:true` with a precise message.
pub fn get_sdk_reference(module: &str, symbol: Option<&str>) -> Option<SdkHit> {
    let m = module.to_lowercase();
    let found = SDK_DOCS.iter().find(|s| s.module == m)?;
    let symbols: Vec<SdkSymbol> = match symbol {
        None => found.symbols.iter().map(symbol_hit).collect(),
        Some(name) => {
            let n = name.to_lowercase();
            let sym = found.symbols.iter().find(|s| s.name.to_lowercase() == n)?;
            vec![symbol_hit(sym)]
        }
    };
    Some(SdkHit {
        module: found.module.to_string(),
        version: found.version.to_string(),
        summary: found.summary.to_string(),
        symbols,
    })
}

fn symbol_hit(s: &SymbolEntry) -> SdkSymbol {
    SdkSymbol {
        name: s.name.to_string(),
        kind: s.kind.to_string(),
        signature: s.signature.to_string(),
        doc: s.doc.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- corpus shape (generated index) ------------------------------------

    #[test]
    fn corpus_is_source_backed_and_sized() {
        // 13 Mintlify pages x sections + OpenAPI operations; the exact
        // count is owned by sync-docs (see generated_docs.meta.json).
        assert!(DOCS.len() >= 100, "corpus too small: {}", DOCS.len());
        assert_eq!(DOCS.len(), 175);
        for doc in &DOCS {
            assert!(
                doc.url.starts_with("https://docs.peridot.id/"),
                "doc URL must live under docs.peridot.id: {}",
                doc.url
            );
            assert!(!doc.title.is_empty());
            assert!(!doc.excerpt.is_empty());
        }
    }

    #[test]
    fn guides_cover_nav_slugs_plus_frozen_aliases() {
        // 13 nav pages (12 guides + api/overview) + payments/wallet aliases
        // that keep the Phase 1 topics resolving with real content.
        assert_eq!(GUIDES.len(), 15);
        assert_eq!(GUIDE_TOPICS.len(), GUIDES.len());
        for topic in GUIDE_TOPICS {
            let hit = get_integration_guide(topic).expect("listed topic must resolve");
            assert_eq!(hit.topic, topic);
            assert!(hit.url.starts_with("https://docs.peridot.id/"));
            assert!(!hit.body.is_empty());
        }
        // Frozen Phase 1 topics keep working (aliases -> real Mintlify docs).
        for frozen in ["authentication", "payments", "wallet"] {
            assert!(
                get_integration_guide(frozen).is_some(),
                "frozen topic must resolve: {frozen}"
            );
        }
        assert!(get_integration_guide("zzz-no-such-topic").is_none());
    }

    #[test]
    fn guide_aliases_point_at_canonical_docs() {
        let payments = get_integration_guide("payments").unwrap();
        let fiat = get_integration_guide("fiat").unwrap();
        assert_eq!(payments.body, fiat.body);
        assert_eq!(payments.url, fiat.url);
        let wallet = get_integration_guide("wallet").unwrap();
        let embed = get_integration_guide("embed-wallet").unwrap();
        assert_eq!(wallet.body, embed.body);
        assert_eq!(wallet.url, embed.url);
    }

    // -- frozen ranking behavior (algorithm unchanged from Phase 1) ---------

    #[test]
    fn title_match_beats_excerpt_match() {
        let hits = search_docs("passkey");
        assert!(!hits.is_empty());
        // A title hit must outrank pure excerpt hits.
        let first_title_hit = hits.iter().position(|h| {
            h.title.to_lowercase().contains("passkey")
        });
        let first_excerpt_only = hits.iter().position(|h| {
            !h.title.to_lowercase().contains("passkey")
                && h.excerpt.to_lowercase().contains("passkey")
        });
        if let (Some(t), Some(e)) = (first_title_hit, first_excerpt_only) {
            assert!(t < e, "title hits must rank before excerpt-only hits");
        }
    }

    #[test]
    fn urls_are_never_matched() {
        // Every URL contains "docs.peridot.id", but matching covers
        // title+excerpt only, so this must return zero hits.
        assert!(search_docs("docs.peridot.id").is_empty());
    }

    #[test]
    fn no_match_returns_empty() {
        assert!(search_docs("zzz-no-such-doc-zzz").is_empty());
    }

    #[test]
    fn matching_is_case_insensitive() {
        let lower = search_docs("wallet");
        let upper = search_docs("WALLET");
        let mixed = search_docs("WaLlEt");
        assert_eq!(lower, upper);
        assert_eq!(lower, mixed);
    }

    #[test]
    fn tiebreak_is_lexicographic_by_title() {
        let docs = [
            DocEntry {
                title: "Zebra Doc",
                url: "https://docs.peridot.id/z",
                excerpt: "shared keyword here",
            },
            DocEntry {
                title: "Apple Doc",
                url: "https://docs.peridot.id/a",
                excerpt: "shared keyword here",
            },
        ];
        let hits = rank("shared", &docs);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Apple Doc");
        assert_eq!(hits[1].title, "Zebra Doc");
    }

    #[test]
    fn earlier_position_ranks_first() {
        let docs = [
            DocEntry {
                title: "Late Doc",
                url: "https://docs.peridot.id/l",
                excerpt: "nothing much then keyword at the end",
            },
            DocEntry {
                title: "Early Doc",
                url: "https://docs.peridot.id/e",
                excerpt: "keyword right at the start here",
            },
        ];
        let hits = rank("keyword", &docs);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Early Doc");
    }

    #[test]
    fn results_capped_at_five() {
        let docs: Vec<DocEntry> = (0..10)
            .map(|_| DocEntry {
                title: "T",
                url: "https://docs.peridot.id/t",
                excerpt: "keyword keyword keyword",
            })
            .collect();
        // Same title/excerpt repeated: still capped at MAX_RESULTS.
        let hits = rank("keyword", &docs);
        assert_eq!(hits.len(), MAX_RESULTS);
    }

    // -- AC-4: spec probes hit the generated corpus --------------------------

    #[test]
    fn spec_probes_all_hit() {
        for probe in [
            "passkey",
            "faucet",
            "DOKU",
            "webhook",
            "sandbox",
            "refresh token",
            "PID handle",
            "leveling",
            "session cookies",
            "openapi",
        ] {
            let hits = search_docs(probe);
            assert!(!hits.is_empty(), "probe has zero hits: {probe}");
            for hit in &hits {
                assert!(hit.url.starts_with("https://docs.peridot.id/"));
            }
        }
    }

    // -- AC-2: per-hit budgets ------------------------------------------------

    #[test]
    fn per_hit_budgets_hold() {
        for doc in DOCS {
            assert!(
                doc.excerpt.chars().count() <= 500,
                "excerpt over budget: {}",
                doc.title
            );
        }
        for guide in GUIDES {
            assert!(
                guide.body.len() <= 8 * 1024,
                "guide body over budget: {}",
                guide.topic
            );
        }
        for example in EXAMPLES {
            assert!(
                example.code.len() <= 8 * 1024,
                "example code over budget: {}",
                example.name
            );
        }
        for module in SDK_DOCS {
            assert!(
                module.symbols.len() <= 32,
                "too many symbols: {}",
                module.module
            );
        }
    }

    // -- AC-5: no Phase 1 placeholder strings ---------------------------------

    #[test]
    fn no_phase1_stub_strings() {
        let mut blob = String::new();
        for doc in DOCS {
            blob.push_str(doc.title);
            blob.push_str(doc.excerpt);
        }
        for guide in GUIDES {
            blob.push_str(guide.title);
            blob.push_str(guide.body);
        }
        for example in EXAMPLES {
            blob.push_str(example.title);
            blob.push_str(example.code);
            blob.push_str(example.description);
        }
        for module in SDK_DOCS {
            blob.push_str(module.summary);
            for sym in module.symbols {
                blob.push_str(sym.signature);
                blob.push_str(sym.doc);
            }
        }
        // Assembled via concat! so the literal stub text appears nowhere
        // in the repo (keeps the AC-5 grep empty) while still asserting
        // the property.
        for stub in [
            concat!(
                "Accept fiat and crypto payments ",
                "with automatic settlement"
            ),
            concat!(
                "Sign users in with passkeys and hosted login ",
                "in minutes"
            ),
            concat!(
                "Create wallets, read balances, and send transactions ",
                "across EVM and Solana chains."
            ),
        ] {
            assert!(!blob.contains(stub), "stub string leaked: {stub}");
        }
    }

    // -- verbatim excerpts (grounded in apps/docs sources) --------------------

    fn docs_sources() -> String {
        // Host-side test: sources are read from the repo tree at test time.
        let files = [
            "apps.mdx",
            "authentication.mdx",
            "embed-wallet.mdx",
            "environments.mdx",
            "errors.mdx",
            "fiat.mdx",
            "getting-started.mdx",
            "index.mdx",
            "leveling.mdx",
            "sdk.mdx",
            "self-hosting.mdx",
            "sign-in-with-peridot-id.mdx",
        ];
        let mut blob = String::new();
        for file in files {
            let path = format!("{}/../docs/{file}", env!("CARGO_MANIFEST_DIR"));
            blob.push_str(&std::fs::read_to_string(&path).unwrap_or_default());
            blob.push('\n');
        }
        let overview = format!("{}/../docs/api/overview.mdx", env!("CARGO_MANIFEST_DIR"));
        blob.push_str(&std::fs::read_to_string(&overview).unwrap_or_default());
        let openapi = format!("{}/../docs/openapi.yaml", env!("CARGO_MANIFEST_DIR"));
        blob.push_str(&std::fs::read_to_string(&openapi).unwrap_or_default());
        blob.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn excerpts_are_verbatim_spans() {
        let sources = docs_sources();
        assert!(sources.len() > 50_000, "sources failed to load");
        // Spot-check: 5 excerpts must occur verbatim (whitespace-normalized).
        let mut checked = 0;
        for doc in DOCS.iter().take(40) {
            let excerpt = doc.excerpt.trim_end_matches('…');
            let norm: String = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
            if excerpt.len() > 60 {
                assert!(
                    sources.contains(&norm),
                    "excerpt not verbatim: {}",
                    doc.title
                );
                checked += 1;
                if checked >= 5 {
                    break;
                }
            }
        }
        assert!(checked >= 5);
    }

    #[test]
    fn example_code_is_verbatim() {
        let sources = docs_sources();
        for example in EXAMPLES {
            let code = example.code.trim_end_matches('…');
            let norm: String = code.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(
                sources.contains(&norm),
                "example code not verbatim: {}",
                example.name
            );
        }
    }

    // -- guides / examples / sdk lookups -------------------------------------

    #[test]
    fn guide_lookup_is_case_insensitive() {
        assert_eq!(
            get_integration_guide("WALLET"),
            get_integration_guide("wallet")
        );
    }

    #[test]
    fn guide_stacks_are_validated() {
        assert!(GUIDE_STACKS.contains(&"web"));
        assert!(!GUIDE_STACKS.contains(&"cobol"));
    }

    #[test]
    fn example_names_cover_listed_set() {
        assert_eq!(EXAMPLE_NAMES.len(), EXAMPLES.len());
        for name in EXAMPLE_NAMES {
            let hit = get_example(name).expect("listed example must resolve");
            assert_eq!(hit.name, name);
            assert!(!hit.code.is_empty());
        }
        // Frozen Phase 1 names keep resolving with real (verbatim) content.
        for frozen in ["create-wallet", "passkey-login", "send-transaction"] {
            assert!(
                get_example(frozen).is_some(),
                "frozen example must resolve: {frozen}"
            );
        }
        assert!(get_example("zzz-no-such-example").is_none());
    }

    #[test]
    fn sdk_modules_cover_listed_set() {
        assert_eq!(SDK_MODULES.len(), SDK_DOCS.len());
        for module in SDK_MODULES {
            let hit = get_sdk_reference(module, None).expect("listed module must resolve");
            assert_eq!(hit.module, module);
            assert!(!hit.symbols.is_empty());
        }
        assert!(get_sdk_reference("zzz-no-such-module", None).is_none());
    }

    #[test]
    fn sdk_symbol_filtering() {
        let hit =
            get_sdk_reference("@peridotvault/pid-sdk-js", Some("auth.login"))
                .expect("symbol exists");
        assert_eq!(hit.symbols.len(), 1);
        assert_eq!(hit.symbols[0].name, "auth.login");
        assert!(
            get_sdk_reference("@peridotvault/pid-sdk-js", Some("zzz-no-such-symbol")).is_none()
        );
    }

    #[test]
    fn sdk_revision_is_pinned() {
        assert!(!SOURCE_REV.is_empty());
        assert_eq!(CONTENT_HASH.len(), 64);
    }
}
