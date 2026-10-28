//! Read-only MCP tool datasets (ANT-845: 4-tool surface).
//!
//! Phase 1 serves hardcoded datasets baked into the canister at build time
//! (title + `https://docs.peridot.id/` URL + short body). No network fetch,
//! no HTTPS outcalls, no index pipeline — see `docs/sync-notes.md` for the
//! future sync-job contract (explicit small `max_response_bytes`, v2 pricing).
//!
//! `search_docs` matching is a case-insensitive substring over title+excerpt
//! only (URLs are never matched). Results are ranked by match position (title
//! matches first), ties broken lexicographically by title, so output is
//! deterministic.
//!
//! Pure logic: no `ic-*` dependencies, fully unit-testable on host.

use serde::{Deserialize, Serialize};

/// Maximum number of hits returned per search call.
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

/// Search the stub corpus.
pub fn search_docs(query: &str) -> Vec<DocHit> {
    rank(query, &DOCS)
}

// ---------------------------------------------------------------------------
// get_integration_guide: topic -> step-by-step guide (baked, read-only).
// ---------------------------------------------------------------------------

/// One hardcoded integration guide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuideEntry {
    pub topic: &'static str,
    pub title: &'static str,
    pub url: &'static str,
    pub body: &'static str,
}

/// Supported guide topics (lowercase, lexicographic order).
pub const GUIDE_TOPICS: [&str; 3] = ["authentication", "payments", "wallet"];

/// Stacks the guides are written against. Phase 1 guides are stack-agnostic;
/// the `stack` argument is accepted, validated, and echoed back.
pub const GUIDE_STACKS: [&str; 4] = ["android", "backend", "ios", "web"];

pub const GUIDES: [GuideEntry; 3] = [
    GuideEntry {
        topic: "authentication",
        title: "PeridotID Authentication Integration",
        url: "https://docs.peridot.id/authentication/quickstart",
        body: "1. Register your app and note the client ID. 2. Start a passkey login via the hosted flow or @peridotvault/pid-sdk-js with PKCE. 3. Exchange the code for short-lived pid_access / pid_refresh cookies. 4. Call your backend with the access cookie; refresh before expiry.",
    },
    GuideEntry {
        topic: "payments",
        title: "PeridotID Payments Integration",
        url: "https://docs.peridot.id/payments/overview",
        body: "1. Create a fiat deposit intent (DOKU Checkout, money-in only). 2. Poll POST /v1/fiat/deposits/:id/sync until corroborated — webhooks cannot reach localhost. 3. The API issues fiat_issue credit on the internal fiat ledger. 4. Settle or escrow via the ledger; issuance runs only inside the API.",
    },
    GuideEntry {
        topic: "wallet",
        title: "PeridotID Wallet Integration",
        url: "https://docs.peridot.id/wallet/integration",
        body: "1. Resolve the user's PID handle (<handle>@pid) to a wallet address. 2. Create wallets and read balances via @peridotvault/pid-sdk-js (direct calls, inline passkey signer). 3. Send transactions across EVM and Solana chains. 4. Never use the popup/hosted flow inside apps/wallet (CI-guarded).",
    },
];

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
// get_example: name -> runnable code sample (baked, read-only).
// ---------------------------------------------------------------------------

/// One hardcoded code example.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExampleEntry {
    pub name: &'static str,
    pub title: &'static str,
    pub language: &'static str,
    pub code: &'static str,
    pub description: &'static str,
}

/// Supported example names (lowercase, lexicographic order).
pub const EXAMPLE_NAMES: [&str; 3] =
    ["create-wallet", "passkey-login", "send-transaction"];

pub const EXAMPLES: [ExampleEntry; 3] = [
    ExampleEntry {
        name: "create-wallet",
        title: "Create a PeridotID wallet",
        language: "typescript",
        code: "import { createWallet } from '@peridotvault/pid-sdk-js';\n\nconst wallet = await createWallet({ handle: 'ifal@pid', signer });\nconsole.log(wallet.address);",
        description: "Creates the 1:1 personal wallet for a PID identity.",
    },
    ExampleEntry {
        name: "passkey-login",
        title: "Passkey login with PKCE",
        language: "typescript",
        code: "import { startLogin } from '@peridotvault/pid-sdk-js';\n\nconst { url, verifier } = await startLogin({ clientId: PID_CLIENT_ID });\n// Redirect to url, then exchange the code with `verifier` for tokens.",
        description: "Starts the public-client login flow with PKCE.",
    },
    ExampleEntry {
        name: "send-transaction",
        title: "Send a transaction",
        language: "typescript",
        code: "import { sendTransaction } from '@peridotvault/pid-sdk-js';\n\nconst sig = await sendTransaction({ wallet, to, amount, signer });\nconsole.log(sig);",
        description: "Sends a transfer from the user's smart-account wallet.",
    },
];

/// A code-example lookup hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExampleHit {
    pub name: String,
    pub title: String,
    pub language: String,
    pub code: String,
    pub description: String,
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
    })
}

// ---------------------------------------------------------------------------
// get_sdk_reference: module (+ optional symbol) -> API reference.
// ---------------------------------------------------------------------------

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

/// Supported module names (lexicographic order).
pub const SDK_MODULES: [&str; 3] =
    ["@peridotvault/pid-evm", "@peridotvault/pid-sdk-js", "@peridotvault/pid-solana"];

const SDK_JS_SYMBOLS: [SymbolEntry; 3] = [
    SymbolEntry {
        name: "startLogin",
        kind: "function",
        signature: "startLogin(opts: { clientId: string }): Promise<{ url: string; verifier: string }>",
        doc: "Starts the PKCE login flow; returns the redirect URL and verifier.",
    },
    SymbolEntry {
        name: "createWallet",
        kind: "function",
        signature: "createWallet(opts: { handle: string; signer: Signer }): Promise<Wallet>",
        doc: "Creates the personal wallet for a PID identity.",
    },
    SymbolEntry {
        name: "sendTransaction",
        kind: "function",
        signature: "sendTransaction(opts: { wallet: Wallet; to: string; amount: bigint; signer: Signer }): Promise<string>",
        doc: "Sends a transfer; resolves to the transaction signature.",
    },
];

const SOLANA_SYMBOLS: [SymbolEntry; 2] = [
    SymbolEntry {
        name: "PID_PROGRAM_ID",
        kind: "constant",
        signature: "PID_PROGRAM_ID: 'CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT'",
        doc: "PeridotID smart-account program id (PDA seed [\"peridot_id\", \"account\", sha256(pid)]).",
    },
    SymbolEntry {
        name: "deriveAccount",
        kind: "function",
        signature: "deriveAccount(pid: string): Promise<PublicKey>",
        doc: "Derives the smart-account PDA for a PID handle.",
    },
];

const EVM_SYMBOLS: [SymbolEntry; 2] = [
    SymbolEntry {
        name: "PeridotAccountV4",
        kind: "contract",
        signature: "PeridotAccountV4 (contracts/evm, permission/adversarial-tested)",
        doc: "EVM smart-account contract; see contracts/evm for the permission model.",
    },
    SymbolEntry {
        name: "resolvePid",
        kind: "function",
        signature: "resolvePid(handle: string): Promise<Address>",
        doc: "Resolves a <handle>@pid identity to its EVM wallet address.",
    },
];

pub const SDK_DOCS: [SdkModule; 3] = [
    SdkModule {
        module: "@peridotvault/pid-evm",
        version: "4.x",
        summary: "EVM smart-account contract bindings and PID resolution.",
        symbols: &EVM_SYMBOLS,
    },
    SdkModule {
        module: "@peridotvault/pid-sdk-js",
        version: "1.x",
        summary: "Browser SDK: login, wallets, and transactions (direct calls, inline passkey signer).",
        symbols: &SDK_JS_SYMBOLS,
    },
    SdkModule {
        module: "@peridotvault/pid-solana",
        version: "1.x",
        summary: "Solana adapter: program id, PDA derivation, and chain calls.",
        symbols: &SOLANA_SYMBOLS,
    },
];

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

    #[test]
    fn guide_topics_cover_listed_set() {
        assert_eq!(GUIDE_TOPICS.len(), GUIDES.len());
        for topic in GUIDE_TOPICS {
            let hit = get_integration_guide(topic).expect("listed topic must resolve");
            assert_eq!(hit.topic, topic);
            assert!(hit.url.starts_with("https://docs.peridot.id/"));
        }
        assert!(get_integration_guide("zzz-no-such-topic").is_none());
    }

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
            get_sdk_reference("@peridotvault/pid-sdk-js", Some("startLogin")).expect("symbol exists");
        assert_eq!(hit.symbols.len(), 1);
        assert_eq!(hit.symbols[0].name, "startLogin");
        assert!(
            get_sdk_reference("@peridotvault/pid-sdk-js", Some("zzz-no-such-symbol")).is_none()
        );
    }
}
