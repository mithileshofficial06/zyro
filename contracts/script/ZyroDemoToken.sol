// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A mintable 18-decimal ERC-20 for testnet demonstrations.
///
/// @dev Lives in `script/` deliberately: it is **not** part of the protocol
///      surface and must never be deployed to a network where anyone could
///      mistake it for real liquidity. `mint` is unrestricted, which is the
///      point on a testnet and unacceptable anywhere else.
///
///      18 decimals is not cosmetic. Zyro's inventory maths assumes it —
///      `targetInventoryWad` and `boundWad` are WAD-scaled, so a 6-decimal
///      token would need both rescaled to match.
contract ZyroDemoToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
