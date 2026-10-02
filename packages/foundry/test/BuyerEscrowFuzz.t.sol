// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import "../src/BuyerEscrow.sol";

interface FuzzVm {
    function deal(address who, uint256 balance) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
}

library Bound {
    function within(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}

contract BuyerEscrowFuzzTest {
    using Bound for uint256;

    FuzzVm private constant vm = FuzzVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BuyerEscrow private escrow;
    address private constant buyer = address(0xB0B);
    address private constant seller = address(0xA11CE);
    uint256 private constant start = 1_000_000;

    function setUp() public {
        vm.warp(start);
        escrow = new BuyerEscrow();
    }

    function fundWith(uint256 amount, uint256 quoteDelay, uint256 refundDelay, bytes32 terms)
        private
        returns (uint256 id, uint64 refundAfter)
    {
        refundAfter = uint64(start + refundDelay);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        id = escrow.fund{value: amount}(seller, uint64(start + quoteDelay), refundAfter, terms);
    }

    function testFuzzFundStoresExactTerms(uint96 rawAmount, uint256 rawRefund, uint256 rawQuote, bytes32 terms) public {
        if (terms == bytes32(0)) terms = keccak256("fallback");
        uint256 amount = uint256(rawAmount).within(1, type(uint96).max);
        uint256 refundDelay = rawRefund.within(1, 30 days);
        uint256 quoteDelay = rawQuote.within(0, refundDelay - 1);
        (uint256 id, uint64 refundAfter) = fundWith(amount, quoteDelay, refundDelay, terms);

        (address b, address s, uint256 a, uint64 q, uint64 r, bytes32 h, BuyerEscrow.State state) = escrow.escrows(id);
        require(b == buyer && s == seller && a == amount, "wrong parties or amount");
        require(q == uint64(start + quoteDelay) && r == refundAfter && h == terms, "wrong terms");
        require(state == BuyerEscrow.State.Funded, "not funded");
        require(address(escrow).balance == amount, "balance mismatch");
        require(escrow.usedTermsHash(buyer, terms), "terms not consumed");
    }

    function testFuzzRejectsRefundWindowBeyondThirtyDays(uint256 rawRefund) public {
        uint256 refundDelay = rawRefund.within(30 days + 1, 3650 days);
        vm.deal(buyer, 1);
        vm.prank(buyer);
        vm.expectRevert();
        escrow.fund{value: 1}(seller, uint64(start), uint64(start + refundDelay), keccak256("terms"));
    }

    function testFuzzOnlyBuyerCanApproveBeforeDeadline(address caller, uint256 rawAmount, uint256 rawWait) public {
        uint256 amount = rawAmount.within(1, 1e30);
        (uint256 id, uint64 refundAfter) = fundWith(amount, 0, 1 hours, keccak256("approve"));
        uint256 when = rawWait.within(start, start + 2 hours);
        vm.warp(when);
        bool allowed = caller == buyer && when < refundAfter;
        if (!allowed) vm.expectRevert();
        vm.prank(caller);
        escrow.approve(id);
        (,,,,,, BuyerEscrow.State state) = escrow.escrows(id);
        require(state == (allowed ? BuyerEscrow.State.Approved : BuyerEscrow.State.Funded), "unexpected state");
    }

    function testFuzzSellerPaidExactlyOnce(uint256 rawAmount, uint256 rawWait) public {
        uint256 amount = rawAmount.within(1, 1e30);
        (uint256 id, uint64 refundAfter) = fundWith(amount, 0, 1 hours, keccak256("release"));
        vm.prank(buyer);
        escrow.approve(id);
        vm.warp(rawWait.within(start, refundAfter - 1));
        vm.prank(seller);
        escrow.withdraw(id);
        require(seller.balance == amount && address(escrow).balance == 0, "payout mismatch");

        vm.prank(seller);
        vm.expectRevert();
        escrow.withdraw(id);
        vm.warp(refundAfter);
        vm.prank(buyer);
        vm.expectRevert();
        escrow.refund(id);
    }

    function testFuzzRefundOnlyAtOrAfterDeadline(uint256 rawAmount, uint256 rawWait, bool approveFirst) public {
        uint256 amount = rawAmount.within(1, 1e30);
        (uint256 id, uint64 refundAfter) = fundWith(amount, 0, 1 hours, keccak256("refund"));
        if (approveFirst) {
            vm.prank(buyer);
            escrow.approve(id);
        }
        uint256 when = rawWait.within(start, start + 2 hours);
        vm.warp(when);
        bool due = when >= refundAfter;
        if (!due) vm.expectRevert();
        vm.prank(buyer);
        escrow.refund(id);
        require(buyer.balance == (due ? amount : 0), "refund mismatch");
        if (due) {
            vm.prank(seller);
            vm.expectRevert();
            escrow.withdraw(id);
        }
    }
}

contract EscrowHandler {
    FuzzVm private constant vm = FuzzVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BuyerEscrow public immutable escrow;
    address[3] private actors = [address(0x1001), address(0x1002), address(0x1003)];
    uint256 public outstanding;
    uint256 public fundedTotal;
    uint256 public settledTotal;
    uint256 private nonce;

    constructor(BuyerEscrow target) {
        escrow = target;
    }

    function fund(uint256 buyerSeed, uint256 sellerSeed, uint256 rawAmount, uint256 rawRefund) external {
        address buyer = actors[buyerSeed % 3];
        address seller = actors[sellerSeed % 3];
        if (buyer == seller) seller = actors[(sellerSeed % 3 + 1) % 3];
        uint256 amount = 1 + (rawAmount % 1e24);
        uint256 refundDelay = 2 + (rawRefund % (30 days - 1));
        vm.deal(buyer, buyer.balance + amount);
        vm.prank(buyer);
        escrow.fund{value: amount}(seller, uint64(block.timestamp), uint64(block.timestamp + refundDelay), keccak256(abi.encode(++nonce)));
        outstanding += amount;
        fundedTotal += amount;
    }

    function approve(uint256 idSeed) external {
        uint256 id = pick(idSeed);
        if (id == 0) return;
        (address buyer,,,, uint64 refundAfter,, BuyerEscrow.State state) = escrow.escrows(id);
        if (state != BuyerEscrow.State.Funded || block.timestamp >= refundAfter) return;
        vm.prank(buyer);
        escrow.approve(id);
    }

    function withdraw(uint256 idSeed) external {
        uint256 id = pick(idSeed);
        if (id == 0) return;
        (, address seller, uint256 amount,, uint64 refundAfter,, BuyerEscrow.State state) = escrow.escrows(id);
        if (state != BuyerEscrow.State.Approved || block.timestamp >= refundAfter) return;
        vm.prank(seller);
        escrow.withdraw(id);
        outstanding -= amount;
        settledTotal += amount;
    }

    function refund(uint256 idSeed) external {
        uint256 id = pick(idSeed);
        if (id == 0) return;
        (address buyer,, uint256 amount,, uint64 refundAfter,, BuyerEscrow.State state) = escrow.escrows(id);
        bool active = state == BuyerEscrow.State.Funded || state == BuyerEscrow.State.Approved;
        if (!active || block.timestamp < refundAfter) return;
        vm.prank(buyer);
        escrow.refund(id);
        outstanding -= amount;
        settledTotal += amount;
    }

    function advance(uint256 rawSeconds) external {
        vm.warp(block.timestamp + (rawSeconds % 31 days));
    }

    function pick(uint256 seed) private view returns (uint256) {
        uint256 count = escrow.nextId() - 1;
        return count == 0 ? 0 : 1 + (seed % count);
    }
}

contract BuyerEscrowInvariantTest {
    FuzzVm private constant vm = FuzzVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BuyerEscrow private escrow;
    EscrowHandler private handler;

    function setUp() public {
        vm.warp(1_000_000);
        escrow = new BuyerEscrow();
        handler = new EscrowHandler(escrow);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_balanceEqualsActiveEscrows() public view {
        require(address(escrow).balance == handler.outstanding(), "escrow balance diverged");
        uint256 active;
        for (uint256 id = 1; id < escrow.nextId(); id++) {
            (,, uint256 amount,,,, BuyerEscrow.State state) = escrow.escrows(id);
            if (state == BuyerEscrow.State.Funded || state == BuyerEscrow.State.Approved) active += amount;
        }
        require(active == address(escrow).balance, "active escrows do not match balance");
    }

    function invariant_valueIsConserved() public view {
        require(handler.fundedTotal() == handler.outstanding() + handler.settledTotal(), "value created or lost");
    }
}
