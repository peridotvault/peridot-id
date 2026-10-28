//! PeridotID Developer MCP Server, Phase 2 (ANT-850: Mintlify-sourced index).
//!
//! Rust ICP canister exposing four read-only MCP tools (`search_docs`,
//! `get_integration_guide`, `get_example`, `get_sdk_reference`) over
//! Streamable HTTP (MCP 2025-11-25, JSON response mode, stateless) at
//! `POST /mcp`. Tool content comes from the committed generated index in
//! [`generated_docs`] (built offline from `apps/docs/`); every hit carries
//! additive `source: {url, rev}` attribution.
//!
//! * [`http_request`] (query): `POST /mcp` returns `upgrade: true` so the
//!   gateway re-issues the request as an update call; deterministic error
//!   responses (`405`/`404`) are served tree-certified (see [`http`]);
//!   `OPTIONS /mcp` returns a plain CORS preflight.
//! * [`http_request_update`] (update): validates transport headers (see
//!   [`http::validate_mcp_headers`]), then serves `POST /mcp` via the MCP
//!   dispatcher in [`protocol`]. Update responses are consensus-certified by
//!   the protocol. `Mcp-Session-Id` is never emitted.
//!
//! No timers, no HTTPS outcalls, no inter-canister calls, no stable-memory
//! persistence (verified by grep, see README).

pub mod generated_docs;
pub mod http;
pub mod protocol;
pub mod tools;

use http::{route, serve_fixed, to_candid, HeaderField, HttpRequest, HttpResponse, Route};

fn json_headers() -> Vec<HeaderField> {
    vec![HeaderField(
        "Content-Type".to_string(),
        "application/json".to_string(),
    )]
}

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
        Route::CorsPreflight => http::cors_preflight(),
        Route::Fixed(kind) => {
            #[cfg(target_arch = "wasm32")]
            let data_certificate = ic_cdk::api::data_certificate();
            #[cfg(not(target_arch = "wasm32"))]
            let data_certificate: Option<Vec<u8>> = None;
            let request_path = req.url.split('?').next().unwrap_or("");
            let served = serve_fixed(data_certificate, kind, request_path);
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
            // ignored and never echoed (ANT-841).
            if let Some(rejection) = http::validate_mcp_headers(&req.headers) {
                return HttpResponse {
                    status_code: rejection.status,
                    headers: json_headers(),
                    body: http::header_rejection_body(&rejection),
                    upgrade: None,
                };
            }
            let outcome = protocol::handle_post(&req.body);
            HttpResponse {
                status_code: outcome.status,
                headers: json_headers(),
                body: outcome.body,
                upgrade: None,
            }
        }
        Route::CorsPreflight => http::cors_preflight(),
        Route::Fixed(kind) => {
            let body = kind.body();
            HttpResponse {
                status_code: kind.status(),
                headers: json_headers(),
                body,
                upgrade: None,
            }
        }
        // The update path is only reached after the query path upgraded.
        Route::Upgrade => HttpResponse {
            status_code: 400,
            headers: json_headers(),
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
