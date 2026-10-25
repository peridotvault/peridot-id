/** V4 permission kind: 1 = nonfinancial, 2 = ETH, 3 = ERC-20, 4 = ERC-721, 5 = ERC-1155. */
export type PermissionKind = 1 | 2 | 3 | 4 | 5;

/** Owner-signed permission grant (mirrors `PeridotAccount.GrantArgs`). */
export interface PermissionGrant {
  permissionId: string;
  sessionX: string;
  sessionY: string;
  kind: PermissionKind;
  target: string;
  selector: string;
  token: string;
  to: string;
  perTxCap: string;
  totalLimit: string;
  nftId: string;
  validAfter: number;
  validUntil: number;
  salt: string;
  deadline: number;
}

/** On-chain permission record (mirrors `PeridotAccount.Permission`). */
export interface PermissionRecord extends PermissionGrant {
  seq: string;
  spent: string;
  revoked: boolean;
}
