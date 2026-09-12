// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";

/// @notice Deploy implementation + factory. Env: IMPLEMENTATION (optional reuse),
/// DEPLOYER_PRIVATE_KEY. Same-address flow: first deploy the implementation via
/// the keyless CREATE2 deployer on every chain, then set IMPLEMENTATION and run
/// this script the same way so the factory lands at one address everywhere.
/// See README.md.
contract Deploy is Script {
    function run() external {
        address implementation = vm.envOr("IMPLEMENTATION", address(0));
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(key);
        if (implementation == address(0)) {
            implementation = address(new PeridotAccount());
        }
        PeridotFactory factory = new PeridotFactory(implementation);
        vm.stopBroadcast();
        console.log("IMPLEMENTATION=%s", implementation);
        console.log("FACTORY=%s", address(factory));
        console.log("INIT_CODE_HASH=%s", vm.toString(factoryCreationCodeHash(implementation)));
    }

    /// @dev keccak256 of the EIP-1167 proxy creation code — the value
    /// `deriveEvmSmartAccountAddress` needs alongside the factory address.
    function factoryCreationCodeHash(address implementation) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                bytes20(implementation),
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
    }
}
