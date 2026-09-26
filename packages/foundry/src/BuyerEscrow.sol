// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract BuyerEscrow {
    enum State { None, Funded, Approved, Paid, Refunded }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint64 refundAfter;
        bytes32 termsHash;
        State state;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Escrow) public escrows;
    mapping(bytes32 => bool) public usedTermsHash;

    event Funded(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 refundAfter, bytes32 termsHash);
    event Approved(uint256 indexed id, address indexed buyer);
    event Released(uint256 indexed id, address indexed seller, address to, uint256 amount);
    event Refunded(uint256 indexed id, address indexed buyer, address to, uint256 amount);

    function fund(address seller, uint64 refundAfter, bytes32 termsHash) external payable returns (uint256 id) {
        require(seller != address(0) && seller != msg.sender, "invalid seller");
        require(msg.value > 0 && termsHash != bytes32(0), "invalid terms or amount");
        require(!usedTermsHash[termsHash], "terms already funded");
        require(refundAfter > block.timestamp && refundAfter <= block.timestamp + 30 days, "invalid refund time");
        usedTermsHash[termsHash] = true;
        id = nextId++;
        escrows[id] = Escrow(msg.sender, seller, msg.value, refundAfter, termsHash, State.Funded);
        emit Funded(id, msg.sender, seller, msg.value, refundAfter, termsHash);
    }

    function approve(uint256 id) external {
        Escrow storage escrow = escrows[id];
        require(escrow.state == State.Funded && msg.sender == escrow.buyer, "not funded buyer");
        require(block.timestamp < escrow.refundAfter, "approval deadline passed");
        escrow.state = State.Approved;
        emit Approved(id, msg.sender);
    }

    function withdraw(uint256 id) external {
        Escrow storage escrow = escrows[id];
        require(escrow.state == State.Approved && msg.sender == escrow.seller, "not approved seller");
        require(block.timestamp < escrow.refundAfter, "withdrawal deadline passed");
        escrow.state = State.Paid;
        (bool sent,) = payable(escrow.seller).call{value: escrow.amount}("");
        require(sent, "release transfer failed");
        emit Released(id, escrow.seller, escrow.seller, escrow.amount);
    }

    function refund(uint256 id) external {
        Escrow storage escrow = escrows[id];
        require((escrow.state == State.Funded || escrow.state == State.Approved) && msg.sender == escrow.buyer, "not active buyer");
        require(block.timestamp >= escrow.refundAfter, "refund not due");
        escrow.state = State.Refunded;
        (bool sent,) = payable(escrow.buyer).call{value: escrow.amount}("");
        require(sent, "refund transfer failed");
        emit Refunded(id, escrow.buyer, escrow.buyer, escrow.amount);
    }
}
