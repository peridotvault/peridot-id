//! HTTP layer (ANT-845): candid HTTP types, routing, header contract, certification.
//!
//! Certification design (ANT-841 recommended path + ANT-843 static-error trees):
//!
//! * `POST /mcp` is served through **`http_request_update`**. Update calls are
//!   consensus-certified by the protocol: replicas sign the response and the
//!   HTTP gateway verifies it against the state-tree certificate. No custom
//!   tree bookkeeping is needed on this path, and no `ic-http-certification`
//!   tree is built for dynamic JSON-RPC (ANT-841: infeasible for open-ended
//!   params/ids, so it is intentionally absent here).
//! * The `http_request` **query** path never serves content: `POST /mcp`
//!   returns an `upgrade: true` response so the gateway re-issues the request
//!   as an update call (per the HTTP gateway protocol). Deterministic
//!   responses (`405` for `GET /mcp`, `404` elsewhere, `204` CORS preflight
//!   for `OPTIONS /mcp`) ARE tree-certified with response-only certification;
//!   the query handler attaches the v2 `IC-Certificate` header whenever the
//!   gateway supplies a `data_certificate`. Nothing is silently uncertified:
//!   every served byte is either upgrade control flow, tree-certified, or
//!   consensus-certified.
//!
//! Header contract (ANT-841 §4, enforced in [`validate_mcp_headers`]):
//! `Content-Type: application/json` required; `Accept` honored (JSON-only
//! yields the single JSON object this server always returns; a present
//! `Accept` naming no supported representation is 406); `MCP-Protocol-Version`
//! rejected with 400 when unsupported; `Mcp-Session-Id` is statelessly ignored
//! and never emitted.
//!
//! Everything in this module except [`install_certification`] (which writes
//! canister certified data) is pure and host-testable. The data certificate
//! is passed in as an argument so tests can use a fixed fake certificate.

use candid::CandidType;
use ic_http_certification::{
    DefaultCelBuilder, DefaultResponseCertification, DefaultResponseOnlyCelExpression,
    HttpCertification, HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    StatusCode, CERTIFICATE_EXPRESSION_HEADER_NAME,
};
use serde::Deserialize;
use serde_json::{json, Value};

use ic_http_certification::HttpResponse as CertResponse;

/// Candid `record { text; text }`. A tuple struct maps to positional fields
/// `_0_`/`_1_`, matching the HTTP gateway protocol exactly.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HeaderField(pub String, pub String);

/// Candid HTTP request as sent by the HTTP gateway.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub certificate_version: Option<u16>,
}

/// Candid HTTP response returned to the HTTP gateway.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

/// Fixed, deterministic query-path error responses (tree-certified).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedResponse {
    /// `GET /mcp` (POST-only endpoint).
    MethodNotAllowed,
    /// Any path other than `/mcp`.
    NotFound,
}

impl FixedResponse {
    /// Tree path for this response's certification entry: the 405 lives at
    /// the exact `/mcp` path; the 404 (served for every other request path)
    /// lives at the `/` wildcard prefix.
    fn tree_path(&self) -> HttpCertificationPath<'static> {
        match self {
            FixedResponse::MethodNotAllowed => HttpCertificationPath::exact("/mcp"),
            FixedResponse::NotFound => HttpCertificationPath::wildcard("/"),
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            FixedResponse::MethodNotAllowed => 405,
            FixedResponse::NotFound => 404,
        }
    }

    pub fn body(&self) -> Vec<u8> {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": serde_json::Value::Null,
            "error": {"code": -32600, "message": "Invalid Request"}
        })
        .to_string()
        .into_bytes()
    }
}

/// Plain (uncertified) CORS preflight response for `OPTIONS /mcp`.
///
/// Rationale: the cert tree holds one entry per path, and exact `/mcp` is
/// already taken by the 405. A preflight carries no content and browsers do
/// not verify ICP certificates, so it is served plain per the ANT-841
/// allowance for non-content responses.
pub fn cors_preflight() -> HttpResponse {
    HttpResponse {
        status_code: 204,
        headers: vec![
            HeaderField("Access-Control-Allow-Origin".to_string(), "*".to_string()),
            HeaderField(
                "Access-Control-Allow-Methods".to_string(),
                "POST, GET, OPTIONS".to_string(),
            ),
            HeaderField(
                "Access-Control-Allow-Headers".to_string(),
                "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id".to_string(),
            ),
            HeaderField("Access-Control-Max-Age".to_string(), "86400".to_string()),
        ],
        body: Vec::new(),
        upgrade: None,
    }
}

/// Routing decision for an incoming HTTP request (pure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Query `POST /mcp`: tell the gateway to upgrade to an update call.
    Upgrade,
    /// Update `POST /mcp`: run the MCP dispatcher.
    HandleMcp,
    /// `OPTIONS /mcp`: CORS preflight (plain 204, both query and update).
    CorsPreflight,
    /// Non-POST methods on `/mcp` (except OPTIONS), or other paths.
    Fixed(FixedResponse),
}

/// Strip the query string and decide the route. Method match is
/// case-insensitive; anything that is not `POST /mcp` never reaches the
/// dispatcher (POST-only).
pub fn route(method: &str, url: &str, is_update: bool) -> Route {
    let path = url.split('?').next().unwrap_or("");
    if path != "/mcp" {
        return Route::Fixed(FixedResponse::NotFound);
    }
    if method.eq_ignore_ascii_case("options") {
        return Route::CorsPreflight;
    }
    if !method.eq_ignore_ascii_case("post") {
        return Route::Fixed(FixedResponse::MethodNotAllowed);
    }
    if is_update {
        Route::HandleMcp
    } else {
        Route::Upgrade
    }
}

// ---------------------------------------------------------------------------
// Transport header contract (ANT-841 §4). Pure: operates on header pairs.
// ---------------------------------------------------------------------------

/// A transport-header violation and the HTTP status it rides on.
/// The body is always a JSON-RPC error object with `Content-Type:
/// application/json`; `Mcp-Session-Id` is never emitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderRejection {
    pub status: u16,
    pub code: i64,
    pub message: &'static str,
    pub data: Value,
}

fn header_value<'a>(headers: &'a [HeaderField], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h.0.eq_ignore_ascii_case(name))
        .map(|h| h.1.as_str())
}

/// Validate the MCP transport headers for a `POST /mcp` update call.
///
/// * `Content-Type: application/json` is required (400 otherwise).
/// * `Accept`, when present, must name a representation this server speaks
///   (`application/json`, `text/event-stream`, or `*/*`); JSON-only clients
///   get the single JSON object this server always returns (406 otherwise).
/// * `MCP-Protocol-Version`, when present, must be supported (400 otherwise).
/// * `Mcp-Session-Id` is statelessly ignored (never required, never echoed).
pub fn validate_mcp_headers(headers: &[HeaderField]) -> Option<HeaderRejection> {
    let content_type = header_value(headers, "content-type").unwrap_or("");
    if !content_type.to_lowercase().contains("application/json") {
        return Some(HeaderRejection {
            status: 400,
            code: -32600,
            message: "Invalid Request",
            data: json!({"field": "content-type", "reason": "application/json required"}),
        });
    }
    if let Some(accept) = header_value(headers, "accept") {
        let a = accept.to_lowercase();
        if !(a.contains("application/json")
            || a.contains("text/event-stream")
            || a.contains("*/*"))
        {
            return Some(HeaderRejection {
                status: 406,
                code: -32600,
                message: "Invalid Request",
                data: json!({"field": "accept", "reason": "no supported representation"}),
            });
        }
    }
    if let Some(version) = header_value(headers, "mcp-protocol-version") {
        if !crate::protocol::SUPPORTED_VERSIONS.contains(&version) {
            return Some(HeaderRejection {
                status: 400,
                code: -32602,
                message: "Invalid params",
                data: json!({
                    "field": "protocol-version",
                    "supportedVersions": crate::protocol::SUPPORTED_VERSIONS,
                }),
            });
        }
    }
    None
}

/// Render a [`HeaderRejection`] as a JSON-RPC error body (no `id`: the
/// request was rejected before dispatch).
pub fn header_rejection_body(rejection: &HeaderRejection) -> Vec<u8> {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": {
            "code": rejection.code,
            "message": rejection.message,
            "data": rejection.data,
        }
    })
    .to_string()
    .into_bytes()
}

fn response_only_cel() -> DefaultResponseOnlyCelExpression<'static> {
    DefaultCelBuilder::response_only_certification()
        .with_response_certification(
            DefaultResponseCertification::certified_response_headers(vec!["Content-Type"]),
        )
        .build()
}

/// A fixed response plus everything needed to certify it. All owned data,
/// rebuilt deterministically per call from [`certified_fixed`] in a fixed
/// order, so every handler reconstructs the exact tree whose root hash was
/// persisted by [`install_certification`] — no shared mutable state
/// (stateless, ANT-842 FR1).
#[derive(Debug, Clone)]
pub struct CertifiedFixed {
    pub cel: DefaultResponseOnlyCelExpression<'static>,
    pub response: CertResponse<'static>,
    pub path: HttpCertificationPath<'static>,
    pub expr_path: Vec<String>,
}

/// Build the certified fixed response for `kind`.
pub fn certified_fixed(kind: FixedResponse) -> CertifiedFixed {
    let cel = response_only_cel();
    let expr = cel.to_string();
    let response = CertResponse::builder()
        .with_status_code(StatusCode::from_u16(kind.status()).expect("fixed status valid"))
        .with_headers(vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            (
                CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(),
                expr.clone(),
            ),
        ])
        .with_body(kind.body())
        .build();
    // Validates the expression header is present and matching.
    HttpCertification::response_only(&cel, &response, None).expect("fixed response certifies");
    let path = kind.tree_path();
    let expr_path = path.to_expr_path();
    CertifiedFixed {
        cel,
        response,
        path,
        expr_path,
    }
}

/// All fixed certifications in insertion order. The order is part of the
/// tree shape: [`install_certification`] and [`serve_fixed`] must use the
/// same order so witnesses verify against the persisted root hash.
fn all_fixed() -> [CertifiedFixed; 2] {
    [
        certified_fixed(FixedResponse::MethodNotAllowed),
        certified_fixed(FixedResponse::NotFound),
    ]
}

fn tree_with(entries: &[CertifiedFixed]) -> HttpCertificationTree {
    let mut tree = HttpCertificationTree::default();
    for e in entries {
        let certification =
            HttpCertification::response_only(&e.cel, &e.response, None).expect("re-certify");
        tree.insert(&HttpCertificationTreeEntry::new(
            e.path.clone(),
            certification,
        ));
    }
    tree
}

/// Serve a fixed response for `kind`, attaching a v2 `IC-Certificate` header
/// when the gateway supplied a data certificate (`None` on direct
/// `dfx canister call` invocations: the plain response is returned).
/// `request_path` is the actual request path (query string stripped): it must
/// be `/mcp` for the 405 and the real path for wildcard 404s.
pub fn serve_fixed(
    data_certificate: Option<Vec<u8>>,
    kind: FixedResponse,
    request_path: &str,
) -> CertResponse<'static> {
    let entries = all_fixed();
    let found = entries.iter().find(|e| {
        e.response.status_code().as_u16() == kind.status()
    });
    let found = found.expect("fixed entry for kind");
    let mut response = found.response.clone();
    if let Some(cert) = data_certificate {
        let tree = tree_with(&entries);
        let certification =
            HttpCertification::response_only(&found.cel, &found.response, None)
                .expect("re-certify");
        let entry =
            HttpCertificationTreeEntry::new(found.path.clone(), certification);
        if let Ok(witness) = tree.witness(&entry, request_path) {
            ic_http_certification::utils::add_v2_certificate_header(
                &cert,
                &mut response,
                &witness,
                &found.expr_path,
            );
        }
    }
    response
}

/// Compute the certification root hash over the fixed responses, for
/// [`install_certification`]. Same entries, same order as [`serve_fixed`].
pub fn certification_root_hash() -> [u8; 32] {
    tree_with(&all_fixed()).root_hash()
}

/// Canister-only: persist the certification root hash. Must run in `init`
/// and `post_upgrade` (both are update contexts where setting certified
/// data is legal).
#[cfg(target_arch = "wasm32")]
pub fn install_certification() {
    ic_cdk::api::certified_data_set(certification_root_hash());
}

/// Convert a certification-crate response into the candid gateway response.
pub fn to_candid(resp: &CertResponse, upgrade: Option<bool>) -> HttpResponse {
    HttpResponse {
        status_code: resp.status_code().as_u16(),
        headers: resp
            .headers()
            .iter()
            .map(|(n, v)| HeaderField(n.clone(), v.clone()))
            .collect(),
        body: resp.body().to_vec(),
        upgrade,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_mcp_upgrades_on_query_and_handles_on_update() {
        assert_eq!(route("POST", "/mcp", false), Route::Upgrade);
        assert_eq!(route("POST", "/mcp", true), Route::HandleMcp);
        assert_eq!(route("post", "/mcp?x=1", false), Route::Upgrade);
    }

    #[test]
    fn get_mcp_is_405_and_other_paths_404() {
        assert_eq!(
            route("GET", "/mcp", false),
            Route::Fixed(FixedResponse::MethodNotAllowed)
        );
        assert_eq!(
            route("GET", "/mcp", true),
            Route::Fixed(FixedResponse::MethodNotAllowed)
        );
        assert_eq!(
            route("POST", "/other", false),
            Route::Fixed(FixedResponse::NotFound)
        );
        assert_eq!(
            route("DELETE", "/mcp", true),
            Route::Fixed(FixedResponse::MethodNotAllowed)
        );
    }

    #[test]
    fn options_mcp_is_cors_preflight() {
        assert_eq!(route("OPTIONS", "/mcp", false), Route::CorsPreflight);
        assert_eq!(route("OPTIONS", "/mcp", true), Route::CorsPreflight);
        assert_eq!(
            route("OPTIONS", "/other", false),
            Route::Fixed(FixedResponse::NotFound)
        );
        let preflight = cors_preflight();
        assert_eq!(preflight.status_code, 204);
        assert!(preflight.body.is_empty());
        assert!(
            preflight
                .headers
                .iter()
                .any(|h| h.0 == "Access-Control-Allow-Origin" && h.1 == "*"),
            "preflight must allow any origin, got: {:?}",
            preflight.headers
        );
    }

    #[test]
    fn header_contract_accepts_happy_path() {
        let headers = vec![
            HeaderField("Content-Type".to_string(), "application/json".to_string()),
            HeaderField(
                "Accept".to_string(),
                "application/json, text/event-stream".to_string(),
            ),
        ];
        assert_eq!(validate_mcp_headers(&headers), None);
        // Header names are case-insensitive; charset suffix is fine.
        let headers = vec![HeaderField(
            "content-type".to_string(),
            "Application/JSON; charset=utf-8".to_string(),
        )];
        assert_eq!(validate_mcp_headers(&headers), None);
    }

    #[test]
    fn header_contract_rejects_bad_content_type() {
        assert_eq!(
            validate_mcp_headers(&[]).map(|r| r.status),
            Some(400)
        );
        let headers = vec![HeaderField("Content-Type".to_string(), "text/plain".to_string())];
        let rejection = validate_mcp_headers(&headers).expect("must reject");
        assert_eq!((rejection.status, rejection.code), (400, -32600));
    }

    #[test]
    fn header_contract_rejects_unsupported_accept_and_version() {
        let headers = vec![
            HeaderField("Content-Type".to_string(), "application/json".to_string()),
            HeaderField("Accept".to_string(), "image/png".to_string()),
        ];
        assert_eq!(
            validate_mcp_headers(&headers).map(|r| r.status),
            Some(406)
        );
        let headers = vec![
            HeaderField("Content-Type".to_string(), "application/json".to_string()),
            HeaderField("MCP-Protocol-Version".to_string(), "1999-01-01".to_string()),
        ];
        let rejection = validate_mcp_headers(&headers).expect("must reject");
        assert_eq!((rejection.status, rejection.code), (400, -32602));
        // A supported version passes; session ids are ignored, never echoed.
        let headers = vec![
            HeaderField("Content-Type".to_string(), "application/json".to_string()),
            HeaderField("MCP-Protocol-Version".to_string(), "2025-11-25".to_string()),
            HeaderField("Mcp-Session-Id".to_string(), "whatever".to_string()),
        ];
        assert_eq!(validate_mcp_headers(&headers), None);
    }

    #[test]
    fn fixed_responses_carry_expression_header() {
        for kind in [FixedResponse::MethodNotAllowed, FixedResponse::NotFound] {
            let c = certified_fixed(kind);
            let has_expr = c.response.headers().iter().any(|(n, _)| {
                n.eq_ignore_ascii_case(CERTIFICATE_EXPRESSION_HEADER_NAME)
            });
            assert!(has_expr, "missing IC-CertificateExpression for {kind:?}");
        }
    }

    #[test]
    fn certificate_header_attached_with_data_certificate() {
        let with_cert = serve_fixed(
            Some(vec![1, 2, 3]),
            FixedResponse::MethodNotAllowed,
            "/mcp",
        );
        assert!(
            with_cert.headers().iter().any(|(n, _)| n == "IC-Certificate"),
            "v2 IC-Certificate header must be present, got: {:?}",
            with_cert.headers()
        );
        let without_cert = serve_fixed(None, FixedResponse::MethodNotAllowed, "/mcp");
        assert!(
            without_cert
                .headers()
                .iter()
                .all(|(n, _)| n != "IC-Certificate"),
            "no IC-Certificate header without a data certificate"
        );
    }

    #[test]
    fn wildcard_404_covers_arbitrary_paths() {
        // The 404 entry must witness successfully for a non-/mcp path.
        let with_cert = serve_fixed(Some(vec![7, 8, 9]), FixedResponse::NotFound, "/other/path");
        assert!(
            with_cert.headers().iter().any(|(n, _)| n == "IC-Certificate"),
            "wildcard 404 must carry a v2 certificate header, got: {:?}",
            with_cert.headers()
        );
        assert_eq!(with_cert.status_code().as_u16(), 404);
    }

    #[test]
    fn fixed_responses_are_deterministic() {
        let a = certified_fixed(FixedResponse::MethodNotAllowed);
        let b = certified_fixed(FixedResponse::MethodNotAllowed);
        assert_eq!(a.response.body(), b.response.body());
        assert_eq!(a.response.status_code(), b.response.status_code());
    }

    #[test]
    fn certification_root_hash_is_stable() {
        assert_eq!(certification_root_hash(), certification_root_hash());
    }
}
