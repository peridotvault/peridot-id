// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PeridotAccount} from "./PeridotAccount.sol";

/// @title PeridotFactory — CREATE2 factory for counterfactual smart accounts.
/// @notice Salt = `bytes32(pidToSeed32(pid))` (same seed as Solana).
/// Authority is set on `initialize`, so rotation never changes the address.
/// Deploy THIS factory at one address on every chain (keyless CREATE2 deploy of
/// the implementation first, then the factory with identical constructor args)
/// and every account keeps one address on Monad / BSC / Arbitrum.
/// @dev V3: `deployAndInit` is relayer-submitted but user-authorized — the user's
/// passkey binds salt, authority, rpIdHash, policy, deadline, chainid and
/// this factory (no amounts). There is intentionally NO bare `deploy`: a
/// deployed-but-uninitialized proxy plus ungated `initialize` is a squat vector,
/// so the path does not exist.
/// @dev Revenue: the factory itself is the canonical revenue vault — protocol fees
/// accumulate here natively. `admins` may only move revenue out
/// (`withdrawRevenue`); there is deliberately NO path for the factory or its
/// admins to touch user accounts, authorities, nonces, or fee policy. The
/// factory is never a wallet authority.
contract PeridotFactory {
    address public immutable implementation;
    /// @dev Only this address may submit `deployAndInit`. It chooses nothing:
    /// authority, fee policy and recipients are all fixed by the user's signed
    /// authorization + this factory's immutables. Zero address = deploys disabled.
    address public relayer;

    /// @dev Revenue administrators. Constructor-seeded; managed by existing
    /// admins only, with a floor of one (the last admin cannot be removed).
    mapping(address => bool) public admins;

    event Deployed(address indexed account, bytes32 indexed salt);
    event RelayerUpdated(address indexed relayer);
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

    modifier onlyAdmin() {
        if (!admins[msg.sender]) revert NotAdmin();
        _;
    }

    /// @dev Number of current admins (constructor + add/remove accounting).
    /// Enforces the floor of one: the vault must never become unmanageable.
    uint256 public adminCount;

    constructor(address _implementation, address _relayer, address[] memory _admins) {
        if (_admins.length == 0) revert ZeroAddress();
        implementation = _implementation;
        relayer = _relayer;
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

    /// @notice Rotate the relayer (current relayer only). Zero disables deploys.
    function updateRelayer(address _relayer) external {
        if (msg.sender != relayer) revert Unauthorized();
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
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

    /// @notice Deploy + passkey-bound initialize atomically.
    /// Mirrors SVM `activate`: the account is pre-funded at its counterfactual address;
    /// the submitter attests `networkFee`, the account recomputes `protocolFee`
    /// from policy — relayerFee → the submitting relayer (`msg.sender` here;
    /// `msg.sender` inside `initialize` is this factory), protocolFee → this
    /// factory vault. Reverts unless the activation authorization (verified by
    /// the account itself) is valid: no front-run window on the authority,
    /// the policy, or the recipients.
    /// @dev Gas sanity is enforced HERE (not in `initialize`): this frame observes
    /// the full activation cost (clone + init + payouts), while the account only
    /// sees its own sub-frame. `networkFee` beyond 2× measured cost reverts and
    /// rolls the whole atomic deployment back.
    function deployAndInit(
        bytes32 salt,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        uint16 feePolicyVersion,
        uint64 deadline,
        uint256 networkFee,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external returns (address account) {
        uint256 startGas = gasleft();
        if (msg.sender != relayer) revert Unauthorized();
        account = Clones.cloneDeterministic(implementation, salt);
        (bool ok, ) = account.call(
            abi.encodeCall(
                PeridotAccount.initialize,
                (
                    salt,
                    x,
                    y,
                    rpIdHash,
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

    /// @notice Counterfactual address for `salt` (matches `deriveEvmSmartAccountAddress`).
    function predict(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }
}
