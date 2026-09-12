// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal base64url (RFC 4648 §5, no padding) decoder.
/// @dev Only what `PeridotAccount` needs: short ASCII slices out of clientDataJSON.
library Base64Url {
    error InvalidChar();

    /// @dev Decode `input` (unpadded base64url) into bytes. Reverts on bad input.
    function decode(bytes memory input) internal pure returns (bytes memory) {
        uint256 len = input.length;
        if (len % 4 == 1) revert InvalidChar();
        uint256 outLen = (len * 6) / 8;
        bytes memory out = new bytes(outLen);
        uint256 val;
        uint256 bits;
        uint256 written;
        for (uint256 i = 0; i < len; i++) {
            uint8 c = uint8(input[i]);
            uint256 d;
            if (c >= 0x41 && c <= 0x5A) d = c - 0x41;
            else if (c >= 0x61 && c <= 0x7A) d = c - 0x61 + 26;
            else if (c >= 0x30 && c <= 0x39) d = c - 0x30 + 52;
            else if (c == 0x2D) d = 62; // '-'
            else if (c == 0x5F) d = 63; // '_'
            else revert InvalidChar();
            val = (val << 6) | d;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[written++] = bytes1(uint8(val >> bits));
                val &= (1 << bits) - 1;
            }
        }
        return out;
    }
}
