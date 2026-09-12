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

    // Happy-path vector (filled from test_LogVector output, signed externally).
    // To regenerate: run test_LogVector, sign `h` with privkey 1, paste r/s.
    bytes32 constant VEC_R = 0x481faf362101090d443ac8fa0d8463771fd1c119e0345aedc79426fae3171283;
    bytes32 constant VEC_S = 0x175a33e15040aee80f26550b77ed9c15d75554cdf8bf6dda1b2c3da08bc5c3e9;
    bool constant VEC_READY = true;

    function setUp() public {
        vm.warp(1_000_000);
        rpIdHash = sha256("localhost");
        factory = new PeridotFactory(address(new PeridotAccount()));
        account = PeridotAccount(payable(factory.deployAndInit(SALT, GX, GY, rpIdHash)));
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
            abi.encodePacked(account.DOMAIN(), block.chainid, address(account), nonce, to, value, keccak256(data), deadline)
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
        account.initialize(GX, GY, rpIdHash);
    }

    function test_ExecuteHappyPath() public {
        if (!VEC_READY) return; // vector not pasted yet — see test_LogVector
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        account.execute(to, 0, "", deadline, authData, clientData, VEC_R, VEC_S);
        assertEq(account.nonce(), 1);
    }

    function test_ExecuteRejectsExpired() public {
        address to = address(0x1234);
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(_payload(to, 0, "", 999_999, 0));
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.execute(to, 0, "", 999_999, authData, clientData, bytes32(0), bytes32(0));
    }

    function test_ExecuteRejectsBadChallenge() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = _authData();
        bytes memory clientData = _clientData(bytes32(uint256(1234))); // wrong challenge
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.execute(to, 0, "", deadline, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsWrongRpId() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = bytes.concat(sha256("evil.example"), bytes1(0x05), bytes4(uint32(1)));
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", deadline, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_ExecuteRejectsNoUserVerification() public {
        address to = address(0x1234);
        uint64 deadline = 1_000_300;
        bytes memory authData = bytes.concat(rpIdHash, bytes1(0x01), bytes4(uint32(1))); // UP only
        bytes memory clientData = _clientData(_payload(to, 0, "", deadline, 0));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", deadline, authData, clientData, bytes32(uint256(1)), bytes32(uint256(2)));
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
        account.execute(to, 0, "", deadline, authData, clientData, VEC_R, highS);
    }

    function test_UpdateAuthorityRejectsBadChallenge() public {
        // Challenge check fires before signature verification (mirrors auth.rs order).
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.updateAuthority(bytes32(uint256(9)), bytes32(uint256(9)), 1_000_300, _authData(), _clientData(bytes32(uint256(1))), bytes32(uint256(1)), bytes32(uint256(2)));
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
        PeridotFactory f = new PeridotFactory(address(impl));
        bytes32 salt = 0x00000000000000000000000000000000b3f1e6a92c4d4f8b9a3e8d7c5b2a1f9e;
        console.log("PARITY_FACTORY=%s", address(f));
        console.log("PARITY_IMPL=%s", address(impl));
        console.log("PARITY_PREDICT=%s", f.predict(salt));
    }
}

contract PayloadParityTest is Test {
    function test_LogPayload() public {
        PeridotAccount impl = new PeridotAccount();
        PeridotFactory f = new PeridotFactory(address(impl));
        PeridotAccount a = PeridotAccount(payable(f.deploy(bytes32(uint256(7)))));
        address to = address(0x1234);
        bytes32 payload = keccak256(
            abi.encodePacked(a.DOMAIN(), block.chainid, address(a), uint64(0), to, uint256(0), keccak256(""), uint64(1_000_300))
        );
        console.log("PAYLOAD_ACCOUNT=%s", address(a));
        console.logBytes32(payload);
    }
}
