// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PeridotAccountBatch} from "../src/PeridotAccountBatch.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";
import {PeridotPermissionExecutor} from "../src/PeridotPermissionExecutor.sol";

/// @dev Nonfinancial mock target: storage write + event, no value movement.
/// Same-target+selector batches of `recordScore` are the v1 batch shape.
contract MockGame {
    mapping(address => uint256) public scores;
    event Scored(address indexed player, uint256 delta, uint256 total);

    function recordScore(uint256 delta) external {
        scores[msg.sender] += delta;
        emit Scored(msg.sender, delta, scores[msg.sender]);
    }

    function claimReward() external {
        scores[msg.sender] += 1;
        emit Scored(msg.sender, 1, scores[msg.sender]);
    }

    function boom() external pure {
        revert("boom");
    }
}

/// @notice ERC-7579 MODE_BATCH tests for the V4-only `PeridotAccountBatch`.
/// Owner batch: one signature, one nonce, single fee computation + payout pair,
/// all-or-nothing loop. Session batch: one signature, one `seq`, single
/// `feeSpent` debit, every op checked against the SAME permission record.
///
/// Owner key = P-256 privkey 1 (generator G); session key = privkey 2 —
/// OWNER vs PERMISSION separation rests on domain/op-tag/mode, as in the
/// single-execution suites.
contract PeridotBatchTest is Test {
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant SX = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant SY = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;
    /// @dev B1 binding (ANT-866): `sha256("test-batch@pid")`, bound on-chain as
    /// `keccak256(PID_HASH ‖ GX ‖ GY)`.
    bytes32 constant PID_HASH = 0x30a308cc52faabba9ef64028eaf37bb94e5418b50a9e3e5338362e7cdb7cfca7;

    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    bytes constant DOMAIN_V4 = "PID|EVM|SMART_ACCOUNT|v4";
    bytes constant DOMAIN_PERM_V2 = "PID|EVM|PERMISSION|v2";

    uint64 constant DEADLINE = 1_000_300;
    uint16 constant POLICY_V1 = 1;

    PeridotFactory factory;
    PeridotAccountBatch account;
    MockGame game;
    bytes32 authPrefix;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        authPrefix = sha256("test-rp");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        factory = new PeridotFactory(address(new PeridotAccountBatch()), admins);
        game = new MockGame();
        bytes32 salt = keccak256(abi.encodePacked(PID_HASH, GX, GY));
        address predicted = factory.predict(salt);
        vm.deal(predicted, 0.01 ether);
        uint256 netFee = 0.002 ether;
        uint256 maxTotalFee = 0.003 ether;
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x05), salt, GX, GY, POLICY_V1, maxTotalFee, DEADLINE, block.chainid, address(factory)
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account = PeridotAccountBatch(
            payable(factory.deployAndInitV4(PID_HASH, GX, GY, POLICY_V1, maxTotalFee, DEADLINE, netFee, auth, client, r, s))
        );
        assertEq(address(account), predicted, "counterfactual address");
        vm.deal(address(account), 10 ether);
    }

    // ---- signing helpers (deterministic RFC-6979 via vm.signP256, low-S normalized) ----

    function _sign(uint256 privKey, bytes32 digest) internal returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(privKey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
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

    function _sigOwner(bytes32 payload) internal returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) {
        auth = _authData();
        client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _sign(1, h);
    }

    function _sigSession(bytes32 payload)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        auth = _authData();
        client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _sign(2, h);
    }

    // ---- batch payload builders (mirror the contract field-for-field) ----

    function _ownerBatchPayload(bytes32 opsHash, uint64 nonce_, uint64 deadline, uint16 policy, uint256 maxTotalFee)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2,
                uint8(0x15),
                account.MODE_BATCH(),
                block.chainid,
                address(account),
                nonce_,
                opsHash,
                deadline,
                policy,
                maxTotalFee
            )
        );
    }

    function _sessionBatchPayload(
        bytes32 pid,
        uint64 seq,
        bytes32 opsHash,
        uint64 deadline,
        uint16 policy,
        uint256 maxTotalFee
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2,
                uint8(0x12),
                account.MODE_BATCH(),
                block.chainid,
                address(account),
                pid,
                seq,
                opsHash,
                deadline,
                policy,
                maxTotalFee
            )
        );
    }

    function _execBatchOwner(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory datas,
        uint256 netFee,
        uint256 maxTotalFee
    ) internal {
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _ownerBatchPayload(opsHash, account.nonce(), DEADLINE, POLICY_V1, maxTotalFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        bytes memory execCalldata =
            abi.encode(targets, values, datas, DEADLINE, POLICY_V1, maxTotalFee, netFee, auth, client, r, s);
        account.executeV4(account.MODE_BATCH(), execCalldata);
    }

    // ---- grant / install one-liners ----

    function _grant(address target, bytes4 selector, uint256 feeLimit) internal returns (bytes32 pid) {
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256(abi.encode(target, selector, feeLimit, block.timestamp, account.nonce()));
        pid = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, block.chainid, address(account), SX, SY, uint8(1), target, selector, address(0),
                address(0), uint256(0), validUntil, salt
            )
        );
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x10), block.chainid, address(account), pid, SX, SY, uint8(1), target, selector,
                address(0), address(0), uint256(0), uint256(0), feeLimit, uint256(0), validAfter, validUntil,
                account.nonce(), DEADLINE
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.grantPermission(
            PeridotAccountBatch.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: target,
                selector: selector,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: feeLimit,
                nftId: 0,
                validAfter: validAfter,
                validUntil: validUntil,
                salt: salt,
                deadline: DEADLINE
            }),
            auth,
            client,
            r,
            s
        );
    }

    function _installModule(uint256 moduleTypeId, address module) internal {
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x13), block.chainid, address(account), moduleTypeId, module, keccak256(""), n,
                DEADLINE
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.installModule(moduleTypeId, module, "", DEADLINE, auth, client, r, s);
    }

    function _execBatchSession(
        PeridotPermissionExecutor executor,
        bytes32 pid,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory datas,
        uint64 seq,
        uint256 netFee,
        uint256 maxTotalFee
    ) internal returns (bytes[] memory) {
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _sessionBatchPayload(pid, seq, opsHash, DEADLINE, POLICY_V1, maxTotalFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, targets, values, datas, DEADLINE, seq, POLICY_V1, maxTotalFee, netFee, address(this), auth, client, r, s
        );
        return executor.executeViaPermissionV2(payable(address(account)), account.MODE_BATCH(), execCalldata);
    }

    // ---- owner batch ----

    function test_BatchOwnerHappy() public {
        bytes32 batchMode = account.MODE_BATCH();
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (3));
        datas[1] = abi.encodeCall(MockGame.claimReward, ());
        uint256 netFee = 0.002 ether;
        uint256 protocol = netFee / 2;
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        vm.expectEmit(true, false, false, true, address(account));
        emit PeridotAccountBatch.BatchExecuted(0, 2, netFee, protocol);
        _execBatchOwner(targets, values, datas, netFee, netFee + protocol);
        assertEq(game.scores(address(account)), 4, "3 + 1 reward");
        assertEq(account.nonce(), 1, "one nonce consumed (activation does not consume nonce)");
        assertEq(address(this).balance, relayerBefore + netFee, "single payout pair");
        assertEq(address(factory).balance, factoryBefore + protocol, "single protocol fee");
    }

    function test_BatchAtomicity() public {
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        datas[1] = abi.encodeCall(MockGame.boom, ());
        uint256 netFee = 0.002 ether;
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _ownerBatchPayload(opsHash, account.nonce(), DEADLINE, POLICY_V1, netFee + netFee / 2);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        bytes memory execCalldata =
            abi.encode(targets, values, datas, DEADLINE, POLICY_V1, netFee + netFee / 2, netFee, auth, client, r, s);
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.CallFailed.selector);
        account.executeV4(batchMode, execCalldata);
        assertEq(game.scores(address(account)), 0, "no partial state");
        assertEq(account.nonce(), 0, "nonce unchanged (activation does not consume nonce)");
    }

    function test_BatchFeeCap() public {
        address[] memory targets = new address[](1);
        targets[0] = address(game);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        uint256 netFee = 0.002 ether;
        uint256 maxTotalFee = netFee; // protocol pushes the total over the cap
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _ownerBatchPayload(opsHash, account.nonce(), DEADLINE, POLICY_V1, maxTotalFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        bytes memory execCalldata =
            abi.encode(targets, values, datas, DEADLINE, POLICY_V1, maxTotalFee, netFee, auth, client, r, s);
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.FeeExceedsMax.selector);
        account.executeV4(batchMode, execCalldata);
    }

    function test_BatchSingleSigDomainSeparation() public {
        // (a) single-shaped signature is useless on the batch path.
        address[] memory targets = new address[](1);
        targets[0] = address(game);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        uint256 netFee = 0.002 ether;
        uint256 maxTotalFee = netFee + netFee / 2;
        bytes32 singlePayload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x15), block.chainid, address(account), account.nonce(), targets[0], uint256(0),
                keccak256(datas[0]), DEADLINE, POLICY_V1, maxTotalFee
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(singlePayload);
        bytes memory batchCalldata =
            abi.encode(targets, values, datas, DEADLINE, POLICY_V1, maxTotalFee, netFee, auth, client, r, s);
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.InvalidChallenge.selector);
        account.executeV4(batchMode, batchCalldata);
        // (b) batch-shaped signature is useless on the single path.
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 batchPayload = _ownerBatchPayload(opsHash, account.nonce(), DEADLINE, POLICY_V1, maxTotalFee);
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigOwner(batchPayload);
        bytes memory singleCalldata = abi.encode(
            targets[0], uint256(0), datas[0], DEADLINE, POLICY_V1, maxTotalFee, netFee, a2, c2, r2, s2
        );
        bytes32 singleMode = account.MODE_SINGLE_DEFAULT();
        vm.expectRevert(PeridotAccountBatch.InvalidChallenge.selector);
        account.executeV4(singleMode, singleCalldata);
    }

    function test_BatchBounds() public {
        bytes32 batchMode = account.MODE_BATCH();
        uint256 netFee = 0.002 ether;
        // Empty batch reverts before any signature check (dummy sig is fine).
        {
            bytes memory batchCalldata = abi.encode(
                new address[](0),
                new uint256[](0),
                new bytes[](0),
                DEADLINE,
                POLICY_V1,
                netFee,
                netFee,
                bytes(""),
                bytes(""),
                bytes32(0),
                bytes32(0)
            );
            vm.expectRevert(PeridotAccountBatch.EmptyBatch.selector);
            account.executeV4(batchMode, batchCalldata);
        }
        // 11 ops exceeds MAX_BATCH_OPS (checked before signature verification).
        {
            address[] memory targets = new address[](11);
            uint256[] memory values = new uint256[](11);
            bytes[] memory datas = new bytes[](11);
            for (uint256 i = 0; i < 11; i++) {
                targets[i] = address(game);
                datas[i] = abi.encodeCall(MockGame.recordScore, (1));
            }
            bytes memory batchCalldata = abi.encode(
                targets, values, datas, DEADLINE, POLICY_V1, netFee, netFee, bytes(""), bytes(""), bytes32(0),
                bytes32(0)
            );
            vm.expectRevert(PeridotAccountBatch.BatchTooLarge.selector);
            account.executeV4(batchMode, batchCalldata);
        }
        // Ragged arrays revert ScopeMismatch (also pre-verify).
        {
            address[] memory targets = new address[](2);
            targets[0] = address(game);
            targets[1] = address(game);
            bytes memory batchCalldata = abi.encode(
                targets, new uint256[](1), new bytes[](2), DEADLINE, POLICY_V1, netFee, netFee, bytes(""), bytes(""),
                bytes32(0), bytes32(0)
            );
            vm.expectRevert(PeridotAccountBatch.ScopeMismatch.selector);
            account.executeV4(batchMode, batchCalldata);
        }
    }

    function test_BatchSupportsMode() public {
        assertTrue(account.supportsExecutionMode(bytes32(0)), "single");
        assertTrue(account.supportsExecutionMode(account.MODE_BATCH()), "batch");
        assertFalse(account.supportsExecutionMode(bytes32(uint256(1))), "delegatecall-style");
        assertEq(account.accountId(), "peridot.pid-account-batch.v4");
    }

    /// @dev ANT-763 Tobias follow-up: the executor allowlist must reject
    /// everything outside single+batch, and the frozen v1 forwarder must
    /// reject batch (fail-closed; account would revert anyway).
    function test_ExecutorGarbageModeRejected() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 batchMode = account.MODE_BATCH();
        bytes32 garbage = bytes32(uint256(0xFF) << 248);
        vm.expectRevert(PeridotPermissionExecutor.UnsupportedExecutionMode.selector);
        executor.executeViaPermissionV2(payable(address(account)), garbage, "");
        vm.expectRevert(PeridotPermissionExecutor.UnsupportedExecutionMode.selector);
        executor.executeViaPermissionV2(payable(address(account)), bytes32(uint256(1)), "");
        vm.expectRevert(PeridotPermissionExecutor.UnsupportedExecutionMode.selector);
        executor.executeViaPermission(payable(address(account)), batchMode, "");
    }

    // ---- session batch (via executor) ----

    function test_BatchSessionHappy() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 pid = _grant(address(game), MockGame.recordScore.selector, 1 ether);
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (5));
        datas[1] = abi.encodeCall(MockGame.recordScore, (7));
        uint256 netFee = 0.002 ether;
        uint256 protocol = netFee / 2;
        vm.expectEmit(true, false, false, true, address(account));
        emit PeridotAccountBatch.PermissionBatchExecuted(pid, 0, 2, netFee, protocol);
        _execBatchSession(executor, pid, targets, values, datas, 0, netFee, netFee + protocol);
        assertEq(game.scores(address(account)), 12, "5 + 7");
        assertEq(account.getPermission(pid).seq, 1, "one seq consumed");
        assertEq(account.getPermission(pid).feeSpent, netFee + protocol, "fee debited once");
    }

    function test_BatchSessionScopePerOp() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 pid = _grant(address(game), MockGame.recordScore.selector, 1 ether);
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        datas[1] = abi.encodeCall(MockGame.claimReward, ());
        uint256 netFee = 0.002 ether;
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _sessionBatchPayload(pid, 0, opsHash, DEADLINE, POLICY_V1, netFee + netFee / 2);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, targets, values, datas, DEADLINE, uint64(0), POLICY_V1, netFee + netFee / 2, netFee, address(this),
            auth, client, r, s
        );
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.ScopeMismatch.selector);
        executor.executeViaPermissionV2(payable(address(account)), batchMode, execCalldata);
        assertEq(account.getPermission(pid).seq, 0, "no seq consumed");
        assertEq(game.scores(address(account)), 0, "zero partial state");
    }

    function test_BatchSessionCrossTargetDenied() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 pid = _grant(address(game), MockGame.recordScore.selector, 1 ether);
        MockGame game2 = new MockGame();
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        datas[1] = abi.encodeCall(MockGame.recordScore, (1));
        uint256 netFee = 0.002 ether;
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _sessionBatchPayload(pid, 0, opsHash, DEADLINE, POLICY_V1, netFee + netFee / 2);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, targets, values, datas, DEADLINE, uint64(0), POLICY_V1, netFee + netFee / 2, netFee, address(this),
            auth, client, r, s
        );
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.ScopeMismatch.selector);
        executor.executeViaPermissionV2(payable(address(account)), batchMode, execCalldata);
    }

    function test_BatchSessionValueDenied() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 pid = _grant(address(game), MockGame.recordScore.selector, 1 ether);
        address[] memory targets = new address[](2);
        targets[0] = address(game);
        targets[1] = address(game);
        uint256[] memory values = new uint256[](2);
        values[1] = 1;
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        datas[1] = abi.encodeCall(MockGame.recordScore, (1));
        uint256 netFee = 0.002 ether;
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _sessionBatchPayload(pid, 0, opsHash, DEADLINE, POLICY_V1, netFee + netFee / 2);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, targets, values, datas, DEADLINE, uint64(0), POLICY_V1, netFee + netFee / 2, netFee, address(this),
            auth, client, r, s
        );
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.ScopeMismatch.selector);
        executor.executeViaPermissionV2(payable(address(account)), batchMode, execCalldata);
    }

    function test_BatchSessionSeqOnce() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        bytes32 pid = _grant(address(game), MockGame.recordScore.selector, 1 ether);
        address[] memory targets = new address[](1);
        targets[0] = address(game);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeCall(MockGame.recordScore, (1));
        uint256 netFee = 0.002 ether;
        _execBatchSession(executor, pid, targets, values, datas, 0, netFee, netFee + netFee / 2);
        assertEq(account.getPermission(pid).seq, 1);
        // Replay the same seq with a fresh signature over seq 0: BadSeq (pre-verify ordering).
        bytes32 opsHash = keccak256(abi.encode(targets, values, datas));
        bytes32 payload = _sessionBatchPayload(pid, 0, opsHash, DEADLINE, POLICY_V1, netFee + netFee / 2);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, targets, values, datas, DEADLINE, uint64(0), POLICY_V1, netFee + netFee / 2, netFee, address(this),
            auth, client, r, s
        );
        bytes32 batchMode = account.MODE_BATCH();
        vm.expectRevert(PeridotAccountBatch.BadSeq.selector);
        executor.executeViaPermissionV2(payable(address(account)), batchMode, execCalldata);
    }

    // ---- fuzz: owner batch shape (properties over money paths) ----

    /// @dev Bounded fuzz: n in 1..5, deltas in 1..100. Scores must equal the
    /// exact sum and exactly one nonce must be consumed per batch.
    function testFuzz_BatchOwnerShape(uint8 nRaw, uint256 seed) public {
        uint256 n = bound(nRaw, 1, 5);
        address[] memory targets = new address[](n);
        uint256[] memory values = new uint256[](n);
        bytes[] memory datas = new bytes[](n);
        uint256 expectedTotal;
        for (uint256 i = 0; i < n; i++) {
            uint256 delta = bound(uint256(keccak256(abi.encode(seed, i))), 1, 100);
            targets[i] = address(game);
            values[i] = 0;
            datas[i] = abi.encodeCall(MockGame.recordScore, (delta));
            expectedTotal += delta;
        }
        uint256 before = game.scores(address(account));
        uint64 nonceBefore = account.nonce();
        uint256 netFee = 0.004 ether;
        _execBatchOwner(targets, values, datas, netFee, netFee + netFee / 2);
        assertEq(game.scores(address(account)), before + expectedTotal, "exact sum");
        assertEq(account.nonce(), nonceBefore + 1, "one nonce per batch");
    }

    // --- base64url (mirrors the V3/V4 suites) ---

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
            uint256 n_ = (b0 << 16) | (b1 << 8) | b2;
            out[j++] = table[(n_ >> 18) & 0x3f];
            out[j++] = table[(n_ >> 12) & 0x3f];
            if (i + 1 < len) out[j++] = table[(n_ >> 6) & 0x3f];
            if (i + 2 < len) out[j++] = table[n_ & 0x3f];
            unchecked {
                i += 3;
            }
        }
        return string(out);
    }
}
