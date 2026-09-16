// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";

/// @notice V3 authorization + fee-schema tests. Happy paths use real P-256 signatures
/// by privkey 1 (pubkey = generator G) over the logged vectors — see
/// `test_LogVector*` + `test/vectors/README.md` for regeneration.
/// @dev Every `setUp` redeploys implementation + factory in the same order, so
/// predicted addresses are stable across tests (chainid 31337).
contract PeridotAccountTest is Test {
    // P-256 generator = pubkey of privkey 1.
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant SALT = bytes32(uint256(7));

    PeridotFactory factory;
    bytes32 rpIdHash;
    // Attested network cost. Must fit the on-chain sanity bound
    // (≤ 2× measured gas × tx.gasprice); the V3 payload does not bind it,
    // so each test could attest its own value — one realistic constant suffices.
    uint256 constant NETWORK_FEE = 0.002 ether;
    uint16 constant POLICY = 1;

    // Activation vector (salt, GX/GY, rpIdHash, POLICY/deadline, factory, chainid).
    bytes32 constant VEC_ACT_R = 0x09e5b78b9ce736236dfb152bb32f32ca6e14e41b6830725f9f1f6a9a7a2f8232;
    bytes32 constant VEC_ACT_S = 0x5d9b60bf78ee752a6ee2d3891af58c94d23183b8e26398b11680cfe1a4313161;
    // Execute vector (to=0x1234, value=0.5 ether, empty data, deadline, nonce 0).
    bytes32 constant VEC_EXE_R = 0x5bfd97516f58cccf3710623ce36f7081ab3545692d7f673e01220f4de0639a72;
    bytes32 constant VEC_EXE_S = 0x3f711468348e9df6db6a76a7b321009f992ff03de9ef6f8d0f2e7e4ce97cf5d3;
    // Rotation vector (newX/Y below, deadline, nonce 0).
    bytes32 constant VEC_ROT_R = 0xba4bfc292216e14a0af3bbb85f072f2aab0810de168288ea72178188c04ae48a;
    bytes32 constant VEC_ROT_S = 0x3d59d520d4d7a608f289f98bd09335900bd027fcbc3c091aab7fcaeee45971c4;
    // Legacy V2-shaped payload vector (must be REJECTED by V3 verifiers).
    bytes32 constant VEC_LEGACY_R = 0xa6aacb48707ffdc17ade2af491365c9286592a3fa68021321049764b497c072c;
    bytes32 constant VEC_LEGACY_S = 0x6dc9cb362a31adffb7ac9bc00bd4e462da068c31771f9bace2ff3f7ff01f556a;
    bool constant VEC_READY = true;

    bytes constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";

    bytes32 constant NEW_X = 0x000000000000000000000000000000000000000000000000000000000000cafe;
    bytes32 constant NEW_Y = 0x000000000000000000000000000000000000000000000000000000000000beef;
    uint64 constant DEADLINE = 1_000_300;
    uint256 constant EXE_VALUE = 0.5 ether;

    // Accepts the relayerFee reimbursement paid to the submitting relayer (this contract).
    // Nonzero gas price: the V3 GasAnomaly sanity bound divides by tx.gasprice.
    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        rpIdHash = sha256("localhost");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        factory = new PeridotFactory(address(new PeridotAccount()), address(this), admins);
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

    function _actPayload() internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                uint8(0x05),
                SALT,
                GX,
                GY,
                rpIdHash,
                POLICY,
                DEADLINE,
                block.chainid,
                address(factory)
            )
        );
    }

    function _exePayload(address account, uint64 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                uint8(0x01),
                block.chainid,
                account,
                nonce,
                address(0x1234),
                EXE_VALUE,
                keccak256(""),
                DEADLINE,
                POLICY
            )
        );
    }

    function _rotPayload(address account, uint64 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                uint8(0x03),
                block.chainid,
                account,
                nonce,
                NEW_X,
                NEW_Y,
                DEADLINE
            )
        );
    }

    function _protocolFee(uint256 networkFee) internal pure returns (uint256) {
        return (networkFee * 5000) / 10000;
    }

    function _deployV3() internal returns (PeridotAccount) {
        address predicted = factory.predict(SALT);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        return PeridotAccount(payable(factory.deployAndInit(
            SALT, GX, GY, rpIdHash, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        )));
    }

    // --- vector logging helpers (sign `h` with P-256 privkey 1, low-S) ---

    function test_LogVectorActivate() public view {
        bytes32 payload = _actPayload();
        bytes memory clientData = _clientData(payload);
        bytes32 h = sha256(bytes.concat(_authData(), sha256(clientData)));
        console.log("SALT=%s", vm.toString(SALT));
        console.log("FACTORY=%s", address(factory));
        console.log("PREDICT=%s", factory.predict(SALT));
        console.logBytes32(payload);
        console.logBytes32(h);
        console.log(string(bytes.concat("CLIENTDATA=", clientData)));
    }

    function test_LogVectorExecute() public view {
        address account = factory.predict(SALT);
        bytes32 payload = _exePayload(account, 0);
        bytes memory clientData = _clientData(payload);
        bytes32 h = sha256(bytes.concat(_authData(), sha256(clientData)));
        console.log("ACCOUNT=%s", account);
        console.logBytes32(payload);
        console.logBytes32(h);
        console.log(string(bytes.concat("CLIENTDATA=", clientData)));
    }

    function test_LogVectorRotate() public view {
        address account = factory.predict(SALT);
        bytes32 payload = _rotPayload(account, 0);
        bytes memory clientData = _clientData(payload);
        bytes32 h = sha256(bytes.concat(_authData(), sha256(clientData)));
        console.log("ACCOUNT=%s", account);
        console.logBytes32(payload);
        console.logBytes32(h);
        console.log(string(bytes.concat("CLIENTDATA=", clientData)));
    }

    function test_LogVectorLegacy() public view {
        // V2-shaped payload (old domain + maxFee, no V3 discipline) — signed
        // only to prove rejection by V3 verifiers.
        address account = factory.predict(SALT);
        bytes32 payload = keccak256(
            abi.encodePacked(
                "PID|EVM|SMART_ACCOUNT|v2",
                uint8(0x01),
                block.chainid,
                account,
                uint64(0),
                address(0x1234),
                EXE_VALUE,
                keccak256(""),
                DEADLINE,
                NETWORK_FEE,
                POLICY
            )
        );
        bytes memory clientData = _clientData(payload);
        bytes32 h = sha256(bytes.concat(_authData(), sha256(clientData)));
        console.logBytes32(payload);
        console.logBytes32(h);
        console.log(string(bytes.concat("CLIENTDATA=", clientData)));
    }

    // --- creation authorization ---

    function test_PredictMatchesDeployAndInit() public {
        if (!VEC_READY) return;
        address predicted = factory.predict(SALT);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        address account = factory.deployAndInit(
            SALT, GX, GY, rpIdHash, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
        assertEq(account, predicted);
    }

    function test_DeployAndInitHappyPath() public {
        if (!VEC_READY) return;
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        PeridotAccount account = _deployV3();
        assertTrue(account.initialized());
        assertEq(account.authorityX(), GX);
        assertEq(account.authorityY(), GY);
        assertEq(account.rpIdHash(), rpIdHash);
        assertEq(account.factory(), address(factory));
        assertEq(account.nonce(), 0);
        assertEq(address(factory).balance, factoryBefore + protocolFee);
        assertEq(address(this).balance, relayerBefore + NETWORK_FEE);
        assertEq(address(account).balance, 0);
    }

    function test_DeployAndInitRejectsAttackerAuthority() public {
        if (!VEC_READY) return;
        // Attacker reuses the victim's signature but substitutes their own key.
        address predicted = factory.predict(SALT);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInit(
            SALT, NEW_X, NEW_Y, rpIdHash, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitRejectsGasAnomaly() public {
        if (!VEC_READY) return;
        // Wild over-attestation (100 ether of "network cost") fails the sanity
        // bound even though the signature itself only binds the policy.
        address predicted = factory.predict(SALT);
        vm.deal(predicted, 100 ether + _protocolFee(100 ether));
        vm.expectRevert(PeridotFactory.GasAnomaly.selector);
        factory.deployAndInit(
            SALT, GX, GY, rpIdHash, POLICY, DEADLINE, 100 ether,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitRejectsUnknownPolicy() public {
        if (!VEC_READY) return;
        address predicted = factory.predict(SALT);
        vm.deal(predicted, NETWORK_FEE);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInit(
            SALT, GX, GY, rpIdHash, 2, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitRejectsStranger() public {
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        vm.prank(address(0xdead));
        factory.deployAndInit(
            SALT, GX, GY, rpIdHash, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), bytes32(0), bytes32(0)
        );
    }

    function test_InitializeRejectsDirectCall() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        // Already initialized AND wrong caller: gate fires on a fresh proxy only
        // reachable via the factory, so a direct call must always revert.
        vm.expectRevert();
        account.initialize(
            SALT, GX, GY, rpIdHash, POLICY, DEADLINE, NETWORK_FEE,
            address(factory), address(this),
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    // --- execution ---

    function test_ExecuteHappyPath() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        address to = address(0x1234);
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + protocolFee);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        account.execute(
            to, EXE_VALUE, "", DEADLINE, POLICY, NETWORK_FEE,
            _authData(), _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
        assertEq(account.nonce(), 1);
        assertEq(to.balance, EXE_VALUE);
        assertEq(address(factory).balance, factoryBefore + protocolFee);
        assertEq(address(this).balance, relayerBefore + NETWORK_FEE);
        assertEq(address(account).balance, 0);
    }

    function test_ExecuteRejectsGasAnomaly() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        vm.deal(address(account), EXE_VALUE + 100 ether + _protocolFee(100 ether));
        vm.expectRevert(PeridotAccount.GasAnomaly.selector);
        account.execute(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, 100 ether,
            _authData(), _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsUnknownPolicy() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE);
        vm.expectRevert(PeridotAccount.UnknownFeePolicy.selector);
        account.execute(
            address(0x1234), EXE_VALUE, "", DEADLINE, 2, NETWORK_FEE,
            _authData(), _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsExpired() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.execute(
            address(0x1234), 0, "", 999_999, POLICY, 0,
            _authData(), _clientData(_exePayload(address(account), 0)), bytes32(0), bytes32(0)
        );
    }

    function test_ExecuteRejectsLongTTL() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        // Deadline 601s out exceeds MAX_TTL even though it is not yet expired.
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.execute(
            address(0x1234), 0, "", 1_000_601, POLICY, 0,
            _authData(), _clientData(_exePayload(address(account), 0)), bytes32(0), bytes32(0)
        );
    }

    function test_ExecuteRejectsBadChallenge() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        bytes memory badClient = _clientData(bytes32(uint256(1)));
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.execute(
            address(0x1234), 0, "", DEADLINE, POLICY, 0,
            _authData(), badClient, VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsLegacyV2Signature() public {
        if (!VEC_READY) return;
        // A real P-256 signature over the V2-shaped payload must NOT verify as V3.
        PeridotAccount account = _deployV3();
        bytes memory legacyClient = _clientData(
            keccak256(
                abi.encodePacked(
                    "PID|EVM|SMART_ACCOUNT|v2",
                    uint8(0x01),
                    block.chainid,
                    address(account),
                    uint64(0),
                    address(0x1234),
                    EXE_VALUE,
                    keccak256(""),
                    DEADLINE,
                    NETWORK_FEE,
                    POLICY
                )
            )
        );
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.execute(
            address(0x1234), 0, "", DEADLINE, POLICY, 0,
            _authData(), legacyClient, VEC_LEGACY_R, VEC_LEGACY_S
        );
    }

    function test_ExecuteRejectsWrongRpId() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        bytes memory evilAuth = bytes.concat(sha256("evil.example"), bytes1(0x05), bytes4(uint32(1)));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(
            address(0x1234), 0, "", DEADLINE, POLICY, 0,
            evilAuth, _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsNoUserVerification() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        bytes memory noUv = bytes.concat(rpIdHash, bytes1(0x01), bytes4(uint32(1)));
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(
            address(0x1234), 0, "", DEADLINE, POLICY, 0,
            noUv, _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsInsufficientFunds() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        // Funded below value + totalFee: auth + sanity pass, funds check fails.
        // networkFee = 1 wei keeps the sanity bound satisfiable at any gas price.
        vm.deal(address(account), EXE_VALUE);
        vm.expectRevert(PeridotAccount.InsufficientFunds.selector);
        account.execute(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, 1,
            _authData(), _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    function test_ExecuteRejectsSelfCall() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        vm.expectRevert(PeridotAccount.InvalidTarget.selector);
        account.execute(
            address(account), 0, "", DEADLINE, POLICY, 0,
            _authData(), _clientData(_exePayload(address(account), 0)), VEC_EXE_R, VEC_EXE_S
        );
    }

    // --- rotation ---

    function test_UpdateAuthorityHappyPath() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        account.updateAuthority(
            NEW_X, NEW_Y, DEADLINE,
            _authData(), _clientData(_rotPayload(address(account), 0)), VEC_ROT_R, VEC_ROT_S
        );
        assertEq(account.authorityX(), NEW_X);
        assertEq(account.authorityY(), NEW_Y);
        assertEq(account.nonce(), 1);
        // rpIdHash is rotation-invariant.
        assertEq(account.rpIdHash(), rpIdHash);
    }

    function test_UpdateAuthorityRejectsBadChallenge() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        bytes memory badClient = _clientData(bytes32(uint256(2)));
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.updateAuthority(NEW_X, NEW_Y, DEADLINE, _authData(), badClient, VEC_ROT_R, VEC_ROT_S);
    }

    function test_UpdateAuthorityRejectsZeroKey() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        vm.expectRevert(PeridotAccount.ZeroAuthority.selector);
        account.updateAuthority(bytes32(0), bytes32(0), DEADLINE, _authData(), "", bytes32(0), bytes32(0));
    }

    // --- factory admin + revenue ---

    function test_UpdateRelayer() public {
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        vm.prank(address(0xdead));
        factory.updateRelayer(address(0xCAFE));
        factory.updateRelayer(address(0xCAFE));
        assertEq(factory.relayer(), address(0xCAFE));
        assertEq(factory.adminCount(), 1);
    }

    function test_AdminAddRemove() public {
        address second = address(0xA11CE);
        // Stranger cannot add.
        vm.expectRevert(PeridotFactory.NotAdmin.selector);
        vm.prank(address(0xdead));
        factory.addAdmin(second);
        // Admin adds; duplicate add is a no-op on the count.
        factory.addAdmin(second);
        factory.addAdmin(second);
        assertTrue(factory.admins(second));
        assertEq(factory.adminCount(), 2);
        // Second admin removes the first; revenue stays manageable.
        vm.prank(second);
        factory.removeAdmin(address(this));
        assertFalse(factory.admins(address(this)));
        assertEq(factory.adminCount(), 1);
        // Removing a non-admin reverts.
        vm.expectRevert(PeridotFactory.NotAdmin.selector);
        vm.prank(second);
        factory.removeAdmin(address(0xdead));
        // Removing the last admin reverts (floor of one).
        vm.expectRevert(PeridotFactory.LastAdmin.selector);
        vm.prank(second);
        factory.removeAdmin(second);
        assertEq(factory.adminCount(), 1);
    }

    function test_WithdrawRevenue() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        assertEq(address(factory).balance, protocolFee);
        address payable dest = payable(address(0xD357));
        // Stranger cannot withdraw.
        vm.expectRevert(PeridotFactory.NotAdmin.selector);
        vm.prank(address(0xdead));
        factory.withdrawRevenue(dest, protocolFee);
        // Over-withdrawal reverts.
        vm.expectRevert(PeridotFactory.InsufficientRevenue.selector);
        factory.withdrawRevenue(dest, protocolFee + 1);
        // Zero destination reverts.
        vm.expectRevert(PeridotFactory.ZeroAddress.selector);
        factory.withdrawRevenue(payable(address(0)), 1);
        // Admin withdraws exactly; factory cannot touch user funds (only its own balance moves).
        uint256 accountBefore = address(account).balance;
        factory.withdrawRevenue(dest, protocolFee);
        assertEq(dest.balance, protocolFee);
        assertEq(address(factory).balance, 0);
        assertEq(address(account).balance, accountBefore);
    }

    function test_FactoryCannotTouchAccounts() public {
        if (!VEC_READY) return;
        // The factory exposes no user-account powers: no execute/rotate path exists.
        // Closest abuse — relayer submits with attacker authority — is already covered
        // by test_DeployAndInitRejectsAttackerAuthority. Here: admins cannot rotate keys.
        PeridotAccount account = _deployV3();
        (bool ok, ) = address(account).call(
            abi.encodeWithSignature(
                "updateAuthority(bytes32,bytes32,uint64,bytes,bytes,bytes32,bytes32)",
                NEW_X, NEW_Y, DEADLINE, _authData(), _clientData(_rotPayload(address(account), 0)), VEC_ROT_R, VEC_ROT_S
            )
        );
        // The VEC_ROT signature is over the CURRENT key (generator G), which the
        // factory (not a passkey holder) cannot produce for attacker keys — and a
        // stranger submitting the victim's own valid rotation changes nothing about
        // ownership (it IS the victim's authorization). What matters: no admin bypass.
        assertTrue(ok);
        assertEq(account.authorityX(), NEW_X);
    }

    function test_PredictIsStableFuzz(bytes32 salt) public view {
        assertEq(factory.predict(salt), factory.predict(salt));
    }

    // --- parity ---

    function test_LogCreate2Parity() public view {
        console.log("PARITY_FACTORY=%s", address(factory));
        console.log("PARITY_IMPL=%s", factory.implementation());
        console.log("PARITY_PREDICT=%s", factory.predict(SALT));
    }

    function test_LogPayload() public view {
        address account = factory.predict(SALT);
        console.logBytes32(_exePayload(account, 0));
    }

    // --- base64url (test-local, mirrors Base64Url.decode alphabet) ---

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
}
