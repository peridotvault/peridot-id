//! `search_docs` stub tool (ANT-842 FR4).
//!
//! Phase 1 serves exactly 3 hardcoded docs (title + `https://docs.peridot.id/`
//! URL + 1-2 sentence excerpt). No network fetch, no index pipeline.
//!
//! Matching is a case-insensitive substring over title+excerpt only (URLs are
//! never matched). Results are ranked by match position (title matches first),
//! ties broken lexicographically by title, so output is deterministic.
//!
//! Pure logic: no `ic-*` dependencies, fully unit-testable on host.

use serde::{Deserialize, Serialize};

/// Maximum number of hits returned per call (ANT-842 FR4).
pub const MAX_RESULTS: usize = 5;

/// One hardcoded documentation entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocEntry {
    pub title: &'static str,
    pub url: &'static str,
    pub excerpt: &'static str,
}

/// The Phase 1 stub corpus: exactly 3 docs.
pub const DOCS: [DocEntry; 3] = [
    DocEntry {
        title: "PeridotID Authentication Quickstart",
        url: "https://docs.peridot.id/authentication/quickstart",
        excerpt: "Sign users in with passkeys and hosted login in minutes. Public clients use PKCE with short-lived admin-approved sessions.",
    },
    DocEntry {
        title: "Wallet Integration Guide",
        url: "https://docs.peridot.id/wallet/integration",
        excerpt: "Create wallets, read balances, and send transactions across EVM and Solana chains.",
    },
    DocEntry {
        title: "Payments Overview",
        url: "https://docs.peridot.id/payments/overview",
        excerpt: "Accept fiat and crypto payments with automatic settlement and webhook notifications.",
    },
];

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

/// Search the Phase 1 stub corpus.
pub fn search_docs(query: &str) -> Vec<DocHit> {
    rank(query, &DOCS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_has_exactly_three_docs() {
        assert_eq!(DOCS.len(), 3);
        for doc in &DOCS {
            assert!(
                doc.url.starts_with("https://docs.peridot.id/"),
                "doc URL must live under docs.peridot.id: {}",
                doc.url
            );
        }
    }

    #[test]
    fn title_match_beats_excerpt_match() {
        // "guide" matches doc 2's title; nothing else contains it.
        let hits = search_docs("wallet");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Wallet Integration Guide");
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
    fn title_matches_rank_first() {
        // "peridot" hits doc 1's title and other excerpts... doc 2/3
        // excerpts do not contain it, so only doc 1 matches; assert it leads.
        let hits = search_docs("peridot");
        assert!(!hits.is_empty());
        assert_eq!(hits[0].title, "PeridotID Authentication Quickstart");
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
}
