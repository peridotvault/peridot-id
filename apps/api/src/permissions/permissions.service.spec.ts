// V4 permission backend spec: canonical vectors (logged from forge `TempVectors`)
// pin the TS builders byte-for-byte, plus grant-hygiene rules mirrored from the contract.
import { EvmAdapter, buildPermExecPayload, keccak256 } from "@peridotvault/pid-evm";
import { GrantPermissionDto } from "./dto/permission.dto";
import { PermissionsService } from "./permissions.service";

const ACCOUNT = "0x15b4F164718FAC7cfDA7B60687acA4173C99aafc";
const TARGET = "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a";
const SX = "0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978";
const SY = "0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1";
const SALT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_000_000;
const VALID_UNTIL = NOW + 7 * 86400;

const hex = (u8: Uint8Array) => "0x" + Buffer.from(u8).toString("hex");
const B = (h: string) => new Uint8Array(Buffer.from(h.slice(2), "hex"));

function baseDto(): GrantPermissionDto {
  const d = new GrantPermissionDto();
  d.kind = 1;
  d.target = TARGET;
  d.selector = "0x12345678";
  d.token = ZERO;
  d.to = ZERO;
  d.perTxCap = "0";
  d.totalLimit = "0";
  d.nftId = "0";
  d.sessionX = SX;
  d.sessionY = SY;
  d.validAfter = NOW;
  d.validUntil = VALID_UNTIL;
  d.salt = SALT;
  d.deadline = NOW + 300;
  d.chainId = 31337;
  d.account = ACCOUNT;
  d.nonce = "0";
  d.factory = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
  return d;
}

describe("PermissionsService", () => {
  const svc = new PermissionsService();

  it("pins the canonical permission id + grant challenge (forge vectors)", () => {
    const v = svc.validateGrant(baseDto(), NOW);
    expect(v.permissionId).toBe("0xb4c008c91489c0d39b391924fad92b9d272cec1be7c2dee6a12c49fe450eb934");
    expect(v.grantPayload).toBe("0x02e91a87b3b3df96dc99198b06401110fe64b0b5a89de6f1efc99cd80a51424b");
  });

  it("pins the canonical perm-exec challenge (forge vector)", () => {
    const data = B("0x32145f90000000000000000000000000000000000000000000000000000000000000002a");
    const got = hex(
      buildPermExecPayload({
        chainId: 31337,
        account: ACCOUNT,
        permissionId: B("0xb4c008c91489c0d39b391924fad92b9d272cec1be7c2dee6a12c49fe450eb934"),
        seq: 0,
        target: TARGET,
        value: 0,
        dataHash: keccak256(data),
        deadline: NOW + 300,
        feePolicyVersion: 1,
      }),
    );
    expect(got).toBe("0x550858b9d3150b036b8825365d6dba05a242be37337f8cbe8f0334d3444cc6f1");
  });

  it("rejects a financial selector on a nonfinancial grant", () => {
    const d = baseDto();
    d.selector = "0xa9059cbb"; // transfer
    expect(() => svc.validateGrant(d, NOW)).toThrow(/financial/);
  });

  it("rejects the account/factory as a nonfinancial target", () => {
    const d = baseDto();
    d.target = ACCOUNT;
    expect(() => svc.validateGrant(d, NOW)).toThrow(/third-party/);
  });

  it("rejects >30d lifetimes and 600s+ deadlines", () => {
    const d = baseDto();
    d.validUntil = NOW + 31 * 86400;
    expect(() => svc.validateGrant(d, NOW)).toThrow(/30 days/);
    const d2 = baseDto();
    d2.deadline = NOW + 601;
    expect(() => svc.validateGrant(d2, NOW)).toThrow(/600s/);
  });

  it("rejects inverted caps on financial grants", () => {
    const d = baseDto();
    d.kind = 3;
    d.token = "0x0000000000000000000000000000000000000bee";
    d.to = "0x000000000000000000000000000000000000beef";
    d.perTxCap = "200";
    d.totalLimit = "100";
    expect(() => svc.validateGrant(d, NOW)).toThrow(/perTxCap/);
  });

  it("accepts a bounded ERC-20 grant", () => {
    const d = baseDto();
    d.kind = 3;
    d.target = ZERO;
    d.selector = "0x00000000";
    d.token = "0x0000000000000000000000000000000000000bee";
    d.to = "0x000000000000000000000000000000000000beef";
    d.perTxCap = "100";
    d.totalLimit = "250";
    const v = svc.validateGrant(d, NOW);
    expect(v.permissionId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("exposes the on-chain denied-selector list", () => {
    expect(svc.deniedSelectors()).toContain("0xa9059cbb");
    expect(svc.deniedSelectors()).toContain("0xa22cb465");
  });
});

describe("V4 adapter selectors", () => {
  const rpcLike = {
    getCode: async () => "0x",
    getBalance: async () => 0n,
    chainId: async () => 31337,
    gasPrice: async () => 0n,
    blockTimestamp: async () => NOW,
    call: async () => null,
  };
  const adapter = new EvmAdapter(rpcLike, ACCOUNT, ACCOUNT);
  const assertion = {
    authenticatorData: B("0x01"),
    clientDataJSON: B("0x02"),
    r: B("0x" + "11".repeat(32)),
    s: B("0x" + "22".repeat(32)),
  };

  it("builds grant/revoke/exec calldata with contract selectors", () => {
    const grant = adapter.buildGrantPermissionData({
      grant: {
        permissionId: B("0xb4c008c91489c0d39b391924fad92b9d272cec1be7c2dee6a12c49fe450eb934"),
        sessionX: B(SX),
        sessionY: B(SY),
        kind: 1,
        target: TARGET,
        selector: B("0x12345678"),
        token: ZERO,
        to: ZERO,
        perTxCap: 0,
        totalLimit: 0,
        nftId: 0,
        validAfter: NOW,
        validUntil: VALID_UNTIL,
        salt: B(SALT),
        deadline: NOW + 300,
      },
      ...assertion,
    });
    expect(grant.slice(0, 10)).toBe("0x2de1b436");
    const revoke = adapter.buildRevokePermissionData({
      permissionId: B("0xb4c008c91489c0d39b391924fad92b9d272cec1be7c2dee6a12c49fe450eb934"),
      deadline: NOW + 300,
      ...assertion,
    });
    expect(revoke.slice(0, 10)).toBe("0xb489b907");
    const exec = adapter.buildExecuteWithPermissionData({
      permissionId: B("0xb4c008c91489c0d39b391924fad92b9d272cec1be7c2dee6a12c49fe450eb934"),
      target: TARGET,
      value: 0,
      data: B("0x12345678"),
      deadline: NOW + 300,
      seq: 0,
      feePolicyVersion: 1,
      networkFee: 0,
      ...assertion,
    });
    expect(exec.slice(0, 10)).toBe("0x9c1e53f4");
    const install = adapter.buildInstallModuleData({
      uninstall: false,
      moduleTypeId: 2,
      module: TARGET,
      initData: new Uint8Array(0),
      deadline: NOW + 300,
      ...assertion,
    });
    expect(install.slice(0, 10)).toBe("0xb7815c08");
  });
});
