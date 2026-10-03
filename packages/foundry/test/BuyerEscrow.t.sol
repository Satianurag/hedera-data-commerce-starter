// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import "../src/BuyerEscrow.sol";

contract RejectingSeller {
    function withdraw(BuyerEscrow escrow, uint256 id) external {
        escrow.withdraw(id);
    }

    receive() external payable { revert("reject payout"); }
}

contract ReenteringSeller {
    BuyerEscrow private immutable escrow;
    uint256 private target;
    bool private attempted;
    bool public reentrySucceeded;

    constructor(BuyerEscrow escrow_) { escrow = escrow_; }

    function withdraw(uint256 id) external {
        target = id;
        escrow.withdraw(id);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        (reentrySucceeded,) = address(escrow).call(abi.encodeCall(BuyerEscrow.withdraw, (target)));
    }
}

interface Vm {
    function deal(address who, uint256 balance) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
    function expectRevert(bytes calldata reason) external;
}

contract BuyerEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BuyerEscrow private escrow;
    address private constant seller = address(0xA11CE);
    address private constant stranger = address(0xBAD);
    uint256 private constant amount = 100_000_000;
    bytes32 private constant termsHash = keccak256("signed-terms-test-fixture");

    function setUp() public {
        vm.warp(1000);
        escrow = new BuyerEscrow();
        vm.deal(address(this), amount * 10);
    }

    function fund() private returns (uint64 refundAfter) {
        refundAfter = uint64(block.timestamp + 3600);
        uint256 id = escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), refundAfter, termsHash);
        require(id == 1, "wrong escrow id");
    }

    function testFundingRequiresBoundedTerms() public {
        vm.expectRevert();
        escrow.fund{value: amount}(address(this), uint64(block.timestamp + 300), uint64(block.timestamp + 3600), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 3600), bytes32(0));
        vm.expectRevert();
        escrow.fund(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 3600), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp), uint64(block.timestamp), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 31 days), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp - 1), uint64(block.timestamp + 3600), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 3600), uint64(block.timestamp + 3600), termsHash);
        require(escrow.nextId() == 1, "failed funding advanced id");
    }

    function testTermsHashCannotBeFundedTwice() public {
        fund();
        require(escrow.usedTermsHash(address(this), termsHash), "buyer replay flag missing");
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 7200), termsHash);
        require(escrow.nextId() == 2, "duplicate funding advanced id");
    }

    function testOtherBuyerCannotBurnMySignedTermsHash() public {
        vm.deal(stranger, amount);
        vm.prank(stranger);
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 3600), termsHash);
        require(escrow.usedTermsHash(stranger, termsHash), "other buyer replay flag missing");
        require(!escrow.usedTermsHash(address(this), termsHash), "other buyer burned my terms");
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 300), uint64(block.timestamp + 3600), termsHash);
        require(escrow.usedTermsHash(address(this), termsHash), "buyer funding did not consume terms");
    }

    function testBuyerApprovalAndSellerWithdrawal() public {
        fund();
        require(address(escrow).balance == amount, "funding missing");
        vm.prank(stranger);
        vm.expectRevert();
        escrow.approve(1);
        vm.prank(seller);
        vm.expectRevert();
        escrow.withdraw(1);
        escrow.approve(1);
        vm.prank(stranger);
        vm.expectRevert();
        escrow.withdraw(1);
        vm.prank(seller);
        escrow.withdraw(1);
        require(seller.balance == amount && address(escrow).balance == 0, "seller payout mismatch");
        vm.prank(seller);
        vm.expectRevert();
        escrow.withdraw(1);
        vm.expectRevert();
        escrow.refund(1);
    }

    function testTimeoutRefundAndNoLateRelease() public {
        uint64 due = fund();
        uint256 buyerAfterFunding = address(this).balance;
        vm.prank(stranger);
        vm.expectRevert();
        escrow.refund(1);
        vm.expectRevert();
        escrow.refund(1);
        vm.warp(due);
        escrow.refund(1);
        require(address(this).balance == buyerAfterFunding + amount && address(escrow).balance == 0, "refund mismatch");
        vm.expectRevert();
        escrow.approve(1);
        vm.expectRevert();
        escrow.refund(1);
    }

    function testApprovedButUnclaimedEscrowCanBeRefundedAtDeadline() public {
        uint64 due = fund();
        uint256 buyerAfterFunding = address(this).balance;
        escrow.approve(1);
        vm.expectRevert();
        escrow.refund(1);
        vm.warp(due);
        vm.prank(seller);
        vm.expectRevert();
        escrow.withdraw(1);
        escrow.refund(1);
        require(address(this).balance == buyerAfterFunding + amount && address(escrow).balance == 0, "approved refund missing");
        vm.prank(seller);
        vm.expectRevert();
        escrow.withdraw(1);
    }

    function assertStrangerCannotRefundAtDeadline(bool approveFirst) private {
        uint64 due = fund();
        if (approveFirst) escrow.approve(1);
        vm.warp(due);
        uint256 buyerBefore = address(this).balance;
        uint256 strangerBefore = stranger.balance;
        vm.prank(stranger);
        vm.expectRevert(bytes("not active buyer"));
        escrow.refund(1);
        (,,,,,, BuyerEscrow.State state) = escrow.escrows(1);
        require(state == (approveFirst ? BuyerEscrow.State.Approved : BuyerEscrow.State.Funded), "stranger changed state");
        require(address(escrow).balance == amount, "stranger changed custody");
        require(address(this).balance == buyerBefore && stranger.balance == strangerBefore, "stranger caused transfer");
        escrow.refund(1);
        require(address(this).balance == buyerBefore + amount && address(escrow).balance == 0, "buyer refund unavailable");
    }

    function testStrangerCannotRefundFundedEscrowAtDeadline() public {
        assertStrangerCannotRefundAtDeadline(false);
    }

    function testStrangerCannotRefundApprovedEscrowAtDeadline() public {
        assertStrangerCannotRefundAtDeadline(true);
    }

    function testSellerCallbackCannotDrainAnotherEscrow() public {
        ReenteringSeller attacker = new ReenteringSeller(escrow);
        uint64 due = uint64(block.timestamp + 3600);
        uint256 first = escrow.fund{value: amount}(address(attacker), uint64(block.timestamp), due, keccak256("attacker"));
        vm.deal(stranger, amount);
        vm.prank(stranger);
        uint256 second = escrow.fund{value: amount}(seller, uint64(block.timestamp), due, keccak256("other escrow"));
        escrow.approve(first);
        attacker.withdraw(first);
        require(!attacker.reentrySucceeded(), "same escrow paid twice during callback");
        require(address(attacker).balance == amount, "seller payout was not exact");
        require(address(escrow).balance == amount, "another escrow's funds were drained");
        (,,,,,, BuyerEscrow.State firstState) = escrow.escrows(first);
        (,,,,,, BuyerEscrow.State secondState) = escrow.escrows(second);
        require(firstState == BuyerEscrow.State.Paid && secondState == BuyerEscrow.State.Funded, "callback changed other escrow");
        vm.warp(due);
        uint256 buyerBefore = stranger.balance;
        vm.prank(stranger);
        escrow.refund(second);
        require(stranger.balance == buyerBefore + amount && address(escrow).balance == 0, "other buyer funds not recoverable");
    }

    function testBuyerCannotApproveAfterDeadline() public {
        uint64 due = fund();
        vm.warp(due);
        vm.expectRevert();
        escrow.approve(1);
    }

    function testRejectedSellerPayoutRemainsRefundable() public {
        RejectingSeller rejecting = new RejectingSeller();
        uint64 due = uint64(block.timestamp + 3600);
        escrow.fund{value: amount}(address(rejecting), uint64(block.timestamp + 300), due, termsHash);
        escrow.approve(1);
        vm.expectRevert();
        rejecting.withdraw(escrow, 1);
        (,,,,,, BuyerEscrow.State state) = escrow.escrows(1);
        require(state == BuyerEscrow.State.Approved && address(escrow).balance == amount,
            "failed payout changed custody");
        vm.warp(due);
        escrow.refund(1);
        require(address(escrow).balance == 0, "failed payout blocked refund");
    }

    receive() external payable {}
}
