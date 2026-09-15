// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PeridotAccount} from "./PeridotAccount.sol";

/// @title PeridotFactory — CREATE2 factory for counterfactual smart accounts.
/// @notice Salt = `bytes32(pidToSeed32(pid))` (same seed as Solana).
/// Authority is set on `initialize`, so rotation never changes the address.
/// Deploy THIS factory at one address on every chain (keyless CREATE2 deploy of
/// the implementation first, then the factory) and every account keeps one
/// address on Monad / BSC / Arbitrum.
contract PeridotFactory {
    address public immutable implementation;
    /// @dev Only this address may deploy/initialize. Closes the squat + prefund-drain
    /// vectors: attacker factories derive different addresses, and both deploy paths
    /// here are gated. Zero address = deploys disabled (kill-switch).
    address public relayer;

    event Deployed(address indexed account, bytes32 indexed salt);
    event RelayerUpdated(address indexed relayer);

    error InitFailed();
    error Unauthorized();

    constructor(address _implementation, address _relayer) {
        implementation = _implementation;
        relayer = _relayer;
    }

    /// @notice Rotate the relayer (current relayer only). Zero disables deploys.
    function updateRelayer(address _relayer) external {
        if (msg.sender != relayer) revert Unauthorized();
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    /// @notice Deploy the proxy for `salt` (reverts if already deployed).
    function deploy(bytes32 salt) external returns (address account) {
        if (msg.sender != relayer) revert Unauthorized();
        account = Clones.cloneDeterministic(implementation, salt);
        emit Deployed(account, salt);
    }

    /// @notice Deploy + initialize atomically (no front-run window on the authority).
    /// Mirrors SVM `activate`: the account is pre-funded at its counterfactual address
    /// and `activationFee` is pulled to `treasury` on init — pass 0 to skip the fee.
    function deployAndInit(
        bytes32 salt,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        uint256 activationFee,
        address treasury
    ) external returns (address account) {
        if (msg.sender != relayer) revert Unauthorized();
        account = Clones.cloneDeterministic(implementation, salt);
        (bool ok, ) =
            account.call(abi.encodeCall(PeridotAccount.initialize, (x, y, rpIdHash, activationFee, treasury)));
        if (!ok) revert InitFailed();
        emit Deployed(account, salt);
    }

    /// @notice Counterfactual address for `salt` (matches `deriveEvmSmartAccountAddress`).
    function predict(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }
}
