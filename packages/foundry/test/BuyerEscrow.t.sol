// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../src/BuyerEscrow.sol";

interface Vm {
    function deal(address who, uint256 balance) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
}

contract BuyerEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BuyerEscrow private escrow;
    address private constant seller = address(0xA11CE);
    address private constant stranger = address(0xBAD);
    uint256 private constant amount = 100_000_000;
    bytes32 private constant termsHash = keccak256("signed-terms-test-fixture");

    function setUp() public {
        escrow = new BuyerEscrow();
        vm.deal(address(this), amount * 10);
    }

    function fund() private returns (uint64 refundAfter) {
        refundAfter = uint64(block.timestamp + 3600);
        uint256 id = escrow.fund{value: amount}(seller, refundAfter, termsHash);
        require(id == 1, "wrong escrow id");
    }

    function testFundingRequiresBoundedTerms() public {
        vm.expectRevert();
        escrow.fund{value: amount}(address(this), uint64(block.timestamp + 3600), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 3600), bytes32(0));
        vm.expectRevert();
        escrow.fund(seller, uint64(block.timestamp + 3600), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp), termsHash);
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 31 days), termsHash);
        require(escrow.nextId() == 1, "failed funding advanced id");
    }

    function testTermsHashCannotBeFundedTwice() public {
        fund();
        vm.expectRevert();
        escrow.fund{value: amount}(seller, uint64(block.timestamp + 7200), termsHash);
        require(escrow.nextId() == 2, "duplicate funding advanced id");
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

    function testBuyerCannotApproveAfterDeadline() public {
        uint64 due = fund();
        vm.warp(due);
        vm.expectRevert();
        escrow.approve(1);
    }

    receive() external payable {}
}
