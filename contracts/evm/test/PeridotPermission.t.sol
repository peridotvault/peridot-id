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

contract MockERC721 {
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function transferFrom(address f, address t, uint256 id) external {
        require(ownerOf[id] == f, "owner");
        ownerOf[id] = t;
    }

    function safeTransferFrom(address f, address t, uint256 id) external {
        require(ownerOf[id] == f, "owner");
        ownerOf[id] = t;
    }
}

contract MockERC1155 {
    mapping(uint256 => mapping(address => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amt) external {
        balanceOf[id][to] += amt;
    }

    function safeTransferFrom(address f, address t, uint256 id, uint256 amt, bytes calldata) external {
        require(balanceOf[id][f] >= amt, "bal");
        balanceOf[id][f] -= amt;
        balanceOf[id][t] += amt;
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
/// Owner key = P-256 privkey 1 (pubkey = generator G, same as V3 vectors).
/// Session key = P-256 privkey 2 (pubkey SX/SY below) — same curve as the
/// owner, so OWNER vs PERMISSION separation rests entirely on the
/// DOMAIN_PERM/op-tag/key-slot distinction under test here.
contract PeridotPermissionTest is Test {
    bytes32 constant GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    bytes32 constant SX = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant SY = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;
    bytes32 constant SALT = bytes32(uint256(7));

    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    bytes constant DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3";
    bytes constant DOMAIN_PERM = "PID|EVM|PERMISSION|v1";

    uint64 constant DEADLINE = 1_000_300;
    uint16 constant POLICY = 1;

    bytes32 constant VEC_ACT_R = 0x09e5b78b9ce736236dfb152bb32f32ca6e14e41b6830725f9f1f6a9a7a2f8232;
    bytes32 constant VEC_ACT_S = 0x5d9b60bf78ee752a6ee2d3891af58c94d23183b8e26398b11680cfe1a4313161;

    bytes4 constant MAGIC_1271 = 0x1626ba7e;
    bytes4 constant MAGIC_INVALID = 0xffffffff;

    PeridotFactory factory;
    PeridotAccount account;
    bytes32 rpIdHash;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        vm.txGasPrice(10 gwei);
        rpIdHash = sha256("localhost");
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        // Same deploy order as the V3 suite → same factory address → VEC_ACT reusable.
        factory = new PeridotFactory(address(new PeridotAccount()), address(this), admins);
        address predicted = factory.predict(SALT);
        vm.deal(predicted, 0.01 ether);
        account = PeridotAccount(
            payable(
                factory.deployAndInit(
                    SALT, GX, GY, rpIdHash, POLICY, DEADLINE, 0.002 ether, _authData(), _clientData(_actPayload()),
                    VEC_ACT_R, VEC_ACT_S
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
        return bytes.concat(rpIdHash, bytes1(0x05), bytes4(uint32(1)));
    }

    function _clientData(bytes32 challenge) internal pure returns (bytes memory) {
        return bytes.concat(
            '{"type":"webauthn.get","challenge":"',
            bytes(b64url(abi.encodePacked(challenge))),
            '","origin":"http://localhost:8081"}'
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

    // ---- payload builders (mirror the contract field-for-field) ----

    function _actPayload() internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(DOMAIN_V3, uint8(0x05), SALT, GX, GY, rpIdHash, POLICY, DEADLINE, block.chainid, address(factory))
        );
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
                DOMAIN_PERM, block.chainid, address(account), sx, sy, kind, target, selector, token, to, nftId,
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
        uint256 nftId,
        uint64 validAfter,
        uint64 validUntil,
        uint64 nonce_,
        uint64 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DOMAIN_PERM, uint8(0x10), block.chainid, address(account), pid, sx, sy, kind, target, selector, token,
                to, perTxCap, totalLimit, nftId, validAfter, validUntil, nonce_, deadline
            )
        );
    }

    function _execPayload(
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
                DOMAIN_PERM, uint8(0x12), block.chainid, address(account), pid, seq, target, value, keccak256(data),
                deadline, policy
            )
        );
    }

    // ---- grant/exec one-liners ----

    function _grant(
        uint8 kind,
        address target,
        bytes4 selector,
        address token,
        address to,
        uint256 perTxCap,
        uint256 totalLimit,
        uint256 nftId
    ) internal returns (bytes32 pid) {
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256(abi.encode(kind, target, token, to, nftId, block.timestamp, account.nonce()));
        pid = _pid(SX, SY, kind, target, selector, token, to, nftId, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, kind, target, selector, token, to, perTxCap, totalLimit, nftId, validAfter, validUntil,
            account.nonce(), DEADLINE
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.grantPermission(
            PeridotAccount.GrantArgs({
                permissionId: pid,
                sessionX: SX,
                sessionY: SY,
                kind: kind,
                target: target,
                selector: selector,
                token: token,
                to: to,
                perTxCap: perTxCap,
                totalLimit: totalLimit,
                nftId: nftId,
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

    function _exec(bytes32 pid, address target, uint256 value, bytes memory data, uint64 seq) internal {
        bytes32 payload = _execPayload(pid, seq, target, value, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        account.executeWithPermission(pid, target, value, data, DEADLINE, seq, POLICY, 0, auth, client, r, s);
    }

    /// @dev `vm.expectRevert` cannot precede helpers (the cheatcode signing call
    /// would consume it), so reverts are asserted via try/catch + selector check.
    function _execReverts(bytes4 err, bytes32 pid, address target, uint256 value, bytes memory data, uint64 seq)
        internal
    {
        bytes32 payload = _execPayload(pid, seq, target, value, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        try account.executeWithPermission(pid, target, value, data, DEADLINE, seq, POLICY, 0, auth, client, r, s) {
            fail("expected revert");
        } catch (bytes memory ret) {
            assertEq(bytes4(ret), err, "wrong revert selector");
        }
    }

    // ---- happy paths ----

    function test_PermNonfinancialHappyPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        _exec(pid, address(evil), 0, abi.encodeCall(EvilTarget.poke, (42)), 0);
        assertEq(evil.number(), 42);
        assertEq(account.getPermission(pid).seq, 1);
    }

    function test_PermEthBounded() public {
        address to = address(0xBEEF);
        bytes32 pid = _grant(2, address(0), bytes4(0), address(0), to, 0.4 ether, 1 ether, 0);
        vm.deal(address(account), 2 ether);
        _exec(pid, to, 0.3 ether, "", 0);
        assertEq(to.balance, 0.3 ether);
        assertEq(account.getPermission(pid).spent, 0.3 ether);
        // Over per-tx cap fails; further in-cap spends work until the total is exhausted.
        _execReverts(PeridotAccount.LimitExceeded.selector, pid, to, 0.8 ether, "", 1);
        _exec(pid, to, 0.4 ether, "", 1);
        _exec(pid, to, 0.3 ether, "", 2);
        assertEq(account.getPermission(pid).spent, 1 ether);
        _execReverts(PeridotAccount.LimitExceeded.selector, pid, to, 1 wei, "", 3);
    }

    function test_PermErc20Bounded() public {
        MockERC20 token = new MockERC20();
        address to = address(0xBEEF);
        token.mint(address(account), 1000);
        bytes32 pid = _grant(3, address(0), bytes4(0), address(token), to, 150, 250, 0);
        _exec(pid, address(token), 0, abi.encodeCall(MockERC20.transfer, (to, 100)), 0);
        assertEq(token.balanceOf(to), 100);
        _execReverts(
            PeridotAccount.LimitExceeded.selector, pid, address(token), 0, abi.encodeCall(MockERC20.transfer, (to, 200)),
            1
        );
        _exec(pid, address(token), 0, abi.encodeCall(MockERC20.transfer, (to, 150)), 1);
        assertEq(token.balanceOf(to), 250);
    }

    function test_PermErc721SingleId() public {
        MockERC721 nft = new MockERC721();
        address to = address(0xBEEF);
        nft.mint(address(account), 7);
        nft.mint(address(account), 8);
        bytes32 pid = _grant(4, address(0), bytes4(0), address(nft), to, 1, 1, 7);
        _exec(pid, address(nft), 0, abi.encodeCall(MockERC721.transferFrom, (address(account), to, 7)), 0);
        assertEq(nft.ownerOf(7), to);
        // Wrong id fails; correct id is already spent.
        _execReverts(
            PeridotAccount.ScopeMismatch.selector, pid, address(nft), 0,
            abi.encodeCall(MockERC721.transferFrom, (address(account), to, 8)), 1
        );
    }

    function test_PermErc1155Capped() public {
        MockERC1155 m = new MockERC1155();
        address to = address(0xBEEF);
        m.mint(address(account), 9, 100);
        bytes32 pid = _grant(5, address(0), bytes4(0), address(m), to, 40, 100, 9);
        _exec(
            pid, address(m), 0,
            abi.encodeCall(MockERC1155.safeTransferFrom, (address(account), to, 9, 40, bytes(""))), 0
        );
        assertEq(m.balanceOf(9, to), 40);
        _execReverts(
            PeridotAccount.LimitExceeded.selector, pid, address(m), 0,
            abi.encodeCall(MockERC1155.safeTransferFrom, (address(account), to, 9, 61, bytes(""))), 1
        );
    }

    function test_PermExecutorPath() public {
        PeridotPermissionExecutor executor = new PeridotPermissionExecutor();
        _installModule(2, address(executor));
        assertTrue(account.isModuleInstalled(2, address(executor), ""));
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (7));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, address(evil), uint256(0), data, DEADLINE, uint64(0), POLICY, uint256(0), address(this), auth, client,
            r, s
        );
        executor.executeViaPermission(payable(address(account)), bytes32(0), execCalldata);
        assertEq(evil.number(), 7);
    }

    function test_PermFeeSettlement() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        vm.deal(address(account), 1 ether);
        uint256 relayerBefore = address(this).balance;
        uint256 factoryBefore = address(factory).balance;
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY, 0.001 ether, auth, client, r, s);
        assertEq(address(this).balance, relayerBefore + 0.001 ether);
        assertEq(address(factory).balance, factoryBefore + 0.0005 ether);
    }

    function test_7579ExecuteHappyPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes memory data = abi.encodeCall(EvilTarget.poke, (11));
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, uint8(0x15), block.chainid, address(account), n, address(evil), uint256(0),
                keccak256(data), DEADLINE, POLICY
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        account.execute(bytes32(0), abi.encode(address(evil), uint256(0), data, DEADLINE, POLICY, uint256(0), auth, client, r, s));
        assertEq(evil.number(), 11);
        assertEq(account.nonce(), n + 1);
    }

    // ---- adversarial: no unauthorized financial operation ----

    function test_AdvCannotSendEthOnNonfinancial() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        vm.deal(address(account), 1 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0.5 ether, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.ScopeMismatch.selector);
        account.executeWithPermission(pid, address(evil), 0.5 ether, data, DEADLINE, 0, POLICY, 0, auth, client, r, s);
    }

    function test_AdvCannotGrantApproveSelector() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256("deny");
        bytes4 sel = MockERC20.approve.selector;
        bytes32 pid = _pid(SX, SY, 1, address(evil), sel, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), sel, address(0), address(0), 0, 0, 0, validAfter, validUntil,
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

    function test_AdvCannotSneakApproveThroughTransferGrant() public {
        MockERC20 token = new MockERC20();
        token.mint(address(account), 1000);
        address to = address(0xBEEF);
        bytes32 pid = _grant(3, address(0), bytes4(0), address(token), to, 100, 100, 0);
        bytes memory evil = abi.encodeCall(MockERC20.approve, (to, 1000));
        bytes32 payload = _execPayload(pid, 0, address(token), 0, evil, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.ScopeMismatch.selector);
        account.executeWithPermission(pid, address(token), 0, evil, DEADLINE, 0, POLICY, 0, auth, client, r, s);
        assertEq(token.allowance(address(account), to), 0);
    }

    function test_AdvCannotTransferToUnlistedRecipient() public {
        MockERC20 token = new MockERC20();
        token.mint(address(account), 1000);
        bytes32 pid = _grant(3, address(0), bytes4(0), address(token), address(0xBEEF), 100, 100, 0);
        address attacker = address(0xBAD);
        bytes memory evil = abi.encodeCall(MockERC20.transfer, (attacker, 100));
        bytes32 payload = _execPayload(pid, 0, address(token), 0, evil, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.ScopeMismatch.selector);
        account.executeWithPermission(pid, address(token), 0, evil, DEADLINE, 0, POLICY, 0, auth, client, r, s);
        assertEq(token.balanceOf(attacker), 0);
    }

    // ---- adversarial: no escalation to owner authority ----

    function test_AdvCannotTargetSelf() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
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
        bytes32 payload = _execPayload(pid, 0, address(account), 0, evilCall, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.InvalidTarget.selector);
        account.executeWithPermission(pid, address(account), 0, evilCall, DEADLINE, 0, POLICY, 0, auth, client, r, s);
        assertEq(account.authorityX(), GX);
    }

    function test_AdvReentryIntoRotateFails() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        // Inner call replays the exact same (valid-once) execution while the outer holds the lock.
        evil.setReenter(
            abi.encodeWithSignature(
                "executeWithPermission(bytes32,address,uint256,bytes,uint64,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)",
                pid,
                address(evil),
                uint256(0),
                data,
                DEADLINE,
                uint64(0),
                POLICY,
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
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
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, validAfter,
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
        bytes32 ep = _execPayload(pid, 0, address(evil), 0, data, dl, POLICY);
        (bytes memory a2, bytes memory c2, bytes32 r2, bytes32 s2) = _sigSession(ep);
        vm.expectRevert(PeridotAccount.PermissionExpired.selector);
        account.executeWithPermission(pid, address(evil), 0, data, dl, 0, POLICY, 0, a2, c2, r2, s2);
    }

    function test_AdvLongTtlRejected() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        uint64 longDl = uint64(block.timestamp + 601);
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, longDl, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.Expired.selector);
        account.executeWithPermission(pid, address(evil), 0, data, longDl, 0, POLICY, 0, auth, client, r, s);
    }

    function test_AdvRevokeIsImmediateAndOwnerOnly() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        // Session-signed revoke (over the owner payload shape) must not verify as owner.
        bytes32 revokePayload = keccak256(
            abi.encodePacked(DOMAIN_PERM, uint8(0x11), block.chainid, address(account), pid, account.nonce(), DEADLINE)
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.chainId(999);
        vm.expectRevert(PeridotAccount.InvalidChallenge.selector);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY, 0, auth, client, r, s);
        vm.chainId(31337);
        _exec(pid, address(evil), 0, data, 0);
    }

    // ---- adversarial: OWNER vs PERMISSION confusion ----

    function test_AdvOwnerSigInvalidOnPermPath() public {
        EvilTarget evil = new EvilTarget(address(account));
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        // Owner signs the PERM payload, but the stored session key differs → Unauthorized.
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY, 0, auth, client, r, s);
    }

    function test_AdvSessionSigInvalidOnOwnerPaths() public {
        // Session signs a V3 owner payload shape; the owner verifier must reject it.
        address to = address(0x1234);
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_V3, uint8(0x01), block.chainid, address(account), account.nonce(), to, uint256(0),
                keccak256(""), DEADLINE, POLICY
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.Unauthorized.selector);
        account.execute(to, 0, "", DEADLINE, POLICY, 0, auth, client, r, s);
    }

    function test_AdvGrantNeedsOwnerSig() public {
        EvilTarget evil = new EvilTarget(address(account));
        uint64 validAfter = 1_000_000;
        uint64 validUntil = 1_000_000 + 7 days;
        bytes32 salt = keccak256("selfgrant");
        bytes32 pid = _pid(SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, validUntil, salt);
        bytes32 payload = _grantPayload(
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, validAfter,
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 ep = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory a3, bytes memory c3, bytes32 r3, bytes32 s3) = _sigSession(ep);
        assertEq(account.isValidSignature(keccak256(data), abi.encode(a3, c3, r3, s3)), MAGIC_INVALID);
    }

    function test_Adv1271NoCrossAccountReplay() public {
        bytes32 salt2 = bytes32(uint256(8));
        address predicted2 = factory.predict(salt2);
        vm.deal(predicted2, 0.01 ether);
        uint64 n = account.nonce();
        bytes32 actPayload = keccak256(
            abi.encodePacked(DOMAIN_V3, uint8(0x05), salt2, GX, GY, rpIdHash, POLICY, DEADLINE, block.chainid, address(factory))
        );
        (bytes memory auth0, bytes memory client0, bytes32 r0, bytes32 s0) = _sigOwner(actPayload);
        PeridotAccount account2 = PeridotAccount(
            payable(factory.deployAndInit(salt2, GX, GY, rpIdHash, POLICY, DEADLINE, 0.002 ether, auth0, client0, r0, s0))
        );
        assertEq(account.nonce(), n); // sanity: deploying B consumed no nonce on A
        bytes32 hash = keccak256("replay me");
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sig1271(hash, 1);
        bytes memory sig = abi.encode(auth, client, r, s);
        assertEq(account.isValidSignature(hash, sig), MAGIC_1271);
        assertEq(account2.isValidSignature(hash, sig), MAGIC_INVALID);
    }

    // ---- adversarial: module + mode boundaries ----

    function _installModule(uint256 moduleTypeId, address module) internal {
        uint64 n = account.nonce();
        bytes32 payload = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, uint8(0x13), block.chainid, address(account), moduleTypeId, module, keccak256(""), n,
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
                DOMAIN_PERM, uint8(0x13), block.chainid, address(account), uint256(3), address(executor),
                keccak256(""), n, DEADLINE
            )
        );
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigOwner(payload);
        vm.expectRevert(PeridotAccount.UnsupportedModuleType.selector);
        account.installModule(3, address(executor), "", DEADLINE, auth, client, r, s);
        // Install needs the owner signature.
        bytes32 payload2 = keccak256(
            abi.encodePacked(
                DOMAIN_PERM, uint8(0x13), block.chainid, address(account), uint256(2), address(executor),
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
                    DOMAIN_PERM, uint8(0x13), block.chainid, address(account), uint256(2), address(executor),
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        bytes memory execCalldata = abi.encode(
            pid, address(evil), uint256(0), data, DEADLINE, uint64(0), POLICY, uint256(0), address(this), auth, client,
            r, s
        );
        // Not installed → NotModule (also covers direct account.executeFromExecutor calls).
        vm.expectRevert(PeridotAccount.NotModule.selector);
        executor.executeViaPermission(payable(address(account)), bytes32(0), execCalldata);
        vm.expectRevert(PeridotAccount.NotModule.selector);
        account.executeFromExecutor(bytes32(0), execCalldata);
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
        account.executeFromExecutor(bytes32(uint256(1)), "");
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
            0, validAfter, validUntil, account.nonce(), DEADLINE
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
            pid, SX, SY, 1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0, validAfter,
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
        bytes32 pid = _grant(1, address(evil), EvilTarget.poke.selector, address(0), address(0), 0, 0, 0);
        vm.deal(address(account), 200 ether);
        bytes memory data = abi.encodeCall(EvilTarget.poke, (1));
        bytes32 payload = _execPayload(pid, 0, address(evil), 0, data, DEADLINE, POLICY);
        (bytes memory auth, bytes memory client, bytes32 r, bytes32 s) = _sigSession(payload);
        vm.expectRevert(PeridotAccount.GasAnomaly.selector);
        account.executeWithPermission(pid, address(evil), 0, data, DEADLINE, 0, POLICY, 100 ether, auth, client, r, s);
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
