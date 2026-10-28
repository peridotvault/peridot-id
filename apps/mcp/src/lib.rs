//! PeridotID Developer MCP Server, Phase 1 (ANT-842/ANT-843).
//!
//! Minimal Rust ICP canister exposing one MCP tool (`search_docs`) over
//! Streamable HTTP (JSON response mode, stateless) at `POST /mcp`.
//!
//! * [`http_request`] (query): `POST /mcp` returns `upgrade: true` so the
//!   gateway re-issues the request as an update call; deterministic error
//!   responses (`405`/`404`) are served tree-certified (see [`http`]).
//! * [`http_request_update`] (update): serves `POST /mcp` via the MCP
//!   dispatcher in [`protocol`]. Update responses are consensus-certified by
//!   the protocol.
//!
//! No timers, no HTTPS outcalls, no inter-canister calls, no stable-memory
//! persistence in Phase 1 (verified by grep, see README).

pub mod http;
pub mod protocol;
pub mod tools;

use http::{certified_fixed, route, serve_fixed, to_candid, HeaderField, HttpRequest, HttpResponse, Route};

#[ic_cdk::init]
fn init() {
    #[cfg(target_arch = "wasm32")]
    http::install_certification();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    #[cfg(target_arch = "wasm32")]
    http::install_certification();
}

/// HTTP gateway entry point (query). Never serves MCP content directly.
#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    match route(&req.method, &req.url, false) {
        Route::Upgrade => HttpResponse {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        },
        Route::Fixed(kind) => {
            let certified = certified_fixed(kind);
            #[cfg(target_arch = "wasm32")]
            let data_certificate = ic_cdk::api::data_certificate();
            #[cfg(not(target_arch = "wasm32"))]
            let data_certificate: Option<Vec<u8>> = None;
            let served = serve_fixed(data_certificate, &certified, kind.path());
            to_candid(&served, None)
        }
        // The query path never dispatches MCP calls; the gateway upgrades
        // `POST /mcp` to `http_request_update` first.
        Route::HandleMcp => unreachable_canister_query(),
    }
}

/// HTTP gateway entry point (update). Serves `POST /mcp`.
#[ic_cdk::update]
fn http_request_update(req: HttpRequest) -> HttpResponse {
    match route(&req.method, &req.url, true) {
        Route::HandleMcp => {
            // Stateless: any `Mcp-Session-Id` header the client sends is
            // ignored (ANT-842 FR1).
            let outcome = protocol::handle_post(&req.body);
            HttpResponse {
                status_code: outcome.status,
                headers: vec![HeaderField(
                    "Content-Type".to_string(),
                    "application/json".to_string(),
                )],
                body: outcome.body,
                upgrade: None,
            }
        }
        Route::Fixed(kind) => {
            let body = kind.body();
            HttpResponse {
                status_code: kind.status(),
                headers: vec![HeaderField(
                    "Content-Type".to_string(),
                    "application/json".to_string(),
                )],
                body,
                upgrade: None,
            }
        }
        // The update path is only reached after the query path upgraded.
        Route::Upgrade => HttpResponse {
            status_code: 400,
            headers: vec![HeaderField(
                "Content-Type".to_string(),
                "application/json".to_string(),
            )],
            body: br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#.to_vec(),
            upgrade: None,
        },
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn unreachable_canister_query() -> HttpResponse {
    panic!("query path never dispatches MCP calls")
}

#[cfg(target_arch = "wasm32")]
fn unreachable_canister_query() -> HttpResponse {
    ic_cdk::trap("query path never dispatches MCP calls")
}

ic_cdk::export_candid!();

#[cfg(test)]
mod did_consistency_tests {
    use super::__export_service;

    #[test]
    fn committed_did_matches_exported_service() {
        let exported = __export_service();
        let committed = include_str!("peridot_mcp.did");
        assert_eq!(
            exported.trim(),
            committed.trim(),
            "src/peridot_mcp.did drifted from the exported service; \
             regenerate it from __export_service() output"
        );
    }
}
