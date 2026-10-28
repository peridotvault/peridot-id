//! JSON-RPC 2.0 + MCP Streamable HTTP dispatch (ANT-845: 4-tool surface).
//!
//! MCP 2025-11-25, JSON response mode only, stateless (any `Mcp-Session-Id`
//! the client sends is ignored and never echoed). One JSON-RPC message per
//! POST; batches are rejected.
//!
//! Pure logic: no `ic-*` dependencies, fully unit-testable on host.
//! HTTP status mapping: JSON-RPC errors ride HTTP 200, except oversize
//! request bodies which ride HTTP 413 with a JSON-RPC `-32602` body,
//! notifications (no `id`, or any `notifications/*` method) which ride
//! HTTP 202 with an empty body, and transport-header violations (checked in
//! [`crate::http::validate_mcp_headers`]) which ride 400/406.

use serde_json::{json, Value};

use crate::tools::{self, DocHit};

/// Protocol versions the server speaks (ANT-841: pin 2025-11-25, accept older).
pub const SUPPORTED_VERSIONS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];
/// Negotiated when the client proposes an unsupported version.
pub const DEFAULT_VERSION: &str = "2025-11-25";
/// Advertised in `initialize` responses (ANT-842 FR3).
pub const SERVER_NAME: &str = "peridot-mcp";
/// Advertised in `initialize` responses (ANT-842 FR3).
pub const SERVER_VERSION: &str = "0.1.0";
/// Max request body bytes (ANT-842 FR5).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Max response body bytes; result lists are truncated to fit (ANT-842 FR5).
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
/// Max `query`/`topic`/`name`/`module`/`symbol` argument length in characters,
/// not bytes.
pub const MAX_QUERY_CHARS: usize = 500;
/// The four Phase 1 read-only tools, lexicographic order (ANT-845).
pub const TOOL_SEARCH_DOCS: &str = "search_docs";
pub const TOOL_GET_GUIDE: &str = "get_integration_guide";
pub const TOOL_GET_EXAMPLE: &str = "get_example";
pub const TOOL_GET_SDK_REF: &str = "get_sdk_reference";
/// Back-compat alias: the original single-tool contract name.
pub const TOOL_NAME: &str = TOOL_SEARCH_DOCS;
/// Tool descriptions, byte-stable contract.
pub const DESC_SEARCH_DOCS: &str =
    "Search official PeridotID documentation. Phase 1: stub over 3 hardcoded docs.";
/// Back-compat alias for the original description.
pub const TOOL_DESCRIPTION: &str = DESC_SEARCH_DOCS;
pub const DESC_GET_GUIDE: &str =
    "Get a step-by-step PeridotID integration guide for a topic (authentication, wallet, payments).";
pub const DESC_GET_EXAMPLE: &str =
    "Get a runnable PeridotID code example by name.";
pub const DESC_GET_SDK_REF: &str =
    "Get PeridotID SDK API reference for a module, optionally filtered to one symbol.";

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
    // Missing `id` => JSON-RPC notification => accepted, no content (202).
    // This covers `notifications/initialized` and any notification-shaped call.
    let id = match obj.get("id") {
        None => return HttpOutcome {
            status: 202,
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
            status: 202,
            body: Vec::new(),
        };
    }
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => handle_initialize(id, &params),
        "tools/list" => handle_list(id),
        "tools/call" => handle_call(id, &params),
        "ping" => result(id, json!({})),
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
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}
        }),
    )
}

fn tool_entry(name: &str, title: &str, description: &str, schema: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": schema
    })
}

fn handle_list(id: Value) -> HttpOutcome {
    result(
        id,
        json!({
            "tools": [
                tool_entry(
                    TOOL_GET_EXAMPLE,
                    "Code Example",
                    DESC_GET_EXAMPLE,
                    json!({
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Example name (e.g. passkey-login)"}
                        },
                        "required": ["name"]
                    }),
                ),
                tool_entry(
                    TOOL_GET_GUIDE,
                    "Integration Guide",
                    DESC_GET_GUIDE,
                    json!({
                        "type": "object",
                        "properties": {
                            "topic": {"type": "string", "description": "Guide topic: authentication, wallet, or payments"},
                            "stack": {"type": "string", "description": "Target stack: web, ios, android, or backend (optional)"}
                        },
                        "required": ["topic"]
                    }),
                ),
                tool_entry(
                    TOOL_GET_SDK_REF,
                    "SDK Reference",
                    DESC_GET_SDK_REF,
                    json!({
                        "type": "object",
                        "properties": {
                            "module": {"type": "string", "description": "SDK module (e.g. @peridotvault/pid-sdk-js)"},
                            "symbol": {"type": "string", "description": "Symbol name within the module (optional)"}
                        },
                        "required": ["module"]
                    }),
                ),
                tool_entry(
                    TOOL_SEARCH_DOCS,
                    "Search Docs",
                    DESC_SEARCH_DOCS,
                    json!({
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"}
                        },
                        "required": ["query"]
                    }),
                ),
            ]
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

/// Wrap a JSON payload value as an MCP `content:[{type:text}]` success result.
fn text_result(id: Value, payload: Value) -> HttpOutcome {
    let text = payload.to_string();
    result(id, json!({"content": [{"type": "text", "text": text}]}))
}

/// Tool-level failure: the call dispatched fine but the tool has no answer.
/// Protocol-level `error` is NOT used here; the failure rides `isError:true`.
fn tool_error(id: Value, message: String) -> HttpOutcome {
    result(
        id,
        json!({"content": [{"type": "text", "text": message}], "isError": true}),
    )
}

/// Extract a required non-empty string argument, enforcing the shared
/// 500-char cap. Returns the value or the JSON-RPC error outcome.
fn str_arg(
    id: &Value,
    args: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, HttpOutcome> {
    let raw = match args.get(field).and_then(Value::as_str) {
        Some(s) => s,
        None => {
            return Err(error(
                id.clone(),
                -32602,
                "Invalid params",
                Some(json!({"field": field})),
            ))
        }
    };
    if raw.is_empty() {
        return Err(error(
            id.clone(),
            -32602,
            "Invalid params",
            Some(json!({"field": field, "reason": "empty"})),
        ));
    }
    if raw.chars().count() > MAX_QUERY_CHARS {
        return Err(error(
            id.clone(),
            -32602,
            "Invalid params",
            Some(json!({"field": field, "reason": "too_long", "maxChars": MAX_QUERY_CHARS})),
        ));
    }
    Ok(raw.to_string())
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
    match name {
        TOOL_SEARCH_DOCS => call_search_docs(id, args),
        TOOL_GET_GUIDE => call_get_guide(id, args),
        TOOL_GET_EXAMPLE => call_get_example(id, args),
        TOOL_GET_SDK_REF => call_get_sdk_ref(id, args),
        _ => error(
            id,
            -32602,
            "Invalid params",
            Some(json!({"tool": name})),
        ),
    }
}

fn call_search_docs(id: Value, args: &serde_json::Map<String, Value>) -> HttpOutcome {
    let query = match str_arg(&id, args, "query") {
        Ok(q) => q,
        Err(out) => return out,
    };
    let hits = tools::search_docs(&query);
    if hits.is_empty() {
        // NOT an error: the call succeeded, the corpus has no answer.
        return result(id, no_match_payload(&query));
    }
    let envelope = render_tools_call(&id, &hits);
    ok(serde_json::to_vec(&envelope).unwrap_or_default())
}

fn call_get_guide(id: Value, args: &serde_json::Map<String, Value>) -> HttpOutcome {
    let topic = match str_arg(&id, args, "topic") {
        Ok(t) => t,
        Err(out) => return out,
    };
    // Optional stack: validated when present, echoed in the payload.
    let stack = match args.get("stack") {
        None => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return error(
                    id,
                    -32602,
                    "Invalid params",
                    Some(json!({"field": "stack", "reason": "empty"})),
                );
            }
            if !tools::GUIDE_STACKS.contains(&s.to_lowercase().as_str()) {
                return error(
                    id,
                    -32602,
                    "Invalid params",
                    Some(json!({"field": "stack", "supportedStacks": tools::GUIDE_STACKS})),
                );
            }
            Some(s.clone())
        }
        Some(_) => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "stack"})),
            )
        }
    };
    match tools::get_integration_guide(&topic) {
        Some(hit) => {
            let mut payload = json!({
                "topic": hit.topic,
                "title": hit.title,
                "url": hit.url,
                "body": hit.body,
            });
            if let Some(s) = stack {
                payload["stack"] = json!(s);
            }
            text_result(id, payload)
        }
        None => tool_error(
            id,
            format!(
                "No integration guide for topic '{topic}'. Supported topics: {}.",
                tools::GUIDE_TOPICS.join(", ")
            ),
        ),
    }
}

fn call_get_example(id: Value, args: &serde_json::Map<String, Value>) -> HttpOutcome {
    let name = match str_arg(&id, args, "name") {
        Ok(n) => n,
        Err(out) => return out,
    };
    match tools::get_example(&name) {
        Some(hit) => text_result(
            id,
            json!({
                "name": hit.name,
                "title": hit.title,
                "language": hit.language,
                "code": hit.code,
                "description": hit.description,
            }),
        ),
        None => tool_error(
            id,
            format!(
                "No example named '{name}'. Supported examples: {}.",
                tools::EXAMPLE_NAMES.join(", ")
            ),
        ),
    }
}

fn call_get_sdk_ref(id: Value, args: &serde_json::Map<String, Value>) -> HttpOutcome {
    let module = match str_arg(&id, args, "module") {
        Ok(m) => m,
        Err(out) => return out,
    };
    let symbol = match args.get("symbol") {
        None => None,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return error(
                    id,
                    -32602,
                    "Invalid params",
                    Some(json!({"field": "symbol", "reason": "empty"})),
                );
            }
            if s.chars().count() > MAX_QUERY_CHARS {
                return error(
                    id,
                    -32602,
                    "Invalid params",
                    Some(json!({"field": "symbol", "reason": "too_long", "maxChars": MAX_QUERY_CHARS})),
                );
            }
            Some(s.clone())
        }
        Some(_) => {
            return error(
                id,
                -32602,
                "Invalid params",
                Some(json!({"field": "symbol"})),
            )
        }
    };
    match tools::get_sdk_reference(&module, symbol.as_deref()) {
        Some(hit) => text_result(
            id,
            json!({
                "module": hit.module,
                "version": hit.version,
                "summary": hit.summary,
                "symbols": hit.symbols,
            }),
        ),
        None => tool_error(
            id,
            match symbol {
                Some(s) => format!(
                    "No SDK reference for symbol '{s}' in module '{module}'. Supported modules: {}.",
                    tools::SDK_MODULES.join(", ")
                ),
                None => format!(
                    "No SDK reference for module '{module}'. Supported modules: {}.",
                    tools::SDK_MODULES.join(", ")
                ),
            },
        ),
    }
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
            assert_eq!(body["result"]["capabilities"], json!({"tools": {}}));
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
        assert_eq!(out.status, 202);
        assert!(out.body.is_empty());
    }

    #[test]
    fn ping_returns_empty_result() {
        let out = call("ping", json!(9), Value::Null);
        assert_eq!(out.status, 200);
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["result"], json!({}));
    }

    #[test]
    fn tools_list_returns_four_tools_in_order() {
        let out = call("tools/list", json!(2), Value::Null);
        assert_eq!(out.status, 200);
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        let tools = body["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![TOOL_GET_EXAMPLE, TOOL_GET_GUIDE, TOOL_GET_SDK_REF, TOOL_SEARCH_DOCS]
        );
        // Every tool carries a title, description, and object schema.
        for t in tools {
            assert!(t["title"].is_string());
            assert!(t["description"].is_string());
            assert_eq!(t["inputSchema"]["type"], json!("object"));
            assert!(t["inputSchema"]["required"].is_array());
        }
        // Byte-identical across two calls (deterministic).
        let out2 = call("tools/list", json!(2), Value::Null);
        assert_eq!(out.body, out2.body);
    }

    #[test]
    fn guide_call_round_trip_and_unknown_topic_is_error() {
        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_GUIDE, "arguments": {"topic": "wallet", "stack": "web"}}),
        );
        assert_eq!(out.status, 200);
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert!(body.get("error").is_none());
        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["topic"], json!("wallet"));
        assert_eq!(payload["stack"], json!("web"));

        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_GUIDE, "arguments": {"topic": "zzz-nope"}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert!(body.get("error").is_none());
        assert_eq!(body["result"]["isError"], json!(true));
    }

    #[test]
    fn example_and_sdk_calls_round_trip() {
        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_EXAMPLE, "arguments": {"name": "passkey-login"}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["language"], json!("typescript"));
        assert!(!payload["code"].as_str().unwrap().is_empty());

        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_EXAMPLE, "arguments": {"name": "zzz-nope"}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["result"]["isError"], json!(true));

        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_SDK_REF, "arguments": {"module": "@peridotvault/pid-sdk-js"}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["symbols"].as_array().unwrap().len(), 3);

        let out = call(
            "tools/call",
            json!(3),
            json!({"name": TOOL_GET_SDK_REF, "arguments": {"module": "zzz-nope"}}),
        );
        let body: Value = serde_json::from_slice(&out.body).unwrap();
        assert_eq!(body["result"]["isError"], json!(true));
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
