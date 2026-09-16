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
    uint256[44] private __gap;

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

    event Initialized(bytes32 x, bytes32 y, uint256 networkFee, uint256 protocolFee);
    event Executed(address indexed to, uint256 value, uint256 networkFee, uint256 protocolFee, uint64 nonce);
    event AuthorityUpdated(bytes32 x, bytes32 y, uint64 nonce);

    /// @dev No constructor args so the implementation is redeployable at one
    /// address on every chain (keyless CREATE2 deploy) — the factory embeds it.
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
    ) external {
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
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) internal view {
        // 1. RP-ID + user verification (first 32B of authenticatorData, flag bit 0x04).
        if (authenticatorData.length < 37) revert Unauthorized();
        if (bytes32(authenticatorData[0:32]) != rpIdHash) revert Unauthorized();
        if (uint8(authenticatorData[32]) & 0x04 == 0) revert Unauthorized();
        // 2. Signed message binds the exact attested bytes.
        bytes32 h = sha256(bytes.concat(authenticatorData, sha256(clientDataJSON)));
        // 3. Challenge inside clientDataJSON must equal the payload (no substitution).
        if (_extractChallenge(clientDataJSON) != expectedPayload) revert InvalidChallenge();
        // 4. P-256 signature over the authority key (low-S enforced inside OZ P256).
        if (!P256.verify(h, r, s, authorityX, authorityY)) revert Unauthorized();
    }

    /// @dev Extract `"challenge":"<base64url>"` and decode it to 32 bytes.
    function _extractChallenge(bytes calldata json) internal pure returns (bytes32) {
        bytes memory marker = bytes('"challenge":"');
        uint256 start = _find(json, marker);
        if (start == type(uint256).max) revert InvalidChallenge();
        start += marker.length;
        uint256 end = start;
        while (end < json.length && json[end] != '"') end++;
        if (end == json.length) revert InvalidChallenge();
        bytes memory decoded = Base64Url.decode(json[start:end]);
        if (decoded.length != 32) revert InvalidChallenge();
        return bytes32(decoded);
    }

    /// @dev Naive subslice search (clientDataJSON is small, runs once per tx).
    function _find(bytes calldata haystack, bytes memory needle) internal pure returns (uint256) {
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
}
