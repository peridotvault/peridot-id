// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PeridotAccount} from "../src/PeridotAccount.sol";
import {PeridotFactory} from "../src/PeridotFactory.sol";
import {PeridotPermissionExecutor} from "../src/PeridotPermissionExecutor.sol";

// ---- minimal mocks (adversarial targets) ----

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        require(allowance[f][msg.sender] >= amt && balanceOf[f] >= amt, "allow");
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[t] += amt;
        return true;
    }
}

/// @dev Fully adversarial target: runs attacker-chosen reentry on every call.
contract EvilTarget {
    address public account;
    bytes public reenterCalldata;
    bool public reentered;
    uint256 public number;

    constructor(address _account) {
        account = _account;
    }

    function setReenter(bytes calldata cd) external {
        reenterCalldata = cd;
    }

    function poke(uint256 x) external {
        number = x;
    }

    receive() external payable {}

    fallback() external payable {
        if (reenterCalldata.length > 0) {
            (bool ok, ) = account.call(reenterCalldata);
            reentered = ok;
        }
    }
}

/// @notice V4 permission-layer + ERC-7579 tests, incl. the adversarial suite.
/// ANT-556 (Option A): sessions are NONFINANCIAL-only. The four
/// `test_Perm*Bounded` financial tests are replaced by tests that FAIL on the
/// old code: financial grants revert at grant time, and session-driven
/// ETH/ERC20/721/1155 movement reverts `ScopeMismatch` on every path.
///
/// Owner key = P-256 privkey 1 (pubkey = generator G, same as V3 vectors).
/// Session key = P-256 privkey 2 (pubkey SX/SY below) — same curve as the
/// owner, so OWNER vs PERMISSION separation rests entirely on the
/// DOMAIN_PERM/op-tag/key-slot distinction under test here.
contract PeridotPermissionTest is Test {
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant SX = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant SY = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;
    /// @dev B1 binding (ANT-866): `sha256("test@pid")`; bound on-chain as
    /// `keccak256(PID_HASH ‖ GX ‖ GY)` via `_salt()`.
    bytes32 constant PID_HASH = 0xd7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa;

    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    bytes constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";
    bytes constant DOMAIN_V4 = "PID|EVM|SMART_ACCOUNT|v4";
    bytes constant DOMAIN_PERM_V1 = "PID|EVM|PERMISSION|v1";
    bytes constant DOMAIN_PERM_V2 = "PID|EVM|PERMISSION|v2";

    uint64 constant DEADLINE = 1_000_300;
    uint16 constant POLICY_V1 = 1;
    uint16 constant POLICY_V2 = 2;

    // ANT-747: on-chain floors removed — v2 settles pure 50% on every chain.
    // B1 (ANT-866): activation signatures are runtime (`_sigOwner` over the
    // bound-salt payload) — the frozen VEC_ACT vector is retired.

    bytes4 constant MAGIC_1271 = 0x1626ba7e;
    bytes4 constant MAGIC_INVALID = 0xffffffff;

    PeridotFactory factory;
    PeridotAccount account;
    bytes32 authPrefix; // neutral authenticator prefix (never compared, ANT-197)

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        authPrefix = sha256("test-rp");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        // Same deploy order as the account suite → same factory address.
        factory = new PeridotFactory(address(new PeridotAccount()), admins);
        address predicted = factory.predictBound(PID_HASH, GX, GY);
        vm.deal(predicted, 0.01 ether);
        (bytes memory actAuth, bytes memory actClient, bytes32 actR, bytes32 actS) = _sigOwner(_actPayloadV4());
        account = PeridotAccount(
            payable(
                factory.deployAndInitV4(
                    PID_HASH, GX, GY, POLICY_V1, 0.003 ether, DEADLINE, 0.002 ether, actAuth, actClient, actR, actS
                )
            )
        );
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
        return _sigAs(1, payload);
    }

    function _sigSession(bytes32 payload)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        return _sigAs(2, payload);
    }

    /// @dev Sign `payload` with an explicit P-256 privkey (rotation tests:
    /// owner and session keys change hands across rotations).
    function _sigAs(uint256 privKey, bytes32 payload)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        auth = _authData();
        client = _clientData(payload);
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _sign(privKey, h);
    }

    // ---- payload builders (mirror the contract field-for-field) ----

    function _actPayloadV4() internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(DOMAIN_V4, uint8(0x05), _salt(), GX, GY, POLICY_V1, uint256(0.003 ether), DEADLINE, block.chainid, address(factory))
        );
    }

    /// @dev B1 (ANT-866): canonical test salt — what the factory derives from
    /// `(PID_HASH, GX, GY)`.
    function _salt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PID_HASH, GX, GY));
    }

    function _pid(
        bytes32 sx,
        bytes32 sy,
        uint8 kind,
        address target,
        bytes4 selector,
        address token,
        address to,
        uint256 nftId,
        uint64 validUntil,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, block.chainid, address(account), sx, sy, kind, target, selector, token, to, nftId,
                validUntil, salt
            )
        );
    }

    function _grantPayload(
        bytes32 pid,
        bytes32 sx,
        bytes32 sy,
        uint8 kind,
        address target,
        bytes4 selector,
        address token,
        address to,
        uint256 perTxCap,
        uint256 totalLimit,
        uint256 feeLimit,
        uint256 nftId,
        uint64 validAfter,
        uint64 validUntil,
        uint64 nonce_,
        uint64 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x10), block.chainid, address(account), pid, sx, sy, kind, target, selector,
                token, to, perTxCap, totalLimit, feeLimit, nftId, validAfter, validUntil, nonce_, deadline
            )
        );
    }

    /// @dev v2 session-execution payload (session signs maxTotalFee).
    function _execPayload(
        bytes32 pid,
        uint64 seq,
        address target,
        uint256 value,
        bytes memory data,
        uint64 deadline,
        uint16 policy,
        uint256 maxTotalFee
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x12), block.chainid, address(account), pid, seq, target, value,
                keccak256(data), deadline, policy, maxTotalFee
            )
        );
    }

    /// @dev Frozen v1 session-execution payload (legacy sunset path only).
    function _execPayloadV1(
        bytes32 pid,
        uint64 seq,
        address target,
        uint256 value,
        bytes memory data,
        uint64 deadline,
        uint16 policy
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V1, uint8(0x12), block.chainid, address(account), pid, seq, target, value,
                keccak256(data), deadline, policy
            )
        );
    }

    // ---- grant/exec one-liners (v2) ----

    /// @dev Grant a NONFINANCIAL permission (v2). perTxCap/totalLimit/nftId must
    /// be 0 under Option A hygiene; feeLimit caps lifetime session fees.
    function _grant(address target, bytes4 selector, uint256 feeLimit) internal returns (bytes32 pid) {
        return _grantAs(1, SX, SY, target, selector, feeLimit);
    }

    /// @dev Grant with explicit owner privkey + session key (rotation tests:
    /// after `updateAuthority` the owner is no longer privkey 1).
    function _grantAs(uint256 ownerPriv, bytes32 sessX, bytes32 sessY, address target, bytes4 selector, uint256 feeLimit)
        internal
        returns (bytes32 pid)
    {
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256(abi.encode(target, selector, feeLimit, block.timestamp, account.nonce()));
        pid = _pid(sessX, sessY, 1, target, selector, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, sessX, sessY, 1, target, selector, address(0), address(0), 0, 0, feeLimit, 0, validAfter, validUntil,
            account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAs(ownerPriv, payload);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: sessX,
                sessionY: sessY,
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

    /// @dev Attempt a grant with an explicit kind; assert it reverts with `err`.
    /// Used for the financial-kind removal gate (fails on old code: grant succeeds).
    function _grantReverts(
        bytes4 err,
        uint8 kind,
        address target,
        bytes4 selector,
        address token,
        address to,
        uint256 feeLimit
    ) internal {
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256(abi.encode(kind, target, token, to, block.timestamp, account.nonce()));
        bytes32 pid = _pid(SX, SY, kind, target, selector, token, to, 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, kind, target, selector, token, to, 0, 0, feeLimit, 0, validAfter, validUntil,
            account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        try account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: kind,
                target: target,
                selector: selector,
                token: token,
                to: to,
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
        ) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), err, "wrong revert selector");
        }
    }

    /// @dev Zero-fee v2 execution (POLICY_V1 row, maxTotalFee 0 — boundary `0 ≤ 0`).
    function _exec(bytes32 pid, address target, uint256 value, bytes memory data, uint64 seq) internal {
        _execFull(pid, target, value, data, seq, POLICY_V1, 0, 0);
    }

    /// @dev Full v2 execution with explicit policy/cap/fee.
    function _execFull(
        bytes32 pid,
        address target,
        uint256 value,
        bytes memory data,
        uint64 seq,
        uint16 policy,
        uint256 maxTotalFee,
        uint256 netFee
    ) internal {
        _execFullAs(2, pid, target, value, data, seq, policy, maxTotalFee, netFee);
    }

    /// @dev Full v2 execution signed by an explicit session privkey (rotation
    /// tests: the session key may differ from privkey 2 after re-grants).
    function _execFullAs(
        uint256 sessPriv,
        bytes32 pid,
        address target,
        uint256 value,
        bytes memory data,
        uint64 seq,
        uint16 policy,
        uint256 maxTotalFee,
        uint256 netFee
    ) internal {
        bytes32 payload = _execPayload(pid, seq, target, value, data, DEADLINE, policy, maxTotalFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAs(sessPriv, payload);
        account.executeWithPermission(pid, target, value, data, DEADLINE, seq, policy, maxTotalFee, netFee, auth, client, r, s);
    }

    /// @dev `vm.expectRevert` cannot precede helpers (the cheatcode signing call
    /// would consume it), so reverts are asserted via try/catch + selector check.
    function _execReverts(bytes4 err, bytes32 pid, address target, uint256 value, bytes memory data, uint64 seq)
        internal
    {
        _execFullReverts(err, pid, target, value, data, seq, POLICY_V1, 0, 0);
    }

    function _execFullReverts(
        bytes4 err,
        bytes32 pid,
        address target,
        uint256 value,
        bytes memory data,
        uint64 seq,
        uint16 policy,
        uint256 maxTotalFee,
        uint256 netFee
    ) internal {
        bytes32 payload = _execPayload(pid, seq, target, value, data, DEADLINE, policy, maxTotalFee);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        try account.executeWithPermission(pid, target, value, data, DEADLINE, seq, policy, maxTotalFee, netFee, auth, client, r, s) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), err, "wrong revert selector");
        }
    }

    /// @dev Fabricate a pre-removal permission record directly in proxy storage
    /// (no grant path mints these anymore). Storage packing: nonce + initialized
    /// + factory share slot 2, so `_permissions` lives at slot 3; slot+2 packs
    /// validAfter/validUntil/seq/kind/revoked. Proves the sunset path: legacy
    /// records keep v1 semantics, financial ones stay dead.
    function _fabricateRecord(bytes32 pid, uint8 kind, address target, bytes4 selector) internal {
        _fabricateRecordGen(pid, kind, target, selector, 0);
    }

    /// @dev Fabricate with an explicit stamped generation (ANT-868 B3: the
    /// struct-appended `generation` u8 lives at record slot base+12; 0 =
    /// pre-upgrade legacy). Pins the struct layout: `getPermission` must read
    /// the stamped value back.
    function _fabricateRecordGen(bytes32 pid, uint8 kind, address target, bytes4 selector, uint8 gen) internal {
        bytes32 base = keccak256(abi.encode(pid, uint256(3)));
        vm.store(address(account), base, SX);
        vm.store(address(account), bytes32(uint256(base) + 1), SY);
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        uint256 packed = uint256(validAfter) | (uint256(validUntil) << 64) | (uint256(kind) << 192);
        vm.store(address(account), bytes32(uint256(base) + 2), bytes32(packed));
        uint256 scopeWord = uint256(uint160(target)) | (uint256(uint32(selector)) << 160);
        vm.store(address(account), bytes32(uint256(base) + 3), bytes32(scopeWord));
        vm.store(address(account), bytes32(uint256(base) + 12), bytes32(uint256(gen)));
        assertEq(account.getPermission(pid).generation, gen, "generation slot moved - update test");
    }

    /// @dev Rotate the owner authority with an explicit owner privkey.
    function _rotate(uint256 ownerPriv, bytes32 newX, bytes32 newY) internal {
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(DOMAIN_V3, uint8(0x03), block.chainid, address(account), n, newX, newY, DEADLINE)
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigAs(ownerPriv, payload);
        account.updateAuthority(newX, newY, DEADLINE, auth, client, r, s);
    }

    // ---- happy paths (non-financial only) ----

    function test_PermNonfinancialHappyPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (42)), 0);
        assertEq(evil.number(), 42);
        assertEq(account.getPermission(pid).seq, 1);
        assertEq(account.getPermission(pid).feeSpent, 0);
    }

    // ---- Option A removal gate (FAIL on old code) ----

    /// @dev Financial-kind grants must die at grant time. On old code every one
    /// of these grants succeeds → this test fails there.
    function test_PermFinancialGrantsRevert() public {
        address to = address(0xBEEF);
        // KIND_ETH (2): native transfer grant.
        _grantReverts(PeridotAccount.ScopeMismatch.selector, 2, address(0), bytes4(0), address(0), to, 1 ether);
        // KIND_ERC20 (3).
        MockERC20 token = new MockERC20();
        _grantReverts(PeridotAccount.ScopeMismatch.selector, 3, address(0), bytes4(0), address(token), to, 1 ether);
        // KIND_ERC721 (4) / KIND_ERC1155 (5): unknown kind ids stay rejected too.
        _grantReverts(PeridotAccount.ScopeMismatch.selector, 4, address(0), bytes4(0), address(token), to, 1 ether);
        _grantReverts(PeridotAccount.ScopeMismatch.selector, 5, address(0), bytes4(0), address(token), to, 1 ether);
        _grantReverts(PeridotAccount.ScopeMismatch.selector, 6, address(0), bytes4(0), address(token), to, 1 ether);
        assertEq(account.nonce(), 0, "failed grants must not consume owner nonce");
    }

    /// @dev A pre-removal ETH grant still in storage cannot move value — not via
    /// the frozen v1 entrypoint, not via v2. On old code the v1 exec succeeds
    /// and moves ETH → this test fails there.
    function test_PermLegacyEthExecReverts() public {
        address to = address(0xBEEF);
        bytes32 pid = keccak256("legacy-eth-grant");
        _fabricateRecord(pid, 2, address(0), bytes4(0));
        vm.deal(address(account), 2 ether);
        assertEq(account.getPermission(pid).kind, 2);
        // Frozen v1 path (legacy sunset entrypoint).
        bytes32 payload = _execPayloadV1(pid, 0, to, 0.3 ether, "", DEADLINE, POLICY_V1);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        try account.executeWithPermission(pid, to, 0.3 ether, "", DEADLINE, 0, POLICY_V1, 0, auth, client, r, s) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), PeridotAccount.ScopeMismatch.selector, "wrong revert selector");
        }
        assertEq(to.balance, 0, "no value may move");
        // v2 path (no v2 grant can exist for kind 2, but the record must stay dead here too).
        bytes32 payload2 = _execPayload(pid, 0, to, 0.3 ether, "", DEADLINE, POLICY_V1, 1 ether);
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(payload2);
        try account.executeWithPermission(pid, to, 0.3 ether, "", DEADLINE, 0, POLICY_V1, 1 ether, 0, a2, c2, r2, s2) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), PeridotAccount.ScopeMismatch.selector, "wrong revert selector");
        }
        assertEq(to.balance, 0, "no value may move");
    }

    /// @dev Same death certificate for token-kind records (ERC20/721/1155).
    /// `_enforceScope` reverts on the kind check before touching any token.
    function test_PermLegacyTokenExecsRevert() public {
        MockERC20 token = new MockERC20();
        token.mint(address(account), 1000);
        address to = address(0xBEEF);
        uint8[3] memory kinds = [uint8(3), uint8(4), uint8(5)];
        for (uint256 i = 0; i < kinds.length; i++) {
            bytes32 pid = keccak256(abi.encode("legacy-token-grant", kinds[i]));
            _fabricateRecord(pid, kinds[i], address(token), bytes4(0));
            bytes memory data = abi.encodeCall(MockERC20.transfer, (to, 100));
            _execFullReverts(
                PeridotAccount.ScopeMismatch.selector, pid, address(token), 0, data, 0, POLICY_V1, 1 ether, 0
            );
        }
        assertEq(token.balanceOf(to), 0, "no tokens may move");
        // Sneaked `approve` through a legacy token record dies the same way.
        bytes32 pid4 = keccak256(abi.encode("legacy-token-grant", uint8(3)));
        bytes memory evil = abi.encodeCall(MockERC20.approve, (to, 1000));
        _execFullReverts(
            PeridotAccount.ScopeMismatch.selector, pid4, address(token), 0, evil, 0, POLICY_V1, 1 ether, 0
        );
        assertEq(token.allowance(address(account), to), 0);
    }

    /// @dev The frozen v1 entrypoint keeps serving legacy NONFINANCIAL grants
    /// (natural sunset): v1-signed exec succeeds, seq advances, v1 fee semantics.
    function test_PermLegacyNonfinancialSunsetsNaturally() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = keccak256("legacy-nonfinancial-grant");
        _fabricateRecord(pid, 1, address(evil), EvilTarget.poke.selector);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (42));
        bytes32 payload = _execPayloadV1(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY_V1, 0, auth, client, r, s);
        assertEq(evil.number(), 42);
        assertEq(account.getPermission(pid).seq, 1);
    }

    // ---- fee caps (Security condition + ANT-544 B5) ----

    function test_PermFeeLimitEnforced() public {
        EvilTarget evil = new EvilTarget(address(account));
        // One execution costs 0.0015 (0.001 network + 0.0005 protocol at POLICY_V1).
        uint256 feeLimit = 0.002 ether;
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, feeLimit);
        vm.deal(address(account), 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        _execFull(pid, address(evil), 0, data, 0, POLICY_V1, 0.0015 ether, 0.001 ether);
        assertEq(account.getPermission(pid).feeSpent, 0.0015 ether);
        // Second identical execution would push lifetime fees to 0.003 > 0.002.
        _execFullReverts(
            PeridotAccount.LimitExceeded.selector, pid, address(evil), 0, data, 1, POLICY_V1, 0.0015 ether,
            0.001 ether
        );
        assertEq(account.getPermission(pid).seq, 1, "reverted exec must not advance seq");
    }

    function test_PermMaxTotalFeeEnforced() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 1 ether);
        vm.deal(address(account), 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        // Attested total 0.0015 (POLICY_V1) against a 0.0014 bound → FeeExceedsMax, nothing moves.
        _execFullReverts(
            PeridotAccount.FeeExceedsMax.selector, pid, address(evil), 0, data, 0, POLICY_V1, 0.0014 ether,
            0.001 ether
        );
        assertEq(evil.number(), 0);
        assertEq(account.getPermission(pid).seq, 0);
        // Exact boundary `total == maxTotalFee` passes (`≤`).
        _execFull(pid, address(evil), 0, data, 0, POLICY_V1, 0.0015 ether, 0.001 ether);
        assertEq(evil.number(), 1);
    }

    function test_PermUnknownPolicyReverts() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        // Version gate runs before signature verification: even a wrong-key
        // signature over an unknown version reverts UnknownFeePolicy.
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, 99, 1 ether);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        try account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, 99, 1 ether, 0, auth, client, r, s) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), PeridotAccount.UnknownFeePolicy.selector, "wrong revert selector");
        }
    }

    // ---- v2 fee formula vectors (ANT-544 B3, byte-exact) ----

    function _execV4Owner(address target, bytes memory data, uint16 policy, uint256 maxTotalFee, uint256 netFee)
        internal
    {
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x01), block.chainid, address(account), n, target, uint256(0), keccak256(data),
                DEADLINE, policy, maxTotalFee
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.executeV4(target, 0, data, DEADLINE, policy, maxTotalFee, netFee, auth, client, r, s);
    }

    /// @dev ANT-747: v2 settles pure 50% — network 0.000021 ETH → 0.0000105 protocol.
    function test_FeeV2PurePercent() public {
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        uint256 netFee = 0.000021 ether;
        uint256 protocol = 0.0000105 ether;
        _execV4Owner(address(evil), abi.encodeCall(EvilTarget.poke, (1)), POLICY_V2, netFee + protocol, netFee);
        assertEq(evil.number(), 1);
        assertEq(address(this).balance, relayerBefore + netFee, "relayer gets exact network fee");
        assertEq(address(factory).balance, factoryBefore + protocol, "vault gets 50% protocol fee");
    }

    /// @dev ANT-747 regression: tiny Base-class fee settles WITHOUT any floor —
    /// network 0.0000002 ETH → protocol 0.0000001 ETH (total 0.0000003), not the
    /// removed 0.00000075 floor (old total would have been 0.00000095).
    function test_FeeV2LowFeeNoFloor() public {
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        uint256 netFee = 200_000_000_000; // 0.0000002 ETH
        uint256 protocol = 100_000_000_000; // pure 50%
        _execV4Owner(address(evil), abi.encodeCall(EvilTarget.poke, (1)), POLICY_V2, netFee + protocol, netFee);
        assertEq(address(factory).balance, factoryBefore + protocol, "vault gets pure 50%, no floor");
        assertEq(address(this).balance, relayerBefore + netFee, "relayer gets exact network fee");
    }

    /// @dev ANT-747 regression: BSC-class tiny fee, same rule — network
    /// 0.0000021 BNB → protocol 0.00000105 BNB (total 0.00000315), not the
    /// removed 0.0000023 floor (old total would have been 0.0000044).
    function test_FeeV2BscLowFeeNoFloor() public {
        vm.chainId(56);
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        uint256 netFee = 2_100_000_000_000;
        uint256 protocol = 1_050_000_000_000; // pure 50%
        _execV4Owner(address(evil), abi.encodeCall(EvilTarget.poke, (1)), POLICY_V2, netFee + protocol, netFee);
        assertEq(address(factory).balance, factoryBefore + protocol, "vault gets pure 50%, no BSC floor");
        assertEq(address(this).balance, relayerBefore + netFee, "relayer gets exact network fee");
        vm.chainId(31337);
    }

    /// @dev Every chain settles the percentage leg — no chain carries a floor.
    function test_FeeV2AllChainsPercentOnly() public {
        vm.chainId(10); // Optimism: percentage leg only.
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        uint256 factoryBefore = address(factory).balance;
        uint256 netFee = 0.0000002 ether;
        _execV4Owner(address(evil), abi.encodeCall(EvilTarget.poke, (1)), POLICY_V2, netFee + 0.0000001 ether, netFee);
        assertEq(address(factory).balance, factoryBefore + 0.0000001 ether, "no floor on any chain");
        vm.chainId(31337);
    }

    function test_ExecV4MaxTotalFeeReverts() public {
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        uint64 n = account.nonce();
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        uint256 netFee = 0.001 ether;
        uint256 protocol = 0.0005 ether; // POLICY_V1 row under V4 also supported.
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x01), block.chainid, address(account), n, address(evil), uint256(0),
                keccak256(data), DEADLINE, POLICY_V1, netFee + protocol - 1
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.FeeExceedsMax.selector);
        account.executeV4(address(evil), 0, data, DEADLINE, POLICY_V1, netFee + protocol - 1, netFee, auth, client, r, s);
        assertEq(account.nonce(), n, "reverted exec must not consume nonce");
    }

    // ---- rotation → address stability (G6 pin) ----

    function test_RotateKeepsAddressAndMovesAuthority() public {
        address before = factory.predictBound(PID_HASH, GX, GY);
        assertEq(before, address(account), "counterfactual address mismatch");
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(DOMAIN_V3, uint8(0x03), block.chainid, address(account), n, SX, SY, DEADLINE)
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.updateAuthority(SX, SY, DEADLINE, auth, client, r, s);
        // Address derives from factory+impl+bound salt only — rotation cannot move it.
        assertEq(factory.predictBound(PID_HASH, GX, GY), before, "rotation moved the address");
        assertEq(account.authorityX(), SX);
        assertEq(account.authorityY(), SY);
        // New key executes (V4 owner path, fresh nonce).
        bytes32 execPayload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x01), block.chainid, address(account), n + 1, address(0x1234), uint256(0),
                keccak256(""), DEADLINE, POLICY_V1, uint256(0)
            )
        );
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(execPayload);
        account.executeV4(address(0x1234), 0, "", DEADLINE, POLICY_V1, 0, 0, a2, c2, r2, s2);
        // Old-key replay over FRESH bytes (current nonce) fails on the key, not
        // the nonce: the old key no longer verifies.
        bytes32 execPayload2 = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x01), block.chainid, address(account), n + 2, address(0x1234), uint256(0),
                keccak256(""), DEADLINE, POLICY_V1, uint256(0)
            )
        );
        (bytes memory a3, bytes memory c3, bytes32 r3, bytes32 s3) = _sigOwner(execPayload2);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.executeV4(address(0x1234), 0, "", DEADLINE, POLICY_V1, 0, 0, a3, c3, r3, s3);
    }

    // ---- ANT-868 B3: rotation revokes sessions (EVM parity of the SVM u8 epoch) ----

    /// @dev Grant → exec → rotate → stale. The pre-rotation session dies with
    /// `SessionStaleGeneration` (not BadSeq/Unauthorized), and a re-grant
    /// under the new owner recovers. Fails on old code: no epoch exists so
    /// the post-rotation exec succeeds.
    function test_RotateRevokesSessionsV2() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        assertEq(account.sessionGeneration(), 0, "fresh epoch must be 0");
        assertEq(account.getPermission(pid).generation, 0, "grant must stamp current epoch");
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (42)), 0);
        assertEq(evil.number(), 42);

        _rotate(1, SX, SY);
        assertEq(account.sessionGeneration(), 1, "rotation must bump the epoch");
        assertEq(account.authorityX(), SX, "rotation must still move authority");

        // Same session, next seq, correctly signed — dead by epoch, not by seq.
        _execFullReverts(
            PeridotAccount.SessionStaleGeneration.selector,
            pid,
            address(evil),
            0,
            abi.encodeCall(EvilTarget.poke, (43)),
            1,
            POLICY_V1,
            0,
            0
        );
        assertEq(evil.number(), 42, "stale exec must not touch the target");

        // Recovery: the new owner (key 2) re-grants the old owner key (key 1)
        // as a session; the fresh stamp (1) executes.
        bytes32 pid2 = _grantAs(2, GX, GY, address(evil), EvilTarget.poke.selector, 0.01 ether);
        assertEq(account.getPermission(pid2).generation, 1, "re-grant must stamp the new epoch");
        _execFullAs(1, pid2, address(evil), 0, abi.encodeCall(EvilTarget.poke, (7)), 0, POLICY_V1, 0, 0);
        assertEq(evil.number(), 7);
        // The old record stays dead even with a correct next-seq signature.
        _execFullReverts(
            PeridotAccount.SessionStaleGeneration.selector,
            pid,
            address(evil),
            0,
            abi.encodeCall(EvilTarget.poke, (44)),
            1,
            POLICY_V1,
            0,
            0
        );
    }

    /// @dev The frozen v1 entrypoint is gated too (shared `_executePermission`
    /// core): a legacy generation-0 record executes pre-rotation and dies
    /// post-rotation.
    function test_RotateRevokesFrozenV1() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = keccak256("legacy-b3-grant");
        _fabricateRecord(pid, 1, address(evil), EvilTarget.poke.selector);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (42));
        bytes32 payload = _execPayloadV1(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY_V1, 0, auth, client, r, s);
        assertEq(evil.number(), 42);

        _rotate(1, SX, SY);
        bytes32 payload2 = _execPayloadV1(pid, 1, address(evil), 0, data, DEADLINE, POLICY_V1);
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(payload2);
        try account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 1, POLICY_V1, 0, a2, c2, r2, s2) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), PeridotAccount.SessionStaleGeneration.selector, "wrong revert selector");
        }
        assertEq(evil.number(), 42, "stale v1 exec must not touch the target");
    }

    /// @dev Fail-closed in the forward direction too: a record stamped NEWER
    /// than the account epoch (crafted storage, never grantable) reverts
    /// instead of executing.
    function test_StaleCheckFailsClosedForward() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = keccak256("future-generation-grant");
        _fabricateRecordGen(pid, 1, address(evil), EvilTarget.poke.selector, 1);
        _execFullReverts(
            PeridotAccount.SessionStaleGeneration.selector,
            pid,
            address(evil),
            0,
            abi.encodeCall(EvilTarget.poke, (1)),
            0,
            POLICY_V1,
            1 ether,
            0
        );
        assertEq(evil.number(), 0);
    }

    /// @dev Saturation: at epoch 255 further rotations keep 255 (never wrap
    /// to 0, which would revive generation-0 records). Current-epoch records
    /// keep executing; generation-0 records stay dead.
    function test_GenerationSaturatesAt255() public {
        // `sessionGeneration` is the appended slot after `__gap`/`_lastResult`.
        vm.store(address(account), bytes32(uint256(45)), bytes32(uint256(255)));
        assertEq(account.sessionGeneration(), 255, "sessionGeneration slot moved - update test");
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        assertEq(account.getPermission(pid).generation, 255);
        _rotate(1, SX, SY);
        assertEq(account.sessionGeneration(), 255, "epoch must saturate, not wrap");
        // Current-epoch record executes (session key 2 == new owner key 2 here;
        // the contract checks the stored session slot, which is unchanged).
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (9)), 0);
        assertEq(evil.number(), 9);
        // Generation-0 record stays dead.
        bytes32 old = keccak256("saturated-old-grant");
        _fabricateRecord(old, 1, address(evil), EvilTarget.poke.selector);
        _execFullReverts(
            PeridotAccount.SessionStaleGeneration.selector,
            old,
            address(evil),
            0,
            abi.encodeCall(EvilTarget.poke, (1)),
            0,
            POLICY_V1,
            1 ether,
            0
        );
    }

    /// @dev Rotation still bumps the epoch when no permission exists (epoch is
    /// account state, not permission state) — and a later grant stamps it.
    function test_RotateBumpsEpochWithoutPermissions() public {
        assertEq(account.sessionGeneration(), 0);
        _rotate(1, SX, SY);
        _rotate(2, GX, GY);
        assertEq(account.sessionGeneration(), 2, "each rotation must bump once");
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grantAs(1, SX, SY, address(evil), EvilTarget.poke.selector, 0.01 ether);
        assertEq(account.getPermission(pid).generation, 2, "grant must stamp the current epoch");
        _execFullAs(2, pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (3)), 0, POLICY_V1, 0, 0);
        assertEq(evil.number(), 3);
    }

    // ---- V4 activation (fee-capped, factory V4 path) ----

    function test_ActivateV4HappyPath() public {
        // Distinct pid → distinct bound salt (the suite pid is already claimed in setUp).
        bytes32 pid9 = keccak256("perm-v4-9");
        bytes32 salt9 = keccak256(abi.encodePacked(pid9, GX, GY));
        address predicted = factory.predictBound(pid9, GX, GY);
        vm.deal(predicted, 0.01 ether);
        uint256 maxTotalFee = 0.003 ether;
        uint256 netFee = 0.002 ether;
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x05), salt9, GX, GY, POLICY_V1, maxTotalFee, DEADLINE, block.chainid,
                address(factory)
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        uint256 factoryBefore = address(factory).balance;
        PeridotAccount fresh = PeridotAccount(
            payable(
                factory.deployAndInitV4(pid9, GX, GY, POLICY_V1, maxTotalFee, DEADLINE, netFee, auth, client, r, s)
            )
        );
        assertTrue(fresh.initialized());
        assertEq(fresh.authorityX(), GX);
        // POLICY_V1 row: protocol = 50% of 0.002.
        assertEq(address(factory).balance, factoryBefore + 0.001 ether);
    }

    function test_ActivateV4MaxTotalFeeReverts() public {
        bytes32 pid10 = keccak256("perm-v4-10");
        bytes32 salt10 = keccak256(abi.encodePacked(pid10, GX, GY));
        address predicted = factory.predictBound(pid10, GX, GY);
        vm.deal(predicted, 0.01 ether);
        uint256 netFee = 0.002 ether;
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x05), salt10, GX, GY, POLICY_V1, netFee, DEADLINE, block.chainid, address(factory)
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotFactory.InitFailed.selector);
        factory.deployAndInitV4(pid10, GX, GY, POLICY_V1, netFee, DEADLINE, netFee, auth, client, r, s);
    }

    // ---- executor + 7579 paths ----

    /// @dev Frozen v1 executor entrypoint keeps serving legacy NONFINANCIAL
    /// grants (13-tuple calldata, v1 payload): install module, fabricate the
    /// pre-removal record, forward through the executor → executes, seq advances.
    function test_PermExecutorPathFrozenV1() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        assertTrue(account.isModuleInstalled(2, address(executor), ""));
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = keccak256("legacy-executor-grant");
        _fabricateRecord(pid, 1, address(evil), EvilTarget.poke.selector);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (7));
        bytes32 payload = _execPayloadV1(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, address(evil), uint256(0), data, DEADLINE, uint64(0), POLICY_V1, uint256(0), address(this), auth,
            client, r, s
        );
        executor.executeViaPermission(payable(address(account)), bytes32(0), execCalldata);
        assertEq(evil.number(), 7);
        assertEq(account.getPermission(pid).seq, 1);
    }

    function test_PermExecutorPathV2() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (7));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, address(evil), uint256(0), data, DEADLINE, uint64(0), POLICY_V1, uint256(0), uint256(0),
            address(this), auth, client, r, s
        );
        executor.executeViaPermissionV2(payable(address(account)), bytes32(0), execCalldata);
        assertEq(evil.number(), 7);
        assertEq(account.getPermission(pid).seq, 1);
    }

    function test_PermFeeSettlement() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 1 ether);
        vm.deal(address(account), 1 ether);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        _execFull(pid, address(evil), 0, data, 0, POLICY_V1, 0.0015 ether, 0.001 ether);
        assertEq(address(this).balance, relayerBefore + 0.001 ether);
        assertEq(address(factory).balance, factoryBefore + 0.0005 ether);
        assertEq(account.getPermission(pid).feeSpent, 0.0015 ether);
    }

    function test_7579ExecuteHappyPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes memory data = abi.encodeCall(EvilTarget.poke, (11));
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x15), block.chainid, address(account), n, address(evil), uint256(0),
                keccak256(data), DEADLINE, POLICY_V1
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.execute(bytes32(0), abi.encode(address(evil), uint256(0), data, DEADLINE, POLICY_V1, uint256(0), auth, client, r, s));
        assertEq(evil.number(), 11);
        assertEq(account.nonce(), n + 1);
    }

    function test_7579ExecuteV4HappyPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        vm.deal(address(account), 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (11));
        uint64 n = account.nonce();
        uint256 netFee = 0.001 ether;
        uint256 protocol = 0.0005 ether;
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x15), block.chainid, address(account), n, address(evil), uint256(0),
                keccak256(data), DEADLINE, POLICY_V1, netFee + protocol
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.executeV4(
            bytes32(0),
            abi.encode(address(evil), uint256(0), data, DEADLINE, POLICY_V1, netFee + protocol, netFee, auth, client, r, s)
        );
        assertEq(evil.number(), 11);
        assertEq(account.nonce(), n + 1);
        // Under-cap bound reverts without consuming nonce.
        bytes32 payload2 = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x15), block.chainid, address(account), n + 1, address(evil), uint256(0),
                keccak256(data), DEADLINE, POLICY_V1, netFee + protocol - 1
            )
        );
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigOwner(payload2);
        vm.expectRevert(PeridotAccount.FeeExceedsMax.selector);
        account.executeV4(
            bytes32(0),
            abi.encode(address(evil), uint256(0), data, DEADLINE, POLICY_V1, netFee + protocol - 1, netFee, a2, c2, r2, s2)
        );
        assertEq(account.nonce(), n + 1);
    }

    // ---- adversarial: no unauthorized financial operation ----

    function test_AdvCannotSendEthOnNonfinancial() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        vm.deal(address(account), 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0.5 ether, data, DEADLINE, POLICY_V1, 1 ether);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.ScopeMismatch.selector);
        account.executeWithPermission(pid, address(evil), 0.5 ether, data, DEADLINE, 0, POLICY_V1, 1 ether, 0, auth, client, r, s);
    }

    function test_AdvCannotGrantApproveSelector() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256("deny");
        bytes4 sel = MockERC20.approve.selector;
        bytes32 pid = _pid(SX, SY, 1, address(evil), sel, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), sel, address(0), address(0), 0, 0, 0, 0, validAfter, validUntil,
            account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.DeniedSelector.selector);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: address(evil),
                selector: sel,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: 0,
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

    // ---- adversarial: no escalation to owner authority ----

    function test_AdvCannotTargetSelf() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory evilCall = abi.encodeWithSignature(
            "updateAuthority(bytes32,bytes32,uint64,bytes,bytes,bytes32,bytes32)",
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            DEADLINE,
            _authData(),
            _clientData(bytes32(0)),
            bytes32(0),
            bytes32(0)
        );
        bytes32 payload = _execPayload(pid, 0, address(account), 0, evilCall, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.InvalidTarget.selector);
        account.executeWithPermission(pid, address(account), 0, evilCall, DEADLINE, 0, POLICY_V1, 0, 0, auth, client, r, s);
        assertEq(account.authorityX(), GX);
    }

    function test_AdvReentryIntoRotateFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        evil.setReenter(
            abi.encodeWithSignature(
                "updateAuthority(bytes32,bytes32,uint64,bytes,bytes,bytes32,bytes32)",
                bytes32(uint256(1)),
                bytes32(uint256(2)),
                DEADLINE,
                _authData(),
                _clientData(bytes32(0)),
                bytes32(0),
                bytes32(0)
            )
        );
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (1)), 0);
        assertFalse(evil.reentered());
        assertEq(account.authorityX(), GX);
    }

    function test_AdvReentryIntoPermExecFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        // Inner call replays the exact same (valid-once) execution while the outer holds the lock.
        evil.setReenter(
            abi.encodeWithSignature(
                "executeWithPermission(bytes32,address,uint256,bytes,uint64,uint64,uint16,uint256,uint256,bytes,bytes,bytes32,bytes32)",
                pid,
                address(evil),
                uint256(0),
                data,
                DEADLINE,
                uint64(0),
                POLICY_V1,
                uint256(0),
                uint256(0),
                auth,
                client,
                r,
                s
            )
        );
        _exec(pid, address(evil), 0, data, 0);
        assertFalse(evil.reentered());
        assertEq(account.getPermission(pid).seq, 1);
    }

    function test_AdvReentryIntoInstallFails() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        evil.setReenter(
            abi.encodeWithSignature(
                "installModule(uint256,address,bytes,uint64,bytes,bytes,bytes32,bytes32)",
                uint256(2),
                address(executor),
                bytes(""),
                DEADLINE,
                _authData(),
                _clientData(bytes32(0)),
                bytes32(0),
                bytes32(0)
            )
        );
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (1)), 0);
        assertFalse(evil.reentered());
        assertFalse(account.isModuleInstalled(2, address(executor), ""));
    }

    // ---- adversarial: replay / expiry / revocation ----

    function test_AdvReplaySameSeqFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (1)), 0);
        _execReverts(
            PeridotAccount.BadSeq.selector, pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (2)), 0
        );
        _execReverts(
            PeridotAccount.BadSeq.selector, pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (2)), 5
        );
        assertEq(evil.number(), 1);
    }

    function test_AdvExpiredPermissionFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_100;
        bytes32 salt = keccak256("short");
        bytes32 pid = _pid(SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, 0, validAfter,
            validUntil, account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: address(evil),
                selector: EvilTarget.poke.selector,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: 0,
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
        vm.warp(validUntil + 1);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        // Fresh short deadline at the new timestamp.
        uint64 dl = uint64(block.timestamp + 100);
        bytes32 ep = _execPayload(pid, 0, address(evil), 0, data, dl, POLICY_V1, 0);
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(ep);
        vm.expectRevert(PeridotAccount.PermissionExpired.selector);
        account.executeWithPermission(pid, address(evil), 0, data, dl, 0, POLICY_V1, 0, 0, a2, c2, r2, s2);
    }

    function test_AdvLongTtlRejected() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        uint64 longDl = uint64(block.timestamp + 601);
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, longDl, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.executeWithPermission(pid, address(evil), 0, data, longDl, 0, POLICY_V1, 0, 0, auth, client, r, s);
    }

    function test_AdvRevokeIsImmediateAndOwnerOnly() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        // Session-signed revoke (over the owner payload shape) must not verify as owner.
        bytes32 revokePayload = keccak256(
            abi.encodePacked(DOMAIN_PERM_V2, uint8(0x11), block.chainid, address(account), pid, account.nonce(), DEADLINE)
        );
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(revokePayload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.revokePermission(pid, DEADLINE, a2, c2, r2, s2);
        // Owner revokes; execution dies immediately without session cooperation.
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(revokePayload);
        account.revokePermission(pid, DEADLINE, auth, client, r, s);
        assertTrue(account.getPermission(pid).revoked);
        _execReverts(
            PeridotAccount.AlreadyRevoked.selector, pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (1)), 0
        );
    }

    function test_AdvCrossChainReplayFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.chainId(999);
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY_V1, 0, 0, auth, client, r, s);
        vm.chainId(31337);
        _exec(pid, address(evil), 0, data, 0);
    }

    // ---- adversarial: OWNER vs PERMISSION confusion ----

    function test_AdvOwnerSigInvalidOnPermPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        // Owner signs the PERM payload, but the stored session key differs → Unauthorized.
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY_V1, 0, 0, auth, client, r, s);
    }

    function test_AdvSessionSigInvalidOnOwnerPaths() public {
        // Session signs a V4 owner payload shape; the owner verifier must reject it.
        address to = address(0x1234);
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V4, uint8(0x01), block.chainid, address(account), account.nonce(), to, uint256(0),
                keccak256(""), DEADLINE, POLICY_V1, uint256(0)
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.executeV4(to, 0, "", DEADLINE, POLICY_V1, 0, 0, auth, client, r, s);
    }

    function test_AdvGrantNeedsOwnerSig() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256("selfgrant");
        bytes32 pid = _pid(SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, 0, validAfter,
            validUntil, account.nonce(), DEADLINE
        );
        // Session key signs its own grant → must fail (only the owner grants).
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: address(evil),
                selector: EvilTarget.poke.selector,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: 0,
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

    // ---- adversarial: ERC-1271 ----

    function _sig1271(bytes32 hash, uint256 privKey)
        internal
        returns (bytes memory auth, bytes memory client, bytes32 r, bytes32 s)
    {
        bytes32 challenge = keccak256(abi.encodePacked(DOMAIN_V3, uint8(0x16), block.chainid, address(account), hash));
        auth = _authData();
        client = _clientData(challenge);
        bytes32 h = sha256(bytes.concat(auth, sha256(client)));
        (r, s) = _sign(privKey, h);
    }

    function test_Adv1271OwnerOkSessionRejected() public {
        bytes32 hash = keccak256("hello peridot");
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sig1271(hash, 1);
        assertEq(account.isValidSignature(hash, abi.encode(auth, client, r, s)), MAGIC_1271);
        // Same hash, session-signed → invalid.
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sig1271(hash, 2);
        assertEq(account.isValidSignature(hash, abi.encode(a2, c2, r2, s2)), MAGIC_INVALID);
        // A permission-execution clientData reused as a 1271 signature → invalid
        // (different challenge domain/fields).
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 ep = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory a3, bytes memory c3, bytes32 r3, bytes32 s3) = _sigSession(ep);
        assertEq(account.isValidSignature(keccak256(data), abi.encode(a3, c3, r3, s3)), MAGIC_INVALID);
    }

    function test_AdvNoDelegatecallInImplementation() public {
        // The EIP-1167 proxies legitimately contain DELEGATECALL; the
        // implementation itself must not. Raw 0xF4 bytes also occur inside
        // PUSH immediates, so walk the opcode stream and skip push data.
        address impl = factory.implementation();
        bytes memory code = impl.code;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0xF4) {
                fail("DELEGATECALL opcode in implementation");
            }
            if (op >= 0x60 && op <= 0x7F) {
                i += (op - 0x5F) + 1;
            } else {
                i += 1;
            }
        }
    }

    function test_AdvGrantIdBinding() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        // permissionId that does not match the scope → BadPermissionId.
        bytes32 payload = _grantPayload(
            bytes32(uint256(1234)), SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0,
            0, 0, validAfter, validUntil, account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.BadPermissionId.selector);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: bytes32(uint256(1234)),
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: address(evil),
                selector: EvilTarget.poke.selector,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: 0,
                nftId: 0,
                validAfter: validAfter,
                validUntil: validUntil,
                salt: bytes32(0),
                deadline: DEADLINE
            }),
            auth,
            client,
            r,
            s
        );
    }

    function test_AdvGrantTtlBounded() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 31 days;
        bytes32 salt = keccak256("long");
        bytes32 pid = _pid(SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, 0, validAfter,
            validUntil, account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.PermissionTTLExceeded.selector);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: 1,
                target: address(evil),
                selector: EvilTarget.poke.selector,
                token: address(0),
                to: address(0),
                perTxCap: 0,
                totalLimit: 0,
                feeLimit: 0,
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

    function test_AdvFeeSanityOnPermPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 1000 ether);
        vm.deal(address(account), 200 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        // Cap checks pass (attested total 150 ≤ 200 cap, lifetime 150 ≤ 1000
        // limit) so the full-frame gas-sanity bound is what reverts.
        _execFullReverts(
            PeridotAccount.GasAnomaly.selector, pid, address(evil), 0, data, 0, POLICY_V1, 200 ether, 100 ether
        );
    }

    // ---- adversarial: module + mode boundaries ----

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

    function test_AdvModuleTypeBoundaries() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        // Fallback + hook modules permanently unsupported.
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x13), block.chainid, address(account), uint256(3), address(executor),
                keccak256(""), n, DEADLINE
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.UnsupportedModuleType.selector);
        account.installModule(3, address(executor), "", DEADLINE, auth, client, r, s);
        // Install needs the owner signature.
        bytes32 payload2 = keccak256(
            abi.encodePacked(
                DOMAIN_PERM_V2, uint8(0x13), block.chainid, address(account), uint256(2), address(executor),
                keccak256(""), n, DEADLINE
            )
        );
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(payload2);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.installModule(2, address(executor), "", DEADLINE, a2, c2, r2, s2);
        // Double install fails.
        _installModule(2, address(executor));
        {
            uint64 n2 = account.nonce();
            bytes32 p3 = keccak256(
                abi.encodePacked(
                    DOMAIN_PERM_V2, uint8(0x13), block.chainid, address(account), uint256(2), address(executor),
                    keccak256(""), n2, DEADLINE
                )
            );
            (bytes memory a3, bytes memory c3, bytes32 r3, bytes32 s3) = _sigOwner(p3);
            try account.installModule(2, address(executor), "", DEADLINE, a3, c3, r3, s3) {
                fail("expected revert");
            } catch (bytes memory ret) {
                assertEq(bytes4(ret), PeridotAccount.AlreadyInstalled.selector);
            }
        }
    }

    function test_AdvExecutorCallNeedsModule() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(address(evil), EvilTarget.poke.selector, 0.01 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY_V1, 0);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, address(evil), uint256(0), data, DEADLINE, uint64(0), POLICY_V1, uint256(0), uint256(0),
            address(this), auth, client, r, s
        );
        // Not installed → NotModule (also covers direct account.executeFromExecutorV2 calls).
        vm.expectRevert(PeridotAccount.NotModule.selector);
        executor.executeViaPermissionV2(payable(address(account)), bytes32(0), execCalldata);
        vm.expectRevert(PeridotAccount.NotModule.selector);
        account.executeFromExecutorV2(bytes32(0), execCalldata);
    }

    function test_AdvDelegatecallAndBatchModesRejected() public {
        assertFalse(account.supportsExecutionMode(bytes32(uint256(1))));
        assertFalse(
            account.supportsExecutionMode(
                bytes32(hex"0100000000000000000000000000000000000000000000000000000000000000")
            )
        );
        assertTrue(account.supportsExecutionMode(bytes32(0)));
        assertTrue(account.supportsModule(1));
        assertTrue(account.supportsModule(2));
        assertFalse(account.supportsModule(3));
        assertFalse(account.supportsModule(4));
        vm.expectRevert(PeridotAccount.UnsupportedExecutionMode.selector);
        account.execute(bytes32(uint256(1)), "");
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        vm.expectRevert(PeridotAccount.UnsupportedExecutionMode.selector);
        account.executeFromExecutorV2(bytes32(uint256(1)), "");
    }

    // --- base64url (mirrors the V3 suite) ---

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
