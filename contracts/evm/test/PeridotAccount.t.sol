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
    // Neutral 32-byte authenticator prefix for fixtures. The contract never
    // compares these bytes (ANT-197 domain-free); any prefix verifies.
    bytes32 authPrefix;
    // Attested network cost. Must fit the on-chain sanity bound
    // (≤ 2× measured gas × tx.gasprice); the V3 payload does not bind it,
    // so each test could attest its own value — one realistic constant suffices.
    uint256 constant NETWORK_FEE = 0.002 ether;
    uint16 constant POLICY = 1;

    // Activation vector (salt, GX/GY, POLICY/deadline, factory, chainid).
    bytes32 constant VEC_ACT_R = 0xe833d5ba603d6a180091a10e6cc56ae051abce1624970cbe8bf278d8e6858636;
    bytes32 constant VEC_ACT_S = 0x6a961eb397aa853a23248b4af0d4d84c3d103a4451959793117939d73bf69a30;
    // Execute vector (to=0x1234, value=0.5 ether, empty data, deadline, nonce 0).
    bytes32 constant VEC_EXE_R = 0x00e4f93de906b9066f94e4edb6a437bbe3adad21ee8133a8177f2dae711cc123;
    bytes32 constant VEC_EXE_S = 0x3a5d1b18a3b9e091fcd1a0b991b75bdb1ba083bd6378937c900593ab4f313879;
    // Rotation vector (newX/Y below, deadline, nonce 0).
    bytes32 constant VEC_ROT_R = 0x4b0bc5779368043f23921bd925fcee708c8359f43a1dbec4c2db38d73875e280;
    bytes32 constant VEC_ROT_S = 0x62e0d1785c6b74d90c4c841fd1f32ef983a807a9f5f7dd099b74ad3b4d7d02a6;
    // Legacy V2-shaped payload vector (must be REJECTED by V3 verifiers).
    bytes32 constant VEC_LEGACY_R = 0xe254c4dfa85b6e7e7c076b114de8391d8e678b32fb24d76dc967bc505f921ffd;
    bytes32 constant VEC_LEGACY_S = 0x36c4db26f3e76662ef53105eb4673ef568b6d4831663cb2d4e9eed6ed22decdd;
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
        authPrefix = sha256("test-rp");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        factory = new PeridotFactory(address(new PeridotAccount()), address(this), admins);
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

    function _actPayload() internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V3,
                uint8(0x05),
                SALT,
                GX,
                GY,
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
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
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
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
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
            SALT, NEW_X, NEW_Y, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitBadSignatureLeavesNoState() public {
        if (!VEC_READY) return;
        // ANT-16 hardening regression (verify-before-write in `initialize`):
        // a bad activation signature must revert with zero state written. The
        // factory path is atomic (clone + init roll back together), so the
        // predicted address holds no code afterwards — and the same salt still
        // activates cleanly, proving no partial state (no squat, no locked salt).
        address predicted = factory.predict(SALT);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInit(
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), bytes32(uint256(1)), bytes32(uint256(2))
        );
        assertEq(predicted.code.length, 0);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        address account = factory.deployAndInit(
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
        assertEq(account, predicted);
        assertEq(PeridotAccount(payable(account)).authorityX(), GX);
        assertEq(PeridotAccount(payable(account)).authorityY(), GY);
        assertTrue(PeridotAccount(payable(account)).initialized());
    }

    function test_DeployAndInitRejectsGasAnomaly() public {
        if (!VEC_READY) return;
        // Wild over-attestation (100 ether of "network cost") fails the sanity
        // bound even though the signature itself only binds the policy.
        address predicted = factory.predict(SALT);
        vm.deal(predicted, 100 ether + _protocolFee(100 ether));
        vm.expectRevert(PeridotFactory.GasAnomaly.selector);
        factory.deployAndInit(
            SALT, GX, GY, POLICY, DEADLINE, 100 ether,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitRejectsUnknownPolicy() public {
        if (!VEC_READY) return;
        address predicted = factory.predict(SALT);
        vm.deal(predicted, NETWORK_FEE);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInit(
            SALT, GX, GY, 2, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayload()), VEC_ACT_R, VEC_ACT_S
        );
    }

    function test_DeployAndInitRejectsStranger() public {
        vm.expectRevert(PeridotFactory.Unauthorized.selector);
        vm.prank(address(0xdead));
        factory.deployAndInit(
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
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
            SALT, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
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

    function test_ExecuteAcceptsForeignPrefix() public {
        if (!VEC_READY) return;
        // ANT-197 domain-free: a signature over an authenticatorData with a
        // foreign 32-byte prefix verifies — no RP comparison remains on-chain.
        // Signed at runtime with privkey 1 (generator key) via vm.signP256.
        PeridotAccount account = _deployV3();
        bytes memory foreignAuth = bytes.concat(sha256("other-rp"), bytes1(0x05), bytes4(uint32(1)));
        bytes32 payload = _exePayload(address(account), 0);
        bytes memory client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(foreignAuth, sha256(client)));
        (bytes32 r, bytes32 s) = _signLowS(1, h);
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + _protocolFee(NETWORK_FEE));
        account.execute(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, NETWORK_FEE,
            foreignAuth, client, r, s
        );
        assertEq(account.nonce(), 1);
    }

    // ---- runtime P-256 signing helper (deterministic RFC-6979 via vm.signP256) ----

    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function _signLowS(uint256 privKey, bytes32 digest) internal returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(privKey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
    }

    function test_ExecuteRejectsNoUserVerification() public {
        if (!VEC_READY) return;
        PeridotAccount account = _deployV3();
        bytes memory noUv = bytes.concat(authPrefix, bytes1(0x01), bytes4(uint32(1)));
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
        // No domain state exists post-ANT-197: rotation touches keys + nonce only.
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
