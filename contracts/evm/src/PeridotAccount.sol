// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64Url} from "./Base64Url.sol";

/// @title PeridotAccount — passkey-owned smart account.
/// @notice EVM counterpart of the Solana smart-account program: the authority is a
/// secp256r1 (P-256) WebAuthn passkey. Deployed as an EIP-1167 minimal proxy behind
/// `PeridotFactory` (CREATE2), so the address is counterfactual and identical on
/// every chain that shares the factory. The passkey signs
/// `authenticatorData ‖ sha256(clientDataJSON)` with the domain-separated payload
/// as the WebAuthn challenge — the same binding as `auth.rs::verify_secp256r1`.
contract PeridotAccount {
    /// @dev Raw ASCII domain, matching `DOMAIN_EVM` in `packages/core/src/evm.ts`
    /// (kept unhashed like Solana's `DOMAIN` — the payload hash covers it).
    bytes public constant DOMAIN = "PID|EVM|SMART_ACCOUNT|v1";

    bytes32 public authorityX;
    bytes32 public authorityY;
    /// @dev sha256 of the WebAuthn RP ID; must equal `authenticatorData[0:32]`.
    bytes32 public rpIdHash;
    uint64 public nonce;
    bool public initialized;

    error AlreadyInitialized();
    error NotInitialized();
    error Unauthorized();
    error InvalidChallenge();
    error Expired();
    error CallFailed();
    error ZeroAuthority();

    event Initialized(bytes32 x, bytes32 y);
    event Executed(address indexed to, uint256 value, uint64 nonce);
    event AuthorityUpdated(bytes32 x, bytes32 y, uint64 nonce);

    /// @dev No constructor args so the implementation is redeployable at one
    /// address on every chain (keyless CREATE2 deploy) — the factory embeds it.
    function initialize(bytes32 x, bytes32 y, bytes32 _rpIdHash) external {
        if (initialized) revert AlreadyInitialized();
        if (x == 0 && y == 0) revert ZeroAuthority();
        authorityX = x;
        authorityY = y;
        rpIdHash = _rpIdHash;
        initialized = true;
        emit Initialized(x, y);
    }

    receive() external payable {}

    /// @notice Execute a call authorized by the passkey.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 deadline,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (!initialized) revert NotInitialized();
        if (block.timestamp > deadline) revert Expired();
        bytes32 expected = keccak256(
            abi.encodePacked(DOMAIN, block.chainid, address(this), nonce, to, value, keccak256(data), deadline)
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        uint64 n = nonce++;
        (bool ok, ) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(to, value, n);
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
        bytes32 expected = keccak256(
            abi.encodePacked(DOMAIN, block.chainid, address(this), nonce, newX, newY, deadline)
        );
        _verify(expected, authenticatorData, clientDataJSON, r, s);
        authorityX = newX;
        authorityY = newY;
        uint64 n = nonce++;
        emit AuthorityUpdated(newX, newY, n);
    }

    /// @dev Mirrors `auth.rs::verify_secp256r1`: signer == stored authority,
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
