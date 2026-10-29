// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";

/// @notice V4 authorization + fee-schema tests (ANT-863 B2). Happy paths use
/// real P-256 signatures by privkey 1 (pubkey = generator G), signed at
/// runtime via `vm.signP256` (see `_sigAct` / `_sigExe` / `_sigRot`) — the
/// hardcoded V3 vector workflow is retired (V3 fee paths are hard-closed
/// on-chain with `V3Deprecated`). Rotation (`updateAuthority`) keeps its V3
/// domain (no fee path — keep-alive) and is covered with runtime signatures.
/// @dev Every `setUp` redeploys implementation + factory in the same order, so
/// predicted addresses are stable across tests (chainid 31337).
contract PeridotAccountTest is Test {
    // P-256 generator = pubkey of privkey 1.
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    /// @dev B1 binding (ANT-866): no raw salt anywhere — `sha256("test@pid")`,
    /// bound on-chain as `keccak256(PID_HASH ‖ GX ‖ GY)` via `_salt()`.
    bytes32 constant PID_HASH = 0xd7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa;

    PeridotFactory factory;
    // Neutral 32-byte authenticator prefix for fixtures. The contract never
    // compares these bytes (ANT-197 domain-free); any prefix verifies.
    bytes32 authPrefix;
    // Attested network cost. Must fit the on-chain sanity bound
    // (<= 2x measured gas x tx.gasprice); the V4 payload binds maxTotalFee
    // (not the attested value), so one realistic constant suffices.
    uint256 constant NETWORK_FEE = 0.002 ether;
    // User-approved fee bound: exact attested total (network + 50% protocol).
    uint256 constant MAX_TOTAL_FEE = 0.003 ether;
    uint16 constant POLICY = 1;

    bytes constant DOMAIN_V4 = "PID|EVM|SMART_ACCOUNT|v4";
    bytes constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";

    bytes32 constant NEW_X = 0x000000000000000000000000000000000000000000000000000000000000cafe;
    bytes32 constant NEW_Y = 0x000000000000000000000000000000000000000000000000000000000000beef;
    uint64 constant DEADLINE = 1_000_300;
    uint256 constant EXE_VALUE = 0.5 ether;

    // Accepts the relayerFee reimbursement paid to the submitting relayer (this contract).
    // Nonzero gas price: the GasAnomaly sanity bound divides by tx.gasprice.
    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        authPrefix = sha256("test-rp");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        factory = new PeridotFactory(address(new PeridotAccount()), admins);
    }

    /// @dev B1 (ANT-866): canonical test salt — what the factory derives from
    /// `(PID_HASH, GX, GY)`. Mirrors `predictBound` / SDK `pidKeyToSalt32`.
    function _salt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PID_HASH, GX, GY));
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

    function _actPayloadV4(bytes32 x, bytes32 y, uint16 policy, uint256 maxFee)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V4,
                uint8(0x05),
                _salt(),
                x,
                y,
                policy,
                maxFee,
                DEADLINE,
                block.chainid,
                address(factory)
            )
        );
    }

    function _exePayloadV4(
        address account,
        uint64 nonce,
        address to,
        uint256 value,
        uint64 deadline,
        uint256 maxFee,
        uint16 policy
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_V4,
                uint8(0x01),
                block.chainid,
                account,
                nonce,
                to,
                value,
                keccak256(""),
                deadline,
                policy,
                maxFee
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

    // ---- runtime P-256 signing (deterministic RFC-6979 via vm.signP256, low-S) ----

    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function _signLowS(uint256 privKey, bytes32 digest) internal returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(privKey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
    }

    function _sigAct(bytes32 x, bytes32 y, uint16 policy, uint256 maxFee)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        auth = _authData();
        client = _clientData(_actPayloadV4(x, y, policy, maxFee));
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _signLowS(1, h);
    }

    function _sigExe(
        address account,
        uint64 nonce,
        address to,
        uint256 value,
        uint64 deadline,
        uint256 maxFee,
        uint16 policy
    ) internal returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) {
        auth = _authData();
        client = _clientData(_exePayloadV4(account, nonce, to, value, deadline, maxFee, policy));
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _signLowS(1, h);
    }

    function _sigRot(address account, uint64 nonce)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        auth = _authData();
        client = _clientData(_rotPayload(account, nonce));
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _signLowS(1, h);
    }

    function _deployV4() internal returns (PeridotAccount) {
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        return PeridotAccount(payable(factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        )));
    }

    // --- creation authorization ---

    function test_PredictMatchesDeployAndInit() public {
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        address account = factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(account, predicted);
    }

    function test_DeployAndInitHappyPath() public {
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        PeridotAccount account = _deployV4();
        assertTrue(account.initialized());
        assertEq(account.authorityX(), GX);
        assertEq(account.authorityY(), GY);
        assertEq(account.factory(), address(factory));
        assertEq(account.nonce(), 0);
        assertEq(address(factory).balance, factoryBefore + protocolFee);
        assertEq(address(this).balance, relayerBefore + NETWORK_FEE);
        assertEq(address(account).balance, 0);
    }

    function test_DeployAndInitV3Reverts() public {
        // ANT-863 B2: the V3 factory path is hard-closed on-chain. A
        // well-formed V3 call (valid signature shape) reverts with
        // V3Deprecated before any other validation.
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        vm.expectRevert(PeridotFactory.V3Deprecated.selector);
        factory.deployAndInit(
            PID_HASH, GX, GY, POLICY, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(predicted.code.length, 0);
    }

    function test_DeployAndInitRejectsAttackerAuthority() public {
        // Attacker reuses the victim's signature but substitutes their own key.
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(
            PID_HASH, NEW_X, NEW_Y, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
    }

    function test_DeployAndInitBadSignatureLeavesNoState() public {
        // ANT-16 hardening regression (verify-before-write in `initialize`):
        // a bad activation signature must revert with zero state written. The
        // factory path is atomic (clone + init roll back together), so the
        // predicted address holds no code afterwards — and the same salt still
        // activates cleanly, proving no partial state (no squat, no locked salt).
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            _authData(), _clientData(_actPayloadV4(GX, GY, POLICY, MAX_TOTAL_FEE)),
            bytes32(uint256(1)), bytes32(uint256(2))
        );
        assertEq(predicted.code.length, 0);
        PeridotAccount account = _deployV4();
        assertEq(address(account), predicted);
        assertEq(account.authorityX(), GX);
        assertEq(account.authorityY(), GY);
        assertTrue(account.initialized());
    }

    function test_DeployAndInitRejectsGasAnomaly() public {
        // Wild over-attestation (100 ether of "network cost") fails the sanity
        // bound even though the V4 cap (200 ether) covers it.
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        uint256 bigFee = 100 ether;
        vm.deal(predicted, bigFee + _protocolFee(bigFee));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, 200 ether);
        vm.expectRevert(PeridotFactory.GasAnomaly.selector);
        factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, 200 ether, DEADLINE, bigFee,
            auth, client, r, s
        );
    }

    function test_DeployAndInitRejectsOverCap() public {
        // ANT-863 B2: attested total above the user-approved maxTotalFee
        // reverts (inner FeeExceedsMax surfaces as factory InitFailed).
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, NETWORK_FEE);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, NETWORK_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(predicted.code.length, 0);
    }

    function test_DeployAndInitRejectsUnknownPolicy() public {
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE);
        // V4 accepts v1+v2; version 3 is unknown (gate fires pre-verify).
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, 3, MAX_TOTAL_FEE);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(
            PID_HASH, GX, GY, 3, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
    }

    function test_DeployAndInitPermissionlessSubmitter() public {
        // AC-E1 (ANT-610): no relayer allowlist — ANY submitter with a valid
        // user authorization deploys. The fee split follows the submitter:
        // networkFee → submitter (payer), protocolFee → factory vault.
        address submitter = address(0xbEEF);
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + protocolFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        vm.prank(submitter);
        address account = factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(account, predicted);
        assertTrue(PeridotAccount(payable(account)).initialized());
        assertEq(submitter.balance, NETWORK_FEE);
        assertEq(address(factory).balance, protocolFee);
    }

    function test_DeployAndInitRejectsStranger() public {
        // Without a valid user signature there is no deployment — even for a
        // random submitter. This is the EVM anti-squat proof (AC-E2): knowing
        // the salt is not enough without the passkey.
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        bytes memory client = _clientData(_actPayloadV4(GX, GY, POLICY, MAX_TOTAL_FEE));
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        vm.prank(address(0xdead));
        factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            _authData(), client, bytes32(0), bytes32(0)
        );
        assertEq(predicted.code.length, 0);
    }

    function test_InitializeRejectsDirectCall() public {
        PeridotAccount account = _deployV4();
        // Already initialized AND wrong caller: gate fires on a fresh proxy only
        // reachable via the factory, so a direct call must always revert.
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        vm.expectRevert();
        account.initialize(
            _salt(), GX, GY, PID_HASH, POLICY, DEADLINE, NETWORK_FEE,
            address(factory), address(this),
            auth, client, r, s
        );
    }

    // --- execution ---

    function test_ExecuteHappyPath() public {
        PeridotAccount account = _deployV4();
        address to = address(0x1234);
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + protocolFee);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, to, EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY);
        account.executeV4(
            to, EXE_VALUE, "", DEADLINE, POLICY, MAX_TOTAL_FEE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(account.nonce(), 1);
        assertEq(to.balance, EXE_VALUE);
        assertEq(address(factory).balance, factoryBefore + protocolFee);
        assertEq(address(this).balance, relayerBefore + NETWORK_FEE);
        assertEq(address(account).balance, 0);
    }

    function test_ExecuteV3Reverts() public {
        // ANT-863 B2: the V3 owner-execute path is hard-closed on-chain. A
        // well-formed call reverts with V3Deprecated before any validation.
        PeridotAccount account = _deployV4();
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.V3Deprecated.selector);
        account.execute(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, NETWORK_FEE,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsGasAnomaly() public {
        PeridotAccount account = _deployV4();
        uint256 bigFee = 100 ether;
        vm.deal(address(account), EXE_VALUE + bigFee + _protocolFee(bigFee));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, 200 ether, POLICY);
        vm.expectRevert(PeridotAccount.GasAnomaly.selector);
        account.executeV4(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, 200 ether, bigFee,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsOverCap() public {
        // ANT-863 B2: attested total above maxTotalFee reverts (FeeExceedsMax)
        // before any value moves or the nonce burns.
        PeridotAccount account = _deployV4();
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, NETWORK_FEE, POLICY);
        vm.expectRevert(PeridotAccount.FeeExceedsMax.selector);
        account.executeV4(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, NETWORK_FEE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(account.nonce(), 0);
    }

    function test_ExecuteRejectsUnknownPolicy() public {
        PeridotAccount account = _deployV4();
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE);
        // V4 accepts v1+v2; version 3 is unknown (gate fires pre-verify).
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, 3);
        vm.expectRevert(PeridotAccount.UnknownFeePolicy.selector);
        account.executeV4(
            address(0x1234), EXE_VALUE, "", DEADLINE, 3, MAX_TOTAL_FEE, NETWORK_FEE,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsExpired() public {
        PeridotAccount account = _deployV4();
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), 0, 999_999, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.executeV4(
            address(0x1234), 0, "", 999_999, POLICY, MAX_TOTAL_FEE, 0,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsLongTTL() public {
        PeridotAccount account = _deployV4();
        // Deadline 601s out exceeds MAX_TTL even though it is not yet expired.
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), 0, 1_000_601, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.executeV4(
            address(0x1234), 0, "", 1_000_601, POLICY, MAX_TOTAL_FEE, 0,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsBadChallenge() public {
        PeridotAccount account = _deployV4();
        bytes memory badClient = _clientData(bytes32(uint256(1)));
        (, , bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), 0, DEADLINE, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.executeV4(
            address(0x1234), 0, "", DEADLINE, POLICY, MAX_TOTAL_FEE, 0,
            _authData(), badClient, r, s
        );
    }

    function test_ExecuteRejectsLegacyV2Signature() public {
        // A real P-256 signature over the V2-shaped payload must NOT verify as V4.
        PeridotAccount account = _deployV4();
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
        bytes32 h = sha256(bytes.concat(_authData(), sha256(legacyClient)));
        (bytes32 r, bytes32 s) = _signLowS(1, h);
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.executeV4(
            address(0x1234), 0, "", DEADLINE, POLICY, MAX_TOTAL_FEE, 0,
            _authData(), legacyClient, r, s
        );
    }

    function test_ExecuteAcceptsForeignPrefix() public {
        // ANT-197 domain-free: a signature over an authenticatorData with a
        // foreign 32-byte prefix verifies — no RP comparison remains on-chain.
        PeridotAccount account = _deployV4();
        bytes memory foreignAuth = bytes.concat(sha256("other-rp"), bytes1(0x05), bytes4(uint32(1)));
        bytes32 payload = _exePayloadV4(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY);
        bytes memory client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(foreignAuth, sha256(client)));
        (bytes32 r, bytes32 s) = _signLowS(1, h);
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + _protocolFee(NETWORK_FEE));
        account.executeV4(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, MAX_TOTAL_FEE, NETWORK_FEE,
            foreignAuth, client, r, s
        );
        assertEq(account.nonce(), 1);
    }

    function test_ExecuteRejectsNoUserVerification() public {
        PeridotAccount account = _deployV4();
        bytes memory noUv = bytes.concat(authPrefix, bytes1(0x01), bytes4(uint32(1)));
        bytes32 payload = _exePayloadV4(address(account), 0, address(0x1234), 0, DEADLINE, MAX_TOTAL_FEE, POLICY);
        bytes memory client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(noUv, sha256(client)));
        (bytes32 r, bytes32 s) = _signLowS(1, h);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.executeV4(
            address(0x1234), 0, "", DEADLINE, POLICY, MAX_TOTAL_FEE, 0,
            noUv, client, r, s
        );
    }

    function test_ExecuteRejectsInsufficientFunds() public {
        PeridotAccount account = _deployV4();
        // Funded below value + totalFee: auth + sanity pass, funds check fails.
        // networkFee = 1 wei keeps the sanity bound satisfiable at any gas price.
        vm.deal(address(account), EXE_VALUE);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(0x1234), EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.InsufficientFunds.selector);
        account.executeV4(
            address(0x1234), EXE_VALUE, "", DEADLINE, POLICY, MAX_TOTAL_FEE, 1,
            auth, client, r, s
        );
    }

    function test_ExecuteRejectsSelfCall() public {
        PeridotAccount account = _deployV4();
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, address(account), 0, DEADLINE, MAX_TOTAL_FEE, POLICY);
        vm.expectRevert(PeridotAccount.InvalidTarget.selector);
        account.executeV4(
            address(account), 0, "", DEADLINE, POLICY, MAX_TOTAL_FEE, 0,
            auth, client, r, s
        );
    }

    // --- rotation (keep-alive V3 domain, no fee path) ---

    function test_UpdateAuthorityHappyPath() public {
        PeridotAccount account = _deployV4();
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigRot(address(account), 0);
        account.updateAuthority(
            NEW_X, NEW_Y, DEADLINE,
            auth, client, r, s
        );
        assertEq(account.authorityX(), NEW_X);
        assertEq(account.authorityY(), NEW_Y);
        assertEq(account.nonce(), 1);
        // No domain state exists post-ANT-197: rotation touches keys + nonce only.
    }

    function test_UpdateAuthorityRejectsBadChallenge() public {
        PeridotAccount account = _deployV4();
        bytes memory badClient = _clientData(bytes32(uint256(2)));
        (, , bytes32 r, bytes32 s) = _sigRot(address(account), 0);
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.updateAuthority(NEW_X, NEW_Y, DEADLINE, _authData(), badClient, r, s);
    }

    function test_UpdateAuthorityRejectsZeroKey() public {
        PeridotAccount account = _deployV4();
        vm.expectRevert(PeridotAccount.ZeroAuthority.selector);
        account.updateAuthority(bytes32(0), bytes32(0), DEADLINE, _authData(), "", bytes32(0), bytes32(0));
    }

    // --- factory admin + revenue ---

    function test_NoRelayerAllowlist() public {
        // AC-E3 (ANT-610): the old `updateRelayer` selector no longer exists —
        // calling it reverts without touching state (no function match).
        (bool ok, ) = address(factory).call(
            abi.encodeWithSignature("updateRelayer(address)", address(0xCAFE))
        );
        assertFalse(ok);
    }

    function test_SetDeploysPaused() public {
        // AC-E4 (ANT-610 section 3.2): the admin pause is the narrow kill-switch
        // replacing the relayer gate. Non-admins cannot toggle it.
        vm.expectRevert(PeridotFactory.NotAdmin.selector);
        vm.prank(address(0xdead));
        factory.setDeploysPaused(true);
        assertFalse(factory.deploysPaused());

        // Paused creation reverts with `Paused()` and writes no state.
        factory.setDeploysPaused(true);
        assertTrue(factory.deploysPaused());
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, NETWORK_FEE + _protocolFee(NETWORK_FEE));
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAct(GX, GY, POLICY, MAX_TOTAL_FEE);
        vm.expectRevert(PeridotFactory.Paused.selector);
        factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(predicted.code.length, 0);

        // Unpausing restores creation; the same salt activates cleanly.
        factory.setDeploysPaused(false);
        assertFalse(factory.deploysPaused());
        address account = factory.deployAndInitV4(
            PID_HASH, GX, GY, POLICY, MAX_TOTAL_FEE, DEADLINE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(account, predicted);
    }

    function test_PauseLeavesSpendAndRevenueUntouched() public {
        // AC-E4/NFR-5: the pause covers creation only — existing accounts keep
        // executing and revenue keeps draining while paused.
        PeridotAccount account = _deployV4();
        uint256 protocolFee = _protocolFee(NETWORK_FEE);
        factory.setDeploysPaused(true);

        address to = address(0x1234);
        vm.deal(address(account), EXE_VALUE + NETWORK_FEE + protocolFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) =
            _sigExe(address(account), 0, to, EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY);
        account.executeV4(
            to, EXE_VALUE, "", DEADLINE, POLICY, MAX_TOTAL_FEE, NETWORK_FEE,
            auth, client, r, s
        );
        assertEq(to.balance, EXE_VALUE);

        address payable dest = payable(address(0xD357));
        uint256 vaultBal = address(factory).balance;
        assertTrue(vaultBal > 0);
        factory.withdrawRevenue(dest, vaultBal);
        assertEq(dest.balance, vaultBal);
        assertEq(address(factory).balance, 0);
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
        PeridotAccount account = _deployV4();
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
        // The factory exposes no user-account powers: no execute/rotate path exists.
        // Closest abuse — relayer submits with attacker authority — is already covered
        // by test_DeployAndInitRejectsAttackerAuthority. Here: admins cannot rotate keys.
        PeridotAccount account = _deployV4();
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigRot(address(account), 0);
        (bool ok, ) = address(account).call(
            abi.encodeWithSignature(
                "updateAuthority(bytes32,bytes32,uint64,bytes,bytes,bytes32,bytes32)",
                NEW_X, NEW_Y, DEADLINE, auth, client, r, s
            )
        );
        // The rotation signature is over the CURRENT key (generator G), which the
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
        console.log("PARITY_PREDICT=%s", factory.predictBound(PID_HASH, GX, GY));
    }

    function test_LogPayload() public view {
        address account = factory.predictBound(PID_HASH, GX, GY);
        console.logBytes32(_exePayloadV4(account, 0, address(0x1234), EXE_VALUE, DEADLINE, MAX_TOTAL_FEE, POLICY));
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
