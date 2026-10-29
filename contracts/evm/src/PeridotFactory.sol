// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PeridotAccount} from "./PeridotAccount.sol";

/// @title PeridotFactory — CREATE2 factory for counterfactual smart accounts.
/// @notice Salt is PID-KEY BOUND (ANT-866/B1): `salt = keccak256(pidHash ‖ x ‖ y)`
/// where `pidHash = sha256(pid)` (same seed as Solana). The factory computes the
/// salt itself from the caller's `(pidHash, x, y)` — no entrypoint accepts a raw
/// salt, so counterfactual funding at a bound address is unclaimable by any
/// non-owner: a different key derives a different address, and forging the
/// victim's salt needs a keccak preimage. Pre-B1 salts (`sha256(pid)`, keyless)
/// are unclaimable under the bound account gate (`SaltNotBound`); SDK/API must
/// fund only bound addresses.
/// Authority is set on `initialize`, so rotation never changes the address
/// (binding is claim-time: rotation keeps the original claiming key's salt).
/// Deploy THIS factory at one address on every chain (keyless CREATE2 deploy of
/// the implementation first, then the factory with identical constructor args)
/// and every account keeps one address on Monad / BSC / Arbitrum.
/// @dev V3: `deployAndInit` is permissionless but user-authorized — any submitter
/// (official relayer, volunteer, or the user self-relaying) may call; the user's
/// passkey binds salt, authority, policy, deadline, chainid and
/// this factory (no amounts). There is intentionally NO bare `deploy`: a
/// deployed-but-uninitialized proxy plus ungated `initialize` is a squat vector,
/// so the path does not exist.
/// @dev Revenue: the factory itself is the canonical revenue vault — protocol fees
/// accumulate here natively. `admins` may only move revenue out
/// (`withdrawRevenue`); there is deliberately NO path for the factory or its
/// admins to touch user accounts, authorities, nonces, or fee policy. The
/// factory is never a wallet authority.
/// @dev Kill-switch replacing the relayer gate (ANT-610 §3.2): `deploysPaused`
/// (admin-only, default off) halts new creation; spend + revenue paths
/// are untouched.
contract PeridotFactory {
    address public immutable implementation;

    /// @dev Revenue administrators. Constructor-seeded; managed by existing
    /// admins only, with a floor of one (the last admin cannot be removed).
    mapping(address => bool) public admins;

    /// @dev Creation kill-switch (ANT-610 §3.2). `false` = creation enabled.
    /// Only creation halts when `true`; existing accounts (`execute`) and
    /// `withdrawRevenue` are untouched.
    bool public deploysPaused;

    event Deployed(address indexed account, bytes32 indexed salt);
    event DeploysPaused(bool paused);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    event RevenueWithdrawn(address indexed destination, uint256 amount);

    error InitFailed();
    error Unauthorized();
    error NotAdmin();
    error ZeroAddress();
    error LastAdmin();
    error InsufficientRevenue();
    error RevenueTransferFailed();
    error GasAnomaly();
    error Paused();

    modifier onlyAdmin() {
        if (!admins[msg.sender]) revert NotAdmin();
        _;
    }

    /// @dev Number of current admins (constructor + add/remove accounting).
    /// Enforces the floor of one: the vault must never become unmanageable.
    uint256 public adminCount;

    constructor(address _implementation, address[] memory _admins) {
        if (_admins.length == 0) revert ZeroAddress();
        implementation = _implementation;
        for (uint256 i = 0; i < _admins.length; i++) {
            if (_admins[i] == address(0)) revert ZeroAddress();
            if (!admins[_admins[i]]) {
                admins[_admins[i]] = true;
                adminCount++;
                emit AdminAdded(_admins[i]);
            }
        }
    }

    /// @notice Accept protocol revenue (called by accounts paying protocolFee).
    receive() external payable {}

    /// @notice Pause/unpause creation (admin only). Paused creation reverts
    /// `Paused()`; existing accounts and revenue are unaffected.
    function setDeploysPaused(bool paused) external onlyAdmin {
        deploysPaused = paused;
        emit DeploysPaused(paused);
    }

    /// @notice Add a revenue administrator (existing admin only).
    function addAdmin(address admin) external onlyAdmin {
        if (admin == address(0)) revert ZeroAddress();
        if (!admins[admin]) {
            admins[admin] = true;
            adminCount++;
            emit AdminAdded(admin);
        }
    }

    /// @notice Remove a revenue administrator (existing admin only).
    /// Reverts when it would empty the set: the vault must never become
    /// unmanageable, and no single call can strand the revenue.
    function removeAdmin(address admin) external onlyAdmin {
        if (!admins[admin]) revert NotAdmin();
        if (adminCount <= 1) revert LastAdmin();
        admins[admin] = false;
        adminCount--;
        emit AdminRemoved(admin);
    }

    /// @notice Move accumulated protocol revenue out (admin only).
    /// Destination/amount are the admin's operational choice per withdrawal;
    /// there is no mutable treasury registry — the vault IS this factory.
    function withdrawRevenue(address payable destination, uint256 amount) external onlyAdmin {
        if (destination == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert InsufficientRevenue();
        (bool ok, ) = destination.call{value: amount}("");
        if (!ok) revert RevenueTransferFailed();
        emit RevenueWithdrawn(destination, amount);
    }

    /// @notice Deploy + passkey-bound initialize atomically. Permissionless
    /// (ANT-610): ANY submitter may call — the account itself verifies the
    /// activation authorization, so no front-run window exists on the authority,
    /// the policy, or the recipients.
    /// Mirrors SVM `activate`: the account is pre-funded at its counterfactual address;
    /// the submitter attests `networkFee`, the account recomputes `protocolFee`
    /// from policy — relayerFee → the submitting caller (`msg.sender` here;
    /// `msg.sender` inside `initialize` is this factory), protocolFee → this
    /// factory vault. Reverts unless the activation authorization (verified by
    /// the account itself) is valid: no front-run window on the authority,
    /// the policy, or the recipients.
    /// @dev B1 binding (ANT-866): `salt = keccak256(pidHash ‖ x ‖ y)` is derived
    /// HERE, never caller-supplied. The account re-enforces the same equation
    /// (`SaltNotBound`) so even a foreign factory fronting the same
    /// implementation cannot smuggle an unbound salt.
    /// @dev Gas sanity is enforced HERE (not in `initialize`): this frame observes
    /// the full activation cost (clone + init + payouts), while the account only
    /// sees its own sub-frame. `networkFee` beyond 2× measured cost reverts and
    /// rolls the whole atomic deployment back.
    function deployAndInit(
        bytes32 pidHash,
        bytes32 x,
        bytes32 y,
        uint16 feePolicyVersion,
        uint64 deadline,
        uint256 networkFee,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external returns (address account) {
        uint256 startGas = gasleft();
        if (deploysPaused) revert Paused();
        bytes32 salt = keccak256(abi.encodePacked(pidHash, x, y));
        account = Clones.cloneDeterministic(implementation, salt);
        (bool ok, ) = account.call(
            abi.encodeCall(
                PeridotAccount.initialize,
                (
                    salt,
                    x,
                    y,
                    pidHash,
                    feePolicyVersion,
                    deadline,
                    networkFee,
                    address(this),
                    msg.sender,
                    authenticatorData,
                    clientDataJSON,
                    r,
                    s
                )
            )
        );
        if (!ok) revert InitFailed();
        if (networkFee > (startGas - gasleft()) * tx.gasprice * 2) revert GasAnomaly();
        emit Deployed(account, salt);
    }

    /// @notice Deploy + passkey-bound initialize atomically (v2, ANT-556).
    /// V4 sibling of `deployAndInit` (frozen): forwards to the account's
    /// fee-capped `initializeV4`, so the activation authorization carries the
    /// user-approved `maxTotalFee`. Gas sanity is enforced on this frame exactly
    /// as in `deployAndInit`. Salt derivation is identically PID-key bound
    /// (ANT-866/B1): `salt = keccak256(pidHash ‖ x ‖ y)` derived here.
    function deployAndInitV4(
        bytes32 pidHash,
        bytes32 x,
        bytes32 y,
        uint16 feePolicyVersion,
        uint256 maxTotalFee,
        uint64 deadline,
        uint256 networkFee,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external returns (address account) {
        uint256 startGas = gasleft();
        if (deploysPaused) revert Paused();
        bytes32 salt = keccak256(abi.encodePacked(pidHash, x, y));
        account = Clones.cloneDeterministic(implementation, salt);
        (bool ok, ) = account.call(
            abi.encodeCall(
                PeridotAccount.initializeV4,
                (
                    salt,
                    x,
                    y,
                    pidHash,
                    feePolicyVersion,
                    maxTotalFee,
                    deadline,
                    networkFee,
                    address(this),
                    msg.sender,
                    authenticatorData,
                    clientDataJSON,
                    r,
                    s
                )
            )
        );
        if (!ok) revert InitFailed();
        if (networkFee > (startGas - gasleft()) * tx.gasprice * 2) revert GasAnomaly();
        emit Deployed(account, salt);
    }

    /// @notice Counterfactual address for a raw `salt` (legacy pre-B1
    /// derivation; kept as a pure view for indexers — new flows use
    /// `predictBound`).
    function predict(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    /// @notice Counterfactual address for a PID-key bound claim
    /// (matches `deriveEvmSmartAccountAddressBound` in the SDK).
    function predictBound(bytes32 pidHash, bytes32 x, bytes32 y) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, keccak256(abi.encodePacked(pidHash, x, y)));
    }
}
