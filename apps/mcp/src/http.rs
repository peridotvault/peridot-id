//! HTTP layer (ANT-842 FR1, FR7): candid HTTP types, routing, certification.
//!
//! Certification design (FR7 default; ANT-841 handoff adopts when posted):
//!
//! * `POST /mcp` is served through **`http_request_update`**. Update calls are
//!   consensus-certified by the protocol: replicas sign the response and the
//!   HTTP gateway verifies it against the state-tree certificate. No custom
//!   tree bookkeeping is needed on this path.
//! * The `http_request` **query** path never serves content: `POST /mcp`
//!   returns an `upgrade: true` response so the gateway re-issues the request
//!   as an update call (per the HTTP gateway protocol). Deterministic error
//!   responses (`405` for `GET /mcp`, `404` elsewhere) ARE tree-certified with
//!   response-only certification; the query handler attaches the v2
//!   `IC-Certificate` header whenever the gateway supplies a
//!   `data_certificate`. Nothing is silently uncertified: every served byte is
//!   either upgrade control flow, tree-certified, or consensus-certified.
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

/// Fixed, deterministic query-path error responses.
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

/// Routing decision for an incoming HTTP request (pure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Query `POST /mcp`: tell the gateway to upgrade to an update call.
    Upgrade,
    /// Update `POST /mcp`: run the MCP dispatcher.
    HandleMcp,
    /// `GET /mcp` and other non-POST methods on `/mcp`, or other paths.
    Fixed(FixedResponse),
}

/// Strip the query string and decide the route. Method match is
/// case-insensitive; anything that is not `POST /mcp` never reaches the
/// dispatcher (ANT-842 FR1: POST-only).
pub fn route(method: &str, url: &str, is_update: bool) -> Route {
    let path = url.split('?').next().unwrap_or("");
    if path != "/mcp" {
        return Route::Fixed(FixedResponse::NotFound);
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
