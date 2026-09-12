// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PeridotAccount} from "./PeridotAccount.sol";

/// @title PeridotFactory — CREATE2 factory for counterfactual smart accounts.
/// @notice Salt = `bytes32(accountIdToSeed32(pidAccount.id))` (same seed as Solana).
/// Authority is set on `initialize`, so rotation never changes the address.
/// Deploy THIS factory at one address on every chain (keyless CREATE2 deploy of
/// the implementation first, then the factory) and every account keeps one
/// address on Monad / BSC / Arbitrum.
contract PeridotFactory {
    address public immutable implementation;

    event Deployed(address indexed account, bytes32 indexed salt);

    error InitFailed();

    constructor(address _implementation) {
        implementation = _implementation;
    }

    /// @notice Deploy the proxy for `salt` (reverts if already deployed).
    function deploy(bytes32 salt) external returns (address account) {
        account = Clones.cloneDeterministic(implementation, salt);
        emit Deployed(account, salt);
    }

    /// @notice Deploy + initialize atomically (no front-run window on the authority).
    function deployAndInit(bytes32 salt, bytes32 x, bytes32 y, bytes32 rpIdHash)
        external
        returns (address account)
    {
        account = Clones.cloneDeterministic(implementation, salt);
        (bool ok, ) = account.call(abi.encodeCall(PeridotAccount.initialize, (x, y, rpIdHash)));
        if (!ok) revert InitFailed();
        emit Deployed(account, salt);
    }

    /// @notice Counterfactual address for `salt` (matches `deriveEvmSmartAccountAddress`).
    function predict(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }
}
