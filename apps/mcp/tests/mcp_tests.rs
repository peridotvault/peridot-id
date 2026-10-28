//! End-to-end dispatcher tests through the public `POST /mcp` surface
//! (ANT-842 AC1, AC2, AC4, AC6). AC3/AC5/AC8 are Tristan's e2e remit; the
//! behaviors they check are implemented here and covered by unit tests.

use peridot_mcp::protocol::{handle_post, TOOL_NAME};
use peridot_mcp::http::{route, FixedResponse, Route};
use serde_json::{json, Value};

fn post(body: &[u8]) -> (u16, Value) {
    let out = handle_post(body);
    let v: Value = serde_json::from_slice(&out.body).unwrap();
    (out.status, v)
}

fn rpc(method: &str, id: Value, params: Value) -> Vec<u8> {
    let mut req = json!({"jsonrpc": "2.0", "id": id, "method": method});
    if !params.is_null() {
        req["params"] = params;
    }
    serde_json::to_vec(&req).unwrap()
}

#[test]
fn ac1_initialize_returns_negotiated_version() {
    let (status, body) = post(&rpc(
        "initialize",
        json!(1),
        json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "1.0.0"}
        }),
    ));
    assert_eq!(status, 200);
    assert_eq!(body["result"]["protocolVersion"], json!("2025-11-25"));
    assert_eq!(body["result"]["serverInfo"]["name"], json!("peridot-mcp"));
}

#[test]
fn ac2_tools_list_returns_exactly_search_docs_twice_identical() {
    let (s1, b1) = post(&rpc("tools/list", json!(2), Value::Null));
    let (s2, b2) = post(&rpc("tools/list", json!(2), Value::Null));
    assert_eq!((s1, s2), (200, 200));
    let tools1 = b1["result"]["tools"].as_array().unwrap();
    assert_eq!(tools1.len(), 1);
    assert_eq!(tools1[0]["name"], json!(TOOL_NAME));
    assert_eq!(
        tools1[0]["inputSchema"],
        json!({
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Search query"}},
            "required": ["query"]
        })
    );
    // Byte-identical across two calls.
    assert_eq!(
        serde_json::to_vec(&b1).unwrap(),
        serde_json::to_vec(&b2).unwrap()
    );
}

#[test]
fn tools_call_wallet_returns_doc_hit() {
    let (status, body) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "search_docs", "arguments": {"query": "wallet"}}),
    ));
    assert_eq!(status, 200);
    assert!(body.get("error").is_none());
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    assert_eq!(payload["resultCount"], json!(1));
    assert_eq!(payload["results"][0]["title"], json!("Wallet Integration Guide"));
    assert!(
        payload["results"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://docs.peridot.id/")
    );
}

#[test]
fn tools_call_no_match_graceful_shape() {
    let (status, body) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "search_docs", "arguments": {"query": "zzz-no-such-doc-zzz"}}),
    ));
    assert_eq!(status, 200);
    // isError absent/false: the call succeeded, the corpus has no answer.
    assert!(body["result"].get("isError").is_none());
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    assert_eq!(
        payload,
        json!({
            "results": [],
            "resultCount": 0,
            "message": "No PeridotID documentation matches 'zzz-no-such-doc-zzz'."
        })
    );
}

#[test]
fn ac4_invalid_params_three_cases() {
    // 1. missing query
    let (_, b1) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "search_docs", "arguments": {}}),
    ));
    assert_eq!(b1["error"]["code"], json!(-32602));
    assert_eq!(b1["error"]["data"]["field"], json!("query"));

    // 2. unknown tool
    let (_, b2) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "nope", "arguments": {"query": "x"}}),
    ));
    assert_eq!(b2["error"]["code"], json!(-32602));
    assert_eq!(b2["error"]["data"]["tool"], json!("nope"));

    // 3. unknown method
    let (_, b3) = post(&rpc("ping", json!(9), Value::Null));
    assert_eq!(b3["error"]["code"], json!(-32601));
}

#[test]
fn ac6_limits_two_cases() {
    // Oversize request body.
    let big = vec![b'x'; 64 * 1024 + 1];
    let out = handle_post(&big);
    assert_eq!(out.status, 413);
    let body: Value = serde_json::from_slice(&out.body).unwrap();
    assert_eq!(body["error"]["code"], json!(-32602));

    // Oversize query.
    let q = "q".repeat(501);
    let (_, body) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "search_docs", "arguments": {"query": q}}),
    ));
    assert_eq!(body["error"]["code"], json!(-32602));
    assert_eq!(body["error"]["data"]["field"], json!("query"));
}

#[test]
fn initialized_notification_is_accepted_silently() {
    let req = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let out = handle_post(&serde_json::to_vec(&req).unwrap());
    assert_eq!(out.status, 204);
    assert!(out.body.is_empty());
    // ...and calls work without a prior handshake (stateless leniency).
    let (status, _) = post(&rpc("tools/list", json!(2), Value::Null));
    assert_eq!(status, 200);
}

#[test]
fn get_mcp_never_reaches_dispatcher() {
    // Routing-level guard lives in http::route; the dispatcher only speaks
    // POST bodies. A JSON-RPC-shaped GET body is still just a POST body here.
    let route = route("GET", "/mcp", false);
    assert_eq!(route, Route::Fixed(FixedResponse::MethodNotAllowed));
}
