// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PeridotPermissionExecutor — ERC-7579 executor module (thin forwarder).
/// @notice Installed on a `PeridotAccount` as a type-2 (executor) module by the
/// owner via `installModule`. It enforces NOTHING by itself: every check
/// (session signature, scope, limits, replay, revocation) runs inside the
/// account's `executeFromExecutor` (single audit point). This contract exists so
/// ERC-7579 tooling, bundlers, and future delegation managers have a standard
/// executor address to route permission executions through.
/// @dev There is intentionally NO delegatecall anywhere in this file. The only
/// external call is `executeFromExecutor` on the account (`call`, own storage
/// context on the account side). `onInstall`/`onUninstall` are deliberate no-ops.
interface IPeridotExecutorAccount {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

contract PeridotPermissionExecutor {
    /// @notice ERC-7579 single default mode (mirrors the account's MODE_SINGLE_DEFAULT).
    bytes32 public constant MODE_SINGLE_DEFAULT = bytes32(0);

    error UnsupportedExecutionMode();

    /// @notice ERC-7579 module type id: this contract is an executor (2) ONLY.
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 2;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    /// @notice Forward a permission execution to the account. Permissionless
    /// submission (relayer is untrusted); authorization is the session signature
    /// inside `executionCalldata`, verified by the account. Reverts unless this
    /// contract is installed as an executor module on `account`.
    /// `executionCalldata` = `abi.encode(permissionId, target, value, data,
    /// deadline, seq, feePolicyVersion, networkFee, feeRecipient,
    /// authenticatorData, clientDataJSON, r, s)`.
    function executeViaPermission(address payable account, bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory)
    {
        if (mode != MODE_SINGLE_DEFAULT) revert UnsupportedExecutionMode();
        return IPeridotExecutorAccount(account).executeFromExecutor{value: msg.value}(mode, executionCalldata);
    }
}
