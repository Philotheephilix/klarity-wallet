// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title HtmlHost — ERC-8244 Contract-Hosted Application
/// @notice Serves a self-contained HTML document via `html()`. The document is
/// too large for a single contract (EIP-170 24KB cap), so its bytes are stored
/// as the runtime code of one or more SSTORE2 "data contracts" and stitched back
/// together at read time. `html()` is a pure view — no state writes, no gas to
/// the caller — exactly what an ERC-8244 host expects.
contract HtmlHost {
    /// The data contracts holding the HTML bytes, in order.
    address[] public chunks;
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    /// Append a chunk of the document. Each chunk is deployed as a data contract
    /// whose runtime code IS the raw bytes. Only the deployer can add chunks.
    function addChunk(bytes calldata data) external {
        require(msg.sender == owner, "not owner");
        chunks.push(_write(data));
    }

    /// ERC-8244 entrypoint. Selector 0x33c34ac3 = bytes4(keccak256("html()")).
    function html() external view returns (string memory) {
        uint256 total;
        uint256 n = chunks.length;
        for (uint256 i = 0; i < n; i++) {
            total += _codeSize(chunks[i]) - 1; // minus the STOP guard byte
        }
        bytes memory out = new bytes(total);
        uint256 off;
        for (uint256 i = 0; i < n; i++) {
            address c = chunks[i];
            uint256 size = _codeSize(c) - 1;
            // copy runtime code [1..size+1) (skip the leading STOP) into out[off..]
            assembly {
                extcodecopy(c, add(add(out, 0x20), off), 1, size)
            }
            off += size;
        }
        return string(out);
    }

    function _codeSize(address a) internal view returns (uint256 s) {
        assembly { s := extcodesize(a) }
    }

    /// SSTORE2 write: deploy a contract whose runtime code == `data`, prefixed
    /// with a single STOP (0x00) byte so the data can never be executed.
    function _write(bytes memory data) internal returns (address ptr) {
        bytes memory runtime = abi.encodePacked(hex"00", data); // STOP guard + data
        uint256 len = runtime.length;
        require(len <= 24576, "chunk too big");
        // Creation code that copies `runtime` out and RETURNs it. The runtime
        // payload begins right after this 14-byte prologue (offset 0x0e):
        //   61 LLLL  PUSH2 len
        //   60 0e    PUSH1 0x0e   (payload offset = prologue length)
        //   60 00    PUSH1 0x00
        //   39       CODECOPY
        //   61 LLLL  PUSH2 len
        //   60 00    PUSH1 0x00
        //   f3       RETURN
        bytes memory creation = abi.encodePacked(
            hex"61", uint16(len),   // PUSH2 len
            hex"600e",              // PUSH1 0x0e  (payload starts at byte 14)
            hex"6000",              // PUSH1 0x00
            hex"39",                // CODECOPY
            hex"61", uint16(len),   // PUSH2 len
            hex"6000",              // PUSH1 0x00
            hex"f3",                // RETURN
            runtime
        );
        assembly {
            ptr := create(0, add(creation, 0x20), mload(creation))
        }
        require(ptr != address(0), "deploy failed");
    }
}
