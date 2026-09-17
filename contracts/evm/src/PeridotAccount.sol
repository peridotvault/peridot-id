// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64Url} from "./Base64Url.sol";

/// @title PeridotAccount — passkey-owned smart account (V3 authorization + fee schema).
/// @notice EVM counterpart of the Solana smart-account program: the authority is a
/// secp256r1 (P-256) WebAuthn passkey. Deployed as an EIP-1167 minimal proxy behind
/// `PeridotFactory` (CREATE2), so the address is counterfactual and identical on
/// every chain that shares the factory. The passkey signs
/// `authenticatorData ‖ sha256(clientDataJSON)` with the domain-separated V3 payload
/// as the WebAuthn challenge — the same binding as `auth.rs::verify_secp256r1_v2`.
/// @dev V3 invariants (see `contracts/V2_AUTHORIZATION.md`):
/// - The user authorizes the transaction intent plus a `feePolicyVersion` — never
///   amounts. The submitter attests `networkFee`; the contract recomputes
///   `protocolFee` from the immutable policy table and enforces the split:
///   relayerFee (`= networkFee`) → fee payer, protocolFee → factory vault.
/// - The attested `networkFee` is sanity-bounded on-chain against measured gas
///   (`GasAnomaly`); receipt reconciliation verifies attestation vs actual.
/// - Every payload starts with `DOMAIN_V3 ‖ opTag` so older versions and sibling
///   operations can never verify.
/// - `initialize` is reachable only atomically through the factory's passkey-bound
///   `deployAndInit` and verifies the activation authorization itself: a compromised
///   relayer can neither choose the authority, squat a salt, change the fee
///   policy, nor redirect funds or revenue.
contract PeridotAccount {
    /// @dev V3 domain, matching `DOMAIN_EVM_V3` in `packages/core/src/evm.ts`.
    bytes public constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";

    uint8 internal constant OP_EXECUTE = 0x01;
    uint8 internal constant OP_ROTATE = 0x03;
    uint8 internal constant OP_ACTIVATE = 0x05;

    /// @dev Fee policy v1: 50% protocol fee (5000 bps of the attested network fee).
    /// Never hardcoded at call sites; new versions arrive via contract upgrade,
    /// never via per-call fields.
    uint16 internal constant FEE_POLICY_V1 = 1;
    uint256 internal constant PROTOCOL_FEE_BPS_V1 = 5000;
    uint256 internal constant MAX_PROTOCOL_FEE_BPS = 5000;

    /// @dev Sanity-bound multiplier: attested networkFee must fit within 2× the
    /// measured execution cost. A bound, not pricing — covers verification/payout
    /// overhead and testnet L2 data fees with headroom.
    uint256 internal constant GAS_SANITY_NUMERATOR = 2;

    /// @dev Maximum authorization lifetime (seconds). Bounds cross-context replay.
    uint64 internal constant MAX_TTL = 600;

    // ---- V4 permission layer (see `contracts/V4_PERMISSIONS.md`, canonical) ----
    /// @dev Permission domain. Deliberately DIFFERENT from DOMAIN_V3 so an owner
    /// signature can never verify as a permission signature and vice versa —
    /// this is the load-bearing OWNER vs PERMISSION distinction (both use P-256).
    bytes public constant DOMAIN_PERM = "PID|EVM|PERMISSION|v1";

    uint8 internal constant OP_GRANT = 0x10;
    uint8 internal constant OP_REVOKE = 0x11;
    uint8 internal constant OP_PERM_EXEC = 0x12;
    uint8 internal constant OP_INSTALL = 0x13;
    uint8 internal constant OP_UNINSTALL = 0x14;
    uint8 internal constant OP_EXEC7579 = 0x15;
    uint8 internal constant OP_1271 = 0x16;

    /// @dev Permission kinds. 0 = empty slot (no permission).
    uint8 internal constant KIND_NONFINANCIAL = 1;
    uint8 internal constant KIND_ETH = 2;
    uint8 internal constant KIND_ERC20 = 3;
    uint8 internal constant KIND_ERC721 = 4;
    uint8 internal constant KIND_ERC1155 = 5;

    /// @dev Longest permission lifetime (seconds): 30 days. Bounds standing authority;
    /// every execution additionally carries a ≤600s deadline (MAX_TTL).
    uint64 internal constant MAX_PERMISSION_TTL = 30 days;
    /// @dev Cap on permission-execution calldata (bytes). Matches the SVM execute cap.
    uint256 internal constant MAX_PERM_DATA = 10_240;

    // ERC-7579 module types (spec §"Module Types").
    uint256 public constant MODULE_TYPE_VALIDATOR = 1;
    uint256 public constant MODULE_TYPE_EXECUTOR = 2;
    uint256 public constant MODULE_TYPE_FALLBACK = 3;
    uint256 public constant MODULE_TYPE_HOOK = 4;

    /// @dev The ONLY execution mode this account supports: single `call`.
    /// Delegatecall and batch modes are permanently unsupported — see V4_PERMISSIONS.md.
    /// Mode encoding follows ERC-7579 (CallType 0x00 = call, ExecType 0x00 = default).
    bytes32 public constant MODE_SINGLE_DEFAULT = bytes32(0);

    /// @dev ERC-4337 EntryPoint reservation. Zero in V1 = 7579 `execute` stays
    /// self-or-EntryPoint gated with no EntryPoint set; a future implementation
    /// may set it. `executeFromExecutor` (permission path) is live today.
    address public constant ENTRY_POINT = address(0);

    /// @dev ERC-1271 magic values.
    bytes4 internal constant MAGIC_1271 = 0x1626ba7e;
    bytes4 internal constant MAGIC_1271_INVALID = 0xffffffff;
    /// @dev ERC-7739 support probe (hash + empty signature).
    bytes32 internal constant PROBE_7739_HASH = bytes32(0x7739773977397739773977397739773977397739773977397739773977397739);
    bytes4 internal constant MAGIC_7739 = 0x77390001;

    bytes32 public authorityX;
    bytes32 public authorityY;
    /// @dev sha256 of the WebAuthn RP ID; must equal `authenticatorData[0:32]`.
    bytes32 public rpIdHash;
    uint64 public nonce;
    bool public initialized;
    /// @dev Canonical revenue recipient: the deploying factory itself, which
    /// accumulates protocol revenue. Set once at init; no setter exists.
    address public factory;

    /// @dev Storage gap for future execution paths (e.g. ERC-4337 adapter).
    /// New state MUST be appended after this gap, never reordered.
    /// @dev V4 consumes 3 slots (permissions, modules, lock); the remainder stays reserved.
    mapping(bytes32 => Permission) private _permissions;
    mapping(uint256 => mapping(address => bool)) private _modules;
    bool private _locked;
    uint256[38] private __gap;

    error AlreadyInitialized();
    error NotInitialized();
    error Unauthorized();
    error InvalidChallenge();
    error Expired();
    error CallFailed();
    error ZeroAuthority();
    error InsufficientFunds();
    error UnknownFeePolicy();
    error ExceedsMaxBps();
    error GasAnomaly();
    error InvalidTarget();
    // ---- V4 errors ----
    error PermissionNotFound();
    error AlreadyRevoked();
    error PermissionExpired();
    error BadSeq();
    error ScopeMismatch();
    error DeniedSelector();
    error LimitExceeded();
    error BadPermissionId();
    error PermissionTTLExceeded();
    error UnsupportedExecutionMode();
    error UnsupportedModuleType();
    error NotModule();
    error AlreadyInstalled();
    error Reentrancy();

    event Initialized(bytes32 x, bytes32 y, uint256 networkFee, uint256 protocolFee);
    event Executed(address indexed to, uint256 value, uint256 networkFee, uint256 protocolFee, uint64 nonce);
    event AuthorityUpdated(bytes32 x, bytes32 y, uint64 nonce);
    // ---- V4 events (7579 names kept where the standard defines them) ----
    event PermissionGranted(bytes32 indexed permissionId, bytes32 sessionX, bytes32 sessionY, uint8 kind);
    event PermissionRevoked(bytes32 indexed permissionId);
    event PermissionExecuted(bytes32 indexed permissionId, uint64 seq, address indexed target, uint256 value);
    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    /// @dev Scoped capability granted by the owner to a P-256 session key.
    /// A permission is NEVER a second wallet: every execution is checked against
    /// this exact record, single-call-only, with owner-initiated revocation.
    /// `spent` tracks value units (ETH/ERC-20/1155-amount) or 0/1 for ERC-721.
    struct Permission {
        bytes32 sessionX;
        bytes32 sessionY;
        uint64 validAfter;
        uint64 validUntil;
        uint64 seq;
        uint8 kind;
        bool revoked;
        address target;
        bytes4 selector;
        address token;
        address to;
        uint256 perTxCap;
        uint256 totalLimit;
        uint256 spent;
        uint256 nftId;
    }

    /// @dev Owner-signed grant arguments (calldata struct to stay under stack limit).
    struct GrantArgs {
        bytes32 permissionId;
        bytes32 sessionX;
        bytes32 sessionY;
        uint8 kind;
        address target;
        bytes4 selector;
        address token;
        address to;
        uint256 perTxCap;
        uint256 totalLimit;
        uint256 nftId;
        uint64 validAfter;
        uint64 validUntil;
        bytes32 salt;
        uint64 deadline;
    }

    /// @dev Permission-execution arguments (single struct to stay under stack limit).
    /// Flat-tuple ABI compatible: `executeFromExecutor` decodes its
    /// `executionCalldata` directly into this struct.
    struct PermExecArgs {
        bytes32 permissionId;
        address target;
        uint256 value;
        bytes data;
        uint64 deadline;
        uint64 seq;
        uint16 feePolicyVersion;
        uint256 networkFee;
        address feeRecipient;
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes32 r;
        bytes32 s;
    }

    /// @dev ERC-7579 owner-execution arguments (decoded from `executionCalldata`).
    struct Exec7579Args {
        address target;
        uint256 value;
        bytes data;
        uint64 deadline;
        uint16 feePolicyVersion;
        uint256 networkFee;
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes32 r;
        bytes32 s;
    }

    /// @dev No constructor args so the implementation is redeployable at one
    /// address on every chain (keyless CREATE2 deploy) — the factory embeds it.
    /// @dev Reentrancy mutex. Set around every path that performs an untrusted
    /// external call (owner execute, permission execution, module callbacks).
    /// There is no legitimate reentry: all privileged paths need a fresh
    /// owner/session signature the callee does not have.
    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @notice One-time setup, called atomically by the factory's passkey-bound
    /// `deployAndInit`. Verifies the user's activation authorization (which binds
    /// salt, authority, rpIdHash, policy, deadline, chainid, factory) before
    /// writing any state. The account is pre-funded at its counterfactual
    /// address (first-top-up, like SVM `activate`); the attested `networkFee`
    /// is split relayerFee → `payer` (the relayer EOA that floated the
    /// deploy; `msg.sender` here is the factory itself),
    /// protocolFee → factory vault. (Gas sanity is enforced by the factory
    /// frame, which observes the full activation cost.)
    function initialize(
        bytes32 salt,
        bytes32 x,
        bytes32 y,
        bytes32 _rpIdHash,
        uint16 feePolicyVersion,
        uint64 deadline,
        uint256 networkFee,
        address _factory,
        address payer,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (x == 0 && y == 0) revert ZeroAuthority();
        if (msg.sender != _factory) revert Unauthorized();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        // Version gate before signature verification: unknown policies revert
        // identically for every caller and reveal nothing about the key.
        uint256 bps = _policyProtocolBps(feePolicyVersion);
        authorityX = x;
        authorityY = y;
        rpIdHash = _rpIdHash;
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                OP_ACTIVATE,
                salt,
                x,
                y,
                _rpIdHash,
                feePolicyVersion,
                deadline,
                block.chainid,
                _factory
            )
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        uint256 protocolFee = _protocolFee(networkFee, bps);
        factory = _factory;
        initialized = true;
        if (address(this).balance < networkFee + protocolFee) revert InsufficientFunds();
        if (networkFee > 0) {
            (bool ok, ) = payer.call{value: networkFee}("");
            if (!ok) revert CallFailed();
        }
        if (protocolFee > 0) {
            (bool ok, ) = _factory.call{value: protocolFee}("");
            if (!ok) revert CallFailed();
        }
        emit Initialized(x, y, networkFee, protocolFee);
    }

    receive() external payable {}

    /// @notice Execute a call authorized by the passkey.
    /// @dev The relayer submits the tx and floats gas, then attests `networkFee`;
    /// the contract sanity-checks it against measured gas, recomputes
    /// `protocolFee` from policy, and splits relayerFee → `msg.sender`,
    /// protocolFee → factory vault — atomically, in this same transaction.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 deadline,
        uint16 feePolicyVersion,
        uint256 networkFee,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint256 startGas = gasleft();
        if (!initialized) revert NotInitialized();
        if (to == address(this)) revert InvalidTarget();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        uint256 bps = _policyProtocolBps(feePolicyVersion);
        bytes32 expected = _executePayload(to, value, data, deadline, feePolicyVersion);
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        _checkGasSanity(startGas, networkFee);
        uint256 protocolFee = _protocolFee(networkFee, bps);
        if (address(this).balance < value + networkFee + protocolFee) revert InsufficientFunds();
        nonce++;
        (bool ok, ) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
        if (networkFee > 0) {
            (ok, ) = msg.sender.call{value: networkFee}("");
            if (!ok) revert CallFailed();
        }
        if (protocolFee > 0) {
            (ok, ) = factory.call{value: protocolFee}("");
            if (!ok) revert CallFailed();
        }
        emit Executed(to, value, networkFee, protocolFee, nonce - 1);
    }

    /// @dev Payload for `execute` (own frame — keeps `execute` under the stack limit).
    function _executePayload(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 deadline,
        uint16 feePolicyVersion
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                OP_EXECUTE,
                block.chainid,
                address(this),
                nonce,
                to,
                value,
                keccak256(data),
                deadline,
                feePolicyVersion
            )
        );
    }

    /// @notice Rotate the passkey authority. Requires a signature from the current key.
    function updateAuthority(
        bytes32 newX,
        bytes32 newY,
        uint64 deadline,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (!initialized) revert NotInitialized();
        if (newX == 0 && newY == 0) revert ZeroAuthority();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        bytes32 expected = keccak256(
            abi.encodePacked(DOMAIN_V3, OP_ROTATE, block.chainid, address(this), nonce, newX, newY, deadline)
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        authorityX = newX;
        authorityY = newY;
        uint64 n = nonce++;
        emit AuthorityUpdated(newX, newY, n);
    }

    /// @dev Resolve the protocol-fee bps for a signed policy version, enforcing
    /// the protocol maximum. Version-gating is safe before signature verification:
    /// unknown versions revert identically for every caller.
    function _policyProtocolBps(uint16 feePolicyVersion) internal pure returns (uint256 bps) {
        if (feePolicyVersion != FEE_POLICY_V1) revert UnknownFeePolicy();
        bps = PROTOCOL_FEE_BPS_V1;
        if (bps > MAX_PROTOCOL_FEE_BPS) revert ExceedsMaxBps();
    }

    /// @dev protocolFee = floor(networkFee × bps / 10_000). Floor favors the user;
    /// relayerFee is exactly networkFee, so the split never loses dust.
    function _protocolFee(uint256 networkFee, uint256 bps) internal pure returns (uint256) {
        return (networkFee * bps) / 10000;
    }

    /// @dev Sanity-bound the attested networkFee against measured execution gas.
    /// A bound, not pricing: covers verification/payout overhead inside the
    /// measured region plus testnet L2 data fees with headroom. Prevents wild
    /// over-attestation; exact attestation-vs-actual matching is verified by
    /// receipt reconciliation (backend/indexer), which also carries L1-fee oracles.
    function _checkGasSanity(uint256 startGas, uint256 networkFee) internal view {
        uint256 measured = (startGas - gasleft()) * tx.gasprice * GAS_SANITY_NUMERATOR;
        if (networkFee > measured) revert GasAnomaly();
    }

    /// @dev Mirrors `auth.rs::verify_secp256r1_v2`: signer == stored authority,
    /// message binds `sha256(clientDataJSON)`, challenge == recomputed payload.
    /// Plus RP-ID hash + user-verification flag hardening (cheap on EVM).
    function _verify(
        bytes32 expectedPayload,
        bytes memory authenticatorData,
        bytes memory clientDataJSON,
        bytes32 r,
        bytes32 s
    ) internal view {
        _verifyWithKey(authorityX, authorityY, expectedPayload, authenticatorData, clientDataJSON, r, s);
    }

    /// @dev Same WebAuthn/P-256 checks as `_verify` but against an explicit key.
    /// Used for session keys (PERM domain payloads) and ERC-1271. The caller is
    /// responsible for domain separation: passing the owner key with a PERM
    /// payload (or vice versa) can never verify because the challenge binds the domain.
    function _verifyWithKey(
        bytes32 x,
        bytes32 y,
        bytes32 expectedPayload,
        bytes memory authenticatorData,
        bytes memory clientDataJSON,
        bytes32 r,
        bytes32 s
    ) internal view {
        // 1. RP-ID + user verification (first 32B of authenticatorData, flag bit 0x04).
        if (authenticatorData.length < 37) revert Unauthorized();
        bytes32 rpId;
        assembly ("memory-safe") {
            rpId := mload(add(authenticatorData, 32))
        }
        if (rpId != rpIdHash) revert Unauthorized();
        if (uint8(authenticatorData[32]) & 0x04 == 0) revert Unauthorized();
        // 2. Signed message binds the exact attested bytes.
        bytes32 h = sha256(bytes.concat(authenticatorData, sha256(clientDataJSON)));
        // 3. Challenge inside clientDataJSON must equal the payload (no substitution).
        if (_extractChallenge(clientDataJSON) != expectedPayload) revert InvalidChallenge();
        // 4. P-256 signature over the given key (low-S enforced inside OZ P256).
        if (!P256.verify(h, r, s, x, y)) revert Unauthorized();
    }

    /// @dev Extract `"challenge":"<base64url>"` and decode it to 32 bytes.
    function _extractChallenge(bytes memory json) internal pure returns (bytes32) {
        bytes memory marker = bytes('"challenge":"');
        uint256 start = _find(json, marker);
        if (start == type(uint256).max) revert InvalidChallenge();
        start += marker.length;
        uint256 end = start;
        while (end < json.length && json[end] != '"') end++;
        if (end == json.length) revert InvalidChallenge();
        bytes memory raw = new bytes(end - start);
        for (uint256 i = 0; i < raw.length; i++) raw[i] = json[start + i];
        bytes memory decoded = Base64Url.decode(raw);
        if (decoded.length != 32) revert InvalidChallenge();
        bytes32 out;
        assembly ("memory-safe") {
            out := mload(add(decoded, 32))
        }
        return out;
    }

    /// @dev Naive subslice search (clientDataJSON is small, runs once per tx).
    function _find(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        if (needle.length == 0 || needle.length > haystack.length) return type(uint256).max;
        for (uint256 i = 0; i + needle.length <= haystack.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return i;
        }
        return type(uint256).max;
    }

    // ============ V4 permission layer + ERC-7579 (see V4_PERMISSIONS.md) ============
    // The account stays the permanent asset-owning account. Permissions are scoped
    // capabilities enforced HERE (single audit point), never a second wallet.
    // There is intentionally NO delegatecall anywhere in this file: untrusted code
    // always runs via `call` in its own storage context, and
    // `supportsExecutionMode` rejects delegatecall/batch modes permanently.

    /// @dev Financial/approval selectors a NONFINANCIAL permission may never invoke
    /// directly. Second layer only: the exact target+selector match (grant-time) is
    /// the first. Token standards evolve — review this list per addition.
    function _deniedSelector(bytes4 sel) internal pure returns (bool) {
        if (sel == 0xa9059cbb) return true; // transfer(address,uint256)
        if (sel == 0x23b872dd) return true; // transferFrom(address,address,uint256)
        if (sel == 0x095ea7b3) return true; // approve(address,uint256)
        if (sel == 0x39509351) return true; // increaseAllowance(address,uint256)
        if (sel == 0xa457c2d7) return true; // decreaseAllowance(address,uint256)
        if (sel == 0xd505accf) return true; // permit(...)
        if (sel == 0x42842e0e) return true; // safeTransferFrom(address,address,uint256)
        if (sel == 0xb88d4fde) return true; // safeTransferFrom(address,address,uint256,bytes)
        if (sel == 0xf242432a) return true; // safeTransferFrom(address,address,uint256,uint256,bytes)
        if (sel == 0x2eb2c2d6) return true; // safeBatchTransferFrom(...)
        if (sel == 0xa22cb465) return true; // setApprovalForAll(address,bool)
        if (sel == 0x87517c45) return true; // Permit2 approve(...)
        if (sel == 0x2a2e0c7a) return true; // Permit2 permit(...)
        return false;
    }

    /// @dev Canonical permission id. Binds chain + account + session + full scope +
    /// expiry + owner-chosen salt (uniqueness across re-grants of one scope).
    function _permissionId(
        bytes32 sessionX,
        bytes32 sessionY,
        uint8 kind,
        address target,
        bytes4 selector,
        address token,
        address to,
        uint256 nftId,
        uint64 validUntil,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM,
                block.chainid,
                address(this),
                sessionX,
                sessionY,
                kind,
                target,
                selector,
                token,
                to,
                nftId,
                validUntil,
                salt
            )
        );
    }

    /// @notice Grant a scoped permission to a P-256 session key. Owner-only.
    /// Consumes the owner nonce (ordered with execute/rotate). Revocation is a
    /// separate owner-signed state flip — never needs session cooperation.
    function grantPermission(
        GrantArgs calldata g,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (!initialized) revert NotInitialized();
        if (g.sessionX == 0 && g.sessionY == 0) revert ZeroAuthority();
        if (g.kind < KIND_NONFINANCIAL || g.kind > KIND_ERC1155) revert ScopeMismatch();
        if (block.timestamp > g.deadline) revert Expired();
        if (g.deadline - block.timestamp > MAX_TTL) revert Expired();
        if (g.validUntil <= block.timestamp) revert PermissionExpired();
        if (g.validUntil <= g.validAfter) revert ScopeMismatch();
        if (g.validUntil - block.timestamp > MAX_PERMISSION_TTL) revert PermissionTTLExceeded();
        bytes32 pid = _permissionId(
            g.sessionX, g.sessionY, g.kind, g.target, g.selector, g.token, g.to, g.nftId, g.validUntil, g.salt
        );
        if (pid != g.permissionId) revert BadPermissionId();
        if (_permissions[pid].sessionX != 0 || _permissions[pid].sessionY != 0) revert AlreadyInstalled();
        // Kind-specific scope hygiene (enforced again at execution).
        if (g.kind == KIND_NONFINANCIAL) {
            if (g.target == address(0) || g.target == address(this) || g.target == factory) revert InvalidTarget();
            if (g.selector == bytes4(0) || _deniedSelector(g.selector)) revert DeniedSelector();
            if (g.token != address(0) || g.to != address(0)) revert ScopeMismatch();
        } else if (g.kind == KIND_ETH) {
            if (g.token != address(0) || g.to == address(0) || g.to == address(this)) revert ScopeMismatch();
            if (g.perTxCap == 0 || g.totalLimit < g.perTxCap) revert LimitExceeded();
        } else {
            if (g.token == address(0) || g.token == address(this) || g.to == address(0)) revert ScopeMismatch();
            if (g.perTxCap == 0 || g.totalLimit < g.perTxCap) revert LimitExceeded();
        }
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_PERM,
                OP_GRANT,
                block.chainid,
                address(this),
                pid,
                g.sessionX,
                g.sessionY,
                g.kind,
                g.target,
                g.selector,
                g.token,
                g.to,
                g.perTxCap,
                g.totalLimit,
                g.nftId,
                g.validAfter,
                g.validUntil,
                nonce,
                g.deadline
            )
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        _permissions[pid] = Permission({
            sessionX: g.sessionX,
            sessionY: g.sessionY,
            validAfter: g.validAfter,
            validUntil: g.validUntil,
            seq: 0,
            kind: g.kind,
            revoked: false,
            target: g.target,
            selector: g.selector,
            token: g.token,
            to: g.to,
            perTxCap: g.perTxCap,
            totalLimit: g.totalLimit,
            spent: 0,
            nftId: g.nftId
        });
        nonce++;
        emit PermissionGranted(pid, g.sessionX, g.sessionY, g.kind);
    }

    /// @notice Revoke a permission. Owner-only, immediate, state-based.
    function revokePermission(
        bytes32 permissionId,
        uint64 deadline,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (!initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        Permission storage p = _permissions[permissionId];
        if (p.sessionX == 0 && p.sessionY == 0) revert PermissionNotFound();
        if (p.revoked) revert AlreadyRevoked();
        bytes32 expected = keccak256(
            abi.encodePacked(DOMAIN_PERM, OP_REVOKE, block.chainid, address(this), permissionId, nonce, deadline)
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        p.revoked = true;
        nonce++;
        emit PermissionRevoked(permissionId);
    }

    /// @notice Execute one scoped call authorized by a session key.
    /// Single call only (no batch): every execution is fully checked.
    function executeWithPermission(
        bytes32 permissionId,
        address target,
        uint256 value,
        bytes calldata data,
        uint64 deadline,
        uint64 seq,
        uint16 feePolicyVersion,
        uint256 networkFee,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _executePermission(
            PermExecArgs({
                permissionId: permissionId,
                target: target,
                value: value,
                data: data,
                deadline: deadline,
                seq: seq,
                feePolicyVersion: feePolicyVersion,
                networkFee: networkFee,
                feeRecipient: msg.sender,
                authenticatorData: authenticatorData,
                clientDataJSON: clientDataJSON,
                r: r,
                s: s
            })
        );
    }

    /// @dev Shared permission-execution core (direct + ERC-7579 executor paths).
    /// Order: checks → effects (seq/spent) → untrusted call → fee payouts.
    function _executePermission(PermExecArgs memory a) internal {
        uint256 startGas = gasleft();
        if (!initialized) revert NotInitialized();
        if (a.target == address(this) || a.target == factory) revert InvalidTarget();
        if (a.data.length > MAX_PERM_DATA) revert ScopeMismatch();
        if (block.timestamp > a.deadline) revert Expired();
        if (a.deadline - block.timestamp > MAX_TTL) revert Expired();
        if (a.feeRecipient == address(0)) revert ZeroAuthority();
        uint256 bps = _policyProtocolBps(a.feePolicyVersion);
        Permission storage p = _permissions[a.permissionId];
        if (p.sessionX == 0 && p.sessionY == 0) revert PermissionNotFound();
        if (p.revoked) revert AlreadyRevoked();
        if (block.timestamp < p.validAfter || block.timestamp > p.validUntil) revert PermissionExpired();
        if (a.seq != p.seq) revert BadSeq();
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_PERM,
                OP_PERM_EXEC,
                block.chainid,
                address(this),
                a.permissionId,
                a.seq,
                a.target,
                a.value,
                keccak256(a.data),
                a.deadline,
                a.feePolicyVersion
            )
        );
        _verifyWithKey(p.sessionX, p.sessionY, expected, a.authenticatorData, a.clientDataJSON, a.r, a.s);
        _enforceScope(p, a.target, a.value, a.data);
        p.seq = a.seq + 1;
        _checkGasSanity(startGas, a.networkFee);
        uint256 protocolFee = _protocolFee(a.networkFee, bps);
        if (address(this).balance < a.value + a.networkFee + protocolFee) revert InsufficientFunds();
        (bool ok, bytes memory result) = a.target.call{value: a.value}(a.data);
        if (!ok) revert CallFailed();
        if (a.networkFee > 0) {
            (ok, ) = a.feeRecipient.call{value: a.networkFee}("");
            if (!ok) revert CallFailed();
        }
        if (protocolFee > 0) {
            (ok, ) = factory.call{value: protocolFee}("");
            if (!ok) revert CallFailed();
        }
        emit PermissionExecuted(a.permissionId, a.seq, a.target, a.value);
        _lastResult = result;
    }

    /// @dev Most recent permission/executor call returndata (for `executeFromExecutor`).
    bytes private _lastResult;

    /// @dev First 4 bytes of `data` as a selector (reverts on short input via length checks at call sites).
    function _sel(bytes memory data) internal pure returns (bytes4 sel) {
        assembly ("memory-safe") {
            sel := mload(add(data, 32))
        }
    }

    /// @dev `data[4:]` copy for `abi.decode` (memory has no range slices).
    function _suffix(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        uint256 len = out.length;
        uint256 src;
        uint256 dest;
        assembly ("memory-safe") {
            src := add(add(data, 32), 4)
            dest := add(out, 32)
        }
        for (uint256 i = 0; i < len; i += 32) {
            uint256 w;
            assembly ("memory-safe") {
                w := mload(add(src, i))
            }
            assembly ("memory-safe") {
                mstore(add(dest, i), w)
            }
        }
    }

    /// @dev Kind-specific scope enforcement + spend accounting (effects, before the call).
    function _enforceScope(Permission storage p, address target, uint256 value, bytes memory data) internal {
        if (p.kind == KIND_NONFINANCIAL) {
            if (value != 0) revert ScopeMismatch();
            if (target != p.target) revert ScopeMismatch();
            if (data.length < 4 || _sel(data) != p.selector) revert ScopeMismatch();
            if (_deniedSelector(p.selector)) revert DeniedSelector();
        } else if (p.kind == KIND_ETH) {
            if (data.length != 0 || target != p.to) revert ScopeMismatch();
            if (value == 0 || value > p.perTxCap || p.spent + value > p.totalLimit) revert LimitExceeded();
            p.spent += value;
        } else if (p.kind == KIND_ERC20) {
            uint256 amount = _checkErc20Call(p, target, value, data);
            if (amount == 0 || amount > p.perTxCap || p.spent + amount > p.totalLimit) revert LimitExceeded();
            p.spent += amount;
        } else if (p.kind == KIND_ERC721) {
            _checkErc721Call(p, target, value, data);
            if (p.spent != 0) revert LimitExceeded();
            p.spent = 1;
        } else if (p.kind == KIND_ERC1155) {
            uint256 amount = _checkErc1155Call(p, target, value, data);
            if (amount == 0 || amount > p.perTxCap || p.spent + amount > p.totalLimit) revert LimitExceeded();
            p.spent += amount;
        } else {
            revert ScopeMismatch();
        }
    }

    /// @dev Verify `data` is exactly `transfer(to, amount)` on the granted token. Returns amount.
    function _checkErc20Call(Permission storage p, address target, uint256 value, bytes memory data)
        internal
        view
        returns (uint256 amount)
    {
        if (value != 0 || target != p.token) revert ScopeMismatch();
        if (data.length != 68 || _sel(data) != 0xa9059cbb) revert ScopeMismatch();
        address to;
        (to, amount) = abi.decode(_suffix(data), (address, uint256));
        if (to != p.to) revert ScopeMismatch();
    }

    /// @dev Verify `data` moves exactly the granted NFT id from this account to `to`.
    /// Accepts `transferFrom` and 3-arg `safeTransferFrom`; the bytes overload is v1-rejected.
    function _checkErc721Call(Permission storage p, address target, uint256 value, bytes memory data)
        internal
        view
    {
        if (value != 0 || target != p.token) revert ScopeMismatch();
        bytes4 sel = _sel(data);
        if (data.length != 100 || (sel != 0x23b872dd && sel != 0x42842e0e)) revert ScopeMismatch();
        (address from, address to, uint256 id) = abi.decode(_suffix(data), (address, address, uint256));
        if (from != address(this) || to != p.to || id != p.nftId) revert ScopeMismatch();
    }

    /// @dev Verify 1155 `safeTransferFrom(this, to, id, amount, "")` (empty data only, v1).
    function _checkErc1155Call(Permission storage p, address target, uint256 value, bytes memory data)
        internal
        view
        returns (uint256 amount)
    {
        if (value != 0 || target != p.token) revert ScopeMismatch();
        if (data.length < 4 || _sel(data) != 0xf242432a) revert ScopeMismatch();
        address from;
        address to;
        uint256 id;
        bytes memory extra;
        (from, to, id, amount, extra) = abi.decode(_suffix(data), (address, address, uint256, uint256, bytes));
        if (from != address(this) || to != p.to || id != p.nftId || extra.length != 0) revert ScopeMismatch();
    }

    // ---- ERC-7579 module management + execution ----

    /// @notice ERC-7579 account id.
    function accountId() external pure returns (string memory) {
        return "peridot.pid-account.v4";
    }

    /// @notice ERC-7579 `supportsModule`: validators + executors only.
    /// Fallback/handler and hook modules are permanently unsupported (no
    /// delegatecall surface, no pre/post-call injection into auth paths).
    function supportsModule(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR || moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @notice ERC-7579 `supportsExecutionMode`: single `call` only.
    /// Delegatecall and batch modes are permanently unsupported.
    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        return mode == MODE_SINGLE_DEFAULT;
    }

    /// @notice ERC-7579 `isModuleInstalled`.
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata) external view returns (bool) {
        return _modules[moduleTypeId][module];
    }

    /// @notice Read a permission record (for wallets/relayers/revocation UX).
    function getPermission(bytes32 permissionId) external view returns (Permission memory) {
        return _permissions[permissionId];
    }

    /// @notice Install a validator/executor module. Owner-only.
    /// Effects first, `onInstall` callback last (a failing init reverts the install).
    function installModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata initData,
        uint64 deadline,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (!initialized) revert NotInitialized();
        if (moduleTypeId != MODULE_TYPE_VALIDATOR && moduleTypeId != MODULE_TYPE_EXECUTOR) {
            revert UnsupportedModuleType();
        }
        if (module == address(0) || module == address(this)) revert InvalidTarget();
        if (_modules[moduleTypeId][module]) revert AlreadyInstalled();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, OP_INSTALL, block.chainid, address(this), moduleTypeId, module, keccak256(initData),
                nonce, deadline
            )
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        _modules[moduleTypeId][module] = true;
        nonce++;
        emit ModuleInstalled(moduleTypeId, module);
        (bool ok, ) = module.call(abi.encodeWithSignature("onInstall(bytes)", initData));
        if (!ok) revert CallFailed();
    }

    /// @notice Uninstall a module. Owner-only. Effects first, `onUninstall` last.
    function uninstallModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata deInitData,
        uint64 deadline,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (!initialized) revert NotInitialized();
        if (!_modules[moduleTypeId][module]) revert NotModule();
        if (block.timestamp > deadline) revert Expired();
        if (deadline - block.timestamp > MAX_TTL) revert Expired();
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, OP_UNINSTALL, block.chainid, address(this), moduleTypeId, module,
                keccak256(deInitData), nonce, deadline
            )
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        _modules[moduleTypeId][module] = false;
        nonce++;
        emit ModuleUninstalled(moduleTypeId, module);
        (bool ok, ) = module.call(abi.encodeWithSignature("onUninstall(bytes)", deInitData));
        if (!ok) revert CallFailed();
    }

    /// @notice ERC-7579 owner execution. Auth travels INSIDE `executionCalldata`
    /// (the standard leaves validator selection to the account):
    /// `abi.encode(target, value, data, deadline, feePolicyVersion, networkFee,
    /// authenticatorData, clientDataJSON, r, s)`. Single-call mode only.
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable nonReentrant {
        if (mode != MODE_SINGLE_DEFAULT) revert UnsupportedExecutionMode();
        // Scoped decode: the 10 locals die here so only `a` stays live.
        Exec7579Args memory a;
        {
            (
                address target,
                uint256 value,
                bytes memory data,
                uint64 deadline,
                uint16 feePolicyVersion,
                uint256 networkFee,
                bytes memory authenticatorData,
                bytes memory clientDataJSON,
                bytes32 r,
                bytes32 s
            ) = abi.decode(
                executionCalldata, (address, uint256, bytes, uint64, uint16, uint256, bytes, bytes, bytes32, bytes32)
            );
            a = Exec7579Args(
                target, value, data, deadline, feePolicyVersion, networkFee, authenticatorData, clientDataJSON, r, s
            );
        }
        uint256 startGas = gasleft();
        if (!initialized) revert NotInitialized();
        if (a.target == address(this)) revert InvalidTarget();
        if (block.timestamp > a.deadline) revert Expired();
        if (a.deadline - block.timestamp > MAX_TTL) revert Expired();
        uint256 bps = _policyProtocolBps(a.feePolicyVersion);
        bytes32 expected = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, OP_EXEC7579, block.chainid, address(this), nonce, a.target, a.value, keccak256(a.data),
                a.deadline, a.feePolicyVersion
            )
        );
        _verify(expected, a.authenticatorData, a.clientDataJSON, a.r, a.s);
        _checkGasSanity(startGas, a.networkFee);
        uint256 protocolFee = _protocolFee(a.networkFee, bps);
        if (address(this).balance < a.value + a.networkFee + protocolFee) revert InsufficientFunds();
        nonce++;
        (bool ok, ) = a.target.call{value: a.value}(a.data);
        if (!ok) revert CallFailed();
        if (a.networkFee > 0) {
            (ok, ) = msg.sender.call{value: a.networkFee}("");
            if (!ok) revert CallFailed();
        }
        if (protocolFee > 0) {
            (ok, ) = factory.call{value: protocolFee}("");
            if (!ok) revert CallFailed();
        }
        emit Executed(a.target, a.value, a.networkFee, protocolFee, nonce - 1);
    }

    /// @notice ERC-7579 executor path. ONLY installed executor modules.
    /// `executionCalldata` = `abi.encode(permissionId, target, value, data,
    /// deadline, seq, feePolicyVersion, networkFee, feeRecipient,
    /// authenticatorData, clientDataJSON, r, s)`.
    /// All permission checks run inside the account (single audit point); the
    /// executor is a thin forwarder and enforces nothing by itself.
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        nonReentrant
        returns (bytes[] memory returnData)
    {
        if (mode != MODE_SINGLE_DEFAULT) revert UnsupportedExecutionMode();
        if (!_modules[MODULE_TYPE_EXECUTOR][msg.sender]) revert NotModule();
        // Scoped decode: the 13 locals die here so only `a` stays live.
        PermExecArgs memory a;
        {
            (
                bytes32 permissionId,
                address target,
                uint256 value,
                bytes memory data,
                uint64 deadline,
                uint64 seq,
                uint16 feePolicyVersion,
                uint256 networkFee,
                address feeRecipient,
                bytes memory authenticatorData,
                bytes memory clientDataJSON,
                bytes32 r,
                bytes32 s
            ) = abi.decode(
                executionCalldata,
                (
                    bytes32, address, uint256, bytes, uint64, uint64, uint16, uint256, address, bytes, bytes, bytes32,
                    bytes32
                )
            );
            a = PermExecArgs(
                permissionId, target, value, data, deadline, seq, feePolicyVersion, networkFee, feeRecipient,
                authenticatorData, clientDataJSON, r, s
            );
        }
        _executePermission(a);
        returnData = new bytes[](1);
        returnData[0] = _lastResult;
    }

    // ---- ERC-1271 (owner only, defensive rehash) ----

    /// @notice ERC-1271 with defensive rehash (cf. ERC-7739 / Coinbase replaySafeHash).
    /// ONLY owner P-256 signatures over the account+chain-bound payload are valid:
    /// session signatures are never accepted here, and the binding makes a
    /// signature unusable on any other account or chain.
    /// `signature` = `abi.encode(authenticatorData, clientDataJSON, r, s)`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (hash == PROBE_7739_HASH && signature.length == 0) return MAGIC_7739;
        if (!initialized) return MAGIC_1271_INVALID;
        (bytes memory authenticatorData, bytes memory clientDataJSON, bytes32 r, bytes32 s) =
            abi.decode(signature, (bytes, bytes, bytes32, bytes32));
        bytes32 expected =
            keccak256(abi.encodePacked(DOMAIN_V3, OP_1271, block.chainid, address(this), hash));
        if (authenticatorData.length < 37) return MAGIC_1271_INVALID;
        bytes32 rpIdCheck;
        assembly ("memory-safe") {
            rpIdCheck := mload(add(authenticatorData, 32))
        }
        if (rpIdCheck != rpIdHash) return MAGIC_1271_INVALID;
        if (uint8(authenticatorData[32]) & 0x04 == 0) return MAGIC_1271_INVALID;
        bytes32 h = sha256(bytes.concat(authenticatorData, sha256(clientDataJSON)));
        if (_extractChallenge(clientDataJSON) != expected) return MAGIC_1271_INVALID;
        if (!P256.verify(h, r, s, authorityX, authorityY)) return MAGIC_1271_INVALID;
        return MAGIC_1271;
    }

    /// @notice ERC-7579 validator forwarding entrypoint. Same owner-only rule;
    /// `sender` is accepted for interface compliance and bound into nothing —
    /// validity comes solely from the owner signature over the rehashed payload.
    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        return this.isValidSignature(hash, signature);
    }
}
