// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";

/// @notice ANT-866/B1 regression: PID-key binding on-chain.
/// @dev Threat (ANT-860 PoC-E, PROVEN): salt = sha256(pid) is keyless, so an
/// attacker claims the victim's counterfactual with their OWN key and drains
/// the victim's pre-fund. Fix: `salt = keccak256(pidHash ‖ x ‖ y)` derived in
/// the factory + re-enforced in the account (`SaltNotBound`).
/// Victim key = P-256 privkey 1 (generator G); attacker key = privkey 2.
contract PeridotBindB1Test is Test {
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant AX = 0x7CF27B188D034F7E8A52380304B51AC3C08969E277F21B35A60B48FC47669978;
    bytes32 constant AY = 0x07775510DB8ED040293D9AC69F7430DBBA7DADE63CE982299E04B79D227873D1;
    bytes32 constant PID_HASH = 0xd7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa; // sha256("test@pid")

    bytes constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";
    bytes constant DOMAIN_V4 = "PID|EVM|SMART_ACCOUNT|v4";

    PeridotFactory factory;
    bytes32 authPrefix;
    uint256 constant NETWORK_FEE = 0.002 ether;
    uint16 constant POLICY = 1;
    uint64 constant DEADLINE = 1_000_300;
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        authPrefix = sha256("test-rp");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        factory = new PeridotFactory(address(new PeridotAccount()), admins);
    }

    function _authData() internal view returns (bytes memory) {
        return bytes.concat(authPrefix, bytes1(0x05), bytes4(uint32(1)));
    }

    function _clientData(bytes32 challenge) internal pure returns (bytes memory) {
        return bytes.concat(
            '{"type":"webauthn.get","challenge":"',
            bytes(b64url(abi.encodePacked(challenge))),
            '","origin":"test.invalid"}'
        );
    }

    // ---- local base64url (mirrors Base64Url.decode alphabet) ----

    function b64url(bytes memory data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        uint256 outLen = ((len + 2) / 3) * 4 - (3 - (len % 3 == 0 ? 3 : len % 3));
        bytes memory out = new bytes(outLen);
        uint256 j;
        for (uint256 i; i < len;) {
            uint256 b0 = uint8(data[i]);
            uint256 b1 = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 b2 = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 n = (b0 << 16) | (b1 << 8) | b2;
            out[j++] = table[(n >> 18) & 0x3f];
            out[j++] = table[(n >> 12) & 0x3f];
            if (i + 1 < len) out[j++] = table[(n >> 6) & 0x3f];
            if (i + 2 < len) out[j++] = table[n & 0x3f];
            unchecked {
                i += 3;
            }
        }
        return string(out);
    }

    function _signLowS(uint256 privKey, bytes32 digest) internal returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(privKey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
    }

    function _boundSalt(bytes32 pidHash, bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(pidHash, x, y));
    }

    function _actPayload(bytes32 salt, bytes32 x, bytes32 y) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(DOMAIN_V3, uint8(0x05), salt, x, y, POLICY, DEADLINE, block.chainid, address(factory))
        );
    }

    function _actPayloadV4(bytes32 salt, bytes32 x, bytes32 y, uint256 maxFee) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(DOMAIN_V4, uint8(0x05), salt, x, y, POLICY, maxFee, DEADLINE, block.chainid, address(factory))
        );
    }

    function _sigFor(uint256 privKey, bytes32 payload) internal returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) {
        auth = _authData();
        client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _signLowS(privKey, h);
    }

    function _protocolFee(uint256 networkFee) internal pure returns (uint256) {
        return (networkFee * 5000) / 10000;
    }

    // ---- binding properties ----

    /// @dev predictBound matches the SDK derivation; distinct keys diverge.
    function test_PredictBoundMatchesDerivation() public view {
        bytes32 salt = _boundSalt(PID_HASH, GX, GY);
        assertEq(factory.predictBound(PID_HASH, GX, GY), factory.predict(salt));
        assertTrue(factory.predictBound(PID_HASH, GX, GY) != factory.predictBound(PID_HASH, AX, AY));
        assertTrue(factory.predictBound(PID_HASH, GX, GY) != factory.predictBound(bytes32(uint256(1)), GX, GY));
    }

    /// @dev Property: distinct (pidHash, key) inputs give distinct salts.
    function testFuzz_BoundSaltInjective(bytes32 pidA, bytes32 xA, bytes32 yA, bytes32 pidB, bytes32 xB, bytes32 yB)
        public
        pure
    {
        vm.assume(pidA != pidB || xA != xB || yA != yB);
        assertTrue(
            keccak256(abi.encodePacked(pidA, xA, yA)) != keccak256(abi.encodePacked(pidB, xB, yB)),
            "bound salt collision"
        );
    }

    // ---- PoC-E replay: squat attempt lands elsewhere, pre-fund untouched ----

    /// @dev Full ANT-860 PoC-E replay under the fix. Victim pre-funds their
    /// bound address; the attacker (own key, own valid signature) can only
    /// ever deploy THEIR OWN bound address — the victim's 1 ETH stays put.
    function test_SquatLandsElsewherePrefundUntouched() public {
        address victimAddr = factory.predictBound(PID_HASH, GX, GY);
        address attackerAddr = factory.predictBound(PID_HASH, AX, AY);
        assertTrue(victimAddr != attackerAddr);

        // Victim pre-funds counterfactual (salary/escrow to known address).
        vm.deal(victimAddr, 1 ether);
        assertEq(victimAddr.balance, 1 ether);

        // Attacker self-signs a claim for the victim's pid with the ATTACKER key.
        // ANT-863 B2: activation rides the fee-capped V4 path (V3 hard-closed).
        bytes32 saltA = _boundSalt(PID_HASH, AX, AY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigFor(2, _actPayloadV4(saltA, AX, AY, 0));
        address deployed = factory.deployAndInitV4(
            PID_HASH, AX, AY, POLICY, 0, DEADLINE, 0, auth, client, r, s
        );
        assertEq(deployed, attackerAddr);
        assertEq(PeridotAccount(payable(deployed)).authorityX(), AX);
        assertEq(PeridotAccount(payable(deployed)).authorityY(), AY);

        // Victim pre-fund untouched: no code, full balance, unclaimable.
        assertEq(victimAddr.code.length, 0);
        assertEq(victimAddr.balance, 1 ether);
    }

    /// @dev Attacker cannot replay the victim's own authorization with a
    /// substituted key (challenge binds salt + authority).
    function test_SquatWithVictimSigAndAttackerKeyReverts() public {
        address victimAddr = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(victimAddr, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        bytes32 saltV = _boundSalt(PID_HASH, GX, GY);
        uint256 maxTotalFee = NETWORK_FEE + _protocolFee(NETWORK_FEE);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigFor(1, _actPayloadV4(saltV, GX, GY, maxTotalFee));
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(PID_HASH, AX, AY, POLICY, maxTotalFee, DEADLINE, NETWORK_FEE, auth, client, r, s);
        assertEq(victimAddr.code.length, 0);
    }

    /// @dev V3 bound claim now reverts (ANT-863 B2 hard-close): the victim
    /// happy path lives on V4 (`test_BoundClaimHappyPathV4`). The victim
    /// address stays unclaimed — no code, pre-fund intact.
    function test_BoundClaimHappyPath() public {
        address victimAddr = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(victimAddr, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        bytes32 saltV = _boundSalt(PID_HASH, GX, GY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigFor(1, _actPayload(saltV, GX, GY));
        vm.expectRevert(PeridotFactory.V3Deprecated.selector);
        factory.deployAndInit(
            PID_HASH, GX, GY, POLICY, DEADLINE, NETWORK_FEE, auth, client, r, s
        );
        assertEq(victimAddr.code.length, 0);
    }

    // ---- account-level gate: SaltNotBound ----

    /// @dev A foreign/malicious factory fronting the same implementation cannot
    /// smuggle an unbound salt: the account re-enforces the equation pre-verify
    /// (garbage signature suffices — the gate fires first).
    function test_InitializeRejectsUnboundSalt() public {
        address proxy = Clones.clone(address(new PeridotAccount()));
        PeridotAccount account = PeridotAccount(payable(proxy));
        vm.expectRevert(PeridotAccount.SaltNotBound.selector);
        account.initialize(
            bytes32(uint256(7)), GX, GY, PID_HASH, POLICY, DEADLINE, NETWORK_FEE,
            address(this), address(this),
            _authData(), _clientData(bytes32(uint256(1))), bytes32(0), bytes32(0)
        );
    }

    /// @dev Fuzz the gate: any (salt, pidHash) pair off the binding equation reverts.
    function testFuzz_InitializeRejectsUnboundSalt(bytes32 salt, bytes32 pidHash) public {
        vm.assume(salt != keccak256(abi.encodePacked(pidHash, GX, GY)));
        address proxy = Clones.clone(address(new PeridotAccount()));
        PeridotAccount account = PeridotAccount(payable(proxy));
        vm.expectRevert(PeridotAccount.SaltNotBound.selector);
        account.initialize(
            salt, GX, GY, pidHash, POLICY, DEADLINE, NETWORK_FEE,
            address(this), address(this),
            _authData(), _clientData(bytes32(uint256(1))), bytes32(0), bytes32(0)
        );
    }

    // ---- V4 bound activation ----

    /// @dev V4 (fee-capped) activation is identically PID-key bound.
    function test_BoundClaimHappyPathV4() public {
        uint256 maxTotalFee = NETWORK_FEE + _protocolFee(NETWORK_FEE);
        bytes32 saltV = _boundSalt(PID_HASH, GX, GY);
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x05), saltV, GX, GY, POLICY, maxTotalFee, DEADLINE, block.chainid, address(factory)
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigFor(1, payload);
        address victimAddr = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(victimAddr, maxTotalFee);
        address deployed = factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, maxTotalFee, DEADLINE, NETWORK_FEE, auth, client, r, s
        );
        assertEq(deployed, victimAddr);
        assertTrue(PeridotAccount(payable(deployed)).initialized());
    }
}
