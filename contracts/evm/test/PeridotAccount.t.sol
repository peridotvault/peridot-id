// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";

/// @notice Factory/account tests. Happy-path execute uses a real P-256 signature
/// by privkey 1 (pubkey = generator G) over the logged vector — see
/// `test_LogVector` + `test/vectors/README.md` for regeneration.
contract PeridotAccountTest is Test {
    // P-256 generator = pubkey of privkey 1.
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant SALT = bytes32(uint256(7));

    PeridotFactory factory;
    PeridotAccount account;
    bytes32 rpIdHash;
    address constant TREASURY = address(0xBEEF);
    uint256 constant RELAY_FEE = 0.001 ether;

    // Happy-path vector (filled from test_LogVector output, signed externally).
    // To regenerate: run test_LogVector, sign `h` with privkey 1, paste r/s.
    bytes32 constant VEC_R = 0x4f7b758dbdbb8868e1d91660ada040161d1d28bf3b3f153fa1b34482fb452f47;
    bytes32 constant VEC_S = 0x62d6037bec54a3ef145fa73225b9cf96e0463535a069896c2873e84645ba8aa4;
    bool constant VEC_READY = true;

    function setUp() public {
        vm.warp(1_000_000);
        rpIdHash = sha256("localhost");
        factory = new PeridotFactory(address(new PeridotAccount()), address(this));
        account = PeridotAccount(payable(factory.deployAndInit(SALT, GX, GY, rpIdHash, 0, address(0))));
    }

    function _authData() internal view returns (bytes memory) {
        return bytes.concat(rpIdHash, bytes1(0x05), bytes4(uint32(1)));
    }

    function _clientData(bytes32 challenge) internal pure returns (bytes memory) {
        return bytes.concat(
            '{"type":"webauthn.get","challenge":"',
            bytes(b64url(abi.encodePacked(challenge))),
            '","origin":"http://localhost:8081"}'
        );
    }

    function _payload(address to, uint256 value, bytes memory data, uint64 deadline, uint64 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                account.DOMAIN(),
                block.chainid,
                address(account),
                nonce,
                to,
                value,
                keccak256(data),
                deadline,
                RELAY_FEE,
                TREASURY
            )
        );
    }

    /// @dev One-time helper: logs the exact bytes to sign for the happy-path vector.
    function test_LogVector() public view {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes32 payload = _payload(to, 0, "", deadline, 0);
        bytes memory clientData = _clientData(payload);
        bytes32 h = sha256(bytes.concat(authData, sha256(clientData)));
        console.log("ACCOUNT=%s", address(account));
        console.logBytes32(payload);
        console.logBytes32(h);
        console.log(string(bytes.concat("CLIENTDATA=", clientData)));
    }

    function test_PredictMatchesDeploy() public {
        bytes32 salt = keccak256("anything");
        assertEq(factory.predict(salt), factory.deploy(salt));
    }

    function test_PredictMatchesDeployFuzz(bytes32 salt) public {
        assertEq(factory.predict(salt), factory.deploy(salt));
    }

    function test_DoubleInitReverts() public {
        vm.expectRevert(PeridotAccount.AlreadyInitialized.selector);
        account.initialize(GX, GY, rpIdHash, 0, address(0));
    }

    function test_ExecuteHappyPath() public {
        if (!VEC_READY) return; // vector not pasted yet — see test_LogVector
        vm.deal(address(account), RELAY_FEE);
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, authData, clientData, VEC_R, VEC_S);
        assertEq(account.nonce(), 1);
        assertEq(TREASURY.balance, RELAY_FEE);
        assertEq(address(account).balance, 0);
    }

    function test_ExecuteRejectsExpired() public {
        address to = address(0x1234);
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(_payload(to, 0, "", 999_999, 0));
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.execute(to, 0, "", 999_999, RELAY_FEE, TREASURY, authData, clientData, bytes32(0), bytes32(0));
    }

    function test_ExecuteRejectsBadChallenge() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(bytes32(uint256(1234))); // wrong challenge
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsWrongRpId() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = bytes.concat(sha256("evil.example"), bytes1(0x05), bytes4(uint32(1)));
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsNoUserVerification() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = bytes.concat(rpIdHash, bytes1(0x01), bytes4(uint32(1))); // UP only
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsHighS() public {
        // Solana secp256r1 precompile parity: high-S signatures are malleable, rejected.
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        uint256 n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
        bytes32 highS = bytes32(n - uint256(VEC_S));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, authData, clientData, VEC_R, highS);
    }

    function test_UpdateAuthorityRejectsBadChallenge() public {
        // Challenge check fires before signature verification (mirrors auth.rs order).
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.updateAuthority(bytes32(uint256(9)), bytes32(uint256(9)), 1_000_300, _authData(), _clientData(bytes32(uint256(1))), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsOvercharge() public {
        // Fee is inside the signed payload: swapping it invalidates the challenge.
        vm.deal(address(account), RELAY_FEE + 1);
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE + 1, TREASURY, _authData(), clientData, VEC_R, VEC_S);
    }

    function test_ExecuteRejectsInsufficientFunds() public {
        // Unfunded account cannot cover value + relay fee (mirrors SVM InsufficientFunds).
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.InsufficientFunds.selector);
        account.execute(to, 0, "", deadline, RELAY_FEE, TREASURY, _authData(), clientData, VEC_R, VEC_S);
    }

    function test_DeployAndInitPullsActivationFee() public {
        // Mirrors SVM `activate`: pre-funded counterfactual, fee pulled to treasury on init.
        bytes32 salt = keccak256("activation-fee");
        address predicted = factory.predict(salt);
        uint256 fee = 0.01 ether;
        vm.deal(predicted, fee);
        address deployed =
            factory.deployAndInit(salt, GX, GY, rpIdHash, fee, TREASURY);
        assertEq(deployed, predicted);
        assertEq(TREASURY.balance, fee);
        assertEq(predicted.balance, 0);
        assertEq(PeridotAccount(payable(deployed)).nonce(), 0);
    }

    function test_DeployAndInitSkipsZeroFee() public {
        bytes32 salt = keccak256("no-fee");
        address deployed = factory.deployAndInit(salt, GX, GY, rpIdHash, 0, address(0));
        assertEq(deployed, factory.predict(salt));
    }

    function test_DeployRejectsStranger() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        factory.deploy(keccak256("squat"));
    }

    function test_DeployAndInitRejectsStranger() public {
        // No squat, no prefund drain: only the relayer reaches `initialize`.
        vm.prank(address(0xBAD));
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        factory.deployAndInit(keccak256("squat"), GX, GY, rpIdHash, 1 ether, address(0xBAD));
    }

    function test_UpdateRelayer() public {
        address next = address(0xCAFE);
        vm.prank(address(0xBAD));
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        factory.updateRelayer(next);
        factory.updateRelayer(next);
        assertEq(factory.relayer(), next);
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        factory.deploy(keccak256("old-relayer"));
        vm.prank(next);
        factory.deploy(keccak256("new-relayer"));
    }

    /// @dev base64url (no padding) encoder for building clientDataJSON challenges.
    function b64url(bytes memory data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        uint256 chars = (len * 8 + 5) / 6;
        bytes memory out = new bytes(chars);
        uint256 j;
        for (uint256 i = 0; i < len; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 n = (a << 16) | (b << 8) | c;
            unchecked {
                out[j++] = table[(n >> 18) & 63];
                out[j++] = table[(n >> 12) & 63];
                if (j < chars) out[j++] = table[(n >> 6) & 63];
                if (j < chars) out[j++] = table[n & 63];
            }
        }
        return string(out);
    }
}

contract Create2ParityTest is Test {
    function test_LogCreate2Parity() public {
        PeridotAccount impl = new PeridotAccount();
        PeridotFactory f = new PeridotFactory(address(impl), address(this));
        bytes32 salt = 0x00000000000000000000000000000000b3f1e6a92c4d4f8b9a3e8d7c5b2a1f9e;
        console.log("PARITY_FACTORY=%s", address(f));
        console.log("PARITY_IMPL=%s", address(impl));
        console.log("PARITY_PREDICT=%s", f.predict(salt));
    }
}

contract PayloadParityTest is Test {
    function test_LogPayload() public {
        PeridotAccount impl = new PeridotAccount();
        PeridotFactory f = new PeridotFactory(address(impl), address(this));
        PeridotAccount a = PeridotAccount(payable(f.deploy(bytes32(uint256(7)))));
        address to = address(0x1234);
        bytes32 payload = keccak256(
            abi.encodePacked(
                a.DOMAIN(),
                block.chainid,
                address(a),
                uint64(0),
                to,
                uint256(0),
                keccak256(""),
                uint64(1_000_300),
                uint256(0),
                address(0)
            )
        );
        console.log("PAYLOAD_ACCOUNT=%s", address(a));
        console.logBytes32(payload);
    }
}
