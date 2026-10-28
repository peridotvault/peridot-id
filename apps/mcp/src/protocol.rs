//! JSON-RPC 2.0 + MCP Streamable HTTP dispatch (ANT-842 FR1-FR3, FR5-FR6).
//!
//! JSON response mode only, stateless (any `Mcp-Session-Id` the client sends
//! is ignored). One JSON-RPC message per POST; batches are rejected.
//!
//! Pure logic: no `ic-*` dependencies, fully unit-testable on host.
//! HTTP status mapping: JSON-RPC errors ride HTTP 200, except oversize
//! request bodies (FR5) which ride HTTP 413 with a JSON-RPC `-32602` body,
//! and notifications (no `id`) which ride HTTP 204 with an empty body.

use serde_json::{json, Value};

use crate::tools::{self, DocHit};

/// Protocol versions the server speaks (ANT-842 FR2).
pub const SUPPORTED_VERSIONS: [&str; 2] = ["2025-06-18", "2025-11-25"];
/// Advertised in `initialize` responses (ANT-842 FR3).
pub const SERVER_NAME: &str = "peridot-mcp";
/// Advertised in `initialize` responses (ANT-842 FR3).
pub const SERVER_VERSION: &str = "0.1.0";
/// Max request body bytes (ANT-842 FR5).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Max response body bytes; result lists are truncated to fit (ANT-842 FR5).
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
/// Max `query` length in characters, not bytes (ANT-842 FR5 edge case).
pub const MAX_QUERY_CHARS: usize = 500;
/// The only Phase 1 tool (ANT-842 FR3).
pub const TOOL_NAME: &str = "search_docs";
/// Tool description, byte-stable contract (ANT-842 FR3).
pub const TOOL_DESCRIPTION: &str =
    "Search official PeridotID documentation. Phase 1: stub over 3 hardcoded docs.";

/// Outcome of handling one `POST /mcp` body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpOutcome {
    pub status: u16,
    pub body: Vec<u8>,
}

fn ok(body: Vec<u8>) -> HttpOutcome {
    HttpOutcome { status: 200, body }
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> HttpOutcome {
    let mut err = json!({"code": code, "message": message});
    if let Some(d) = data {
        err["data"] = d;
    }
    ok(json!({"jsonrpc": "2.0", "id": id, "error": err})
        .to_string()
        .into_bytes())
}

fn result(id: Value, result: Value) -> HttpOutcome {
    // Enforce the FR5 response cap on the final envelope.
    let mut body = json!({"jsonrpc": "2.0", "id": id, "result": result})
        .to_string()
        .into_bytes();
    if body.len() > MAX_RESPONSE_BYTES {
        body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32603,
                "message": "Internal error",
                "data": {"reason": "response_too_large"}
            }
        })
        .to_string()
        .into_bytes();
    }
    ok(body)
}

/// Handle one raw `POST /mcp` body.
pub fn handle_post(body: &[u8]) -> HttpOutcome {
    if body.len() > MAX_REQUEST_BYTES {
        return HttpOutcome {
            status: 413,
            body: json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32602,
                    "message": "Invalid params",
                    "data": {"field": "request", "reason": "too_large", "maxBytes": MAX_REQUEST_BYTES}
                }
            })
            .to_string()
            .into_bytes(),
        };
    }
    let msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return error(
                Value::Null,
                -32700,
                "Parse error",
                Some(json!({"reason": "malformed_json"})),
            )
        }
    };
    // No batch support in Phase 1 (ANT-842 FR1).
    if msg.is_array() {
        return error(
            Value::Null,
            -32600,
            "Invalid Request",
            Some(json!({"reason": "batch_not_supported"})),
        );
    }
    let obj = match msg.as_object() {
        Some(o) => o,
        None => return error(Value::Null, -32600, "Invalid Request", None),
    };
    // Missing `id` => JSON-RPC notification => no response (ANT-842 edge case).
    // This covers `notifications/initialized` and any notification-shaped call.
    let id = match obj.get("id") {
        None => return HttpOutcome {
            status: 204,
            body: Vec::new(),
        },
        Some(v) => v.clone(),
    };
    if !(id.is_string() || id.is_number() || id.is_null()) {
        return error(Value::Null, -32600, "Invalid Request", Some(json!({"field": "id"})));
    }
    let method = match obj.get("method").and_then(Value::as_str) {
        Some(m) => m,
        None => return error(id, -32600, "Invalid Request", Some(json!({"field": "method"}))),
    };
    // `notifications/*` never produces a response, even with an `id`
    // (stateless leniency: accept the handshake, don't debate it).
    if method.starts_with("notifications/") {
        return HttpOutcome {
            status: 204,
            body: Vec::new(),
        };
    }
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => handle_initialize(id, &params),
        "tools/list" => handle_list(id),
        "tools/call" => handle_call(id, &params),
        other => error(
            id,
            -32601,
            "Method not found",
            Some(json!({"method": other})),
        ),
    }
}

fn handle_initialize(id: Value, params: &Value) -> HttpOutcome {
    let params = match params.as_object() {
        Some(p) => p,
        None => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "params"})),
            )
        }
    };
    let version = match params.get("protocolVersion").and_then(Value::as_str) {
        Some(v) => v,
        None => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "protocolVersion"})),
            )
        }
    };
    if !SUPPORTED_VERSIONS.contains(&version) {
        return error(
            id,
            -32602,
            "Invalid params",
            Some(json!({"field": "protocolVersion", "supportedVersions": SUPPORTED_VERSIONS})),
        );
    }
    result(
        id,
        json!({
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}
        }),
    )
}

fn handle_list(id: Value) -> HttpOutcome {
    result(
        id,
        json!({
            "tools": [{
                "name": TOOL_NAME,
                "title": "Search Docs",
                "description": TOOL_DESCRIPTION,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"}
                    },
                    "required": ["query"]
                }
            }]
        }),
    )
}

/// Render a `tools/call` success envelope, truncating the hit list to fit
/// the FR5 response cap (sets `"truncated": true` when truncated).
pub fn render_tools_call(id: &Value, hits: &[DocHit]) -> Value {
    let mut shown: &[DocHit] = hits;
    // Shrink from the tail until the envelope fits; an empty list always fits.
    let mut truncated = false;
    while shown.len() > 1 {
        let candidate = call_payload(shown, truncated || shown.len() < hits.len());
        let envelope = json!({"jsonrpc": "2.0", "id": id, "result": candidate});
        if serde_json::to_vec(&envelope).map(|v| v.len()).unwrap_or(usize::MAX)
            <= MAX_RESPONSE_BYTES
        {
            return envelope;
        }
        shown = &shown[..shown.len() - 1];
        truncated = true;
    }
    json!({"jsonrpc": "2.0", "id": id, "result": call_payload(shown, truncated)})
}

fn call_payload(hits: &[DocHit], truncated: bool) -> Value {
    let results: Vec<Value> = hits
        .iter()
        .map(|h| json!({"title": h.title, "url": h.url, "excerpt": h.excerpt}))
        .collect();
    let result_count = results.len();
    let mut payload = json!({"results": results, "resultCount": result_count});
    if truncated {
        payload["truncated"] = json!(true);
    }
    let text = payload.to_string();
    json!({"content": [{"type": "text", "text": text}]})
}

fn no_match_payload(query: &str) -> Value {
    let text = json!({
        "results": [],
        "resultCount": 0,
        "message": format!("No PeridotID documentation matches '{query}'.")
    })
    .to_string();
    json!({"content": [{"type": "text", "text": text}]})
}

fn handle_call(id: Value, params: &Value) -> HttpOutcome {
    let params = match params.as_object() {
        Some(p) => p,
        None => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "params"})),
            )
        }
    };
    let name = match params.get("name").and_then(Value::as_str) {
        Some(n) => n,
        None => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "name"})),
            )
        }
    };
    if name != TOOL_NAME {
        return error(
            id,
            -32602,
            "Invalid params",
            Some(json!({"tool": name})),
        );
    }
    // `arguments: null` and missing `arguments` are both invalid (edge case).
    let args = match params.get("arguments") {
        Some(Value::Object(a)) => a,
        _ => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "arguments"})),
            )
        }
    };
    let query = match args.get("query").and_then(Value::as_str) {
        Some(q) => q,
        None => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "query"})),
            )
        }
    };
    if query.is_empty() {
        return error(
            id,
            -32602,
            "Invalid params",
            Some(json!({"field": "query", "reason": "empty"})),
        );
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return error(
            id,
            -32602,
            "Invalid params",
            Some(json!({"field": "query", "reason": "too_long", "maxChars": MAX_QUERY_CHARS})),
        );
    }
    let hits = tools::search_docs(query);
    if hits.is_empty() {
        // NOT an error: the call succeeded, the corpus has no answer (FR6).
        return result(id, no_match_payload(query));
    }
    let envelope = render_tools_call(&id, &hits);
    ok(serde_json::to_vec(&envelope).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, id: Value, params: Value) -> HttpOutcome {
        let mut req = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if !params.is_null() {
            req["params"] = params;
        }
        handle_post(&serde_json::to_vec(&req).unwrap())
    }

    #[test]
    fn initialize_negotiates_version() {
        for v in SUPPORTED_VERSIONS {
            let out = call(
                "initialize",
                json!(1),
                json!({"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "opencode", "version": "1.0.0"}}),
            );
            assert_eq!(out.status, 200);
            let body: Value = serde_json::from_slice(&out.body).unwrap();
            assert_eq!(body["result"]["protocolVersion"], json!(v));
            assert_eq!(body["result"]["serverInfo"]["name"], json!(SERVER_NAME));
            assert_eq!(body["result"]["serverInfo"]["version"], json!(SERVER_VERSION));
        }
    }

    #[test]
    fn initialize_rejects_unsupported_version() {
        let out = call("initialize", json!(1), json!({"protocolVersion": "1999-01-01"}));
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["error"]["code"], json!(-32602));
        assert_eq!(
            body["error"]["data"]["supportedVersions"],
            json!(SUPPORTED_VERSIONS)
        );
    }

    #[test]
    fn notification_has_no_response() {
        let req = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        let out = handle_post(&serde_json::to_vec(&req).unwrap());
        assert_eq!(out.status, 204);
        assert!(out.body.is_empty());
    }

    #[test]
    fn batch_is_rejected() {
        let out = handle_post(br#"[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]"#);
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["error"]["code"], json!(-32600));
    }

    #[test]
    fn oversize_request_is_413_with_rpc_body() {
        let big = vec![b'x'; MAX_REQUEST_BYTES + 1];
        let out = handle_post(&big);
        assert_eq!(out.status, 413);
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["error"]["code"], json!(-32602));
    }

    #[test]
    fn query_length_is_counted_in_chars() {
        // 501 chars over multi-byte codepoints still trips the 500-char rule.
        let q: String = "é".repeat(501);
        assert!(q.len() > 501); // bytes exceed chars: proves char counting matters
        let out = call(
            "tools/call",
            json!(3),
            json!({"name": "search_docs", "arguments": {"query": q}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["error"]["code"], json!(-32602));
        assert_eq!(body["error"]["data"]["field"], json!("query"));
    }

    #[test]
    fn truncation_sets_flag_and_fits_cap() {
        let hits: Vec<DocHit> = (0..500)
            .map(|i| DocHit {
                title: format!("Doc {i:04}"),
                url: "https://docs.peridot.id/x".to_string(),
                excerpt: "y".repeat(200),
            })
            .collect();
        let envelope = render_tools_call(&json!(3), &hits);
        let bytes = serde_json::to_vec(&envelope).unwrap();
        assert!(bytes.len() <= MAX_RESPONSE_BYTES, "len={}", bytes.len());
        let text = envelope["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["truncated"], json!(true));
        assert!(payload["resultCount"].as_u64().unwrap() < 500);
    }
}
