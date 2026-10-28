//! End-to-end dispatcher tests through the public `POST /mcp` surface
//! (ANT-845: initialize -> notifications/initialized -> tools/list ->
//! tools/call across all four tools, plus limits and routing guards).

use peridot_mcp::protocol::{
    handle_post, TOOL_GET_EXAMPLE, TOOL_GET_GUIDE, TOOL_GET_SDK_REF, TOOL_NAME,
};
use peridot_mcp::http::{cors_preflight, route, validate_mcp_headers, FixedResponse, HeaderField, Route};
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

fn json_headers() -> Vec<HeaderField> {
    vec![
        HeaderField("Content-Type".to_string(), "application/json".to_string()),
        HeaderField(
            "Accept".to_string(),
            "application/json, text/event-stream".to_string(),
        ),
    ]
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
    assert_eq!(body["result"]["capabilities"], json!({"tools": {}}));

    // Older supported versions echo back.
    for v in ["2025-03-26", "2025-06-18"] {
        let (_, body) = post(&rpc(
            "initialize",
            json!(1),
            json!({"protocolVersion": v, "capabilities": {}}),
        ));
        assert_eq!(body["result"]["protocolVersion"], json!(v));
    }
}

#[test]
fn ac2_tools_list_returns_four_tools_twice_identical() {
    let (s1, b1) = post(&rpc("tools/list", json!(2), Value::Null));
    let (s2, b2) = post(&rpc("tools/list", json!(2), Value::Null));
    assert_eq!((s1, s2), (200, 200));
    let tools1 = b1["result"]["tools"].as_array().unwrap();
    assert_eq!(tools1.len(), 4);
    let names: Vec<&str> = tools1
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![TOOL_GET_EXAMPLE, TOOL_GET_GUIDE, TOOL_GET_SDK_REF, TOOL_NAME]
    );
    assert_eq!(
        tools1[3]["inputSchema"],
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
fn tools_call_wallet_returns_doc_hits() {
    let (status, body) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "search_docs", "arguments": {"query": "wallet"}}),
    ));
    assert_eq!(status, 200);
    assert!(body.get("error").is_none());
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    let count = payload["resultCount"].as_u64().unwrap();
    assert!(count >= 1, "wallet must hit the source-backed corpus");
    assert!(count <= 5);
    assert_eq!(payload["results"].as_array().unwrap().len() as u64, count);
    for hit in payload["results"].as_array().unwrap() {
        assert!(hit["url"]
            .as_str()
            .unwrap()
            .starts_with("https://docs.peridot.id/"));
        assert!(hit["source"]["url"].as_str().unwrap() == hit["url"].as_str().unwrap());
    }
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
fn full_handshake_flow_across_all_tools() {
    // initialize -> 200, notifications/initialized -> 202, then every tool.
    let (s, _) = post(&rpc(
        "initialize",
        json!(1),
        json!({"protocolVersion": "2025-11-25", "capabilities": {}}),
    ));
    assert_eq!(s, 200);
    let notif = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let out = handle_post(&serde_json::to_vec(&notif).unwrap());
    assert_eq!(out.status, 202);
    assert!(out.body.is_empty());

    let calls = vec![
        (TOOL_GET_GUIDE, json!({"topic": "authentication"})),
        (TOOL_GET_EXAMPLE, json!({"name": "passkey-login"})),
        (
            TOOL_GET_SDK_REF,
            json!({"module": "@peridotvault/pid-sdk-js", "symbol": "auth.login"}),
        ),
        (TOOL_NAME, json!({"query": "passkey"})),
    ];
    for (tool, args) in calls {
        let (status, body) = post(&rpc(
            "tools/call",
            json!(3),
            json!({"name": tool, "arguments": args}),
        ));
        assert_eq!(status, 200, "tool {tool} must answer 200");
        assert!(body.get("error").is_none(), "tool {tool} must not error");
        assert!(body["result"]["content"][0]["text"].is_string());
    }

    // Unknown topic/symbol are tool failures (isError), unknown tool is -32602.
    let (_, b) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": TOOL_GET_GUIDE, "arguments": {"topic": "zzz-nope"}}),
    ));
    assert_eq!(b["result"]["isError"], json!(true));
    let (_, b) = post(&rpc(
        "tools/call",
        json!(3),
        json!({"name": "nope", "arguments": {"query": "x"}}),
    ));
    assert_eq!(b["error"]["code"], json!(-32602));

    // ping -> empty result.
    let (_, b) = post(&rpc("ping", json!(9), Value::Null));
    assert_eq!(b["result"], json!({}));
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

    // 3. unknown method (ping is the only extra method)
    let (_, b3) = post(&rpc("frobnicate", json!(9), Value::Null));
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
    assert_eq!(out.status, 202);
    assert!(out.body.is_empty());
    // ...and calls work without a prior handshake (stateless leniency).
    let (status, _) = post(&rpc("tools/list", json!(2), Value::Null));
    assert_eq!(status, 200);
}

#[test]
fn transport_headers_gate_update_calls() {
    // Happy path passes; missing content-type and bad version do not.
    assert_eq!(validate_mcp_headers(&json_headers()), None);
    assert!(validate_mcp_headers(&[]).is_some());
    let bad_version = vec![
        HeaderField("Content-Type".to_string(), "application/json".to_string()),
        HeaderField("MCP-Protocol-Version".to_string(), "1999-01-01".to_string()),
    ];
    let rejection = validate_mcp_headers(&bad_version).expect("must reject");
    assert_eq!(rejection.status, 400);
}

#[test]
fn get_mcp_never_reaches_dispatcher() {
    // Routing-level guard lives in http::route; the dispatcher only speaks
    // POST bodies. A JSON-RPC-shaped GET body is still just a POST body here.
    let route = route("GET", "/mcp", false);
    assert_eq!(route, Route::Fixed(FixedResponse::MethodNotAllowed));
}

#[test]
fn options_mcp_returns_plain_cors_preflight() {
    assert_eq!(route("OPTIONS", "/mcp", false), Route::CorsPreflight);
    let preflight = cors_preflight();
    assert_eq!(preflight.status_code, 204);
    assert!(preflight.body.is_empty());
}
